import { CodexCompactionTracker, compactCodexThread, type CompactionStatus } from './codex-compaction';
/**
 * CodexKernel — 本机已装的 `codex` CLI(headless `codex exec --json`)适配成
 * 中立 `AgentKernel`,与 ClaudeCodeKernel 并列的第二个内核实现。
 *
 * **薄脊梁(spine)**:本文件只剩 codex 执行面的「流程骨架」——spawn / 记录
 * thread_id 以便 resume / JSONL → KernelEvent 的搬运 / 取消。**所有 Codex-isms
 * (`exec`/`exec resume` argv、approval_policy/sandbox_mode、systemPrompt 注入、
 * JSONL→KernelEvent 映射)都锁在 `codex-profile.ts`(+ `codex-mapper.ts`)**。日后
 * 整对外迁到 `packages/kernel-adaptors/codex` 时搬那两件,spine 上的中立契约不动。
 *
 * 「组装一轮」(systemPrompt/charter/persona/model)由编排层 `composeTurnRequest`
 * 提供;本内核只负责 codex 执行面。复用 `spawnJsonl`(自动 merge process.env)。
 *
 * 基线(headless · 不接 SDK):无优雅 mid-turn;`cancel`/`interrupt` = 杀进程。
 * 无 per-tool 权限回调(走 sandbox/approval 模式)→ requestPermission 不接。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelModelCatalog,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { CodexNativeCheckpoint } from './codex-native-checkpoint';
import { CODEX_KERNEL_PROFILE } from './kernel-profile';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { runCapture } from '../lib/node-spawn';
import { spawnJsonl, scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { issueToken, revokeToken } from './cred-proxy';
import { sidecarSpawnJsonl, materializeEnv, stripModelKeys } from './sidecar-spawn';
import { ensureSidecar } from './sidecar-singleton';
import { sidecarEnabled } from './kernel-mode';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import {
  buildCodexAppServerGlobalArgs,
  buildCodexAppServerTurnInput,
  buildCodexArgs,
  resolveCodexModelEffort,
  type CodexModelMetadata,
  CODEX_DEFAULT_PERMISSION_MODE,
  CODEX_DRIVER_LABEL,
  CODEX_FALLBACK_MODELS,
  CODEX_SUPPORTED_PERMISSION_MODES,
  createCodexMapperState,
  ensureCodexHooksConfig,
  flushCodexMapper,
  mapCodexEvent,
  toCodexAppServerPermission,
  type CodexRawEvent,
} from './codex-profile';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { evaluateSettingsRules, loadSettingsPermissionRules } from '../api/lib/permission-settings';
import { clampMode } from './permission-config';
import { CodexAppServerClient, type ServerRequest } from './codex-appserver-client';
import {
  AppServerUnavailable,
  KernelEventQueue,
  classifyApproval,
  classifyElicitation,
  createCodexNotifState,
  mapCodexNotification,
} from './codex-appserver';
import {
  materializeForgeaxToolsRuntime,
  type ForgeaxToolsRuntime,
} from './mcp/forgeax-tools-runtime';
import {
  assertCodexMcpSupported,
  buildCodexMcpOverrides,
  CODEX_MCP_SERVER_KEY,
  CodexMcpError,
} from './codex-mcp';
import { codexHomeKey, codexHomeMutex, codexWorkingDirectory, codexSessionHomePath, codexNativeSourceFingerprint, ensureCodexSessionHome } from './codex-session-home';
import { HISTORY_RESYNC_REQUIRED_MESSAGE } from './history-resync';
import { registerAsk, type AskHandle } from '../core/ask-user-registry';

/** Emit a structured turn failure (the neutral spine has no codex_mcp_* code, so
 *  the machine code rides in the `protocol` message prefix). Keeps the B5
 *  invariant: turn.usage precedes turn.done. */
function* codexMcpFailure(message: string): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message } };
  yield { kind: 'turn.done', reason: 'error' };
}

function* codexCancelled(): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'turn.done', reason: 'cancelled' };
}

function hasCodexMcpTools(req: TurnRequest): boolean {
  return req.tools?.some((tool) => tool.name !== 'ask_user') ?? false;
}

function askUserDynamicTools(req: TurnRequest): Array<Record<string, unknown>> | undefined {
  const tool = req.tools?.find((candidate) => candidate.name === 'ask_user');
  if (!tool) return undefined;
  return [{
    type: 'function',
    name: tool.name,
    description: tool.description ?? 'Ask the user one to three blocking questions.',
    inputSchema: tool.inputSchema ?? { type: 'object' },
  }];
}

function codexHistoryMode(req: TurnRequest): string {
  return (req.historyPlan as { mode?: string } | undefined)?.mode ?? 'snapshot';
}

function* codexHistoryResumeFailure(): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE } };
  yield { kind: 'turn.done', reason: 'error' };
}

export type CodexTurnTransport = 'app-server' | 'exec';

export interface CodexKernelOptions {
  readonly onTransportSelected?: (transport: CodexTurnTransport) => void;
}

export class CodexKernel implements AgentKernel {
  private static readonly instances = new Set<CodexKernel>();

  static async closeAppServerPool(): Promise<void> {
    await Promise.all([...CodexKernel.instances].map((kernel) => kernel.closeAppServers()));
  }
  constructor(private readonly options: CodexKernelOptions = {}) {
    CodexKernel.instances.add(this);
  }

  readonly id = 'codex';
  readonly displayName = CODEX_DRIVER_LABEL;
  readonly orchestrationProfile = CODEX_KERNEL_PROFILE;
  readonly fallbackModels = CODEX_FALLBACK_MODELS;
  readonly permissionCapabilities = {
    supported: CODEX_SUPPORTED_PERMISSION_MODES,
    defaultMode: CODEX_DEFAULT_PERMISSION_MODE,
  } as const;
  readonly capabilities: KernelCapabilities = {
    // `codex exec --json` 的 agent_message 是整段(item.completed),非 token 级流式。
    streaming: false,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
    forkExtract: false,
  };

