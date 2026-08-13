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
import { CODEX_KERNEL_PROFILE } from './kernel-profile';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  toCodexAppServerPermission,
  CODEX_DEFAULT_PERMISSION_MODE,
  CODEX_DRIVER_LABEL,
  CODEX_FALLBACK_MODELS,
  CODEX_SUPPORTED_PERMISSION_MODES,
  createCodexMapperState,
  ensureCodexHooksConfig,
  flushCodexMapper,
  mapCodexEvent,
  type CodexRawEvent,
} from './codex-profile';
import { clampMode } from './permission-config';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { evaluateSettingsRules, loadSettingsPermissionRules } from '../api/lib/permission-settings';
import {
  CodexAppServerClient,
  type CodexAppServerOptions,
  type ServerRequest,
} from './codex-appserver-client';
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
import {
  codexHomeKey,
  codexHomeMutex,
  codexNativeSourceFingerprint,
  codexSessionNativeStdioMcpNames,
  codexSessionHomeFingerprint,
  ensureCodexSessionHome,
} from './codex-session-home';
import { CodexAppServerPool, type OwnedCodexAppServer } from './codex-appserver-pool';
import { registerAsk, type AskHandle } from '../core/ask-user-registry';

/** Emit a structured turn failure (the neutral spine has no codex_mcp_* code, so
 *  the machine code rides in the `protocol` message prefix). Keeps the B5
 *  invariant: turn.usage precedes turn.done. */
function* codexMcpFailure(message: string): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message } };
  yield { kind: 'turn.done', reason: 'error' };
}

function* historyResumeFailure(message: string): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message } };
  yield { kind: 'turn.done', reason: 'error' };
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

export type CodexTurnTransport = 'app-server' | 'exec';

export interface CodexKernelOptions {
  readonly onTransportSelected?: (transport: CodexTurnTransport) => void;
}

export class CodexKernel implements AgentKernel {
  constructor(private readonly options: CodexKernelOptions = {}) {}

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
  private readonly threadIdMap = new Map<string, string>();
  /** threadId → codex app-server thread id(app-server 路径:thread/start 后记下,用于 thread/resume)。 */
  private readonly appThreadIdMap = new Map<string, string>();
  /** A prewarmed thread is already loaded in this exact live app-server. Calling
   *  thread/resume on it before its first turn fails because it has no persisted
   *  rollout yet; retain the owner identity so the real turn uses it directly. */
  private readonly appThreadOwnerMap = new Map<string, CodexAppServerClient>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();
  private static readonly appServerPool = new CodexAppServerPool();

