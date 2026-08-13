/**
 * ClaudeCodeKernel — the reference agent CLI(headless)适配成中立 `AgentKernel`。
 *
 * **薄脊梁(spine)**:本文件只剩 CC 执行面的「流程骨架」——spawn / session resume /
 * stream-json → KernelEvent 的搬运 / 取消。**所有 Claude-Code-isms(argv flags、
 * permission-mode 枚举、MCP-isms、wire→KernelEvent 映射、stop-reason 映射)都锁在
 * `cc-profile.ts`**(adaptor profile)。日后整对外迁到 `packages/kernel-adaptors/
 * claude-code` 时,搬「本文件 + cc-profile.ts」,spine 上的中立契约不动。
 *
 * 「组装一轮」(systemPrompt/charter/persona/model)由编排层 `composeTurnRequest`
 * 提供;内核只负责执行面。旧 `cli-providers` 路径原地保留作 fallback(FORGEAX_KERNEL=cli)。
 *
 * 复用共享件:`spawnJsonl`(自动 merge process.env)、`mapClaudeEvent`(raw→ChatEvent)。
 *
 * 基线(headless · 不接 SDK):无优雅 mid-turn;`cancel`/`interrupt` = 杀进程。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelModelCatalog,
  PermissionMode,
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
import {
  ClaudeSessionPool,
  ClaudeSessionPoolBusyError,
  ClaudeSessionCancelledError,
  claudeNativeSourceFingerprint,
  claudeSessionEligible,
  claudeSessionPoolEnabled,
  type ClaudeSessionTransport,
} from './claude-session-pool';
import { createDirectClaudeTransport, createSidecarClaudeTransport } from './claude-session-transport';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import { tt } from '../lib/turn-trace';
import {
  createClaudeMapperState,
  flushClaudeMapper,
  mapClaudeEvent,
  type ClaudeRawEvent,
} from '../cli-providers/shared/claude-code-mapper';
import { defaultProjectRoot } from '@forgeax/platform-io';
import {
  buildCcArgs,
  buildCcInput,
  buildCcPersistentArgs,
  buildSessionArgs,
  chatEventToKernel,
  ccSessionExists,
  CLAUDE_CODE_DRIVER_LABEL,
  CLAUDE_CODE_FALLBACK_MODELS,
  CC_DEFAULT_PERMISSION_MODE,
  CC_SUPPORTED_PERMISSION_MODES,
  probeStreamJsonModels,
  registerTurnGate,
  releaseTurnGate,
} from './cc-profile';
import {
  acquireProjectMcpNativeLease,
  isProjectMcpToolName,
  ProjectMcpNativeOwnershipBusyError,
  projectMcpConfigFingerprint,
} from './project-mcp';

interface NativeHandoffController {
  request(): Promise<boolean>;
  bind(handler: () => Promise<boolean>): void;
  fail(): void;
}

function createNativeHandoffController(): NativeHandoffController {
  let handler: (() => Promise<boolean>) | undefined;
  let failed = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  return {
    async request() {
      if (!handler && !failed) await ready;
      return handler ? handler() : false;
    },
    bind(next) {
      if (failed) return;
      handler = next;
      resolveReady();
    },
    fail() {
      failed = true;
      resolveReady();
    },
  };
}

async function createNativeOwnedClaudeTransport(
  projectRoot: string,
  ownsProjectMcp: boolean,
  factory: () => Promise<ClaudeSessionTransport>,
  handoff: NativeHandoffController,
): Promise<ClaudeSessionTransport> {
  const lease = ownsProjectMcp
    ? await acquireProjectMcpNativeLease(projectRoot, { onHandoffRequested: () => handoff.request() })
    : undefined;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await lease?.release();
  };
  try {
    const transport = await factory();
    return {
      pid: transport.pid,
      write: (data) => transport.write(data),
      onData: (cb) => transport.onData(cb),
      onExit: (cb) => transport.onExit((info) => {
        handoff.fail();
        void release();
        cb(info);
      }),
      close: async () => {
        try {
          await transport.close();
        } finally {
          // The pool can close a freshly-created transport before the caller
          // gets a chance to bind the session handoff callback. Wake any
          // owner already waiting in that narrow construction window.
          handoff.fail();
          await release();
        }
      },
    };
  } catch (error) {
    handoff.fail();
    await release();
    throw error;
  }
}

export class ClaudeCodeKernel implements AgentKernel {
  readonly id = 'claude-code';
  readonly displayName = CLAUDE_CODE_DRIVER_LABEL;
  readonly fallbackModels = CLAUDE_CODE_FALLBACK_MODELS;
  readonly orchestrationProfile = RENTED_KERNEL_PROFILE;
  readonly permissionCapabilities = {
    supported: CC_SUPPORTED_PERMISSION_MODES,
    defaultMode: CC_DEFAULT_PERMISSION_MODE,
  } as const;

  /** 真实模型目录:stream-json 控制面 initialize 的 `models` —— 与 TUI `/model`
   *  同一份(按订阅现算)。失败 → 编排层降级 last-known → fallbackModels。 */
  async listModels(): Promise<KernelModelCatalog> {
    const models = await probeStreamJsonModels(await this.binary());
    return { models, source: 'kernel' };
  }

  readonly capabilities: KernelCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
    // cc 自带 extractMemories fork,但无法用分层 policy 驱动它 → 对编排层不可驱动,标 false(走冷兜底)。
    forkExtract: false,
  };

  private binaryPromise?: Promise<string>;
  /** threadId 已起过 session → 后续 --resume(与旧 provider 对称)。 */
  private readonly startedThreadIds = new Set<string>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();
  private static readonly sessionPool = new ClaudeSessionPool<ClaudeRawEvent>();

  static async closeSessionPool(): Promise<void> {
    await ClaudeCodeKernel.sessionPool.closeAll();
  }

  /**
   * Start the persistent transport for a real own session without sending a
   * model turn. The UI calls this while the session is idle, so Claude can
   * load its native MCP/plugin/skill/settings surface before the first user
   * message arrives. This is deliberately an optional kernel capability; it
   * does not alter the TurnRequest or bypass any trust/permission boundary.
   */
  async prewarm(req: TurnRequest): Promise<{ warmed: boolean; reused: boolean }> {
    if (!claudeSessionPoolEnabled() || !claudeSessionEligible(req) || !req.session.threadId?.trim()) {
      return { warmed: false, reused: false };
    }

    const projectRoot = defaultProjectRoot();
    const ownsProjectMcp = req.trustTier !== 'imported'
      && req.tools.some((tool) => isProjectMcpToolName(tool.name, projectRoot));
    const binary = await this.binary();
    // Do not mark the thread as started until a real user turn has completed:
    // a prewarm process has not written a Claude transcript yet, so a later
    // cold fallback must still be allowed to use `--session-id`.
    const sessionPlan = buildSessionArgs(req.session.threadId, projectRoot, this.startedThreadIds);
    if (!sessionPlan.threadId) return { warmed: false, reused: false };
    const persistentArgs = buildCcPersistentArgs(req, projectRoot, sessionPlan.args, this.permissionModeFor(req));
    const useSidecar = sidecarEnabled();
    const sidecar = useSidecar ? await ensureSidecar() : undefined;
    const sidecarBaseId = req.hostSessionId || req.session.threadId || req.session.agentId || 'kernel';
    const poolSessionId = `claude-pool-${sessionPlan.threadId}`;
    const poolKey = this.sessionPoolKey(req, projectRoot);
    const handoff = createNativeHandoffController();
    const acquired = await ClaudeCodeKernel.sessionPool.acquire(poolSessionId, poolKey, async () => {
      if (useSidecar) {
        return createNativeOwnedClaudeTransport(projectRoot, ownsProjectMcp, () => createSidecarClaudeTransport(sidecar!, {
          sessionId: poolSessionId,
          agentId: req.session.agentId || 'forge',
          trustTier: req.trustTier ?? 'own',
          callId: sidecarBaseId,
          ...(req.budget ? { budget: req.budget } : {}),
          kernel: {
            kind: 'claude-code', credential: 'sidecar-managed', cmd: binary,
            args: persistentArgs, cwd: projectRoot,
            env: stripModelKeys(materializeEnv()),
          },
        }), handoff);
      }
      return createNativeOwnedClaudeTransport(projectRoot, ownsProjectMcp, async () =>
        createDirectClaudeTransport({ cmd: binary, args: persistentArgs, cwd: projectRoot }), handoff);
    });
    if (!acquired.reused) handoff.bind(() => acquired.session.requestHandoff());
    // Claude's stream-json control plane can initialize commands, skills and
    // MCP/plugin discovery without a model/user turn. Await it here so the HTTP
    // warm endpoint means "native capability plane ready", not merely "child
    // process spawned"; no hidden prompt is written to the transcript.
    try {
      await acquired.session.initialize();
    } catch (error) {
      await acquired.session.close();
      throw error;
    }
    tt('cc.prewarm', { threadId: sessionPlan.threadId, reused: acquired.reused, pid: acquired.session.pid });
    return { warmed: true, reused: acquired.reused };
  }

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'ANTHROPIC_CLI_PATH',
      defaultBinary: 'claude',
    }));
  }

  hasNativeHistoryResume(threadId: string): boolean {
    return this.startedThreadIds.has(threadId) || ccSessionExists(defaultProjectRoot(), threadId);
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // Match the cold-process cancellation contract before doing any binary,
    // credential, sidecar, native capability, or persistent-session work.
    // In particular, a pre-aborted warm turn must not surface the pool's
    // internal cancellation sentinel as a public API error.
    if (signal.aborted) {
      const state = createClaudeMapperState();
      for (const ev of flushClaudeMapper(state, 'cancelled')) yield* chatEventToKernel(ev);
      return;
    }

    // 内部 AbortController:外部 signal 或 openHandle(callId).cancel 任一触发都中断。
    const ac = new AbortController();
    signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) ClaudeCodeKernel.inflight.set(req.callId, ac);

    // 权限闸(B-4):若编排层提供了中立 `requestPermission`,把它登记进 in-process gate
    // registry(键=真实 sid),供权限回执端优先于「弹卡」直接咨询。详见 cc-profile 注释。
    const gateSid = req.hostSessionId?.trim() || req.session.threadId?.trim() || '';
    const gateRegistered = req.requestPermission ? registerTurnGate(gateSid, req.requestPermission) : false;

    let credToken: string | undefined;
    try {
      const kernelStartedAt = Date.now();
      const binary = await this.binary();
      const projectRoot = defaultProjectRoot();
      const sessionPlan = this.buildSessionPlan(req, projectRoot);
      const ownsProjectMcp = req.trustTier !== 'imported'
        && req.tools.some((tool) => isProjectMcpToolName(tool.name, projectRoot));
      const args = buildCcArgs(req, projectRoot, sessionPlan.args, this.permissionModeFor(req));
      const persistentArgs = buildCcPersistentArgs(req, projectRoot, sessionPlan.args, this.permissionModeFor(req));

      // 凭据地板:imported → scrub 非必要宿主密钥。模型 key 处理分两路:
      //  - sidecar 路径(FORGEAX_SIDECAR=on):凭据由 **sidecar cred-vault** 发 scoped token,
      //    本进程**不跑** in-process cred-proxy,且把真模型 key 从 env 剔除(不经 socket 外发);
      //    sidecar 注入 scoped。
      //  - 非 sidecar(默认):server 进程内 cred-proxy 发 nonce(C0-a 过渡)。
      const useSidecar = sidecarEnabled();
      let envOverride: Record<string, string | undefined> | undefined;
      if (req.trustTier === 'imported') {
        envOverride = scrubbedSecretEnv();
        if (!useSidecar) {
          const issued = await issueToken('anthropic');
          if (issued) {
            credToken = issued.token;
            envOverride = { ...envOverride, ANTHROPIC_API_KEY: issued.token, ANTHROPIC_BASE_URL: issued.baseUrl };
          }
        }
      }
      const sidecarBaseId = req.callId || req.hostSessionId || req.session.threadId || req.session.agentId || 'kernel';
      const sidecar = useSidecar ? await ensureSidecar() : undefined;
      tt('cc.spawn-ready', { sidecar: useSidecar, ms: Date.now() - kernelStartedAt, args: args.length });
      const persistentEligible = claudeSessionPoolEnabled()
        && Boolean(sessionPlan.threadId)
        && claudeSessionEligible(req);
      let lines: AsyncIterable<ClaudeRawEvent>;
      let exit: Promise<{ code: number; stderr: string }>;
      const spawnCold = async () => {
        const lease = claudeSessionEligible(req) && ownsProjectMcp
          ? await acquireProjectMcpNativeLease(projectRoot)
          : undefined;
        try {
          const spawned = useSidecar
            ? sidecarSpawnJsonl<ClaudeRawEvent>(sidecar!, {
            sessionId: sidecarBaseId,
            agentId: req.session.agentId || 'forge',
            trustTier: req.trustTier ?? 'own',
            callId: sidecarBaseId,
            ...(req.budget ? { budget: req.budget } : {}),
            // credential='sidecar-managed' → sidecar 发 scoped token 注入;此处剔除真模型 key 不外发。
            kernel: { kind: 'claude-code', credential: 'sidecar-managed', cmd: binary, args, cwd: projectRoot, env: stripModelKeys(materializeEnv(envOverride)) },
            }, ac.signal)
            : spawnJsonl<ClaudeRawEvent>({
                cmd: binary,
                args,
                cwd: projectRoot,
                signal: ac.signal,
                ...(envOverride ? { envOverride } : {}),
              });
          if (lease) void spawned.exit.finally(() => lease.release());
          return spawned;
        } catch (error) {
          await lease?.release();
          throw error;
        }
      };
      if (persistentEligible) {
        try {
          const poolKey = this.sessionPoolKey(req, projectRoot);
          const poolSessionId = `claude-pool-${sessionPlan.threadId}`;
          const handoff = createNativeHandoffController();
          const acquired = await ClaudeCodeKernel.sessionPool.acquire(poolSessionId, poolKey, async () => {
            if (useSidecar) {
              return createNativeOwnedClaudeTransport(projectRoot, ownsProjectMcp, () => createSidecarClaudeTransport(sidecar!, {
                sessionId: poolSessionId,
                agentId: req.session.agentId || 'forge',
                trustTier: req.trustTier ?? 'own',
                callId: poolSessionId,
                ...(req.budget ? { budget: req.budget } : {}),
                // credential='sidecar-managed' → sidecar 发 scoped token 注入;此处剔除真模型 key 不外发。
                kernel: {
                  kind: 'claude-code', credential: 'sidecar-managed', cmd: binary,
                  args: persistentArgs, cwd: projectRoot,
                  env: stripModelKeys(materializeEnv(envOverride)),
                },
              }), handoff);
            }
              return createNativeOwnedClaudeTransport(projectRoot, ownsProjectMcp, async () =>
                createDirectClaudeTransport({ cmd: binary, args: persistentArgs, cwd: projectRoot, ...(envOverride ? { envOverride } : {}) }), handoff);
          });
          if (!acquired.reused) handoff.bind(() => acquired.session.requestHandoff());
          tt('cc.session-mode', { mode: 'persistent-stream-json', reused: acquired.reused, pid: acquired.session.pid });
          const turn = await acquired.session.execute(buildCcInput(req), ac.signal);
          lines = turn.lines;
          exit = turn.exit;
        } catch (error) {
          if (error instanceof ClaudeSessionCancelledError) {
            const cancelled = createClaudeMapperState();
            for (const ev of flushClaudeMapper(cancelled, 'cancelled')) yield* chatEventToKernel(ev);
            return;
          }
          if (
            error instanceof ProjectMcpNativeOwnershipBusyError
            || error instanceof ClaudeSessionPoolBusyError
          ) {
            throw error;
          }
          // Pool setup is an optimization. A spawn/sidecar write failure must
          // retain the old complete one-shot path for this turn.
          tt('cc.pool-fallback', { error: (error as Error).message });
          const oneShot = await spawnCold();
          lines = oneShot.lines;
          exit = oneShot.exit;
        }
      } else {
        const oneShot = await spawnCold();
        lines = oneShot.lines;
        exit = oneShot.exit;
      }

      const state = createClaudeMapperState();
      const streamStartedAt = Date.now();
      let rawFirstSeen = false;
      let tokenFirstSeen = false;
      try {
        for await (const raw of lines) {
          if (!rawFirstSeen) {
            rawFirstSeen = true;
            tt('cc.raw-first', { ms: Date.now() - streamStartedAt });
          }
          for (const ev of mapClaudeEvent(raw, state)) {
            if (!tokenFirstSeen && (ev.type === 'token' || ev.type === 'thinking')) {
              tokenFirstSeen = true;
              tt('cc.token-first', { ms: Date.now() - streamStartedAt, kind: ev.type });
            }
            yield* chatEventToKernel(ev);
          }
        }
      } catch (streamErr) {
        yield* chatEventToKernel({ type: 'error', message: `claude-code stream error: ${(streamErr as Error).message}` });
        return;
      }

      const exitInfo = await exit;
      if (!state.doneEmitted) {
        if (signal.aborted) {
          // 取消语义(R4-05):杀进程导致 exitInfo.code !== 0,但这是「用户/编排层
          // 主动中断」而非真崩溃 —— 必须收口为 turn.done{cancelled},而非 error。
          // 经 cc profile 的 done 路径(stopReason:'cancelled' → wireStopToKernel
          // → 'cancelled')复用同一终态构造,保持 DRY、不手搓 raw 事件形状。
          // flushClaudeMapper 自身置 doneEmitted,无需在此重复。
          for (const ev of flushClaudeMapper(state, 'cancelled')) yield* chatEventToKernel(ev);
        } else if (exitInfo.code !== 0) {
          const tail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').trim();
          yield* chatEventToKernel({ type: 'error', message: `claude exited ${exitInfo.code}${tail ? ': ' + tail : ''}` });
        } else {
          for (const ev of flushClaudeMapper(state)) yield* chatEventToKernel(ev);
        }
      }
    } finally {
      if (credToken) revokeToken(credToken);
      if (req.callId) ClaudeCodeKernel.inflight.delete(req.callId);
      if (gateRegistered) releaseTurnGate(gateSid);
    }
  }

  /** 从中立 TurnRequest 拼 `claude -p` argv —— 委托给 cc-profile(所有 CC-isms 在那)。
   *
   *  档位解析(全在中立轴上,方言翻译只在 cc-profile 出口发生一次):
   *    pendingMode(setPermissionMode RPC —— 最近一次**活的**控制面动作)
   *      ?? req.permissionMode(本轮随请求带来的档位,实际由设置页 standing 配置填充)
   *      ?? cc-profile 默认档(= 全内核默认)
   *  pending 优先:`req.permissionMode` 现在承载的是**持久配置**(每轮都填),若让它压过
   *  RPC,用户/宿主一旦配过 standing 档,mid-turn 的 setPermissionMode 就永远失效
   *  (例如 plan 只读闸切不进去)。故最近的显式动作优先。 */
  private buildArgs(req: TurnRequest, projectRoot: string): string[] {
    const session = this.buildSessionPlan(req, projectRoot);
    return buildCcArgs(req, projectRoot, session.args, this.permissionModeFor(req));
  }

  private buildSessionPlan(req: TurnRequest, projectRoot: string): { args: string[]; threadId?: string } {
    const tid = req.session.threadId?.trim();
    const session = buildSessionArgs(tid, projectRoot, this.startedThreadIds);
    if (session.threadId) this.startedThreadIds.add(session.threadId);
    return session;
  }

  private permissionModeFor(req: TurnRequest): PermissionMode {
    const pendingMode = req.callId ? ClaudeCodeKernel.pendingPermissionMode.get(req.callId) : undefined;
    return pendingMode ?? req.permissionMode ?? CC_DEFAULT_PERMISSION_MODE;
  }

  private sessionPoolKey(req: TurnRequest, projectRoot: string): string {
    return JSON.stringify({
      projectRoot,
      nativeSources: claudeNativeSourceFingerprint(projectRoot),
      projectMcp: projectMcpConfigFingerprint(projectRoot),
      threadId: req.session.threadId,
      hostSessionId: req.hostSessionId,
      agentId: req.session.agentId,
      trustTier: req.trustTier,
      permissionMode: this.permissionModeFor(req),
      model: req.model,
      fallbackModels: req.fallbackModels,
      systemPrompt: {
        charter: req.systemPrompt.charter,
        persona: req.systemPrompt.persona,
        mode: req.systemPrompt.mode,
      },
      tools: req.tools,
      toolPolicy: req.toolPolicy,
      budget: req.budget,
    });
  }

  /** callId → 下一轮 spawn 要用的**中立**档位(由 setPermissionMode 原样存入)。
   *  headless `claude -p` 无法 mid-turn 改 permission-mode(没有 SDK control 通道),
   *  故 setPermissionMode 只能影响**下一轮** spawn 的 argv —— 见 openHandle 注释。
   *  存中立值而非 CC 枚举:方言翻译保持单点(cc-profile),此处不提前落方言。 */
  private static readonly pendingPermissionMode = new Map<string, PermissionMode>();

  openHandle(callId: string): TurnHandle {
    const kill = async (): Promise<void> => {
      ClaudeCodeKernel.inflight.get(callId)?.abort();
    };
    return {
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        // headless `claude -p` 是一次性 spawn,**无 mid-turn control 通道**(那是 CC
        // SDK 的能力,headless 没有)→ 不能改正在飞的这一轮。我们做能做的:把中立档位
        // 原样存下,**下一轮**该 callId 的 spawn argv 即生效(翻方言在 cc-profile
        // 出口做)。这是 headless 形态的真实上限,不静默假装。
        ClaudeCodeKernel.pendingPermissionMode.set(callId, mode);
      },
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
      const hasKey = Boolean(process.env.ANTHROPIC_API_KEY) || existsSync(resolvePath(homedir(), '.claude.json'));
      return code === 0 && hasKey
        ? { ok: true, kernelId: this.id, detail: out || 'claude ready' }
        : { ok: false, kernelId: this.id, detail: !hasKey ? 'ANTHROPIC_API_KEY/login missing' : `claude --version exit ${code}` };
    } catch (e) {
      return { ok: false, kernelId: this.id, detail: (e as Error).message };
    }
  }
}