  private binaryPromise?: Promise<string>;
  private versionPromise?: Promise<string>;
  /** threadId → codex thread_id(exec 路径:收到 thread.started 后记下,用于 exec resume)。 */
  private modelMetadata: CodexModelMetadata[] = [];
  private readonly threadIdMap = new Map<string, string>();
  /** threadId → codex app-server thread id(app-server 路径:thread/start 后记下,用于 thread/resume)。 */
  private readonly compactionTrackers = new Map<string, CodexCompactionTracker>();
  private readonly appThreadIdMap = new Map<string, string>();
  /** Logical sessions prewarmed by this kernel must resume on the same live
   * app-server. Keeping this owner identity prevents a prewarmed empty native
   * thread from being silently replaced by a second process. */
  private readonly appThreadOwnerMap = new Map<string, CodexAppServerClient>();
  /** ForgeaX MCP runtimes are process-owned too; retain them with the native
   * app-server and clean them only when that owner is closed or replaced. */
  private readonly appThreadRuntimeMap = new Map<string, ForgeaxToolsRuntime>();
  /** App-server process configuration is immutable after spawn. Do not reuse
   * an owner when the next turn changes its model, permission, identity or
   * advertised tool schemas. */
  private readonly appThreadConfigMap = new Map<string, string>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'CODEX_CLI_PATH',
      defaultBinary: 'codex',
    }));
  }

  /** Cached `codex --version` line (for the MCP capability gate). Empty on error
   *  → treated as unsupported by the gate (fail-closed for a tools turn). */
  private version(): Promise<string> {
    return (this.versionPromise ??= (async () => {
      try {
        const { stdout } = await runCapture(await this.binary(), ['--version']);
        return stdout.trim().split('\n')[0] ?? '';
      } catch {
        return '';
      }
    })());
  }

  private async closeAppServers(): Promise<void> {
    const clients = [...new Set(this.appThreadOwnerMap.values())];
    const runtimes = [...this.appThreadRuntimeMap.values()];
    this.appThreadOwnerMap.clear();
    this.appThreadIdMap.clear();
    this.compactionTrackers.clear();
    this.appThreadRuntimeMap.clear();
    this.appThreadConfigMap.clear();
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(runtimes.map((runtime) => runtime.cleanup()));
  }

  /** Retire one logical session's native owner and every process-owned MCP
   * runtime attached to it. A dead app-server still needs this cleanup: its
   * child MCP process may outlive the parent and the maps otherwise make the
   * next prewarm look like a clean replacement. */
  private async retireAppOwner(tid: string): Promise<void> {
    const owner = this.appThreadOwnerMap.get(tid);
    const runtime = this.appThreadRuntimeMap.get(tid);
    this.appThreadOwnerMap.delete(tid);
    this.appThreadIdMap.delete(tid);
    this.appThreadRuntimeMap.delete(tid);
    this.appThreadConfigMap.delete(tid);
    const closeOwner = typeof (owner as { close?: unknown } | undefined)?.close === 'function'
      ? (owner as CodexAppServerClient).close()
      : undefined;
    await Promise.all([closeOwner, runtime?.cleanup()]);
  }

  private appServerConfigKey(req: TurnRequest): string {
    const value = {
      threadId: req.session.threadId?.trim() || '',
      nativeSources: codexNativeSourceFingerprint(),
      agentId: req.session.agentId?.trim() || 'forge',
      hostSessionId: req.hostSessionId?.trim() || '',
      model: req.model?.trim() || '',
      permissionMode: req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE,
      trustTier: req.trustTier ?? 'own',
      workingDirectory: codexWorkingDirectory(req),
      charter: req.systemPrompt.charter,
      persona: req.systemPrompt.persona,
      tools: (req.tools ?? []).map((tool) => ({
        name: tool.name,
        capabilityId: tool.capabilityId,
        capabilityGeneration: tool.capabilityGeneration,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
    try {
      return JSON.stringify(value);
    } catch {
      // Tool schemas are expected to be JSON values. A non-serializable schema
      // must never widen reuse; a unique key forces a conservative replacement
      // instead of sharing the old process or restoring a checkpoint.
      return `unserializable:${randomUUID()}`;
    }
  }

  /** The composer may send a delta/none lane only after this kernel has
   * observed a resumable native thread in this process. */
  private compactionTracker(threadId: string): CodexCompactionTracker {
    let tracker = this.compactionTrackers.get(threadId);
    if (!tracker) { tracker = new CodexCompactionTracker(); this.compactionTrackers.set(threadId, tracker); }
    return tracker;
  }

  async compactNativeHistory(threadId: string, onStatus: (status: CompactionStatus) => void): Promise<void> {
    const owner = this.appThreadOwnerMap.get(threadId);
    const nativeId = this.appThreadIdMap.get(threadId);
    if (!owner?.alive || !nativeId) throw new Error('Native context is not connected. Continue this conversation before compacting.');
    await compactCodexThread(owner, nativeId, this.compactionTracker(threadId), onStatus);
  }

  hasNativeHistoryResume(threadId: string): boolean {
    const tid = threadId.trim();
    return Boolean(tid && (this.threadIdMap.has(tid)
      || (this.appThreadIdMap.has(tid) && this.appThreadOwnerMap.get(tid)?.alive)));
  }

  async restoreNativeHistory(req: TurnRequest): Promise<void> {
    // Restore only an explicitly owned completed thread, never discover an
    // arbitrary recent rollout or start a new model conversation here.
    try {
      await this.prewarm(req, { resumeOnly: true });
    } catch {
      // No confirmed native owner: the coordinator retains authoritative
      // snapshot recovery, including when the control plane cannot start.
    }
  }

  /**
   * Start the app-server/thread control plane without submitting a model turn.
   * This is deliberately an explicit lifecycle operation: an exec-owned
   * logical session is not migrated until a real snapshot turn is composed.
   */
  async prewarm(req: TurnRequest, options: { resumeOnly?: boolean } = {}): Promise<{ warmed: boolean; reused: boolean }> {
    if (req.trustTier === 'imported') return { warmed: false, reused: false };
    const tid = req.session.threadId?.trim();
    if (!tid) return { warmed: false, reused: false };
    if (this.threadIdMap.has(tid) && this.appThreadIdMap.has(tid)) {
      this.threadIdMap.delete(tid);
      await this.retireAppOwner(tid);
      return { warmed: false, reused: false };
    }
    if (this.threadIdMap.has(tid) && !this.appThreadIdMap.has(tid)) {
      return { warmed: false, reused: false };
    }
    const configKey = this.appServerConfigKey(req);
    const existing = this.appThreadOwnerMap.get(tid);
    if (existing?.alive && this.appThreadConfigMap.get(tid) === configKey) {
      return { warmed: true, reused: true };
    }
    if (existing || this.appThreadIdMap.has(tid) || this.appThreadRuntimeMap.has(tid)) {
      await this.retireAppOwner(tid);
      if (!options.resumeOnly) return { warmed: false, reused: false };
    }
    const checkpoint = new CodexNativeCheckpoint(codexSessionHomePath(codexHomeKey(req)), configKey);
    const resumeId = options.resumeOnly ? checkpoint.read() : undefined;
    if (options.resumeOnly && !resumeId) return { warmed: false, reused: false };
    const binary = await this.binary();
    const workingDirectory = codexWorkingDirectory(req);
    const hooksActive = ensureCodexHooksConfig(workingDirectory);
    const env: Record<string, string> = {};
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    if (hooksActive) {
      env.FORGEAX_SERVER_URL = `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? '18900'}`;
      env.FORGEAX_SID = req.hostSessionId?.trim() || tid;
      env.FORGEAX_AGENT = req.session.agentId?.trim() || 'forge';
      env.FORGEAX_KERNEL = 'codex';
    }
    let runtime: ForgeaxToolsRuntime | undefined;
    const mcpTools = req.tools?.filter((tool) => tool.name !== 'ask_user') ?? [];
    if (mcpTools.length > 0) {
      runtime = await materializeForgeaxToolsRuntime({ ...req, tools: mcpTools }, { runtimeId: req.callId || tid });
      Object.assign(env, runtime!.env);
    }
    const homeKey = codexHomeKey(req);
    const releaseHome = await codexHomeMutex.acquire(homeKey);
    let client: CodexAppServerClient | undefined;
    try {
      env.CODEX_HOME = await ensureCodexSessionHome(homeKey, { workingDirectory });
      client = new CodexAppServerClient({
        binary,
        cwd: workingDirectory,
        env,
        globalArgs: buildCodexAppServerGlobalArgs(
          hooksActive,
          runtime ? buildCodexMcpOverrides(runtime) : [],
        ),
        onServerRequest: () => { throw new Error('codex prewarm received a server request without an active turn'); },
        onNotification: () => { /* readiness is tracked by the client */ },
        onExit: () => { /* the next turn observes a dead owner */ },
      });
      await client.ensureStarted();
      const sp = req.systemPrompt;
      const developerInstructions = sp.persona?.trim()
        ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
        : sp.charter;
      const started = await client.request(resumeId ? 'thread/resume' : 'thread/start', {
        ...(resumeId ? { threadId: resumeId } : {}),
        cwd: workingDirectory,
        ...toCodexAppServerPermission(req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE),
        ...(developerInstructions?.trim() ? { developerInstructions } : {}),
        ...(req.model?.trim() ? { model: req.model.trim() } : {}),
        ...(askUserDynamicTools(req) ? { dynamicTools: askUserDynamicTools(req) } : {}),
        ephemeral: false,
      }) as { thread?: { id?: string } };
      const nativeId = started.thread?.id;
      if (!nativeId || (resumeId && nativeId !== resumeId)) throw new Error('codex native thread identity was not confirmed');
      if (hasCodexMcpTools(req)) {
        const readiness = await client.waitForThreadMcpServers(nativeId, [CODEX_MCP_SERVER_KEY]);
        if (!readiness.ready) throw new Error('codex prewarm ForgeaX tools are not ready');
      }
      this.appThreadIdMap.set(tid, nativeId);
      this.appThreadOwnerMap.set(tid, client);
      this.appThreadConfigMap.set(tid, configKey);
      if (runtime) this.appThreadRuntimeMap.set(tid, runtime);
      this.threadIdMap.delete(tid);
      return { warmed: true, reused: false };
    } catch (error) {
      client?.shutdown();
      await runtime?.cleanup();
      if (options.resumeOnly) {
        checkpoint.clear();
        return { warmed: false, reused: false };
      }
      throw error;
    } finally {
      releaseHome();
    }
  }

  /** 真实模型目录:app-server JSON-RPC `model/list`(TUI /model 同源)。
   *  一次性 client:initialize 握手 → model/list → SIGTERM;失败/超时 → 编排层
   *  降级 last-known → fallbackModels。
   *
   *  超时兜底(与 cc/cbc/cursor 探针同构):`CodexAppServerClient` 只在收到应答或
   *  子进程 `exit` 时才结算 request——若 app-server 起来了却**挂住不回**(hang,
   *  非 crash),`await` 会永不返回,`finally` 的 shutdown 也永不执行,泄漏子进程 +
   *  把这个悬挂 promise 钉进 `catalogCache`,后续 codex `/model` 全部一起卡死。
   *  故用超时竞速:到点 `shutdown()`(SIGTERM → exit handler reject 在飞 request)
   *  并 reject,让降级链正常接手。 */
  async listModels(): Promise<KernelModelCatalog> {
    const TIMEOUT_MS = 15_000;
    const client = new CodexAppServerClient({
      binary: await this.binary(),
      cwd: defaultProjectRoot(),
      globalArgs: buildCodexAppServerGlobalArgs(),
      onServerRequest: () => ({}),
      onNotification: () => { /* 目录探测不消费通知 */ },
    });
    const work = (async (): Promise<KernelModelCatalog> => {
      await client.ensureStarted();
      const res = await client.request('model/list', {}) as {
        models?: Array<CodexModelMetadata & { displayName?: string; name?: string; description?: string }>;
        data?: Array<CodexModelMetadata & { displayName?: string; name?: string }>;
      };
      const rows = Array.isArray(res?.models) ? res.models : Array.isArray(res?.data) ? res.data : [];
      this.modelMetadata = rows;
      const models = rows
        .map((m) => {
          const id = (m.id ?? m.model ?? '').trim();
          if (!id) return null;
          const label = (m.displayName ?? m.name ?? '').trim();
          return { id, ...(label && label !== id ? { label } : {}) };
        })
        .filter((m): m is { id: string; label?: string } => m !== null);
      return { models, source: 'kernel' };
    })();
    // 若超时先赢,work 稍后可能因 exit-handler reject 而拒绝——吞掉避免 unhandledRejection。
    work.catch(() => { /* race/finally 已统一收口 shutdown */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            client.shutdown();
            reject(new Error(`codex app-server model/list timed out after ${TIMEOUT_MS}ms`));
          }, TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      client.shutdown();
    }
  }

  /**
   * 一轮:**PRIMARY = app-server(有 per-tool 审批)**,起不来则回退到 **exec(无审批)**。
   *  - app-server 仅对 **非 imported** trust 启用 —— imported pack 走 exec 路径以保留凭据地板
   *    (sidecar/cred-proxy:模型 key 不入不可信子进程);app-server 是持久直 spawn,真 key 在
   *    其 env,只给可信轮。
   *  - fallback 必须在 yield 任何事件**之前**判定(AppServerUnavailable 在 ensureStarted 抛),
   *    否则会半截重跑。 */
  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // Every dispatched host turn can advance its ledger cursor, including
    // admission failures and exec fallback. Invalidate before either path.
    new CodexNativeCheckpoint(codexSessionHomePath(codexHomeKey(req), {
      nativeCapabilities: req.trustTier !== 'imported',
    }), '').clear();
    // Do not probe the binary, validate provider capability, materialize MCP,
    // acquire a session home, or spawn app-server/exec after cancellation was
    // already requested.  This is the public cold-turn cancellation contract.
    if (signal.aborted) {
      yield { kind: 'turn.usage' };
      yield { kind: 'turn.done', reason: 'cancelled' };
      return;
    }

    let reasoningEffort: string | undefined;
    const selectedModel = req.model?.trim();
    if (selectedModel) {
      try {
        if (!this.modelMetadata.some((row) => row.id === selectedModel || row.model === selectedModel)) await this.listModels();
        reasoningEffort = resolveCodexModelEffort(selectedModel, this.modelMetadata);
      } catch (error) {
        yield { kind: 'turn.usage' };
        yield { kind: 'error', error: { code: 'protocol', message: `model_capability_unavailable: ${(error as Error).message}` } };
        yield { kind: 'turn.done', reason: 'error' };
        return;
      }
      if (signal.aborted) {
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }
    }

    // 版本能力闸(plan §5.5):有工具轮但 codex 版本低于底线 → 明确失败,不静默丢工具。
    // 空工具轮任何版本放行。两条执行路径统一在此判定,fallback 也不会绕过。
    const hasTools = (req.tools?.length ?? 0) > 0;
    if (hasTools) {
      try {
        assertCodexMcpSupported(await this.version(), true);
      } catch (e) {
        if (e instanceof CodexMcpError) {
          yield* codexMcpFailure(`${e.code}: ${e.message}`);
          return;
        }
        throw e;
      }
    }

    if (req.trustTier !== 'imported') {
      const tid = req.session.threadId?.trim();
      const historyMode = codexHistoryMode(req);
      const hasExecOwner = Boolean(tid && this.threadIdMap.has(tid));
      const hasAppOwner = Boolean(tid && this.appThreadIdMap.has(tid));
      const appOwner = tid ? this.appThreadOwnerMap.get(tid) : undefined;
      // Delta/none are valid only while the process-local native owner that
      // produced the cursor is still available. Do not replace an exec owner
      // with a blank app-server thread and silently lose its context.
      if (
        historyMode !== 'snapshot'
        && tid
        && hasAppOwner
        && (hasExecOwner || !appOwner?.alive)
      ) {
        this.threadIdMap.delete(tid);
        await this.retireAppOwner(tid);
        yield* codexHistoryResumeFailure();
        return;
      }
      if (historyMode !== 'snapshot' && tid && hasExecOwner && !hasAppOwner) {
        yield* this.runTurnExec(req, signal, reasoningEffort);
        return;
      }
      try {
        yield* this.runTurnAppServer(req, signal, reasoningEffort);
        return;
      } catch (e) {
        if (!(e instanceof AppServerUnavailable)) throw e;
        if (req.tools?.some((tool) => tool.name === 'ask_user')) {
          yield* codexMcpFailure(
            `codex_appserver_required: Ask User requires Codex app-server's timeout-free dynamic tool channel; refusing finite MCP fallback: ${(e as Error).message}`,
          );
          return;
        }
        if (hasAppOwner && historyMode !== 'snapshot') {
          this.threadIdMap.delete(tid!);
          await this.retireAppOwner(tid!);
          yield* codexHistoryResumeFailure();
          return;
        }
        if (historyMode === 'snapshot' && tid) {
          this.threadIdMap.delete(tid);
          await this.retireAppOwner(tid);
        }
        // app-server transport 起不来 → 回退 exec。fallback **必须携带同一套 MCP 工具**
        // (exec 路径会重新 materialize runtime),禁止退化成「无工具继续回答」(plan §6.2)。
        // eslint-disable-next-line no-console
        console.warn(`[codex] app-server unavailable, falling back to exec (keeps same MCP tools): ${(e as Error).message}`);
      }
    }
    yield* this.runTurnExec(req, signal, reasoningEffort);
  }

  /** PRIMARY:`codex app-server`(JSON-RPC),审批 server-request 接到中立
   *  `req.requestPermission`(= Studio 审批卡)。app-server 所有 codex-isms 在
   *  codex-appserver.ts;本方法只编排 client 生命周期 + thread/turn。 */
  private async *runTurnAppServer(req: TurnRequest, signal: AbortSignal, reasoningEffort?: string): AsyncIterable<KernelEvent> {
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) CodexKernel.inflight.set(req.callId, ac);

    const binary = await this.binary();
    const projectRoot = defaultProjectRoot();
    const workingDirectory = codexWorkingDirectory(req);
    // settings.permissions 拦截面(046 楔子3):工作区静态 hooks.json(PreToolUse 全量
    // 拦截,补 approval 只覆盖「codex 主动问」的缺口)。app-server 是 per-turn 进程
    // (finally shutdown)→ FORGEAX_* 上下文经 env 注入安全,hook 脚本据此回调
    // /:sid/hook-gate。用户自跑 codex 无 FORGEAX env → hook 零干预。
    const hooksActive = ensureCodexHooksConfig(workingDirectory);
    const env: Record<string, string> = {};
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    if (hooksActive) {
      env.FORGEAX_SERVER_URL = `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? '18900'}`;
      env.FORGEAX_SID = req.hostSessionId?.trim() || req.session.threadId?.trim() || '';
      env.FORGEAX_AGENT = req.session.agentId?.trim() || 'forge';
      env.FORGEAX_KERNEL = 'codex';
    }

    // fxt MCP runtime(本轮工具)。materialize 失败 = fail-closed(plan §6.3),不回退 exec
    // (exec 也会同样失败),直接结构化报错收尾。runtime.env(FORGEAX_* + specs + expose)
    // 合并进 codex 进程 env → codex 起的 MCP 子进程继承(secrets/context 走 env 不走 argv)。
    let runtime: ForgeaxToolsRuntime | undefined;
    const mcpTools = req.tools?.filter((tool) => tool.name !== 'ask_user') ?? [];
    if (mcpTools.length > 0) {
      try {
        runtime = await materializeForgeaxToolsRuntime({ ...req, tools: mcpTools }, {
          runtimeId: req.callId || req.hostSessionId || req.session.threadId || 'codex-appserver',
        });
      } catch (e) {
        if (req.callId) CodexKernel.inflight.delete(req.callId);
        yield* codexMcpFailure(`codex_mcp_materialize_failed: ${(e as Error).message}`);
        return;
      }
    }
    if (runtime) Object.assign(env, runtime.env);
    const mcpOverrides = runtime ? buildCodexMcpOverrides(runtime) : [];
    const globalArgs = buildCodexAppServerGlobalArgs(hooksActive, mcpOverrides);
    const tid = req.session.threadId?.trim();
    const configKey = this.appServerConfigKey(req);

    // 稳定隔离 CODEX_HOME + keyed mutex(plan §8):同一逻辑 session 跨 turn 复用目录
    // (thread resume 不丢),同 home 串行(防 SQLite lock / session 损坏)。
    const homeKey = codexHomeKey(req);
    const releaseHome = await codexHomeMutex.acquire(homeKey);
    let homeReleased = false;
    const releaseHomeOnce = () => { if (!homeReleased) { homeReleased = true; releaseHome(); } };
    try {
      env.CODEX_HOME = await ensureCodexSessionHome(homeKey, { nativeCapabilities: req.trustTier !== 'imported', workingDirectory });
    } catch (e) {
      releaseHomeOnce();
      await runtime?.cleanup();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      yield* codexMcpFailure(`codex_mcp_start_failed: session home unavailable: ${(e as Error).message}`);
      return;
    }

    let existingOwner = tid ? this.appThreadOwnerMap.get(tid) : undefined;
    if (tid && existingOwner?.alive && this.appThreadIdMap.has(tid)) {
      if (this.appThreadConfigMap.get(tid) !== configKey) {
        if (codexHistoryMode(req) !== 'snapshot') {
          await runtime?.cleanup();
          releaseHomeOnce();
          if (req.callId) CodexKernel.inflight.delete(req.callId);
          yield* codexHistoryResumeFailure();
          return;
        }
        await this.retireAppOwner(tid);
        existingOwner = undefined;
      }
    } else if (tid && existingOwner && !existingOwner.alive) {
      // Preserve a persisted native thread id so a snapshot turn can resume it
      // in a replacement process, but reclaim the dead owner's process/runtime.
      const staleRuntime = this.appThreadRuntimeMap.get(tid);
      this.appThreadOwnerMap.delete(tid);
      this.appThreadRuntimeMap.delete(tid);
      const closeOwner = typeof (existingOwner as { close?: unknown }).close === 'function'
        ? existingOwner.close()
        : undefined;
      await Promise.all([closeOwner, staleRuntime?.cleanup()]);
      existingOwner = undefined;
    }

    const queue = new KernelEventQueue();
    const notifState = createCodexNotifState(this.compactionTracker(tid ?? req.callId ?? randomUUID()));
    const activeAskHandles = new Map<AskHandle, string>();

    // 审批 server-request:settings.permissions 规则先行(046 楔子3:deny 即拒 /
    // allow 即批 / ask 强制走卡),未命中 → 中立 requestPermission(= Studio 审批卡),
    // 都没有 → 默认放行(headless --force 类比,原基线)。
    const handleServerRequest = async (rpc: ServerRequest): Promise<unknown> => {
      if (rpc.method === 'item/tool/call') {
        const p = (rpc.params ?? {}) as Record<string, unknown>;
        if (p.namespace == null && p.tool === 'ask_user' && askUserDynamicTools(req)) {
          const callId = typeof p.callId === 'string' && p.callId
            ? p.callId
            : `ask-${String(rpc.id)}`;
          const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
          const sid = req.hostSessionId?.trim() || req.session.threadId?.trim() || '';
          const agent = req.session.agentId?.trim() || 'forge';
          const handle = registerAsk({
            sid, agentPath: agent, instanceId: `codex:${tid ?? sid}:${agent}`,
            runtimeEpochId: tid ?? sid, requestId: randomUUID(),
          }, 0);
          queue.push({ kind: 'tool.call', callId, name: 'ask_user',
            args: { ...args, _askRequestId: handle.requestId } });
          activeAskHandles.set(handle, callId);
          try {
            const answers = await handle.promise;
            if (answers === null) {
              queue.push({ kind: 'tool.result', callId, name: 'ask_user', ok: false, error: 'Ask User was interrupted.' });
              return { contentItems: [{ type: 'inputText', text: 'Ask User was interrupted.' }], success: false };
            }
            const result = JSON.stringify({ ok: true, questions: answers });
            queue.push({ kind: 'tool.result', callId, name: 'ask_user', ok: true, result });
            return { contentItems: [{ type: 'inputText', text: result }], success: true };
          } finally {
            activeAskHandles.delete(handle);
            handle.dispose();
          }
        }
        throw new Error(`unsupported codex dynamic tool: ${String(p.namespace ?? '')}/${String(p.tool ?? '')}`);
      }
      // MCP elicitation(server 向 client 要表单/URL):fxt 不主动发,但 client 仍须显式
      // decline/cancel 不支持的 elicitation,且**绝不**把它误判为「用户已批准」(plan §9.3)。
      const elicit = classifyElicitation(rpc.method);
      if (elicit) {
        // eslint-disable-next-line no-console
        console.warn(`[codex] declining unsupported MCP elicitation: ${rpc.method} (id=${String(rpc.id)})`);
        return elicit.reply;
      }
      const cls = classifyApproval(rpc.method);
      if (!cls) throw new Error(`unhandled codex server-request: ${rpc.method}`);
      const p = (rpc.params ?? {}) as any;
      const command = cls.tool === 'Bash'
        ? (typeof p.command === 'string' ? p.command : Array.isArray(p.command) ? p.command.join(' ') : (p.reason ?? 'run command'))
        : (p.reason ?? 'apply file changes');
      const verdict = evaluateSettingsRules(loadSettingsPermissionRules(projectRoot), cls.tool, { command });
      let allow = true; // 无规则命中且无 requestPermission 闸 → 放行(与 exec sandbox 基线一致)。
      if (verdict?.behavior === 'deny') {
        allow = false;
      } else if (verdict?.behavior === 'allow') {
        allow = true;
      } else if (req.requestPermission) {
        const decision = await req.requestPermission({ name: cls.tool, args: { command, ...p } });
        allow = decision.behavior === 'allow';
      } else if (verdict?.behavior === 'ask') {
        // 用户显式要求 ask,但编排层没给 requestPermission 闸 → 无人可问,fail-closed。
        allow = false;
      }
      // v1 方法用 ReviewDecision(approved/denied);v2 用 accept/decline。
      return cls.v1 ? { decision: allow ? 'approved' : 'denied' } : { decision: allow ? 'accept' : 'decline' };
    };

    let client: CodexAppServerClient;
    const closeCompaction = (phase: 'failed' | 'cancelled'): void => {
      for (const status of notifState.compaction.finish(phase)) {
        queue.push({ kind: 'stored-event', payload: { type: 'compaction.status', ts: Date.now(), payload: status } });
      }
    };
    const onExit = (code: number | null, tail: string): void => {
      if (!notifState.ended) {
        closeCompaction('failed');
        queue.push({ kind: 'turn.usage' });
        queue.push({ kind: 'error', error: { code: 'protocol', message: `codex app-server exited ${code}${tail ? ': ' + tail : ''}` } });
        queue.push({ kind: 'turn.done', reason: 'error' });
        notifState.ended = true;
      }
      if (tid && this.appThreadOwnerMap.get(tid) === client) {
        this.appThreadOwnerMap.delete(tid);
        this.appThreadIdMap.delete(tid);
        this.appThreadConfigMap.delete(tid);
        const ownerRuntime = this.appThreadRuntimeMap.get(tid);
        this.appThreadRuntimeMap.delete(tid);
        void ownerRuntime?.cleanup();
      }
      queue.end();
    };
    const turnHandlers = {
      onNotification: (m: string, params: any) => mapCodexNotification(m, params, notifState, queue),
      onServerRequest: handleServerRequest,
      onExit,
    };
    const reuseOwner = Boolean(
      existingOwner?.alive
        && tid
        && this.appThreadIdMap.has(tid)
        && this.appThreadConfigMap.get(tid) === configKey,
    );
    let ownsClient = true;
    if (reuseOwner) {
      client = existingOwner!;
      client.setTurnHandlers(turnHandlers);
      ownsClient = false;
    } else {
      client = new CodexAppServerClient({
        binary,
        cwd: workingDirectory,
        env,
        // globalArgs 注入在 `app-server` 子命令之前：默认关闭 Codex 原生多 Agent；
        // hooksActive → --dangerously-bypass-hook-trust；有工具轮 → 注册本轮 fxt MCP。
        globalArgs,
        ...turnHandlers,
      });
    }

    let activeCodexThreadId: string | undefined;
    let activeCodexTurnId: string | undefined;
    const interruptActiveTurn = (): void => {
      if (!activeCodexThreadId || !activeCodexTurnId) return;
      void client.request('turn/interrupt', {
        threadId: activeCodexThreadId,
        turnId: activeCodexTurnId,
      }, 5_000).catch(() => undefined);
    };
    const onAbort = () => {
      // Keep ask identities until the terminal drain publishes their results.
      // app-server owners are intentionally reused across turns. Ending only
      // this turn's local queue would leave the native turn running and let
      // its model/MCP work bleed into the next logical turn.
      interruptActiveTurn();
      if (!notifState.ended) {
        closeCompaction('cancelled');
        queue.push({ kind: 'turn.done', reason: 'cancelled' });
        notifState.ended = true;
      }
      queue.end();
    };
    if (ac.signal.aborted) onAbort();
    else ac.signal.addEventListener('abort', onAbort, { once: true });

    // 起不来 → 抛 AppServerUnavailable(在 yield 任何事件前),让 runTurn 回退 exec。
    // 回退前必须释放 home mutex 且清理本轮 runtime——exec fallback 会重新 acquire + materialize
    // (携带同一套 MCP 工具),不能持锁/漏临时文件。
    try {
      await client.ensureStarted();
    } catch (e) {
      ac.signal.removeEventListener('abort', onAbort);
      if (ownsClient) client.shutdown();
      if (tid && this.appThreadOwnerMap.get(tid) === client) {
        this.appThreadOwnerMap.delete(tid);
        this.appThreadIdMap.delete(tid);
      }
      releaseHomeOnce();
      await runtime?.cleanup();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      throw new AppServerUnavailable((e as Error).message);
    }
    if (ac.signal.aborted) {
      yield* codexCancelled();
      ac.signal.removeEventListener('abort', onAbort);
      if (ownsClient) client.shutdown();
      releaseHomeOnce();
      await runtime?.cleanup();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      return;
    }
    this.options.onTransportSelected?.('app-server');

    try {
      const historyMode = codexHistoryMode(req);
      const appServerPermission = toCodexAppServerPermission(
        req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE,
      );
      let codexThreadId = tid ? this.appThreadIdMap.get(tid) : undefined;
      const startFresh = async (): Promise<string | undefined> => {
        if (ac.signal.aborted) return undefined;
        // systemPrompt(charter+persona)由编排层 composeTurnRequest 提供;app-server
        // 经 thread 的 developerInstructions 注入(不碰仓内 AGENTS.md)。模型同 exec:
        // 经中立 TurnRequest.model 透传,不再走 CODEX_MODEL env 特例。
        const sp = req.systemPrompt;
        const developerInstructions = sp.persona?.trim()
          ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
          : sp.charter;
        const model = req.model?.trim() || undefined;
        const res = await client.request('thread/start', {
          cwd: workingDirectory,
          ...toCodexAppServerPermission(req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE),
          ...(developerInstructions?.trim() ? { developerInstructions } : {}),
          ...(model ? { model } : {}),
          ...(askUserDynamicTools(req) ? { dynamicTools: askUserDynamicTools(req) } : {}),
          ephemeral: false,
        });
        return res?.thread?.id;
      };

      if (codexThreadId && this.appThreadOwnerMap.get(tid ?? '') === client) {
        // A prewarmed native thread is already owned by this live client; a
        // second thread/resume would race its process-local state.
      } else if (codexThreadId) {
        try {
          await client.request('thread/resume', {
            threadId: codexThreadId,
            ...(askUserDynamicTools(req) ? { dynamicTools: askUserDynamicTools(req) } : {}),
          });
        } catch {
          if (ac.signal.aborted) {
            yield* codexCancelled();
            return;
          }
          codexThreadId = await startFresh();
        }
      } else {
        codexThreadId = await startFresh();
      }
      if (ac.signal.aborted) {
        yield* codexCancelled();
        return;
      }
      if (codexThreadId && tid) this.appThreadIdMap.set(tid, codexThreadId);
      activeCodexThreadId = codexThreadId;
      if (!codexThreadId) {
        yield { kind: 'turn.usage' };
        yield { kind: 'error', error: { code: 'protocol', message: 'codex thread/start returned no id' } };
        yield { kind: 'turn.done', reason: 'error' };
        return;
      }

      if (hasCodexMcpTools(req)) {
        try {
          const readiness = await client.waitForThreadMcpServers(
            codexThreadId,
            [CODEX_MCP_SERVER_KEY],
            { signal: ac.signal },
          );
          if (ac.signal.aborted) {
            yield* codexCancelled();
            return;
          }
          if (!readiness.ready) {
            yield* codexMcpFailure(
              'codex_mcp_unavailable: required fxt server did not become ready; retry without losing tool capability',
            );
            return;
          }
        } catch (error) {
          if (ac.signal.aborted) {
            yield* codexCancelled();
            return;
          }
          throw error;
        }
      }

      if (ac.signal.aborted) {
        yield* codexCancelled();
        return;
      }
      if (codexThreadId && tid && historyMode === 'snapshot') {
        this.threadIdMap.delete(tid);
      }
      const checkpoint = new CodexNativeCheckpoint(env.CODEX_HOME!, configKey);
      const turnStart = await client.request('turn/start', {
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        threadId: codexThreadId,
        sandboxPolicy: {
          type: appServerPermission.sandbox === 'danger-full-access'
            ? 'dangerFullAccess'
            : appServerPermission.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite',
        },
        approvalPolicy: appServerPermission.approvalPolicy,
        input: buildCodexAppServerTurnInput(req),
      });
      activeCodexTurnId = turnStart?.turn?.id ?? turnStart?.id;
      if (ac.signal.aborted) {
        interruptActiveTurn();
        yield* codexCancelled();
        return;
      }
      if (tid) {
        // A normal app-server turn is also a native-history owner. Retaining
        // this exact live client is what makes the next delta/none turn a
        // legitimate continuation instead of a false "no owner" resync.
        if (this.appThreadOwnerMap.get(tid) !== client) {
          const previousRuntime = this.appThreadRuntimeMap.get(tid);
          if (previousRuntime && previousRuntime !== runtime) {
            this.appThreadRuntimeMap.delete(tid);
            void previousRuntime.cleanup();
          }
          if (runtime) this.appThreadRuntimeMap.set(tid, runtime);
          else this.appThreadRuntimeMap.delete(tid);
          this.appThreadOwnerMap.set(tid, client);
        }
        this.appThreadConfigMap.set(tid, configKey);
        ownsClient = false;
      }

      for await (const ev of queue) {
        // A native turn can end while a dynamic ask is still pending. Closing
        // its handle only in finally drops the result into an ended queue and
        // leaves the UI waiting for a request the host can no longer answer.
        // Publish the terminal tool facts before the terminal turn fact.
        if (ev.kind === 'turn.done') {
          const pendingAsks = [...activeAskHandles];
          activeAskHandles.clear();
          for (const [handle] of pendingAsks) handle.dispose();
          for (const [, callId] of pendingAsks) {
            yield { kind: 'tool.result', callId, name: 'ask_user', ok: false,
              error: 'The turn ended before this question was answered.' } as KernelEvent;
          }
        }
        if (ev.kind === 'turn.done' && ev.reason === 'stop' && codexThreadId && !ac.signal.aborted) {
          checkpoint.complete(codexThreadId);
        }
        yield ev;
        if (ev.kind === 'turn.done') break;
      }
    } finally {
      for (const handle of activeAskHandles.keys()) handle.dispose();
      activeAskHandles.clear();
      ac.signal.removeEventListener('abort', onAbort);
      if (ownsClient) client.shutdown();
      if (ownsClient || (tid && this.appThreadRuntimeMap.get(tid) !== runtime)) {
        await runtime?.cleanup();
      }
      releaseHomeOnce();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
    }
  }

  /** FALLBACK:legacy 一次性 `codex exec --json`(无审批,走 sandbox)。 */
  private async *runTurnExec(req: TurnRequest, signal: AbortSignal, reasoningEffort?: string): AsyncIterable<KernelEvent> {
    this.options.onTransportSelected?.('exec');
    // 内部 AbortController:外部 signal 或 openHandle(callId).cancel 任一触发都中断。
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) CodexKernel.inflight.set(req.callId, ac);

    let credToken: string | undefined;
    let runtime: ForgeaxToolsRuntime | undefined;
    let releaseHome: (() => void) | undefined;
    try {
      const binary = await this.binary();
      const workingDirectory = codexWorkingDirectory(req);
      // settings.permissions 拦截面(046 楔子3):同 app-server 路径,工作区静态
      // hooks.json + FORGEAX_* env(exec 是 per-turn 进程,env 注入安全)。
      const hooksActive = ensureCodexHooksConfig(workingDirectory);

      // fxt MCP runtime(本轮工具)。materialize 失败 = fail-closed(plan §6.3)。
      const mcpTools = req.tools?.filter((tool) => tool.name !== 'ask_user') ?? [];
      if (mcpTools.length > 0) {
        try {
          runtime = await materializeForgeaxToolsRuntime({ ...req, tools: mcpTools }, {
            runtimeId: req.callId || req.hostSessionId || req.session.threadId || 'codex-exec',
          });
        } catch (e) {
          yield* codexMcpFailure(`codex_mcp_materialize_failed: ${(e as Error).message}`);
          return;
        }
      }
      const mcpOverrides = runtime ? buildCodexMcpOverrides(runtime) : [];
      const args = this.buildArgs(req, hooksActive, mcpOverrides, reasoningEffort);

      // 稳定隔离 CODEX_HOME + keyed mutex(plan §8):同一逻辑 session 跨 turn 复用目录
      // (exec resume 不丢),同 home 串行。
      const homeKey = codexHomeKey(req);
      releaseHome = await codexHomeMutex.acquire(homeKey);
      const codexHome = await ensureCodexSessionHome(homeKey, { nativeCapabilities: req.trustTier !== 'imported', workingDirectory });

      // 凭据地板:imported → scrub。sidecar 路径(FORGEAX_SIDECAR=on)凭据由 sidecar cred-vault
      // 发 scoped token,本进程不跑 in-process cred-proxy 且剔真 key;非 sidecar 用 server 进程内代理。
      const useSidecar = sidecarEnabled();
      // 始终注入隔离 CODEX_HOME(其余键仅覆盖,不影响 process.env 继承)。
      let envOverride: Record<string, string | undefined> = { CODEX_HOME: codexHome };
      if (req.trustTier === 'imported') {
        envOverride = { ...envOverride, ...scrubbedSecretEnv() };
        if (!useSidecar) {
          const issued = await issueToken('openai');
          if (issued) {
            credToken = issued.token;
            envOverride = { ...envOverride, OPENAI_API_KEY: issued.token, OPENAI_BASE_URL: issued.baseUrl };
          }
        }
      }
      if (hooksActive) {
        envOverride = {
          ...envOverride,
          FORGEAX_SERVER_URL: `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? '18900'}`,
          FORGEAX_SID: req.hostSessionId?.trim() || req.session.threadId?.trim() || '',
          FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
          FORGEAX_KERNEL: 'codex',
        };
      }
      // fxt runtime env(FORGEAX_* + specs + expose)合并进 codex 进程 env → codex 起的
      // MCP 子进程继承(secrets/context 走 env 不走 argv)。放最后覆盖,确保 SID/AGENT 一致。
      if (runtime) envOverride = { ...envOverride, ...runtime.env };
      const sidecarBaseId = req.callId || req.hostSessionId || req.session.threadId || req.session.agentId || 'kernel';
      const { lines, exit } = useSidecar
        ? sidecarSpawnJsonl<CodexRawEvent>(await ensureSidecar(), {
            sessionId: sidecarBaseId,
            agentId: req.session.agentId || 'forge',
            trustTier: req.trustTier ?? 'own',
            callId: sidecarBaseId,
            ...(req.budget ? { budget: req.budget } : {}),
            kernel: { kind: 'codex', credential: 'sidecar-managed', cmd: binary, args, cwd: workingDirectory, env: stripModelKeys(materializeEnv(envOverride)) },
          }, ac.signal)
        : spawnJsonl<CodexRawEvent>({
            cmd: binary,
            args,
            cwd: workingDirectory,
            signal: ac.signal,
            ...(envOverride ? { envOverride } : {}),
          });

      const tid = req.session.threadId?.trim();
      const state = createCodexMapperState();
      try {
        for await (const raw of lines) {
          for (const ev of mapCodexEvent(raw, state)) {
            yield ev;
          }
          // 首轮记下 codex thread_id 以便后续 resume(threadId ≠ codex thread_id)。
          if (tid && state.threadId && !this.threadIdMap.has(tid)) {
            this.threadIdMap.set(tid, state.threadId);
          }
        }
      } catch (streamErr) {
        if (!state.doneEmitted) {
          if (ac.signal.aborted) {
            // 取消杀进程会把读流打断成异常 —— 这是主动中断,收口为 cancelled 而非 error
            // (R4-05)。复用 flushCodexMapper 的 cancelled 分支,不手搓终态形状。
            for (const ev of flushCodexMapper(state, { code: 0, stderr: '' }, true)) yield ev;
          } else {
            yield { kind: 'turn.usage' };
            yield {
              kind: 'error',
              error: { code: 'protocol', message: `codex stream error: ${(streamErr as Error).message}` },
            };
            yield { kind: 'turn.done', reason: 'error' };
          }
        }
        return;
      }

      const exitInfo = await exit;
      // 兜底:进程退出但 mapper 从未发过终态(无 turn.completed/failed)。
      // 被取消杀进程(ac.signal.aborted)→ 收口 cancelled 而非 exit-code error。
      for (const ev of flushCodexMapper(state, exitInfo, ac.signal.aborted)) yield ev;
    } finally {
      if (credToken) revokeToken(credToken);
      await runtime?.cleanup();
      releaseHome?.();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
    }
  }

  /** 从中立 TurnRequest 拼 `codex exec [--json] ...` argv —— 委托给 codex-profile
   *  (所有 Codex-isms 在那)。resume 的 codexThreadId 由首轮 thread.started 记下。
   *  `mcpOverrides` = 本轮 fxt MCP 的 `-c` 参数(无工具轮为空)。 */
  private buildArgs(req: TurnRequest, hooksActive = false, mcpOverrides: string[] = [], reasoningEffort?: string): string[] {
    const tid = req.session.threadId?.trim();
    const codexThreadId = tid ? this.threadIdMap.get(tid) : undefined;
    // Codex exec cannot implement gated/planning because it has no approval
    // callback or read-only enforcement. Clamp only the fallback path and make
    // the downgrade visible instead of silently widening the request.
    const requested = req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE;
    const { mode, downgraded } = clampMode(
      requested,
      CODEX_SUPPORTED_PERMISSION_MODES,
      CODEX_DEFAULT_PERMISSION_MODE,
    );
    if (downgraded) {
      process.stderr.write(
        `[codex-kernel] permissionMode="${requested}" 在 codex headless 无落点(无 per-tool 闸/无只读强制),已降级为 "${mode}"。收窄请用 sandbox_mode 或 settings 规则。\n`,
      );
    }
    return buildCodexArgs(req, codexThreadId, hooksActive, mcpOverrides, mode, reasoningEffort);
  }

  openHandle(callId: string): TurnHandle {
    const kill = async (): Promise<void> => {
      CodexKernel.inflight.get(callId)?.abort();
    };
    return {
      // no-op(诚实标注):codex headless 的权限语义 = spawn 时固定的
      // `approval_policy=never` + `sandbox_mode=workspace-write`(见 codex-profile),
      // **没有 per-tool 权限闸,也没有 mid-turn control 通道**改 sandbox。因此中立
      // PermissionMode 在 codex 上无落点 —— 既不能 mid-turn 改,也无「下一轮 argv」语义
      // 上的合理映射(planning/gated 在纯 sandbox 模式下无对应)。保持 no-op,不静默假装。
      async setPermissionMode(): Promise<void> {},
      async setModel(): Promise<void> {},
      interrupt: kill,
      cancel: kill,
    };
  }

  async probe(): Promise<KernelHealth> {
    try {
      const binary = await this.binary();
      const { stdout, code } = await runCapture(binary, ['--version']);
      const out = stdout.trim().split('\n')[0] ?? '';
      const hasAuth =
        Boolean(process.env.OPENAI_API_KEY) ||
        existsSync(resolvePath(process.env.CODEX_HOME || resolvePath(homedir(), '.codex'), 'auth.json'));
      return code === 0 && hasAuth
        ? { ok: true, kernelId: this.id, detail: out || 'codex ready' }
        : {
            ok: false,
            kernelId: this.id,
            detail: !hasAuth
              ? 'OPENAI_API_KEY not set (or run codex login)'
              : `codex --version exit ${code}`,
          };
    } catch (e) {
      return { ok: false, kernelId: this.id, detail: (e as Error).message };
    }
  }
}
