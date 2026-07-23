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
import { RENTED_KERNEL_PROFILE } from './kernel-profile';
import { existsSync } from 'node:fs';
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
  buildCodexArgs,
  CODEX_DRIVER_LABEL,
  CODEX_FALLBACK_MODELS,
  createCodexMapperState,
  ensureCodexHooksConfig,
  flushCodexMapper,
  mapCodexEvent,
  type CodexRawEvent,
} from './codex-profile';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { evaluateSettingsRules, loadSettingsPermissionRules } from '../api/lib/permission-settings';
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
  CodexMcpError,
} from './codex-mcp';
import { codexHomeKey, codexHomeMutex, ensureCodexSessionHome } from './codex-session-home';

/** Emit a structured turn failure (the neutral spine has no codex_mcp_* code, so
 *  the machine code rides in the `protocol` message prefix). Keeps the B5
 *  invariant: turn.usage precedes turn.done. */
function* codexMcpFailure(message: string): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message } };
  yield { kind: 'turn.done', reason: 'error' };
}

export type CodexTurnTransport = 'app-server' | 'exec';

export interface CodexKernelOptions {
  readonly onTransportSelected?: (transport: CodexTurnTransport) => void;
}

export class CodexKernel implements AgentKernel {
  constructor(private readonly options: CodexKernelOptions = {}) {}

  readonly id = 'codex';
  readonly displayName = CODEX_DRIVER_LABEL;
  readonly orchestrationProfile = RENTED_KERNEL_PROFILE;
  readonly fallbackModels = CODEX_FALLBACK_MODELS;
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

