/** Session —— per-sid 容器：bus / queue / blackboard / tree / ledgers / scheduler 全在内。
 *
 *  与 agenteam ref 的差异（plan §2.0 / §2.1 / §3.1.1）：
 *  - forgeax 的 sid 对应**一整棵 agent tree**（root + 所有 sub-agent）。一棵树一份
 *    ledger map（per-agent），一份 blackboard、一份 EventBus、一份 Scheduler。
 *  - **Session 不包 start/stop**：调度由 caller 直接 `session.scheduler.start() /
 *    .shutdown()`。`Session.dispose()` 只做容器层资源释放。
 *  - **abort 路径 = Scheduler，不放 Session**：cancel 由 caller 走
 *    `session.scheduler.interruptAgents(agentPath?)` 派给 per-agent `BaseAgent.stop()`
 *    （= `abortController.abort()`），与 agenteam ref `core/scheduler.interruptAgents`
 *    一致。Session 自身不持 AbortController。
 *  - **不维护 client attach 计数**：哪个 ws 连着哪个 sid 由外层（WsHub / 单独 status
 *    API）查；Session 不背任何 ref-count，订阅直接 `session.eventBus.observe(handler)`。
 *  - **sandbox 不挂 Session**：由 SandboxManager 按 `defaultDir` 池化共享，first
 *    tool exec 时 lazy acquire，与 Session 解耦。
 *  - **agentFactory** 是 caller（SessionManager）注入的 callback：Scheduler 通过它
 *    为每个 agentPath 构造 ConsciousAgent 实例（包含 ledger / sessionDefaultModels
 *    注入），Session 自己只负责管 ledger map + 资源回收。
 *
 *  字段（plan §2.1）：
 *  - sid / paths / config / blackboard / eventBus / scheduler / tree / ledgers → dispose */

import { Blackboard } from "./blackboard";
import { EventBus } from "./event-bus";
import { LiveTurnTracker } from "./live-turn-tracker";
import { AgentTree } from "./agent-tree";
import { Scheduler, type AgentFactory } from "./scheduler";
import { EventLedger } from "../ledger/event-ledger";
import { FileActivityLedger } from "../ledger/file-activity-ledger";
import type { FileLockMap } from "../fs/agent-fs-recorder";
import { bindSystemEventLog } from "../ledger/system-event-log";
import { Logger } from "./logger";
import type { Event, SessionConfig, ModelsConfig } from "./types";
import type { PathManagerAPI, SessionLayerAPI } from "../fs/types";
import { createOrGetFSWatcher } from "../fs/watcher";
import { getPathManager } from "../fs/path-manager";
import { AgentKitReloadCoordinator } from "../kits/reload-coordinator";
import { clearRememberedForSession } from "../kernel/tool-approval";
import { clearUiStateForSession } from "../api/lib/ui-manifest-registry";
import { runAutoExtract } from "../soul/auto-extract";
import { tryKernelForkExtract } from "../soul/fork-extract";
import { resolveKernel } from "../kernel/resolve-kernel";
import { canonicalToolName } from "../kernel/canonical-tool-name";
import type { ArtifactResolver, ArtifactTurnContext } from "../orchestration-seams";
import type { ArtifactResolvedPayload, ArtifactSummary } from "@forgeax/types/artifact-summary";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** One pending delegate_to_subagent awaiting the sub-agent's turn-end.
 *  Keyed by sub-agent's `agentPath` (e.g. "suzu"). */
export interface DelegationInfo {
  /** The agent that called delegate_to_subagent (e.g. "forge"). */
  delegator: string;
  /** First ~80 chars of the brief, for the callback message. */
  brief: string;
  /** ms — used to GC stale entries if turn-end never fires. */
  ts: number;
}

export interface SessionInitConfig {
  sid: string;
  paths: PathManagerAPI;
  config: SessionConfig;
  /** Caller 提供的 agent factory —— Scheduler attach 一个新 agentPath 时调它构造
   *  BaseAgent 实例（注入 ledger / kit / models）。SessionManager 在构造 Session
   *  时把它包出来，避免 Session 反向依赖 ConsciousAgent。 */
  agentFactory: AgentFactory;
  /** Optional: agent 被 `controlAgent("remove", path)` 摘掉后的清理钩子
   *  （wipe blackboard 命名空间 / dispose ledger）。SessionManager 默认
   *  包出 `(agentPath) => session.freeAgentState(agentPath)`。 */
  onAgentFreed?: (agentPath: string) => void | Promise<void>;
  /** Host-owned final-settle artifact derivation. Optional for standalone
   * orchestrator consumers; the product shell injects it at app boot. */
  artifactResolver?: ArtifactResolver;
}

/** Pull plain text out of a `hook:assistantMessage` payload. The assistant
 *  message lives at `payload.llmMessage.content`, which is either a string or
 *  an array of content blocks; we concatenate the `text` blocks (thinking /
 *  tool_use blocks are skipped — the delegator wants the report, not internals). */
function extractAssistantText(payload: unknown): string {
  const msg = (payload as { llmMessage?: { content?: unknown } } | undefined)?.llmMessage;
  const content = msg?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  return "";
}

function stableArtifactId(sid: string, turnId: string, checkpointMsgId?: string): string {
  return createHash("sha256")
    .update(`${sid}\0${turnId}\0${checkpointMsgId ?? ""}`)
    .digest("hex");
}