  static async closeAppServerPool(): Promise<void> {
    await CodexKernel.appServerPool.closeAll();
  }

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'CODEX_CLI_PATH',
      defaultBinary: 'codex',
    }));
  }

  hasNativeHistoryResume(threadId: string): boolean {
    return this.threadIdMap.has(threadId) || this.appThreadIdMap.has(threadId);
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
        models?: Array<{ id?: string; model?: string; displayName?: string; name?: string; description?: string }>;
        data?: Array<{ id?: string; model?: string; displayName?: string; name?: string }>;
      };
      const rows = Array.isArray(res?.models) ? res.models : Array.isArray(res?.data) ? res.data : [];
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

  private appServerFingerprint(req: TurnRequest, input: {
    binary: string;
    binaryVersion: string;
    home: string;
    env: Record<string, string>;
    hooksActive: boolean;
  }): string {
    const env = Object.entries(input.env)
      .filter(([name]) => name !== 'FORGEAX_TOOL_SPECS_FILE')
      // Provider secrets affect process identity, but only their one-way digest
      // is admitted to the outer process fingerprint.
      .map(([name, value]) => [
        name,
        /KEY|TOKEN|AUTH/i.test(name)
          ? createHash('sha256').update(value).digest('hex')
          : value,
      ] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify({
      binary: input.binary,
      binaryVersion: input.binaryVersion,
      home: input.home,
      nativeSourceFingerprint: codexNativeSourceFingerprint(),
      homeFingerprint: codexSessionHomeFingerprint(input.home),
      hooksActive: input.hooksActive,
      env,
      tools: req.tools.map((tool) => ({
        name: tool.name,
        capabilityId: tool.capabilityId,
        capabilityGeneration: tool.capabilityGeneration,
        description: tool.description,
        inputSchema: tool.inputSchema,
        delivery: tool.delivery,
      })),
      capabilityGeneration: req.capabilityGeneration,
    })).digest('hex');
  }

  private async acquireAppServer(
    req: TurnRequest,
    handlers: Pick<CodexAppServerOptions, 'onServerRequest' | 'onNotification' | 'onExit'>,
    signal?: AbortSignal,
  ): Promise<{
    homeKey: string;
    home: string;
    session: OwnedCodexAppServer;
    reused: boolean;
    nativeThreadInvalidated: boolean;
    releaseHome(): void;
  }> {
    const binary = await this.binary();
    const projectRoot = defaultProjectRoot();
    const hooksActive = ensureCodexHooksConfig(projectRoot);
    const env: Record<string, string> = {};
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    if (hooksActive) {
      env.FORGEAX_SERVER_URL = `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? '18900'}`;
      env.FORGEAX_SID = req.hostSessionId?.trim() || req.session.threadId?.trim() || '';
      env.FORGEAX_AGENT = req.session.agentId?.trim() || 'forge';
      env.FORGEAX_KERNEL = 'codex';
    }
    const homeKey = codexHomeKey(req);
    const releaseHome = await codexHomeMutex.acquire(homeKey);
    let homeReleased = false;
    const releaseHomeOnce = () => {
      if (homeReleased) return;
      homeReleased = true;
      releaseHome();
    };
    let runtime: ForgeaxToolsRuntime | undefined;
    try {
      if (signal?.aborted) throw new Error('codex app-server admission cancelled');
      const mcpTools = req.tools?.filter((tool) => tool.name !== 'ask_user') ?? [];
      runtime = await materializeForgeaxToolsRuntime({ ...req, tools: mcpTools }, {
        runtimeId: req.callId || req.hostSessionId || req.session.threadId || 'codex-appserver',
      });
      if (signal?.aborted) throw new Error('codex app-server admission cancelled');
      if (runtime) Object.assign(env, runtime.env);
      const globalArgs = buildCodexAppServerGlobalArgs(
        hooksActive,
        runtime ? buildCodexMcpOverrides(runtime) : [],
      );
      env.CODEX_HOME = await ensureCodexSessionHome(homeKey);
      const fingerprint = this.appServerFingerprint(req, {
        binary,
        binaryVersion: await this.version(),
        home: env.CODEX_HOME,
        env,
        hooksActive,
      });
      let candidateOwned = false;
      const acquired = await CodexKernel.appServerPool.acquire(homeKey, fingerprint, async () => {
        candidateOwned = true;
        const client = new CodexAppServerClient({
          binary,
          cwd: projectRoot,
          env,
          globalArgs,
          ...handlers,
        });
        try {
          await client.ensureStarted();
          return { client, cleanup: async () => { await runtime?.cleanup(); } };
        } catch (error) {
          // Spawn succeeded but initialize failed/timed out: the client has not
          // entered the pool yet, so this callback is the only lifecycle owner.
          await client.close();
          throw error;
        }
      });
      if (!candidateOwned) await runtime?.cleanup();
      const logicalThreadId = req.session.threadId?.trim();
      let nativeThreadInvalidated = false;
      if (logicalThreadId && this.appThreadOwnerMap.has(logicalThreadId)
        && this.appThreadOwnerMap.get(logicalThreadId) !== acquired.session.client) {
        // A fingerprint change/crash replaced the process. Its in-memory
        // thread id cannot be resumed in the new owner until Codex persisted a
        // real turn, so discard both references and start a fresh exact thread.
        this.appThreadIdMap.delete(logicalThreadId);
        this.appThreadOwnerMap.delete(logicalThreadId);
        // app-server was the authoritative owner once both mappings existed;
        // an older exec id left from a migration must not become a fallback
        // resume target after that owner disappears.
        this.threadIdMap.delete(logicalThreadId);
        nativeThreadInvalidated = true;
      }
      acquired.session.client.setTurnHandlers(handlers);
      return {
        homeKey,
        home: env.CODEX_HOME,
        ...acquired,
        nativeThreadInvalidated,
        releaseHome: releaseHomeOnce,
      };
    } catch (error) {
      await runtime?.cleanup();
      releaseHomeOnce();
      throw error;
    }
  }

  /**
   * Start Codex's persistent control plane without a hidden model prompt. The
   * real turn will reuse it only if the complete MCP/permission/config surface
   * still has the same fingerprint.
   */
  async prewarm(req: TurnRequest): Promise<{ warmed: boolean; reused: boolean }> {
    if (req.trustTier === 'imported') return { warmed: false, reused: false };
    const tid = req.session.threadId?.trim();
    // Prewarm never carries a host-history snapshot. If this logical session
    // already belongs to exec, creating an app-server thread here would bind
    // the next turn to an empty native conversation. Keep transport ownership
    // with exec; a deliberate snapshot turn is the only safe migration point.
    if (tid && this.threadIdMap.has(tid) && !this.appThreadIdMap.has(tid)) {
      return { warmed: false, reused: false };
    }
    const owned = await this.acquireAppServer(req, {
      onNotification: () => { /* no turn exists during warm-up */ },
      onServerRequest: () => { throw new Error('codex prewarm received a server request without an active turn'); },
      onExit: () => { /* the next acquire observes alive=false and replaces it */ },
    });
    try {
      if (owned.nativeThreadInvalidated) {
        // The current request was composed while the old native thread still
        // existed. Prewarm has no history snapshot, so never create a blank
        // replacement thread; both stale transport mappings were cleared by
        // acquire and the next real compose will emit a snapshot.
        return { warmed: false, reused: owned.reused };
      }
      if (tid && !this.appThreadIdMap.has(tid)) {
        const permission = toCodexAppServerPermission(req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE);
        const started = await this.startAppServerThread(owned.session.client, req, permission, owned.home);
        const requiredFxtUnavailable = hasCodexMcpTools(req)
          && [...started.readiness.pending, ...started.readiness.failed].includes(CODEX_MCP_SERVER_KEY);
        if (started.threadId && !requiredFxtUnavailable) {
          this.appThreadIdMap.set(tid, started.threadId);
          this.appThreadOwnerMap.set(tid, owned.session.client);
        }
        if (!started.readiness.ready) {
          // A warm endpoint must not claim success while a configured local
          // capability is still absent. Keep the process/thread alive so a
          // late server may recover naturally before the user's real turn.
          return { warmed: false, reused: owned.reused };
        }
      }
      if (tid && this.appThreadIdMap.has(tid)) {
        // A valid app-server thread is now the sole native-history owner.
        this.threadIdMap.delete(tid);
      }
      return { warmed: true, reused: owned.reused };
    } finally {
      CodexKernel.appServerPool.release(owned.homeKey, owned.session);
      owned.releaseHome();
    }
  }

  private async startAppServerThread(
    client: CodexAppServerClient,
    req: TurnRequest,
    permission: ReturnType<typeof toCodexAppServerPermission>,
    home: string,
    signal?: AbortSignal,
  ): Promise<{ threadId?: string; readiness: { ready: boolean; pending: string[]; failed: string[] } }> {
    if (signal?.aborted) {
      return { readiness: { ready: false, pending: [], failed: ['cancelled'] } };
    }
    const sp = req.systemPrompt;
    const developerInstructions = sp.persona?.trim()
      ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
      : sp.charter;
    const model = req.model?.trim() || undefined;
    const res = await client.request('thread/start', {
      cwd: defaultProjectRoot(),
      sandbox: permission.sandbox,
      approvalPolicy: permission.approvalPolicy,
      ...(developerInstructions?.trim() ? { developerInstructions } : {}),
      ...(model ? { model } : {}),
      ephemeral: false,
      ...(askUserDynamicTools(req) ? { dynamicTools: askUserDynamicTools(req) } : {}),
    });
    const threadId = res?.thread?.id;
    if (!threadId) return { readiness: { ready: false, pending: ['thread/start'], failed: [] } };
    if (signal?.aborted) {
      return { threadId, readiness: { ready: false, pending: [], failed: ['cancelled'] } };
    }
    let readiness: { ready: boolean; pending: string[]; failed: string[] };
    try {
      readiness = await client.waitForThreadMcpServers(
        threadId,
        [...codexSessionNativeStdioMcpNames(home), ...(hasCodexMcpTools(req) ? [CODEX_MCP_SERVER_KEY] : [])],
        { signal },
      );
    } catch (error) {
      if (!signal?.aborted) throw error;
      readiness = { ready: false, pending: [], failed: ['cancelled'] };
    }
    if (!readiness.ready) {
      // eslint-disable-next-line no-console
      console.warn(`[codex] thread MCP warm-up incomplete; continuing with optional servers pending=[${readiness.pending.join(', ')}] failed=[${readiness.failed.join(', ')}]`);
    }
    return { threadId, readiness };
  }

  /**
   * 一轮:**PRIMARY = app-server(有 per-tool 审批)**,起不来则回退到 **exec(无审批)**。
   *  - app-server 仅对 **非 imported** trust 启用 —— imported pack 走 exec 路径以保留凭据地板
   *    (sidecar/cred-proxy:模型 key 不入不可信子进程);app-server 是持久直 spawn,真 key 在
   *    其 env,只给可信轮。
   *  - fallback 必须在 yield 任何事件**之前**判定(AppServerUnavailable 在 ensureStarted 抛),
   *    否则会半截重跑。 */
  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // Cancellation is a terminal user decision. It must win before binary,
    // session-home, MCP materialization, pool admission or fallback work.
    if (signal.aborted) {
      yield { kind: 'turn.usage' };
      yield { kind: 'turn.done', reason: 'cancelled' };
      return;
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
      const historyMode = (req as TurnRequest & { historyPlan?: { mode?: string } }).historyPlan?.mode;
      const hadAppResume = Boolean(tid && this.appThreadIdMap.has(tid));
      // Native thread identifiers are transport-specific. If this logical
      // session already belongs to legacy exec and the composer emitted only
      // a delta, switching to app-server would create a blank native thread
      // and silently omit the earlier conversation. Keep the established
      // transport until a snapshot can deliberately establish app-server.
      if (historyMode !== 'snapshot' && tid && this.threadIdMap.has(tid) && !this.appThreadIdMap.has(tid)) {
        yield* this.runTurnExec(req, signal);
        return;
      }
      try {
        yield* this.runTurnAppServer(req, signal);
        return;
      } catch (e) {
        if (!(e instanceof AppServerUnavailable)) throw e;
        if (req.tools?.some((tool) => tool.name === 'ask_user')) {
          yield* codexMcpFailure(
            `codex_appserver_required: Ask User requires Codex app-server's timeout-free dynamic tool channel; refusing finite MCP fallback: ${(e as Error).message}`,
          );
          return;
        }
        // App-server and exec keep different native thread identifiers. A
        // non-snapshot request prepared for an app-server owner must never be
        // sent through exec. Clear every stale owner and require a new compose,
        // which now emits a complete snapshot.
        const missingDeltaOwner = historyMode === 'delta' && tid && !this.threadIdMap.has(tid);
        if (tid && ((historyMode !== 'snapshot' && hadAppResume) || missingDeltaOwner)) {
          this.appThreadIdMap.delete(tid);
          this.appThreadOwnerMap.delete(tid);
          this.threadIdMap.delete(tid);
          yield* historyResumeFailure('codex native session is unavailable; retry to synchronize a fresh history snapshot');
          return;
        }
        // A snapshot can safely rebuild on exec, but it must start a fresh exec
        // thread. Resuming an older exec id would inject the full history twice.
        if (historyMode === 'snapshot' && tid) {
          this.appThreadIdMap.delete(tid);
          this.appThreadOwnerMap.delete(tid);
          this.threadIdMap.delete(tid);
        }
        // app-server transport 起不来 → 回退 exec。fallback **必须携带同一套 MCP 工具**
        // (exec 路径会重新 materialize runtime),禁止退化成「无工具继续回答」(plan §6.2)。
        // eslint-disable-next-line no-console
        console.warn(`[codex] app-server unavailable, falling back to exec (keeps same MCP tools): ${(e as Error).message}`);
      }
    }
    yield* this.runTurnExec(req, signal);
  }

  /** PRIMARY:`codex app-server`(JSON-RPC),审批 server-request 接到中立
   *  `req.requestPermission`(= Studio 审批卡)。app-server 所有 codex-isms 在
   *  codex-appserver.ts;本方法只编排 client 生命周期 + thread/turn。 */
  private async *runTurnAppServer(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) CodexKernel.inflight.set(req.callId, ac);

    if (ac.signal.aborted) {
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      yield { kind: 'turn.usage' };
      yield { kind: 'turn.done', reason: 'cancelled' };
      return;
    }

    const projectRoot = defaultProjectRoot();
    const queue = new KernelEventQueue();
    const notifState = createCodexNotifState();
    const permissionMode = req.permissionMode ?? CODEX_DEFAULT_PERMISSION_MODE;
    const appServerPermission = toCodexAppServerPermission(permissionMode);
    const activeAskHandles = new Set<AskHandle>();

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
          queue.push({ kind: 'tool.call', callId, name: 'ask_user', args });
          const sid = req.hostSessionId?.trim() || req.session.threadId?.trim() || '';
          const agent = req.session.agentId?.trim() || 'forge';
          const handle = registerAsk(sid, agent, 0);
          activeAskHandles.add(handle);
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

    const handlers: Pick<CodexAppServerOptions, 'onServerRequest' | 'onNotification' | 'onExit'> = {
      onNotification: (m, params) => mapCodexNotification(m, params, notifState, queue),
      onServerRequest: handleServerRequest,
      onExit: (code, tail) => {
        if (!notifState.ended) {
          queue.push({ kind: 'turn.usage' });
          queue.push({ kind: 'error', error: { code: 'protocol', message: `codex app-server exited ${code}${tail ? ': ' + tail : ''}` } });
          queue.push({ kind: 'turn.done', reason: 'error' });
          notifState.ended = true;
        }
        queue.end();
      },
    };

    let activeClient: CodexAppServerClient | undefined;
    let activeCodexThreadId: string | undefined;
    let activeCodexTurnId: string | undefined;
    const onAbort = () => {
      for (const handle of activeAskHandles) handle.dispose();
      activeAskHandles.clear();
      if (activeClient && activeCodexThreadId && activeCodexTurnId) {
        void activeClient.request('turn/interrupt', {
          threadId: activeCodexThreadId,
          turnId: activeCodexTurnId,
        }, 5_000).catch(() => undefined);
      }
      if (!notifState.ended) {
        queue.push({ kind: 'turn.done', reason: 'cancelled' });
        notifState.ended = true;
      }
      queue.end();
    };
    if (ac.signal.aborted) onAbort();
    else ac.signal.addEventListener('abort', onAbort, { once: true });

    let pooled: Awaited<ReturnType<CodexKernel['acquireAppServer']>>;
    try {
      pooled = await this.acquireAppServer(req, handlers, ac.signal);
    } catch (e) {
      ac.signal.removeEventListener('abort', onAbort);
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      if (ac.signal.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }
      throw new AppServerUnavailable((e as Error).message);
    }
    const client = pooled.session.client;
    activeClient = client;
    this.options.onTransportSelected?.('app-server');

    let reusable = false;
    try {
      // The signal may have fired while queued on the session-home mutex. Stop
      // before any thread/user RPC; the healthy warm process remains reusable.
      if (ac.signal.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }
      const tid = req.session.threadId?.trim();
      const historyMode = (req as TurnRequest & { historyPlan?: { mode?: string } }).historyPlan?.mode;
      if (pooled.nativeThreadInvalidated && historyMode !== 'snapshot') {
        // The request has no complete history snapshot. A replacement process
        // cannot rebuild the old native conversation from delta/none/undefined.
        yield* historyResumeFailure('codex native process changed; retry to synchronize a fresh history snapshot');
        return;
      }
      let codexThreadId = tid ? this.appThreadIdMap.get(tid) : undefined;
      const startFresh = async () => {
        // systemPrompt/model/permission and MCP readiness use the exact same
        // path as prewarm; no hidden prompt is sent in either case.
        return this.startAppServerThread(client, req, appServerPermission, pooled.home, ac.signal);
      };

      if (codexThreadId) {
        if (!tid || this.appThreadOwnerMap.get(tid) !== client) {
          try {
            await client.request('thread/resume', {
              threadId: codexThreadId,
              ...(askUserDynamicTools(req) ? { dynamicTools: askUserDynamicTools(req) } : {}),
            });
          } catch {
            if (tid) {
              this.appThreadIdMap.delete(tid);
              this.appThreadOwnerMap.delete(tid);
            }
            yield* historyResumeFailure('codex native session resume failed; retry to synchronize a fresh history snapshot');
            return;
          }
        }
      } else {
        const started = await startFresh();
        codexThreadId = started.threadId;
      }
      if (ac.signal.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }
      if (!codexThreadId) {
        yield { kind: 'turn.usage' };
        yield { kind: 'error', error: { code: 'protocol', message: 'codex thread/start returned no id' } };
        yield { kind: 'turn.done', reason: 'error' };
        return;
      }

      // Required ForgeaX tools are an admission condition on every tool turn,
      // including a reused native thread. A previous warm/turn may have seen
      // fxt ready and a later startup retry may have failed or been cancelled;
      // never submit a tool-less model turn from that stale thread.
      if (hasCodexMcpTools(req)) {
        let readiness: { ready: boolean; pending: string[]; failed: string[] };
        try {
          readiness = await client.waitForThreadMcpServers(
            codexThreadId,
            [CODEX_MCP_SERVER_KEY],
            { signal: ac.signal },
          );
        } catch (error) {
          if (!ac.signal.aborted) throw error;
          yield { kind: 'turn.usage' };
          yield { kind: 'turn.done', reason: 'cancelled' };
          return;
        }
        if (!readiness.ready) {
          yield* codexMcpFailure('codex_mcp_unavailable: required fxt server did not become ready; retry without losing tool capability');
          return;
        }
      }
      if (ac.signal.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }
      if (tid && !this.appThreadIdMap.has(tid)) {
        this.appThreadIdMap.set(tid, codexThreadId);
        this.appThreadOwnerMap.set(tid, client);
        // Successful snapshot migration establishes one authoritative native
        // owner. Never leave the pre-migration exec id available for fallback.
        this.threadIdMap.delete(tid);
        yield {
          kind: 'x.kernel.thread',
          kernelId: 'codex',
          threadId: tid,
          kernelThreadId: codexThreadId,
          transport: 'app-server',
        };
      }

      // Final admission boundary: no user message or tool side effect may be
      // submitted after cancellation while thread start/resume/readiness was
      // awaiting native work.
      if (ac.signal.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }
      const turnStart = await client.request('turn/start', {
        threadId: codexThreadId,
        sandboxPolicy: { type: appServerPermission.sandbox === 'danger-full-access'
          ? 'dangerFullAccess'
          : appServerPermission.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' },
        approvalPolicy: appServerPermission.approvalPolicy,
        input: buildCodexAppServerTurnInput(req),
      });
      const codexTurnId = turnStart?.turn?.id ?? turnStart?.id;
      activeCodexThreadId = codexThreadId;
      activeCodexTurnId = codexTurnId;
      if (ac.signal.aborted && codexTurnId) {
        await client.request('turn/interrupt', { threadId: codexThreadId, turnId: codexTurnId }, 5_000).catch(() => undefined);
      }

      for await (const ev of queue) {
        // SSE and similar consumers close their iterator immediately after the
        // terminal event. Record successful ownership before yielding it, or
        // generator.return() jumps straight to finally and evicts a healthy
        // process merely because the consumer obeyed the terminal contract.
        if (ev.kind === 'turn.done') reusable = client.alive && !ac.signal.aborted;
        yield ev;
        if (ev.kind === 'turn.done') break;
      }
      reusable = client.alive && !ac.signal.aborted;
    } finally {
      for (const handle of activeAskHandles) handle.dispose();
      activeAskHandles.clear();
      ac.signal.removeEventListener('abort', onAbort);
      if (reusable) {
        // Do not retain callbacks that close over a completed turn while idle.
        client.setTurnHandlers({
          onNotification: () => { /* no active turn */ },
          onServerRequest: () => { throw new Error('codex app-server request arrived without an active turn'); },
          onExit: () => { /* the next acquire observes alive=false */ },
        });
        CodexKernel.appServerPool.release(pooled.homeKey, pooled.session);
      } else {
        await CodexKernel.appServerPool.evict(pooled.homeKey, pooled.session);
      }
      pooled.releaseHome();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
    }
  }

  /** FALLBACK:legacy 一次性 `codex exec --json`(无审批,走 sandbox)。 */
  private async *runTurnExec(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
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
      const projectRoot = defaultProjectRoot();
      // settings.permissions 拦截面(046 楔子3):同 app-server 路径,工作区静态
      // hooks.json + FORGEAX_* env(exec 是 per-turn 进程,env 注入安全)。
      const hooksActive = ensureCodexHooksConfig(projectRoot);

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
      const args = this.buildArgs(req, hooksActive, mcpOverrides);

      // 稳定隔离 CODEX_HOME + keyed mutex(plan §8):同一逻辑 session 跨 turn 复用目录
      // (exec resume 不丢),同 home 串行。
      const homeKey = codexHomeKey(req);
      releaseHome = await codexHomeMutex.acquire(homeKey);
      // A legacy exec process must never overlap the warm app-server for the
      // same CODEX_HOME. Finish the ownership handoff before spawning exec.
      await CodexKernel.appServerPool.evict(homeKey);
      this.appThreadIdMap.delete(req.session.threadId?.trim() || '');
      const codexHome = await ensureCodexSessionHome(homeKey, {
        nativeCapabilities: req.trustTier !== 'imported',
      });

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
            kernel: { kind: 'codex', credential: 'sidecar-managed', cmd: binary, args, cwd: projectRoot, env: stripModelKeys(materializeEnv(envOverride)) },
          }, ac.signal)
        : spawnJsonl<CodexRawEvent>({
            cmd: binary,
            args,
            cwd: projectRoot,
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
            // 这个映射此前只活在上面这张内存 Map 里,进程一重启就没了 —— 而内核
            // 自己的 rollout(模型视角的完整记录:提示词/真实输出/观察/真时间戳)
            // 是按 codex thread id 命名落在隔离 CODEX_HOME 下的。不落盘这条指针,
            // 事后就只能靠时间戳猜哪个 rollout 对应哪个会话。经 x.* 扩展通道发出,
            // session 的总线→账本观察者会把它持久化进本 agent 的账本。
            yield {
              kind: 'x.kernel.thread',
              kernelId: 'codex',
              threadId: tid,
              kernelThreadId: state.threadId,
              transport: 'exec',
            };
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
  private buildArgs(req: TurnRequest, hooksActive = false, mcpOverrides: string[] = []): string[] {
    const tid = req.session.threadId?.trim();
    const codexThreadId = tid ? this.threadIdMap.get(tid) : undefined;
    // 本轮档位:codex 只能兑现 autoEdits / unrestricted,越界(gated/planning)先 clamp
    // 到默认档并出声 —— 不静默把「只读/把闸」当成跑通了。
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
    return buildCodexArgs(req, codexThreadId, hooksActive, mcpOverrides, mode);
  }

  openHandle(callId: string): TurnHandle {
    const kill = async (): Promise<void> => {
      CodexKernel.inflight.get(callId)?.abort();
    };
    return {
      // no-op(诚实标注):codex headless 的权限语义在 spawn 时由 argv 固定
      // (`approval_policy=never` + `sandbox_mode=<档>`,见 codex-profile),**没有
      // per-tool 权限闸,也没有 mid-turn control 通道**改 sandbox → 正在飞的这一轮改不了。
      // 档位入口只有一个:`TurnRequest.permissionMode`(buildArgs 处 clamp 后翻方言);
      // 本 RPC 保持 no-op,不静默假装能改。
      async setPermissionMode(): Promise<void> {},
      async setModel(): Promise<void> {},
      interrupt: kill,
      cancel: kill,
    };
  }

  async probe(): Promise<KernelHealth> {
    try {
      const binary = await this.binary();
      const { stdout, code } = await runCapture(binary, ['--version'], { timeoutMs: 5000 });
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