  /**
   * 一轮:**PRIMARY = app-server(有 per-tool 审批)**,起不来则回退到 **exec(无审批)**。
   *  - app-server 仅对 **非 imported** trust 启用 —— imported pack 走 exec 路径以保留凭据地板
   *    (sidecar/cred-proxy:模型 key 不入不可信子进程);app-server 是持久直 spawn,真 key 在
   *    其 env,只给可信轮。
   *  - fallback 必须在 yield 任何事件**之前**判定(AppServerUnavailable 在 ensureStarted 抛),
   *    否则会半截重跑。 */
  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
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
      try {
        yield* this.runTurnAppServer(req, signal);
        return;
      } catch (e) {
        if (!(e instanceof AppServerUnavailable)) throw e;
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

    const binary = await this.binary();
    const projectRoot = defaultProjectRoot();
    // settings.permissions 拦截面(046 楔子3):工作区静态 hooks.json(PreToolUse 全量
    // 拦截,补 approval 只覆盖「codex 主动问」的缺口)。app-server 是 per-turn 进程
    // (finally shutdown)→ FORGEAX_* 上下文经 env 注入安全,hook 脚本据此回调
    // /:sid/hook-gate。用户自跑 codex 无 FORGEAX env → hook 零干预。
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

    // fxt MCP runtime(本轮工具)。materialize 失败 = fail-closed(plan §6.3),不回退 exec
    // (exec 也会同样失败),直接结构化报错收尾。runtime.env(FORGEAX_* + specs + expose)
    // 合并进 codex 进程 env → codex 起的 MCP 子进程继承(secrets/context 走 env 不走 argv)。
    let runtime: ForgeaxToolsRuntime | undefined;
    if ((req.tools?.length ?? 0) > 0) {
      try {
        runtime = await materializeForgeaxToolsRuntime(req, {
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
    const globalArgs = [
      ...(hooksActive ? ['--dangerously-bypass-hook-trust'] : []),
      ...mcpOverrides,
    ];

    // 稳定隔离 CODEX_HOME + keyed mutex(plan §8):同一逻辑 session 跨 turn 复用目录
    // (thread resume 不丢),同 home 串行(防 SQLite lock / session 损坏)。
    const homeKey = codexHomeKey(req);
    const releaseHome = await codexHomeMutex.acquire(homeKey);
    let homeReleased = false;
    const releaseHomeOnce = () => { if (!homeReleased) { homeReleased = true; releaseHome(); } };
    try {
      env.CODEX_HOME = await ensureCodexSessionHome(homeKey);
    } catch (e) {
      releaseHomeOnce();
      await runtime?.cleanup();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      yield* codexMcpFailure(`codex_mcp_start_failed: session home unavailable: ${(e as Error).message}`);
      return;
    }

    const queue = new KernelEventQueue();
    const notifState = createCodexNotifState();

    // 审批 server-request:settings.permissions 规则先行(046 楔子3:deny 即拒 /
    // allow 即批 / ask 强制走卡),未命中 → 中立 requestPermission(= Studio 审批卡),
    // 都没有 → 默认放行(headless --force 类比,原基线)。
    const handleServerRequest = async (rpc: ServerRequest): Promise<unknown> => {
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

    const client = new CodexAppServerClient({
      binary,
      cwd: projectRoot,
      env,
      // globalArgs 注入在 `app-server` 子命令之前:hooksActive → --dangerously-bypass-hook-trust;
      // 有工具轮 → `-c mcp_servers.fxt.*` 注册本轮 fxt MCP server(plan §6.1)。
      ...(globalArgs.length ? { globalArgs } : {}),
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
    });

    const onAbort = () => {
      if (!notifState.ended) {
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
      client.shutdown();
      releaseHomeOnce();
      await runtime?.cleanup();
      if (req.callId) CodexKernel.inflight.delete(req.callId);
      throw new AppServerUnavailable((e as Error).message);
    }
    this.options.onTransportSelected?.('app-server');

    try {
      const tid = req.session.threadId?.trim();
      let codexThreadId = tid ? this.appThreadIdMap.get(tid) : undefined;
      const startFresh = async (): Promise<string | undefined> => {
        // systemPrompt(charter+persona)由编排层 composeTurnRequest 提供;app-server
        // 经 thread 的 developerInstructions 注入(不碰仓内 AGENTS.md)。模型同 exec:
        // 经中立 TurnRequest.model 透传,不再走 CODEX_MODEL env 特例。
        const sp = req.systemPrompt;
        const developerInstructions = sp.persona?.trim()
          ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
          : sp.charter;
        const model = req.model?.trim() || undefined;
        const res = await client.request('thread/start', {
          cwd: projectRoot,
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
          ...(developerInstructions?.trim() ? { developerInstructions } : {}),
          ...(model ? { model } : {}),
          ephemeral: false,
        });
        return res?.thread?.id;
      };

      if (codexThreadId) {
        try {
          await client.request('thread/resume', { threadId: codexThreadId });
        } catch {
          codexThreadId = await startFresh();
        }
      } else {
        codexThreadId = await startFresh();
      }
      if (codexThreadId && tid) this.appThreadIdMap.set(tid, codexThreadId);
      if (!codexThreadId) {
        yield { kind: 'turn.usage' };
        yield { kind: 'error', error: { code: 'protocol', message: 'codex thread/start returned no id' } };
        yield { kind: 'turn.done', reason: 'error' };
        return;
      }

      const task = req.systemPrompt.dynamicSuffix?.trim()
        ? `${req.input.text}\n\n${req.systemPrompt.dynamicSuffix.trim()}`
        : req.input.text;
      await client.request('turn/start', {
        threadId: codexThreadId,
        input: [{ type: 'text', text: task, text_elements: [] }],
      });

      for await (const ev of queue) {
        yield ev;
        if (ev.kind === 'turn.done') break;
      }
    } finally {
      ac.signal.removeEventListener('abort', onAbort);
      client.shutdown();
      await runtime?.cleanup();
      releaseHomeOnce();
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
      if ((req.tools?.length ?? 0) > 0) {
        try {
          runtime = await materializeForgeaxToolsRuntime(req, {
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
      const codexHome = await ensureCodexSessionHome(homeKey);

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
    return buildCodexArgs(req, codexThreadId, hooksActive, mcpOverrides);
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