function askResultHasAnswer(value: unknown): boolean {
  let source = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof source === "string") {
      const raw = source.trim().replace(/^\[ask_user\]\s*/i, "");
      try { source = JSON.parse(raw) as unknown; continue; } catch {
        return /「[^」]+」/.test(raw);
      }
    }
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;
    const envelope = source as { ok?: unknown; questions?: unknown; text?: unknown; structuredContent?: unknown };
    if (envelope.ok === true && Array.isArray(envelope.questions)) break;
    if (envelope.structuredContent !== null && envelope.structuredContent !== undefined) {
      source = envelope.structuredContent;
      continue;
    }
    if (typeof envelope.text === "string") {
      source = envelope.text;
      continue;
    }
    return false;
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const record = source as { ok?: unknown; questions?: unknown };
  if (record.ok !== true || !Array.isArray(record.questions)) return false;
  return record.questions.some((question) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) return false;
    const values = (question as { values?: unknown }).values;
    return Array.isArray(values) && values.some((item) => typeof item === "string" && item.trim().length > 0);
  });
}

function askToolResultResolved(payload: Record<string, unknown>): boolean {
  if (typeof payload.error === "string" && payload.error) return false;
  return askResultHasAnswer(payload.result ?? payload.resultData);
}

export class Session {
  readonly sid: string;
  readonly paths: SessionLayerAPI;
  config: SessionConfig;

  readonly blackboard: Blackboard;
  readonly eventBus: EventBus;
  /** 在途 turn 累积 —— WsHub 给新连接发 turn-snapshot 用(多 tab 同步 §4.3)。 */
  readonly liveTurns: LiveTurnTracker;
  readonly tree: AgentTree;
  readonly scheduler: Scheduler;

  /** Kit hot-reload dispatcher（B1.11）：
   *  - fs.watch builtin/user/session 3 共享层 + per-agent 那一层 kits/
   *  - per-tool-batch poll baseline（ConsciousAgent.refreshTools 默认绑到这里）
   *  - ScriptAgent src/index.ts 改动 → 走 `scheduler.controlAgent("restart", path)`
   *
   *  bun / node fs.watch 在 Linux 上 inotify 路径基本一致，但 bun 对
   *  `O_TRUNC + write + close` 的 add 事件偶尔会漏；这正是 ref 设计 polling
   *  fallback 的原因 —— ConsciousAgent 每个 tool batch 之后调一次 flushReloads
   *  作为可靠路径，fs.watch 只是事件驱动的加速。 */
  readonly kitReloadCoordinator: AgentKitReloadCoordinator;

  /** Per-Session logger —— 落到 `<sid>/logs/debug.log` 全量 + `<sid>/logs/latest.log`
   *  INFO+。覆盖：Session plumbing 错误 / EventBus → log 桥 / agent plumbing
   *  事件。跟 EventLedger 是两条不同的轨：ledger 是 LLM context 真相，logger
   *  是运维 / 观测真相。 */
  readonly logger: Logger;

  /** Per-agent ledgers —— scheduler 通过 agentFactory 构造 ConsciousAgent 时
   *  从这里取出 ledger 喂给 ContextWindow。 */
  readonly ledgers = new Map<string, EventLedger>();

  /** Per-session **file-activity** ledger —— SSOT for "who touched what".
   *  Wired into BaseAgent ctor: every wrapped `ctx.fs` mutation appends one
   *  record here (via `wrapAgentFsWithRecorder`). UI / LLM slot / REST all
   *  derive from this one ledger; no agent owns/persists its own file list.
   *  See [[file-activity-tracking]] design notes in the recorder module. */
  readonly fileActivity: FileActivityLedger;

  /** In-memory cross-agent file-edit lock map. `Map<absPath, {agentPath, op,
   *  since}>`. Held only for the duration of a recorder-wrapped write —
   *  never persisted (process death = locks cleared). Cross-agent visible
   *  via `/api/sessions/:sid/file-locks`. */
  readonly fileLocks: FileLockMap = new Map();

  /** Pending delegations awaiting a completion-callback. Populated by the
   *  `delegate_to_subagent` tool when the delegator hands a task to a
   *  teammate; consumed by `_bindDelegationCallback` when the teammate
   *  emits `hook:turnEnd`. Without this map the delegator never learns
   *  the sub-agent finished — fire-and-forget by design pre-2026-05-28,
   *  user complained "主 agent 不知道". Mirrors agentic_os's MessageBus
   *  auto-deliver pattern (sub-agent → parent on turn-end). */
  readonly delegations = new Map<string, DelegationInfo>();

  /** Latest assistant text per agentPath, captured live off the EventBus.
   *  Consumed by `_bindDelegationCallback` so the completion message carries
   *  the teammate's ACTUAL output (e.g. tsumugi's verify report), not just a
   *  "done" notice. Without this the delegator knew the sub-agent finished but
   *  not WHAT it produced, so it stalled asking the user to paste the result
   *  back across chat tabs — the root of the "做一点就停/反复说继续" loop. */
  private readonly latestAssistantText = new Map<string, string>();

  /** New turn protocol state. A turn is not considered settled until its
   * `hook:turnEnd` is observed and any ask_user wait has completed. */
  private readonly artifactResolver?: ArtifactResolver;
  private readonly artifactTurns = new Map<string, {
    turnId: string;
    checkpointMsgId?: string;
    startedAt: number;
    eligible: boolean;
    waitingForInput?: boolean;
  }>();
  private readonly pendingAskCalls = new Set<string>();
  /** CLI AskUserQuestion calls are answered through the permission side
   * channel. Their tool result is often a human-readable sentence rather than
   * the native structured `{ ok, questions }` payload, so keep provenance
   * beside the pending call instead of guessing from result prose. */
  private readonly permissionAskCalls = new Set<string>();
  /** Add the active turn id to tool events that predate the payload turnId
   * field. EventLedger persists it as history metadata for precise attribution. */
  private readonly activeTurnIds = new Map<string, string>();
  private readonly artifactResolutionInFlight = new Map<string, Promise<void>>();

  private disposed = false;

  constructor(private readonly init: SessionInitConfig) {
    this.sid = init.sid;
    this.paths = init.paths.session(init.sid);
    this.config = init.config;
    this.artifactResolver = init.artifactResolver;

    this.blackboard = new Blackboard(this.paths.root() + "/blackboard.json");
    this.blackboard.loadFromDisk();

    this.fileActivity = new FileActivityLedger(this.paths.root(), this.paths.fileActivityLog());

    this.logger = new Logger({
      debugLogPath: this.paths.debugLogFile(),
      latestLogPath: this.paths.latestLogFile(),
    });

    this.eventBus = new EventBus();
    this.liveTurns = new LiveTurnTracker(this.eventBus);
    this.tree = new AgentTree(init.sid, init.paths);
    this.tree.init();

    // 注意构造顺序：scheduler hooks 通过 `this.kitReloadCoordinator` 间接访问，
    // 闭包延迟解引用 —— 把 coordinator 放在 scheduler **之后**构造也行，因为
    // scheduler.attachAgent 是 async，第一次 attach 时 coordinator 已就位。
    this.scheduler = new Scheduler({
      sid: this.sid,
      eventBus: this.eventBus,
      tree: this.tree,
      agentFactory: init.agentFactory,
      logger: this.logger,
      onAgentFreed: init.onAgentFreed ?? ((agentPath) => this.freeAgentState(agentPath)),
      onAgentAttached: (agent) => this.kitReloadCoordinator?.registerAgent(agent),
      onAgentDetached: (agentPath) => {
        this.kitReloadCoordinator?.unregisterAgent(agentPath);
        // A detached agent may never emit a tool result. Drop its Ask wait
        // keys and any in-memory artifact turn that cannot receive a final
        // lifecycle event; otherwise a later agent with the same path can be
        // held in waiting_for_input forever.
        for (const key of this.pendingAskCalls) {
          if (key.startsWith(`${agentPath}:`)) this.pendingAskCalls.delete(key);
        }
        for (const key of this.permissionAskCalls) {
          if (key.startsWith(`${agentPath}:`)) this.permissionAskCalls.delete(key);
        }
        if (!this.liveTurns.has(agentPath)) {
          this.artifactTurns.delete(agentPath);
          this.activeTurnIds.delete(agentPath);
        }
        // Target of a pending delegation is going away (shutdown/restart/remove/
        // crash) — `hook:turnEnd` will never fire for it, so without this the
        // `delegations` entry leaks forever and permanently blocks future
        // delegations to this path via `delegationGuard`'s target-busy check.
        this._resolveDelegation(agentPath, { aborted: true });
        // Same "hook:turnEnd will never fire" gap also strands the TARGET's own
        // UI: the front-end's cancel button / "thinking" indicator only clear on
        // `hook:turnEnd` (session-stream.ts's `setStreaming(sid, emitter, false)`),
        // so a sub-agent that's forcibly terminated mid-turn stays visually
        // "running" forever even though its delegator was already notified.
        // Synthesize the same shape `ledger-recovery.ts` uses for unsealed turns
        // (`aborted: true, synthesized: true`) and `publish` (not `emit`) it so
        // `_bindLedgerPersistence` seals the ledger and the WS hub relays it to
        // every tab watching this agentPath — no queue routing needed, this is a
        // status broadcast, not a message. Gated on `liveTurns.has()` so we never
        // double-fire if the real turnEnd already made it out.
        if (this.liveTurns.has(agentPath)) {
          this.eventBus.publish(
            {
              source: `agent:${agentPath}`,
              type: "hook:turnEnd",
              payload: {
                aborted: true,
                error: "agent detached before its turn ended",
                synthesized: true,
              },
              ts: Date.now(),
            },
            agentPath,
          );
        }
      },
    });

    this.kitReloadCoordinator = new AgentKitReloadCoordinator(
      this.sid,
      createOrGetFSWatcher(),
      init.paths,
      () => this.tree.list().map((n) => n.path),
      async (agentPath) => {
        // scheduler.controlAgent("restart") 拿 lifecycleLock，确保和正在 run
        // 的 turn 串行。返回值字符串无所谓——只要它真跑完算 handled，让
        // coordinator 推进 src baseline。busy 时 lifecycleLock 会让它排队等
        // 而不是立刻返回 false，所以这里返回 true 即可。
        try {
          await this.scheduler.controlAgent("restart", agentPath);
          return true;
        } catch (err: any) {
          this.logger.error(agentPath, undefined, `scriptSrcChanged restart failed: ${err?.message ?? err}`);
          return false;
        }
      },
    );
    // **不**主动 startWatching —— coordinator 自己在第一次 registerAgent
    // 时 lazy-boot 共享层 fs.watch（参考 ref：scheduler.start() 才起）。
    // 这样纯 container session（不 attachAgent 的 bus/scaffold/LRU 用例）
    // 不占任何 inotify slot，避免 bun 上 slot 累积引起的 fs 事件派发劣化。

    // 三条独立 observer：
    //   1) per-agent ledger persistence（对齐 ref `_bindEventBus`）—— 把跟某 agent
    //      关联的事件落到该 agent 的 events.jsonl。
    //   2) `agent_command` routing（对齐 ref `attachSchedulerListeners`）—— UI / CLI
    //      / 其他 agent 在总线上发 `{type:"agent_command", to:agentPath, payload:
    //      {toolName, args}}` 时，桥到目标 ConsciousAgent.queueCommand，让对方在
    //      下一 turn 把它合成 user-issued tool_call 进 LLM 历史。
    //   3) per-session "headless" event log（对齐 ref `system-event-log`）——
    //      没 owner、没 to 的事件（agent_added/removed、default_dir_changed、
    //      partial_boundary、compact_boundary 等）落到 `<sid>/global-events.jsonl`。
    // 顺序无关；dispose 时按注册逆序 unsub。
    this._busUnsubs = [
      this._bindLedgerPersistence(),
      this._bindArtifactResolution(),
      this._bindAgentCommandRouting(),
      this._bindDelegationCallback(),
      this._bindAutoExtract(),
      bindSystemEventLog(this.paths.globalEventsLog(), this.eventBus),
      () => this.liveTurns.dispose(),
    ];
    // Reopen/restart recovery is best-effort and never blocks Session
    // construction. The same resolver + append-before-broadcast path is used
    // for repaired terminal events, so a crash between turn-end and artifact
    // WAL append cannot permanently lose the card.
    queueMicrotask(() => { void this._reconcileArtifactTurns(); });
  }

  /** Explicit settle hook for kernel paths that transcribe their WAL directly
   * instead of publishing the lifecycle events through this EventBus (the CLI
   * kernel path is one such caller). */
  async resolveArtifactTurn(context: ArtifactTurnContext): Promise<void> {
    await this._resolveArtifact(context);
  }

  /** Project root used for attribution of relative tool paths. In Studio the
   * session is nested under the bound game, so the session state directory is
   * deliberately not used as the execution root. */
  artifactProjectRoot(): string {
    try {
      if (this.config.defaultDir) {
        // Tool hooks may report project-root-relative paths such as
        // `.forgeax/games/<slug>/src/file.ts`, while SnapshotStore diffs are
        // game-relative.  The project root is the directory containing the
        // `.forgeax/games` tree, not the bound game directory itself.
        return resolve(getPathManager().user().gamesDir(), "..", "..");
      }
    } catch {
      /* Fall back to the generic session root for standalone consumers. */
    }
    return this.paths.root();
  }

  // ─── turn-end → 自动沉淀(USER.md + 分层记忆)──────────────────────────────

  /** 每个 agent 回合结束(非取消)后,后台抽取持久记忆并按层路由(P1)。节流/互斥/
   *  fire-and-forget 全在 `runAutoExtract` 内,这里只负责取 ledger + resolveModels。
   *  `FORGEAX_AUTO_EXTRACT=0` 可全局关闭。 */
  private _bindAutoExtract(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (event.type !== "hook:turnEnd" || !emitterId) return;
      const payload = (event.payload ?? {}) as { aborted?: boolean };
      if (payload.aborted) return;
      if (!this.tree.get(emitterId)) return; // 仅树内 agent
      // stable-identity gate(对齐 cc 主-agent-only):只**顶层 persona**(有稳定 soul 身份)长记忆;
      //   临时 subagent(路径含 `/agents/`)跳过 → 不产孤儿 soul(抽了也读不回,白烧 token)。
      if (emitterId.includes("/agents/")) return;
      const agent = this.scheduler.getAgent(emitterId) as unknown as {
        agentContext?: { resolveModels?: () => ModelsConfig };
      } | null;
      const resolveModels = agent?.agentContext?.resolveModels;
      if (typeof resolveModels !== "function") return; // ScriptAgent / 无模型 → 跳过
      let kernelId: string | undefined;
      try { kernelId = resolveKernel(emitterId).id; } catch { /* 无内核 → 按默认 gate */ }
      void runAutoExtract(
        {
          sid: this.sid,
          agentPath: emitterId,
          ledger: this.getOrCreateLedger(emitterId),
          resolveModels,
          ...(kernelId ? { kernelId } : {}),
        },
        // cache-warm 优先:内核支持 forkExtract → 复用上一轮缓存前缀抽取;否则冷兜底。
        { tryFork: () => tryKernelForkExtract({ sid: this.sid, agentPath: emitterId }) },
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(emitterId, undefined, `auto-extract: ${msg}`);
      });
    });
  }

  // ─── delegate_to_subagent → auto-completion-callback ─────────────────────

  /** When a teammate that the delegator handed work to via
   *  `delegate_to_subagent` finishes its turn, push a `message` back to the
   *  delegator so it can react in its next turn — agentic_os MessageBus
   *  auto-deliver pattern (sub-agent → parent on turn-end). Without this the
   *  delegator never learns the sub-agent finished; user complaint
   *  "主 agent 不知道". The pending entry is created by the tool and consumed
   *  here on the first `hook:turnEnd` emitted by the sub-agent. */
  private _bindDelegationCallback(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (!emitterId) return;

      // Capture every agent's latest assistant text so a completion callback
      // can relay the teammate's actual output (not just "done"). Cheap string
      // write per turn; kept for all agents since `delegations` membership can
      // change between the message and turn-end.
      if (event.type === "hook:assistantMessage") {
        const text = extractAssistantText(event.payload);
        if (text) this.latestAssistantText.set(emitterId, text);
        return;
      }

      if (event.type !== "hook:turnEnd") return;
      const payload = (event.payload ?? {}) as { aborted?: boolean; error?: string; stopReason?: string };
      this._resolveDelegation(emitterId, { aborted: payload.aborted, error: payload.error });
    });
  }

  /** Resolve (and remove) a pending delegation targeting `targetAgentPath`,
   *  relaying a completion/abort message back to the delegator. Two call
   *  sites: `_bindDelegationCallback`'s `hook:turnEnd` observer (normal
   *  completion) and the Scheduler's `onAgentDetached` hook (target shut
   *  down / restarted / removed / crashed while a delegation was still
   *  pending for it). Without the second call site `hook:turnEnd` never
   *  fires for a target that's gone, so the `delegations` entry leaks
   *  forever and permanently blocks future delegations to that path via
   *  `delegationGuard`'s target-busy check. */
  private _resolveDelegation(
    targetAgentPath: string,
    outcome: { aborted?: boolean; error?: unknown },
  ): void {
    const info = this.delegations.get(targetAgentPath);
    if (!info) return;
    this.delegations.delete(targetAgentPath);
    const status = outcome.aborted ? "取消" : outcome.error ? "失败" : "完成";
    const detail = outcome.error ? `（错误：${String(outcome.error).slice(0, 120)}）` : "";
    // Relay the teammate's actual final output so the delegator can act on it
    // directly (e.g. apply tsumugi's verify report) instead of stalling to
    // ask the user to paste it back. Trim to keep the delegator's context
    // bounded; the full transcript still lives in the teammate's ledger.
    const result = outcome.aborted ? "" : (this.latestAssistantText.get(targetAgentPath) ?? "");
    this.latestAssistantText.delete(targetAgentPath);
    const MAX = 8000;
    const resultBlock = result
      ? `\n\n--- ${targetAgentPath} 的产出 ---\n${result.length > MAX ? result.slice(0, MAX) + "\n…（已截断，完整内容见该 agent 的对话）" : result}`
      : "";
    // emit (not publish) — `to` routes the event into the delegator's
    // per-agent queue. Without queue routing the delegator's run-loop
    // (waitForEvent → drainQueue) never wakes and the message is lost.
    // durability: "required" — the delegator's queue can independently fill
    // up with ordinary UI/tool messages; this callback must not be FIFO-
    // evicted along with them, or the delegator never learns the teammate
    // finished (see EventQueue's MAX_EVENTS overflow eviction).
    this.eventBus.emit(
      {
        source: "agent",
        type: "message",
        payload: {
          content: `✓ ${targetAgentPath} ${status}了你交办的任务${detail}：${info.brief}${resultBlock}`,
          fromAgent: targetAgentPath,
        },
        to: info.delegator,
        handoff: "turn",
        durability: "required",
        ts: Date.now(),
      },
      targetAgentPath,
    );
  }

  // ─── EventBus → agent_command routing ────────────────────────────────────

  /** 镜像 agenteam ref `attachSchedulerListeners`：观察总线上的 `agent_command`
   *  事件，把它桥到 `scheduler.getAgent(to).queueCommand(...)`。target 优先取
   *  `event.to`，缺省回退到 `payload.agentId` —— UI 发的事件通常用 payload.agentId
   *  避免触发 EventBus.route() 的 inbound message 路径（payload 模式是纯 metadata
   *  容器，不会被 route() 转发到目标 queue）。
   *
   *  duck-type 检查 `queueCommand` 函数存在 —— Session 不 import ConsciousAgent
   *  类型（plan §3.6：Session 不反向依赖 conscious-agent.ts），让 ScriptAgent /
   *  BaseAgent 静默 ignore 这种事件。 */
  private _bindAgentCommandRouting(): () => void {
    return this.eventBus.observe((event) => {
      if (event.type !== "agent_command") return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const targetPath =
        (event.to as string | undefined) ?? (payload.agentId as string | undefined);
      if (!targetPath) return;
      const agent = this.scheduler.getAgent(targetPath);
      if (!agent) return;
      const handler = (agent as unknown as { queueCommand?: unknown }).queueCommand;
      if (typeof handler !== "function") return;       // ScriptAgent etc.
      const toolName = payload.toolName as string | undefined;
      if (!toolName) return;
      const args = (payload.args as Record<string, string> | undefined) ?? {};
      const reason = (payload.reason as string | undefined) ?? undefined;
      const interrupt = (payload.interrupt as boolean | undefined) ?? true;
      try {
        (handler as (
          n: string,
          a: Record<string, string>,
          r: string | undefined,
          i: boolean,
        ) => void).call(agent, toolName, args, reason, interrupt);
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        this.logger.error(
          targetPath,
          undefined,
          `agent_command queueCommand "${toolName}" failed: ${msg}`,
        );
      }
    });
  }

  private readonly _busUnsubs: Array<() => void>;

  // ─── final settle → host-owned artifact resolution ──────────────────────

  private async _reconcileArtifactTurns(): Promise<void> {
    if (!this.artifactResolver) return;
    const paths = new Set<string>(this.ledgers.keys());
    for (const node of this.tree.list()) paths.add(node.path);

    for (const agentPath of paths) {
      let events: Array<import("../ledger/types").StoredEvent>;
      try {
        events = await this.getOrCreateLedger(agentPath).readAllEvents();
      } catch {
        continue;
      }

      const starts = new Map<string, {
        startedAt: number;
        checkpointMsgId?: string;
        eligible: boolean;
        waitingForInput: boolean;
      }>();
      const resolved = new Set<string>();
      const permissionAskCalls = new Set<string>();
      for (const event of events) {
        const payload = event.payload ?? {};
        if (event.type === "artifact:resolved" && typeof payload.artifactId === "string") {
          resolved.add(payload.artifactId);
          continue;
        }
        if (event.type === "hook:turnStart") {
          const turnId = typeof payload.turnId === "string" && payload.turnId
            ? payload.turnId
            : event.history?.turnId;
          if (!turnId) continue;
          starts.set(turnId, {
            startedAt: event.ts,
            ...(typeof payload.msgId === "string" ? { checkpointMsgId: payload.msgId } : {}),
            eligible: payload.artifactResolutionExpected !== false,
            waitingForInput: false,
          });
          continue;
        }
        if (event.type === "hook:toolCall") {
          const name = typeof payload.name === "string" ? payload.name : undefined;
          const turnId = event.history?.turnId ?? (typeof payload.turnId === "string" ? payload.turnId : undefined);
          if (turnId && name && canonicalToolName(name) === "ask_user") {
            const nested = payload.toolCall && typeof payload.toolCall === "object"
              ? payload.toolCall as Record<string, unknown>
              : undefined;
            const callId = typeof payload.callId === "string"
              ? payload.callId
              : typeof payload.toolCallId === "string"
                ? payload.toolCallId
                : typeof nested?.id === "string" ? nested.id : `anonymous:${event.ts}`;
            const pendingKey = `${turnId}:${callId}`;
            if (payload.permissionPrompt === true) permissionAskCalls.add(pendingKey);
            const start = starts.get(turnId);
            if (start) start.waitingForInput = true;
          }
          continue;
        }
        if (event.type === "hook:toolResult") {
          const turnId = event.history?.turnId ?? (typeof payload.turnId === "string" ? payload.turnId : undefined);
          if (turnId) {
            const start = starts.get(turnId);
            const callId = typeof payload.callId === "string"
              ? payload.callId
              : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
            const pendingKeys = [...permissionAskCalls].filter((key) => key.startsWith(`${turnId}:`));
            const matchedKey = callId
              ? `${turnId}:${callId}`
              : pendingKeys.length === 1 ? pendingKeys[0] : undefined;
            const permissionPrompt = matchedKey ? permissionAskCalls.has(matchedKey) : false;
            if (matchedKey) permissionAskCalls.delete(matchedKey);
            const resolved = permissionPrompt
              ? payload.error === undefined && payload.ok !== false
              : askToolResultResolved(payload);
            if (start && start.waitingForInput && !resolved) {
              // An expired/invalid Ask result is not a final settle. Keep the
              // turn blocked so recovery cannot manufacture an artifact.
              start.waitingForInput = true;
            } else if (start) {
              start.waitingForInput = false;
            }
          }
          continue;
        }
        if (event.type !== "hook:turnEnd") continue;
        const turnId = typeof payload.turnId === "string" && payload.turnId
          ? payload.turnId
          : event.history?.turnId;
        if (!turnId) continue;
        const start = starts.get(turnId);
        if (!start || !start.eligible || payload.artifactResolutionExpected === false) continue;
        const waitingForInput = payload.aborted !== true
          && (payload.waitingForInput === true || start.waitingForInput);
        if (waitingForInput) {
          // Keep the start record through an interaction checkpoint.  A
          // restarted session may see the eventual ask result and final
          // turn-end later in the same ledger; deleting it here would make
          // that recovery path permanently lose the artifact resolution.
          continue;
        }
        starts.delete(turnId);
        for (const key of permissionAskCalls) {
          if (key.startsWith(`${turnId}:`)) permissionAskCalls.delete(key);
        }
        const artifactId = stableArtifactId(this.sid, turnId, start.checkpointMsgId ?? (typeof payload.msgId === "string" ? payload.msgId : undefined));
        if (resolved.has(artifactId)) continue;
        void this._resolveArtifact({
          sid: this.sid,
          agentId: agentPath,
          projectRoot: this.artifactProjectRoot(),
          ...(this.config.defaultDir ? { game: this.config.defaultDir } : {}),
          turnId,
          ...((start.checkpointMsgId ?? (typeof payload.msgId === "string" ? payload.msgId : undefined))
            ? { checkpointMsgId: start.checkpointMsgId ?? (payload.msgId as string) }
            : {}),
          startedAt: start.startedAt,
          settledAt: event.ts,
          ...(typeof event.seq === "number" ? { anchorSeq: event.seq } : {}),
          ...(payload.aborted === true ? { aborted: true } : {}),
          ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        });
      }
    }
  }

  /** Observe the lifecycle boundary only. File attribution remains in the
   * resolver, which can use the checkpoint CAS and the WAL as its two sources
   * of truth; this observer must not inspect the workspace itself. */
  private _bindArtifactResolution(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (!emitterId || !this.artifactResolver) return;

      if (event.type === "hook:turnStart") {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const turnId = typeof payload.turnId === "string" && payload.turnId
          ? payload.turnId
          : `legacy:${event.ts}`;
        const checkpointMsgId = typeof payload.msgId === "string" && payload.msgId
          ? payload.msgId
          : undefined;
        this.artifactTurns.set(emitterId, {
          turnId,
          ...(checkpointMsgId ? { checkpointMsgId } : {}),
          startedAt: event.ts,
          eligible: payload.artifactResolutionExpected !== false,
        });
        this.activeTurnIds.set(emitterId, turnId);
        return;
      }

      if (event.type === "hook:toolCall") {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const nested = payload.toolCall && typeof payload.toolCall === "object"
          ? payload.toolCall as Record<string, unknown>
          : undefined;
        const name = typeof payload.name === "string"
          ? payload.name
          : typeof nested?.name === "string" ? nested.name : undefined;
        if (name && canonicalToolName(name) === "ask_user") {
          const callId = typeof payload.callId === "string"
            ? payload.callId
            : typeof payload.toolCallId === "string"
              ? payload.toolCallId
              : typeof nested?.id === "string" ? nested.id : `anonymous:${event.ts}`;
          this.pendingAskCalls.add(`${emitterId}:${callId}`);
          if (payload.permissionPrompt === true) this.permissionAskCalls.add(`${emitterId}:${callId}`);
        }
        return;
      }

      if (event.type === "hook:toolResult") {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const callId = typeof payload.callId === "string"
          ? payload.callId
          : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        const turn = this.artifactTurns.get(emitterId);
        const pendingKeys = [...this.pendingAskCalls].filter((key) => key.startsWith(`${emitterId}:`));
        const matchedKeys = callId
          ? this.pendingAskCalls.has(`${emitterId}:${callId}`) ? [`${emitterId}:${callId}`] : []
          : pendingKeys;
        const matchedPending = matchedKeys.length > 0;
        const permissionPrompt = matchedKeys.length === 1 && this.permissionAskCalls.has(matchedKeys[0]!);
        const askResult = permissionPrompt
          ? payload.error === undefined && payload.ok !== false
          : askToolResultResolved(payload);
        for (const key of matchedKeys) {
          this.pendingAskCalls.delete(key);
          this.permissionAskCalls.delete(key);
        }
        if (turn && matchedPending) turn.waitingForInput = !askResult;
        return;
      }

      if (event.type !== "hook:turnEnd") return;
      const turn = this.artifactTurns.get(emitterId);
      if (!turn) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (!turn.eligible || payload.artifactResolutionExpected === false) {
        this.artifactTurns.delete(emitterId);
        this.activeTurnIds.delete(emitterId);
        return;
      }
      const waitingForInput = payload.aborted !== true && (payload.waitingForInput === true
        || turn.waitingForInput === true
        || [...this.pendingAskCalls].some((key) => key.startsWith(`${emitterId}:`)));
      if (waitingForInput) {
        // This is an interaction checkpoint, not a final settle. Keep the
        // turn open so the eventual ask reply gets one artifact resolution.
        turn.waitingForInput = true;
        return;
      }

      this.artifactTurns.delete(emitterId);
      this.activeTurnIds.delete(emitterId);
      for (const key of this.pendingAskCalls) {
        if (key.startsWith(`${emitterId}:`)) this.pendingAskCalls.delete(key);
      }
      for (const key of this.permissionAskCalls) {
        if (key.startsWith(`${emitterId}:`)) this.permissionAskCalls.delete(key);
      }
      const context: ArtifactTurnContext = {
        sid: this.sid,
        agentId: emitterId,
        projectRoot: this.artifactProjectRoot(),
        ...(this.config.defaultDir ? { game: this.config.defaultDir } : {}),
        turnId: turn.turnId,
        ...(turn.checkpointMsgId ? { checkpointMsgId: turn.checkpointMsgId } : {}),
        ...(typeof event.seq === "number" ? { anchorSeq: event.seq } : {}),
        startedAt: turn.startedAt,
        settledAt: event.ts,
        ...(payload.aborted === true ? { aborted: true } : {}),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      };
      void this._resolveArtifact(context);
    });
  }

  private _resolveArtifact(context: ArtifactTurnContext): Promise<void> {
    const artifactId = stableArtifactId(context.sid ?? this.sid, context.turnId, context.checkpointMsgId);
    const existing = this.artifactResolutionInFlight.get(artifactId);
    if (existing) return existing;

    const work = (async () => {
      let payload: ArtifactResolvedPayload;
      try {
        payload = await this.artifactResolver!.resolveTurn(context);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(context.agentId, undefined, `artifact resolution failed: ${reason}`);
        const summary: ArtifactSummary = {
          id: artifactId,
          sid: context.sid ?? this.sid,
          turnId: context.turnId,
          ...(context.checkpointMsgId ? { checkpointMsgId: context.checkpointMsgId } : {}),
          files: [],
          status: "unavailable",
          derivedUnavailable: true,
          unavailableReason: reason,
          reliableCandidatePaths: [],
          agents: [context.agentId],
          durationMs: Math.max(0, context.settledAt - context.startedAt),
        };
        payload = {
          schemaVersion: 1,
          artifactId,
          turnId: context.turnId,
          ...(context.checkpointMsgId ? { checkpointMsgId: context.checkpointMsgId } : {}),
          ...(context.anchorSeq !== undefined ? { anchorSeq: context.anchorSeq } : {}),
          resolution: { kind: "unavailable", reason, reliableCandidatePaths: [], summary },
        };
      }

      const ledger = this.getOrCreateLedger(context.agentId);
      const prior = await ledger.readAllEvents();
      if (prior.some((event) => event.type === "artifact:resolved" && event.payload?.artifactId === payload.artifactId)) return;

      const event: Event = {
        type: "artifact:resolved",
        source: "host:artifact-deriver",
        ts: Date.now(),
        payload: payload as unknown as Record<string, unknown>,
      };
      // Append confirmation comes before live broadcast. The persistence
      // observer below skips this host-owned source to avoid a second WAL row.
      ledger.append(event, context.agentId, {
        eventId: `artifact:${payload.artifactId}`,
        turnId: payload.turnId,
      });
      this.eventBus.publish(event, context.agentId);
    })().finally(() => {
      if (this.artifactResolutionInFlight.get(artifactId) === work) {
        this.artifactResolutionInFlight.delete(artifactId);
      }
    });
    this.artifactResolutionInFlight.set(artifactId, work);
    return work;
  }

  // ─── EventBus → ledger persistence ───────────────────────────────────────

  /** 镜像 agenteam ref `session-manager._bindEventBus`：所有跟某个 agent 关联的
   *  event（emitterId === agent || event.to === agent）落到该 agent 的 ledger。
   *  stream chunk 类高频事件（type 以 `stream:` 开头）跳过。同步写盘（不 defer）确保
   *  buildPrompt 在同一 async tick 内读到当前 turn 的 inbound_message。 */
  private _bindLedgerPersistence(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (event.type.startsWith("stream:")) return;
      // file-activity:* 是给 UI / file-activity-ledger 的信号事件，不是对话事件 ——
      // 已经写入 `<sid>/file-activity.jsonl`，再写一份到 per-agent EventLedger 只
      // 是双倍噪声 + LLM 历史污染。用专门的 LLM slot（file-activity-recent）按需
      // 注入，比每个 write 自动塞 prompt 更可控。
      if (event.type.startsWith("file-activity:")) return;
      // `_resolveArtifact` appends its WAL row synchronously before publishing
      // the live event. Re-appending here would make replay show duplicates.
      if (event.type === "artifact:resolved" && event.source === "host:artifact-deriver") return;

      if (event.type === "hook:turnStart" && emitterId) {
        const turnId = (event.payload as Record<string, unknown> | undefined)?.turnId;
        if (typeof turnId === "string" && turnId) this.activeTurnIds.set(emitterId, turnId);
      }

      const candidates: string[] = [];
      if (emitterId && this.tree.get(emitterId)) candidates.push(emitterId);
      if (event.to && event.to !== "*" && event.to !== emitterId && this.tree.get(event.to as string)) {
        candidates.push(event.to as string);
      }
      if (candidates.length === 0) return;

      if (this.disposed) return;
      if (event.to && event.isBlocked?.()) return;
      for (const agentPath of candidates) {
        try {
          const turnId = this.activeTurnIds.get(agentPath);
          this.getOrCreateLedger(agentPath).append(
            event,
            emitterId,
            turnId ? { turnId } : undefined,
          );
        } catch (err) {
          const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
          this.logger.error(agentPath, undefined, `WAL append "${event.type}" failed: ${msg}`);
        }
      }
      if (event.type === "hook:turnEnd" && emitterId) this.activeTurnIds.delete(emitterId);
    });
  }

  // ─── Per-agent ledger lookup ─────────────────────────────────────────────

  /** Lazy-init per-agent ledger。SessionManager / agentFactory 可以提前 prime。 */
  getOrCreateLedger(agentPath: string): EventLedger {
    let ledger = this.ledgers.get(agentPath);
    if (!ledger) {
      ledger = new EventLedger(this.sid, agentPath, this.init.paths);
      this.ledgers.set(agentPath, ledger);
    }
    return ledger;
  }

  // ─── External-state cleanup hook for Scheduler ───────────────────────────

  /** Called by Scheduler.controlAgent("remove") via onAgentFreed callback. Wipes
   *  the agent's blackboard namespace + drops its ledger from the map. We do NOT
   *  rm the agent dir / ledger file —— that belongs to a future fs-mutation
   *  command path（`destroy_subagent`）, not Scheduler's lifecycle removal. */
  freeAgentState(agentPath: string): void {
    this.blackboard.removeAll(agentPath);
    this.ledgers.delete(agentPath);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Soft dispose —— SessionManager.close 调，**不**删盘。
   *
   *  顺序对齐 ref `Scheduler.destroyRuntime`（agenteam-os-ref scheduler.ts:470）：
   *    1. _busUnsub                    ← 先停 ledger persistence observer
   *    2. scheduler.shutdown()         ← ref `shutdownAll`，等 agents 全停
   *    3. kitReloadCoordinator.stopWatching()
   *    4. tree.dispose()               ← ref `agentTree.stopWatching`
   *    5. blackboard.flush() + ledgers.clear()
   *    6. logger.close()               ← ref destroyRuntime 最后一步
   *
   *  注意：console emitter 在 SessionManager 级 attach（process-singleton），
   *  SM 关 last session 时统一 `detachConsoleEventEmitter`；Session 自己不动
   *  全局 console bridge，避免抢其他 live session 的 slot。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (let i = this._busUnsubs.length - 1; i >= 0; i--) this._busUnsubs[i]();
    await this.scheduler.shutdown();
    this.kitReloadCoordinator.stopWatching();
    await this.tree.dispose();
    this.blackboard.flush();
    this.ledgers.clear();
    this.fileActivity.dispose();
    this.fileLocks.clear();
    clearRememberedForSession(this.sid); // 清本会话的工具审批 remember(不跨会话残留)
    clearUiStateForSession(this.sid); // 清本会话的 UI 语义操作层 lease + manifest 缓存
    await this.logger.close();
  }
}
