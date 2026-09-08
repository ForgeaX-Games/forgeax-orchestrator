/** Session —— per-sid 容器：bus / blackboard / RuntimeTree / EventStores / Supervisor。
 *
 *  与 agenteam ref 的差异（plan §2.0 / §2.1 / §3.1.1）：
 *  - forgeax 的 sid 对应一棵统一 RuntimeTree；resident/ephemeral 都在其中。
 *  - Session 不持第二套 start/stop 状态；RuntimeSupervisor 是唯一生命周期入口。
 *  - abort 解析为 instanceId 后交给 RuntimeController；Session 不持 AbortController。
 *  - **不维护 client attach 计数**：哪个 ws 连着哪个 sid 由外层（WsHub / 单独 status
 *    API）查；Session 不背任何 ref-count，订阅直接 `session.eventBus.observe(handler)`。
 *  - **sandbox 不挂 Session**：由 SandboxManager 按 `defaultDir` 池化共享，first
 *    tool exec 时 lazy acquire，与 Session 解耦。
 *  - KernelTurnExecutor 按需构造无生命周期的 RuntimeAgentHost。
 *
 *  字段（plan §2.1）：
 *  - sid / paths / config / blackboard / eventBus / tree / stores → dispose */

import { Blackboard } from "./blackboard";
import { EventBus } from "./event-bus";
import { LiveTurnTracker } from "./live-turn-tracker";
import { EventLedger } from "../ledger/event-ledger";
import { FileActivityLedger } from "../ledger/file-activity-ledger";
import type { FileLockMap } from "../fs/agent-fs-recorder";
import { bindSystemEventLog } from "../ledger/system-event-log";
import { Logger } from "./logger";
import type { Event, SessionConfig, ModelsConfig } from "./types";
import type { PathManagerAPI, SessionLayerAPI } from "../fs/types";
import { clearRememberedForSession } from "../kernel/tool-approval";
import { requestToolApproval } from "../kernel/tool-approval";
import { checkKernelTool } from "../kernel/trust-gate";
import { loadSettingsPermissionRules } from "../api/lib/permission-settings";
import { resolveTemplateTrust } from "../agents/agent-template-catalog";
import { clearUiStateForSession } from "../api/lib/ui-manifest-registry";
import { runAutoExtract } from "../soul/auto-extract";
import { tryKernelForkExtract } from "../soul/fork-extract";
import { resolveKernel } from "../kernel/resolve-kernel";
import { canonicalToolName } from "../kernel/canonical-tool-name";
import { isAbsolute, relative, sep } from "node:path";
import { AgentTemplateCatalog } from "../agents/agent-template-catalog";
import { ResidentDefinitionStore } from "../agents/resident-definition-store";
import {
  registerResidentDefinition,
  registerResidentDefinitions,
} from "../agents/resident-template-adapter";
import { resolveExternalAgentTemplate } from "../agents/loader";
import { ensureAgentScaffold, isValidAgentName } from "./agent-scaffold";
import { SessionEventPaths } from "../ledger/session-event-paths";
import { MemoryTemplateRegistry } from "../runtime/agent-template-locator";
import { AgentRegistrar } from "../runtime/agent-registrar";
import { EphemeralAgentSpawner } from "../runtime/ephemeral-agent-spawner";
import { KernelTurnExecutor } from "../runtime/kernel-turn-executor";
import { RuntimeAgentTreeAdapter } from "../runtime/runtime-agent-tree-adapter";
import { RuntimeSupervisor } from "../runtime/runtime-supervisor";
import { RuntimeTree } from "../runtime/runtime-tree";
import type { AgentHandle } from "../runtime/agent-handle";
import type { SpawnEphemeralRequest } from "../runtime/ephemeral-agent-spawner";
import { existsSync, mkdirSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { AgentKitReloadCoordinator } from "../kits/reload-coordinator";
import { createOrGetFSWatcher } from "../fs/watcher";
import { FileSystemTemplateSource } from "../agents/filesystem-template-source";
import { MemoryTemplateSource } from "../agents/memory-template-source";
import type {
  AgentTemplateDraft,
  TemplateRef,
} from "../agents/template-types";
import { recoverAbandonedEphemeralHistories } from "../ledger/ephemeral-history-recovery";
import type { RuntimeAgentHost } from "../runtime/runtime-agent-host";
import type { RuntimeConfigSnapshot } from "../runtime/runtime-config";
import type { RuntimeToolContext } from "../runtime/runtime-context";
import { defaultProjectRoot } from "@forgeax/platform-io";
import { Scheduler } from "./scheduler";
import { ConsciousAgent } from "./conscious-agent";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import type { ArtifactResolver, ArtifactTurnContext } from "../orchestration-seams";
import type { ArtifactResolvedPayload, ArtifactSummary } from "@forgeax/types/artifact-summary";
import { getArtifactResolver } from "../orchestration-seams";
import { createHash } from "node:crypto";

/** One pending delegate_to_subagent awaiting the sub-agent's turn-end.
 *  Keyed by sub-agent's `agentPath` (e.g. "suzu"). */
export interface DelegationInfo {
  /** The agent that called delegate_to_subagent (e.g. "forge"). */
  delegator: string;
  /** First ~80 chars of the brief, for the callback message. */
  brief: string;
  /** ms — used to GC stale entries if turn-end never fires. */
  ts: number;
  /** Stable identity of the delegated delivery, not merely the target address. */
  delegationId?: string;
  /** Runtime identity captured before delivery. */
  targetInstanceId?: string;
  targetRuntimeEpochId?: string;
  /** Source event and expected host turn identity. */
  sourceEventId?: string;
  turnId?: string;
}

/** Thrown by `Session.ensureResidentAgent` so HTTP callers can map
 *  persona-not-found → 404, duplicate registration → 409, I/O/catalog
 *  failures → 500 without string-matching error messages. */
export class AgentMaterializationError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 500,
  ) {
    super(message);
    this.name = "AgentMaterializationError";
  }
}

export interface SessionInitConfig {
  sid: string;
  paths: PathManagerAPI;
  config: SessionConfig;
  artifactResolver?: ArtifactResolver;
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
    const envelope = source as {
      ok?: unknown;
      questions?: unknown;
      text?: unknown;
      structuredContent?: unknown;
    };
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
    return Array.isArray(values)
      && values.some((item) => typeof item === "string" && item.trim().length > 0);
  });
}

function askToolResultResolved(payload: Record<string, unknown>): boolean {
  if (typeof payload.error === "string" && payload.error) return false;
  return askResultHasAnswer(payload.result ?? payload.resultData);
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

export class Session {
  readonly sid: string;
  readonly paths: SessionLayerAPI;
  config: SessionConfig;

  readonly blackboard: Blackboard;
  readonly eventBus: EventBus;
  /** 在途 turn 累积 —— WsHub 给新连接发 turn-snapshot 用(多 tab 同步 §4.3)。 */
  readonly liveTurns: LiveTurnTracker;
  readonly runtimeTree: RuntimeTree;
  readonly tree: RuntimeAgentTreeAdapter;
  readonly templateCatalog: AgentTemplateCatalog;
  readonly memoryTemplates: MemoryTemplateRegistry;
  readonly eventPaths: SessionEventPaths;
  readonly registrar: AgentRegistrar;
  readonly supervisor: RuntimeSupervisor;
  /** Legacy lifecycle projection retained for older kit/scaffold consumers;
   * new runtime work must use supervisor/tree instance APIs. */
  readonly scheduler: Scheduler;
  readonly kitReloadCoordinator: AgentKitReloadCoordinator;

  /** Compatibility projection for artifact delivery consumers. */
  artifactProjectRoot(): string {
    try {
      const root = this.init.paths.sessionWorkDir(this.sid);
      if (root && isAbsolute(root)) return root;
    } catch {
      // Generic/legacy sessions have no bound project root.
    }
    return defaultProjectRoot();
  }

  /** Per-Session logger —— 落到 `<sid>/logs/debug.log` 全量 + `<sid>/logs/latest.log`
   *  INFO+。覆盖：Session plumbing 错误 / EventBus → log 桥 / agent plumbing
   *  事件。跟 EventLedger 是两条不同的轨：ledger 是 LLM context 真相，logger
   *  是运维 / 观测真相。 */
  readonly logger: Logger;

  /** Address-indexed compatibility ledgers；实例 EventStore 才是持久化 owner。 */
  readonly ledgers = new Map<string, EventLedger>();

  /** Per-session **file-activity** ledger —— SSOT for "who touched what".
   *  Wired into RuntimeAgentHost: every wrapped `ctx.fs` mutation appends one
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

  /** Host-owned final-settle artifact derivation.  RuntimeTree owns the live
   * instance lifecycle, while these maps retain only the per-address turn
   * boundary needed to derive one artifact after the turn is settled. */
  private readonly artifactResolver?: ArtifactResolver;
  private readonly artifactTurns = new Map<string, {
    turnId: string;
    checkpointMsgId?: string;
    startedAt: number;
    eligible: boolean;
    waitingForInput?: boolean;
  }>();
  private readonly pendingAskCalls = new Set<string>();
  private readonly permissionAskCalls = new Set<string>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly artifactResolutionInFlight = new Map<string, Promise<void>>();

  private disposed = false;
  private readonly residentTemplateRefs = new Set<TemplateRef>();
  /** Per-agent single-flight for lazy persona materialization. */
  private readonly residentMaterializations = new Map<string, Promise<string>>();

  constructor(private readonly init: SessionInitConfig) {
    this.sid = init.sid;
    this.paths = init.paths.session(init.sid);
    this.config = init.config;
    this.artifactResolver = init.artifactResolver ?? getArtifactResolver();

    this.blackboard = new Blackboard(this.paths.root() + "/blackboard.json");
    this.blackboard.loadFromDisk();

    this.fileActivity = new FileActivityLedger(this.paths.root(), this.paths.fileActivityLog());

    this.logger = new Logger({
      debugLogPath: this.paths.debugLogFile(),
      latestLogPath: this.paths.latestLogFile(),
    });

    this.eventBus = new EventBus();
    this.liveTurns = new LiveTurnTracker(this.eventBus);
    this.runtimeTree = new RuntimeTree(this.sid);
    this.tree = new RuntimeAgentTreeAdapter(this.sid, this.runtimeTree);
    this.kitReloadCoordinator = new AgentKitReloadCoordinator(
      this.sid,
      createOrGetFSWatcher(),
      init.paths,
      async (instance, revision, kinds) => {
        const store = this.supervisor.getEventStore(instance.instanceId);
        if (!store) return;
        await store.append(
          this.registrar.eventFactory.agent(
            instance,
            "agent.execution_revision_staged",
            { revision, kinds: [...kinds] },
          ),
          "required",
        );
        await store.flush();
        this.eventBus.publish(
          {
            source: "runtime",
            type: "runtime:template-revision",
            payload: {
              sid: this.sid,
              agentInstanceId: instance.instanceId,
              runtimeEpochId: instance.runtimeEpochId,
              templateRef: instance.templateRef,
              revision,
              kinds: [...kinds],
            },
            ts: Date.now(),
          },
          this.tree.addressOf(instance),
        );
      },
    );
    this.templateCatalog = new AgentTemplateCatalog();
    this.memoryTemplates = new MemoryTemplateRegistry();
    this.eventPaths = new SessionEventPaths(
      this.paths.root(),
      this.config.runtimeEventsRoot ?? "runtime-events",
    );
    let sessionCwd: string | undefined;
    try {
      const resolved = init.paths.sessionWorkDir(this.sid);
      if (resolved && existsSync(resolved)) sessionCwd = resolved;
    } catch {
      // Invalid/missing binding falls back to the instance template root.
    }
    this.registrar = new AgentRegistrar(
      this.sid,
      this.templateCatalog,
      this.memoryTemplates,
      this.runtimeTree,
      this.eventPaths,
      (instance, eventStore) => new KernelTurnExecutor(
        instance,
        eventStore,
        {
          eventBus: this.eventBus,
          blackboard: this.blackboard,
          tree: this.tree,
          ...(sessionCwd ? { sessionCwd } : {}),
          sessionDefaultModels: this.config.defaultModels,
          fileRecorder: {
            ledger: this.fileActivity,
            locks: this.fileLocks,
            emit: (record, kind) => {
              this.eventBus.publish(
                {
                  source: `agent:${record.agentPath}`,
                  type: `file-activity:${kind}` as const,
                  payload: record as unknown as Record<string, unknown>,
                  ts: record.ts,
                },
                record.agentPath,
              );
            },
          },
          onAgentReady: (agent) =>
            this.kitReloadCoordinator.registerAgent(instance, agent),
          onAgentDisposed: () =>
            this.kitReloadCoordinator.unregisterAgent(instance.instanceId),
          authorizeTool: (toolName, args) =>
            this.authorizeRuntimeTool(instance, toolName, args),
          flushExecutionReloads: () =>
            this.kitReloadCoordinator.flushReloads().then(() => undefined),
          runtimeToolContext: this.runtimeToolContextFor(instance),
        },
      ),
    );
    const spawner = new EphemeralAgentSpawner(
      this.templateCatalog,
      this.memoryTemplates,
      this.registrar,
      sessionCwd ?? this.paths.root(),
    );
    this.supervisor = new RuntimeSupervisor({
      sid: this.sid,
      workspaceRoot: sessionCwd ?? this.paths.root(),
      tree: this.runtimeTree,
      registrar: this.registrar,
      spawner,
      memoryTemplates: this.memoryTemplates,
      removeRuntimeState: (instanceId) =>
        this.eventPaths.removeRuntimeState(instanceId),
    });
    this.scheduler = new Scheduler({
      sid: this.sid,
      eventBus: this.eventBus,
      tree: this.tree,
      agentFactory: async (agentPath) => {
        const layer = this.paths.agent(agentPath);
        const runtimeInstance = this.tree.resolve(agentPath);
        let agentJson = AGENT_DEFAULTS;
        try {
          agentJson = {
            ...AGENT_DEFAULTS,
            ...(JSON.parse(readFileSync(layer.agentJson(), "utf8")) as Record<string, unknown>),
          } as typeof AGENT_DEFAULTS;
        } catch {
          // Legacy callers are allowed to attach a scaffold with no valid JSON.
        }
        return new ConsciousAgent({
          agentPath,
          agentDir: layer.root(),
          agentJson,
          eventBus: this.eventBus,
          blackboard: this.blackboard,
          tree: this.tree,
          sid: this.sid,
          ledger: this.getOrCreateLedger(agentPath),
          sessionDefaultModels: this.config.defaultModels,
          ...(runtimeInstance
            ? {
                runtime: this.runtimeToolContextFor(runtimeInstance),
                runtimeStateRoot: runtimeInstance.runtime.runtimeStateRoot,
              }
            : {}),
        });
      },
      onAgentDetached: async (agentPath) => {
        this.finishDelegationsForTarget(agentPath);
        for (const key of this.pendingAskCalls) {
          if (key.startsWith(`${agentPath}:`)) this.pendingAskCalls.delete(key);
        }
        for (const key of this.permissionAskCalls) {
          if (key.startsWith(`${agentPath}:`)) this.permissionAskCalls.delete(key);
        }
        if (!this.liveTurns.snapshots().some((turn) => turn.emitterId === agentPath)) {
          this.artifactTurns.delete(agentPath);
          this.activeTurnIds.delete(agentPath);
        }
        if (this.liveTurns.snapshots().some((turn) => turn.emitterId === agentPath)) {
          this.eventBus.publish(
            {
              source: `agent:${agentPath}`,
              type: "hook:turnEnd",
              payload: { aborted: true, synthesized: true },
              ts: Date.now(),
            },
            agentPath,
          );
        }
      },
      onAgentFreed: (agentPath) => this.freeAgentState(agentPath),
    });
    // 三条独立 observer：
    //   1) per-agent ledger persistence（对齐 ref `_bindEventBus`）—— 把跟某 agent
    //      关联的事件落到该 agent 的 events.jsonl。
    //   2) `agent_command` routing —— UI / CLI 发到明确 RuntimeTree 节点，
    //      observer 只负责转交给该实例唯一的 RuntimeController。
    //   3) per-session "headless" event log（对齐 ref `system-event-log`）——
    //      没 owner、没 to 的事件（agent_added/removed、default_dir_changed、
    //      partial_boundary、compact_boundary 等）落到 `<sid>/global-events.jsonl`。
    // 顺序无关；dispose 时按注册逆序 unsub。
    this._busUnsubs = [
      this._bindLedgerPersistence(),
      this._bindArtifactResolution(),
      this._bindAgentCommandRouting(),
      this._bindRuntimeTreeEvents(),
      this._bindDelegationCallback(),
      this._bindAutoExtract(),
      bindSystemEventLog(this.eventPaths.globalFile(), this.eventBus),
      () => this.liveTurns.dispose(),
    ];
    queueMicrotask(() => { void this._reconcileArtifactTurns(); });
  }

  async resolveArtifactTurn(context: ArtifactTurnContext): Promise<void> {
    await this._resolveArtifact(context);
  }

  /** One-shot resident bootstrap. Files prove identity; RuntimeTree proves life. */
  async initializeRuntime(): Promise<void> {
    mkdirSync(this.paths.agentsDir(), { recursive: true });
    await recoverAbandonedEphemeralHistories(this.sid, this.paths.root());
    await this._bootstrapResidentDefinitions();
    // RuntimeTree and the address-indexed ledgers are populated by the
    // bootstrap above.  Reconcile here as well as on construction so a
    // reopen cannot miss terminal events that were already on disk before the
    // asynchronous Session construction completed.
    await this._reconcileArtifactTurns();
  }

  async reloadRuntime(): Promise<void> {
    await this.supervisor.resetResidentsForReload();
    for (const templateRef of this.residentTemplateRefs) {
      this.templateCatalog.unregister(templateRef);
    }
    this.residentTemplateRefs.clear();
    this.ledgers.clear();
    await this._bootstrapResidentDefinitions();
  }

  private async _bootstrapResidentDefinitions(): Promise<void> {
    const definitions = ResidentDefinitionStore.scan(
      this.sid,
      this.paths.agentsDir(),
    );
    const prepared = await registerResidentDefinitions(
      this.templateCatalog,
      definitions,
    );
    for (const resident of prepared) {
      this.residentTemplateRefs.add(resident.templateRef);
    }
    const residents = await this.supervisor.bootstrapResidents(prepared);
    this.eventBus.publish({
      source: "runtime",
      type: "runtime:tree-reloaded",
      payload: {
        sid: this.sid,
        residentCount: residents.length,
        instanceIds: residents.map((instance) => instance.instanceId),
      },
      ts: Date.now(),
    });
  }

  spawnEphemeral(request: SpawnEphemeralRequest): Promise<AgentHandle> {
    return this.supervisor.spawnEphemeral(request);
  }

  /** Build the one instance-bound lifecycle authority shared by RuntimeAgentHost
   * and the legacy Scheduler compatibility projection. The latter may expose a
   * BaseAgent context to older kits, but it must still delegate creation and
   * delivery through RuntimeSupervisor rather than owning a second topology. */
  private runtimeToolContextFor(
    instance: import("../runtime/types").AgentInstance,
  ): RuntimeToolContext {
    return {
      sid: instance.sid,
      instanceId: instance.instanceId,
      runtimeEpochId: instance.runtimeEpochId,
      templateRef: instance.templateRef,
      workspaceRoot: instance.runtime.workspaceRoot,
      createChild: async (templateRef) => {
        const handle = await this.spawnEphemeral({
          parentInstanceId: instance.instanceId,
          templateRef,
        });
        return { instanceId: handle.instanceId };
      },
      sendToAgent: async (agentAddress, input) => {
        const target = this.tree.resolve(agentAddress);
        if (!target) {
          throw new Error(`runtime agent not found: ${agentAddress}`);
        }
        const targetAddress = this.tree.addressOf(target);
        const event = isRuntimeEvent(input)
          ? { ...input, to: targetAddress }
          : {
              source: `agent:${this.tree.addressOf(instance)}`,
              type: "user_input",
              payload: {
                content:
                  typeof input === "string"
                    ? input
                    : JSON.stringify(input ?? ""),
              },
              to: targetAddress,
              handoff: "turn" as const,
              ts: Date.now(),
            };
        // acceptTurn is the synchronous delivery receipt. Completion remains
        // host-owned so a tool does not wait for the target's full turn.
        const completion = this.supervisor.acceptTurn(target.instanceId, event);
        this.eventBus.publish(event, this.tree.addressOf(instance));
        void completion.catch((error) => {
          this.logger.error(
            targetAddress,
            undefined,
            `runtime target turn failed after accepted delivery: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      },
      listChildren: () =>
        this.runtimeTree.childrenOf(instance.instanceId).map((child) => ({
          instanceId: child.instanceId,
          templateRef: child.templateRef,
          lifetime: child.lifetime,
          state: child.state,
        })),
      listTemplates: () =>
        this.templateCatalog.list().map((entry) => ({
          templateRef: entry.templateRef,
          entryId: entry.entryId,
        })),
      ensureResident: (agentId, options) => this.ensureResidentAgent(agentId, options),
    };
  }

  /** Authorize a command injected by the control plane before RuntimeAgentHost
   * emits a tool-call or invokes any ToolDefinition. The live instance's
   * catalog registration is the trust authority; visibility is checked by the
   * host against the same per-instance ToolRegistry immediately before this
   * callback. */
  private async authorizeRuntimeTool(
    instance: import("../runtime/types").AgentInstance,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const trustTier = resolveTemplateTrust(
      this.templateCatalog,
      instance.templateRef,
    );
    const projectRoot = defaultProjectRoot();
    const decision = checkKernelTool(trustTier, toolName, {
      args,
      projectRoot,
      activeGame: this.config.defaultDir,
      sid: this.sid,
      rules: loadSettingsPermissionRules(projectRoot),
    });
    if (decision.outcome === "deny") {
      throw new Error(decision.reason ?? `agent command denied: ${toolName}`);
    }
    if (decision.outcome === "ask") {
      const approved = await requestToolApproval({
        eventBus: this.eventBus,
        sid: this.sid,
        agent: this.tree.addressOf(instance),
        toolName,
        ...(decision.capability ? { capability: decision.capability } : {}),
        args,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      if (!approved) {
        throw new Error(`denied by user: ${toolName}`);
      }
    }
  }

  /** Lazily materialize a top-level marketplace/extension persona as a
   *  resident Agent the first time it's addressed (`to: '<id>'` on
   *  `POST /messages`) and it isn't in the tree yet — restores the pre-runtime
   *  `ensurePersonaScaffold` UX (Studio's persona avatars are populated from
   *  `/api/agents`, decoupled from this session's live tree, so a
   *  never-messaged persona has no `agents/<id>/` directory yet). Idempotent:
   *  an id already in the tree returns its address untouched. Simple-name ids
   *  only; nested resident paths / fullIds are the caller's job to gate out
   *  (mirrors the old scaffold's contract). */
  async ensureResidentAgent(
    agentId: string,
    options: import("../runtime/runtime-context").EnsureResidentOptions = {},
  ): Promise<string> {
    const existing = this.tree.get(agentId);
    if (existing) return existing.path;
    if (!isValidAgentName(agentId)) {
      throw new AgentMaterializationError(`agent path not found: ${agentId}`, 404);
    }
    const inflight = this.residentMaterializations.get(agentId);
    if (inflight) return inflight;
    const promise = this._materializeResidentAgent(agentId, options).finally(() => {
      this.residentMaterializations.delete(agentId);
    });
    this.residentMaterializations.set(agentId, promise);
    return promise;
  }

  private async _materializeResidentAgent(
    agentId: string,
    options: import("../runtime/runtime-context").EnsureResidentOptions,
  ): Promise<string> {
    // Re-check once inside the single-flight slot: a sibling call that started
    // just before this one may have already landed the instance in the tree.
    const landed = this.tree.get(agentId);
    if (landed) return landed.path;

    const persona = await resolveExternalAgentTemplate(agentId);
    if (!persona) {
      throw new AgentMaterializationError(
        `persona '${agentId}' 未找到 —— 不在 marketplace 或 plugin 列表里。` +
          `请确认 plugin 已安装、id 拼写正确，或换一个已知 agent。`,
        404,
      );
    }

    try {
      await ensureAgentScaffold(this.sid, agentId, {
        overrides: {
          trustTier: persona.trustTier,
          personaFile: persona.personaPath,
          ...(options.model
            ? { models: { model: Array.isArray(options.model) ? [...options.model] : [options.model] } }
            : {}),
          ...(persona.memoryDir ? { memoryDir: persona.memoryDir } : {}),
          skillSources: persona.skillSources,
          ...(persona.tools && persona.tools.length > 0
            ? { kits: { config: { "host-tools": { allow: persona.tools } } } }
            : {}),
        },
      });
    } catch (error) {
      throw new AgentMaterializationError(
        `failed to scaffold resident '${agentId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        500,
      );
    }

    const definitions = ResidentDefinitionStore.scan(this.sid, this.paths.agentsDir());
    const definition = definitions.get(agentId);
    if (!definition) {
      throw new AgentMaterializationError(
        `resident scaffold for '${agentId}' did not materialize on disk`,
        500,
      );
    }

    try {
      const prepared = await registerResidentDefinition(this.templateCatalog, this.sid, definition);
      this.residentTemplateRefs.add(prepared.templateRef);
      const instance = await this.supervisor.registerResident(prepared, null);
      const address = this.tree.addressOf(instance);
      const store = this.supervisor.getEventStore(instance.instanceId);
      if (store) this.ledgers.set(address, store.ledger);
      return address;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentMaterializationError(
        `failed to register resident '${agentId}': ${message}`,
        /duplicate/i.test(message) ? 409 : 500,
      );
    }
  }

  registerFileSystemTemplate(options: {
    readonly root: string;
    readonly entryId: string;
    readonly sourceId?: string;
  }): TemplateRef {
    const source = new FileSystemTemplateSource({
      sourceId: options.sourceId ?? `registered-path:${realpathSync(options.root)}`,
      root: options.root,
    });
    return this.templateCatalog.register({
      entryId: options.entryId,
      source,
      scope: { kind: "session", sid: this.sid },
      registrationLifetime: "session",
      trust: "own",
      provenance: { adapter: "runtime-control-plane" },
      revisionPolicy: { kind: "explicit" },
    });
  }

  registerMemoryTemplate(options: {
    readonly sourceId: string;
    readonly entryId: string;
    readonly template: AgentTemplateDraft;
  }): TemplateRef {
    const source = new MemoryTemplateSource({
      sourceId: options.sourceId,
      templates: { [options.entryId]: options.template },
    });
    return this.templateCatalog.register({
      entryId: options.entryId,
      source,
      scope: { kind: "session", sid: this.sid },
      registrationLifetime: "session",
      trust: "own",
      provenance: { adapter: "runtime-control-plane" },
      revisionPolicy: { kind: "explicit" },
    });
  }

  async deleteResident(logicalPath: string): Promise<
    | {
        readonly ok: true;
        readonly memoryRemoved: true;
        readonly removedInstanceIds: readonly string[];
      }
    | {
        readonly ok: false;
        readonly phase: "filesystem";
        readonly memoryRemoved: true;
        readonly residualPath: string;
        readonly error: string;
      }
  > {
    const instance = this.runtimeTree.findResident(logicalPath);
    if (!instance) throw new Error(`resident agent not found: ${logicalPath}`);
    const configRoot = instance.template.resources.templateRoot;
    if (!configRoot) {
      throw new Error(`resident template root missing: ${logicalPath}`);
    }
    const agentsRoot = realpathSync(this.paths.agentsDir());
    const residentRoot = realpathSync(configRoot);
    const containment = relative(agentsRoot, residentRoot);
    if (
      !containment ||
      containment === ".." ||
      containment.startsWith(`..${sep}`) ||
      isAbsolute(containment)
    ) {
      throw new Error(`resident config root is outside Session agents/: ${residentRoot}`);
    }

    const removed = await this.supervisor.removeResidentSubtree(instance.instanceId);
    for (const item of removed) {
      const address = this.tree.addressOf(item);
      this.blackboard.removeAll(address);
      this.ledgers.delete(address);
      this.templateCatalog.unregister(item.templateRef);
      this.residentTemplateRefs.delete(item.templateRef);
    }
    try {
      rmSync(residentRoot, { recursive: true });
      return {
        ok: true,
        memoryRemoved: true,
        removedInstanceIds: Object.freeze(
          removed.map((item) => item.instanceId),
        ),
      };
    } catch (error) {
      return {
        ok: false,
        phase: "filesystem",
        memoryRemoved: true,
        residualPath: residentRoot,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  enqueueAgent(agentPath: string, input: unknown): Promise<import("../runtime/agent-runtime-controller").AgentTurnResult> {
    const instance = this.tree.resolve(agentPath);
    if (!instance) return Promise.reject(new Error(`runtime agent not found: ${agentPath}`));
    return this.supervisor.enqueue(instance.instanceId, input);
  }

  /** Lazily materialize the Kit/AgentContext host; this creates no lifecycle. */
  async initializeAgentHost(
    agentAddress: string,
  ): Promise<RuntimeAgentHost> {
    const instance = this.tree.resolve(agentAddress);
    if (!instance) {
      throw new Error(`runtime agent not found: ${agentAddress}`);
    }
    const executor = this.supervisor
      .getController(instance.instanceId)
      ?.turnExecutor;
    if (!(executor instanceof KernelTurnExecutor)) {
      throw new Error(`runtime Agent has no KernelTurnExecutor: ${agentAddress}`);
    }
    return executor.initialize();
  }

  getAgentHost(agentAddress: string): RuntimeAgentHost | null {
    const instance = this.tree.resolve(agentAddress);
    if (!instance) return null;
    const executor = this.supervisor
      .getController(instance.instanceId)
      ?.turnExecutor;
    return executor instanceof KernelTurnExecutor
      ? executor.compatibilityAgent
      : null;
  }

  interruptRuntime(agentAddress?: string, reason = "turn interrupted"): void {
    if (agentAddress) {
      const instance = this.tree.resolve(agentAddress);
      if (instance) this.supervisor.interruptTurn(instance.instanceId, reason);
      return;
    }
    for (const instance of this.runtimeTree.list()) {
      this.supervisor.interruptTurn(instance.instanceId, reason);
    }
  }

  async stageRuntimeConfig(
    instanceId: string,
    snapshot: RuntimeConfigSnapshot,
  ): Promise<void> {
    const instance = this.runtimeTree.get(instanceId);
    if (!instance) throw new Error(`runtime agent not found: ${instanceId}`);
    const store = this.supervisor.getEventStore(instanceId);
    if (!store) throw new Error(`runtime EventStore not found: ${instanceId}`);
    await store.append(
      this.registrar.eventFactory.agent(
        instance,
        "agent.runtime_config_staged",
        { revision: snapshot.revision },
      ),
      "required",
    );
    await store.flush();
    instance.runtimeConfig.stage(snapshot);
    this.eventBus.publish(
      {
        source: "runtime",
        type: "runtime:config-revision",
        payload: {
          sid: this.sid,
          agentInstanceId: instance.instanceId,
          runtimeEpochId: instance.runtimeEpochId,
          templateRef: instance.templateRef,
          revision: snapshot.revision,
        },
        ts: Date.now(),
      },
      this.tree.addressOf(instance),
    );
  }

  // ─── turn-end → 自动沉淀(USER.md + 分层记忆)──────────────────────────────

  /** 每个 agent 回合结束(非取消)后,后台抽取持久记忆并按层路由(P1)。节流/互斥/
   *  fire-and-forget 全在 `runAutoExtract` 内,这里只负责取 ledger + resolveModels。
   *  `FORGEAX_AUTO_EXTRACT=0` 可全局关闭。 */
  private _bindAutoExtract(): () => void {
    return this.eventBus.observe((event, emitterId) => {
      if (event.type !== "hook:turnEnd" || !emitterId) return;
      const payload = (event.payload ?? {}) as {
        aborted?: boolean;
        providerId?: string;
      };
      if (payload.aborted) return;
      // stable-identity gate(对齐 cc 主-agent-only):只**顶层 resident persona**
      // 长记忆。旧门闩查 emitterId 是否含 `/agents/`——那是旧 AgentTree 的物理相对
      // 路径(`iori/agents/suzu`);RuntimeTree 改成逻辑路径(`iori/suzu`)后该字符串
      // 永远匹配不到。改查 lifetime + parentInstanceId。
      const instance = this.tree.resolve(emitterId);
      if (!instance) return;
      if (instance.lifetime === "ephemeral") return;
      if (instance.parentInstanceId !== null) return;
      const agent = this.getAgentHost(emitterId) as unknown as {
        agentContext?: { resolveModels?: () => ModelsConfig };
      } | null;
      const resolveModels = agent?.agentContext?.resolveModels;
      if (typeof resolveModels !== "function") return; // 无模型能力 → 跳过
      let kernelId: string | undefined;
      try {
        kernelId = resolveKernel(
          emitterId,
          payload.providerId ?? instance.template.definition.kernelId,
        ).id;
      } catch { /* 无内核 → 按默认 gate */ }
      void runAutoExtract(
        {
          sid: this.sid,
          agentPath: emitterId,
          ledger: this.getOrCreateLedger(emitterId),
          resolveModels,
          ...(kernelId ? { kernelId } : {}),
        },
        // cache-warm 优先:内核支持 forkExtract → 复用上一轮缓存前缀抽取;否则冷兜底。
        {
          tryFork: () =>
            tryKernelForkExtract({
              sid: this.sid,
              agentPath: emitterId,
              instanceId: instance.instanceId,
              ...(kernelId ? { kernelId } : {}),
            }),
        },
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

      if (event.type === "runtime:instance-removed") {
        const removedId = (event.payload as { agentInstanceId?: unknown } | undefined)
          ?.agentInstanceId;
        if (typeof removedId !== "string") return;
        for (const [key, info] of this.delegations) {
          if (info.targetInstanceId !== removedId) continue;
          this.finishDelegation(key, info, {
            aborted: true,
            error: "delegated runtime instance was removed",
          });
        }
        return;
      }

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
      const info = this.delegations.get(emitterId);
      if (!info) return;
      const payload = (event.payload ?? {}) as {
        aborted?: boolean;
        error?: string;
        stopReason?: string;
        delegationId?: string;
        sourceEventId?: string;
        turnId?: string;
        agentInstanceId?: string;
        runtimeEpochId?: string;
      };
      // A completion belongs to one accepted delegated delivery, not to an
      // address or to the first turn-end from that address. All identity
      // components are required; missing or stale fields are a no-op.
      if (
        !info.delegationId ||
        !info.sourceEventId ||
        !info.turnId ||
        !info.targetInstanceId ||
        !info.targetRuntimeEpochId ||
        payload.delegationId !== info.delegationId ||
        payload.sourceEventId !== info.sourceEventId ||
        payload.turnId !== info.turnId ||
        payload.agentInstanceId !== info.targetInstanceId ||
        payload.runtimeEpochId !== info.targetRuntimeEpochId
      ) return;
      this.delegations.delete(emitterId);
      const status = payload.aborted ? "取消" : payload.error ? "失败" : "完成";
      const detail = payload.error ? `（错误：${String(payload.error).slice(0, 120)}）` : "";
      // Relay the teammate's actual final output so the delegator can act on it
      // directly (e.g. apply tsumugi's verify report) instead of stalling to
      // ask the user to paste it back. Trim to keep the delegator's context
      // bounded; the full transcript still lives in the teammate's ledger.
      const result = payload.aborted ? "" : (this.latestAssistantText.get(emitterId) ?? "");
      this.latestAssistantText.delete(emitterId);
      const MAX = 8000;
      const resultBlock = result
        ? `\n\n--- ${emitterId} 的产出 ---\n${result.length > MAX ? result.slice(0, MAX) + "\n…（已截断，完整内容见该 agent 的对话）" : result}`
        : "";
      const callback: import("./types").Event = {
          source: "agent",
          type: "message",
          payload: {
            content: `✓ ${emitterId} ${status}了你交办的任务${detail}：${info.brief}${resultBlock}`,
            fromAgent: emitterId,
          },
          to: info.delegator,
          handoff: "turn",
          durability: "required",
          ts: Date.now(),
      };
      this.eventBus.publish(callback, emitterId);
      const delegator = this.tree.resolve(info.delegator);
      if (!delegator) return;
      void this.supervisor.enqueue(delegator.instanceId, callback).catch((error) => {
        this.logger.error(
          info.delegator,
          undefined,
          `delegation callback enqueue failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  private finishDelegation(
    key: string,
    info: DelegationInfo,
    outcome: { aborted?: boolean; error?: string },
  ): void {
    if (this.delegations.get(key) !== info) return;
    this.delegations.delete(key);
    this.latestAssistantText.delete(key);
    const status = outcome.aborted ? "取消" : outcome.error ? "失败" : "完成";
    const detail = outcome.error
      ? `（错误：${String(outcome.error).slice(0, 120)}）`
      : "";
    const callback: import("./types").Event = {
      source: "agent",
      type: "message",
      payload: {
        content: `✓ ${key} ${status}了你交办的任务${detail}：${info.brief}`,
        fromAgent: key,
        ...(info.delegationId ? { delegationId: info.delegationId } : {}),
        ...(info.sourceEventId ? { sourceEventId: info.sourceEventId } : {}),
        ...(info.targetInstanceId ? { targetInstanceId: info.targetInstanceId } : {}),
        ...(info.targetRuntimeEpochId
          ? { targetRuntimeEpochId: info.targetRuntimeEpochId }
          : {}),
      },
      to: info.delegator,
      handoff: "turn",
      durability: "required",
      ts: Date.now(),
    };
    this.eventBus.publish(callback, key);
    const delegator = this.tree.resolve(info.delegator);
    if (!delegator) return;
    void this.supervisor.enqueue(delegator.instanceId, callback).catch((error) => {
      this.logger.error(
        info.delegator,
        undefined,
        `delegation callback enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Explicit detach/restart/remove cleanup for the legacy Scheduler
   * projection. RuntimeSupervisor removals use the instance-id path above;
   * this address path exists only for callers still using Scheduler. */
  private finishDelegationsForTarget(agentPath: string): void {
    for (const [key, info] of this.delegations) {
      if (key !== agentPath) continue;
      this.finishDelegation(key, info, {
        aborted: true,
        error: "delegated target was detached",
      });
    }
  }

  // ─── EventBus → agent_command routing ────────────────────────────────────

  /** Route control-plane agent_command events into the one runtime controller. */
  private _bindAgentCommandRouting(): () => void {
    return this.eventBus.observe((event) => {
      if (event.type !== "agent_command") return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const targetPath =
        (event.to as string | undefined) ?? (payload.agentId as string | undefined);
      if (!targetPath) return;
      const toolName = payload.toolName as string | undefined;
      if (!toolName) return;
      const interrupt = (payload.interrupt as boolean | undefined) ?? true;
      const instance = this.tree.resolve(targetPath);
      if (!instance) return;
      try {
        if (interrupt) {
          this.supervisor.interruptTurn(
            instance.instanceId,
            (payload.reason as string | undefined) ?? "agent command",
          );
        }
        void this.supervisor.enqueue(instance.instanceId, {
          ...event,
          to: this.tree.addressOf(instance),
        }).catch((error) => {
          this.logger.error(
            targetPath,
            undefined,
            `agent_command "${toolName}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        this.logger.error(
          targetPath,
          undefined,
          `agent_command "${toolName}" failed: ${msg}`,
        );
      }
    });
  }

  private readonly _busUnsubs: Array<() => void>;

  /** Reconcile terminal turns already persisted before this Session was
   * reopened.  The scan is deliberately ledger-only: the injected resolver
   * owns all workspace/file attribution and this layer only supplies the
   * causal turn boundary. */
  private async _reconcileArtifactTurns(): Promise<void> {
    if (!this.artifactResolver || this.disposed) return;
    const paths = new Set<string>(this.ledgers.keys());
    for (const instance of this.runtimeTree.list()) {
      paths.add(this.tree.addressOf(instance));
    }

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
        const payload = (event.payload ?? {}) as Record<string, unknown>;
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
          const turnId = event.history?.turnId
            ?? (typeof payload.turnId === "string" ? payload.turnId : undefined);
          if (turnId && name && canonicalToolName(name) === "ask_user") {
            const nested = payload.toolCall && typeof payload.toolCall === "object"
              ? payload.toolCall as Record<string, unknown>
              : undefined;
            const callId = typeof payload.callId === "string"
              ? payload.callId
              : typeof payload.toolCallId === "string"
                ? payload.toolCallId
                : typeof nested?.id === "string" ? nested.id : `anonymous:${event.ts}`;
            const key = `${turnId}:${callId}`;
            if (payload.permissionPrompt === true) permissionAskCalls.add(key);
            const start = starts.get(turnId);
            if (start) start.waitingForInput = true;
          }
          continue;
        }
        if (event.type === "hook:toolResult") {
          const turnId = event.history?.turnId
            ?? (typeof payload.turnId === "string" ? payload.turnId : undefined);
          if (!turnId) continue;
          const start = starts.get(turnId);
          const callId = typeof payload.callId === "string"
            ? payload.callId
            : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
          const pendingKeys = [...permissionAskCalls]
            .filter((key) => key.startsWith(`${turnId}:`));
          const matchedKey = callId
            ? `${turnId}:${callId}`
            : pendingKeys.length === 1 ? pendingKeys[0] : undefined;
          const permissionPrompt = matchedKey
            ? permissionAskCalls.has(matchedKey)
            : false;
          if (matchedKey) permissionAskCalls.delete(matchedKey);
          const answer = permissionPrompt
            ? payload.error === undefined && payload.ok !== false
            : askToolResultResolved(payload);
          if (start && start.waitingForInput && !answer) start.waitingForInput = true;
          else if (start) start.waitingForInput = false;
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
        if (waitingForInput) continue;
        starts.delete(turnId);
        for (const key of permissionAskCalls) {
          if (key.startsWith(`${turnId}:`)) permissionAskCalls.delete(key);
        }
        const checkpointMsgId = start.checkpointMsgId
          ?? (typeof payload.msgId === "string" ? payload.msgId : undefined);
        const artifactId = stableArtifactId(this.sid, turnId, checkpointMsgId);
        if (resolved.has(artifactId)) continue;
        void this._resolveArtifact({
          sid: this.sid,
          agentId: agentPath,
          projectRoot: this.artifactProjectRoot(),
          ...(this.config.defaultDir ? { game: this.config.defaultDir } : {}),
          turnId,
          ...(checkpointMsgId ? { checkpointMsgId } : {}),
          startedAt: start.startedAt,
          settledAt: event.ts,
          ...(typeof event.seq === "number" ? { anchorSeq: event.seq } : {}),
          ...(payload.aborted === true ? { aborted: true } : {}),
          ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        });
      }
    }
  }

  /** Observe only the lifecycle boundary.  Workspace attribution remains in
   * the injected resolver, while this observer guarantees one final-settle
   * invocation per logical turn and preserves AskUser wait semantics. */
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
          if (payload.permissionPrompt === true) {
            this.permissionAskCalls.add(`${emitterId}:${callId}`);
          }
        }
        return;
      }
      if (event.type === "hook:toolResult") {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const callId = typeof payload.callId === "string"
          ? payload.callId
          : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        const turn = this.artifactTurns.get(emitterId);
        const pendingKeys = [...this.pendingAskCalls]
          .filter((key) => key.startsWith(`${emitterId}:`));
        const matchedKeys = callId
          ? this.pendingAskCalls.has(`${emitterId}:${callId}`)
            ? [`${emitterId}:${callId}`]
            : []
          : pendingKeys;
        const permissionPrompt = matchedKeys.length === 1
          && this.permissionAskCalls.has(matchedKeys[0]!);
        const answer = permissionPrompt
          ? payload.error === undefined && payload.ok !== false
          : askToolResultResolved(payload);
        for (const key of matchedKeys) {
          this.pendingAskCalls.delete(key);
          this.permissionAskCalls.delete(key);
        }
        if (turn && matchedKeys.length > 0) turn.waitingForInput = !answer;
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
      const waitingForInput = payload.aborted !== true
        && (payload.waitingForInput === true
          || turn.waitingForInput === true
          || [...this.pendingAskCalls].some((key) => key.startsWith(`${emitterId}:`)));
      if (waitingForInput) {
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
      void this._resolveArtifact({
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
      });
    });
  }

  private _resolveArtifact(context: ArtifactTurnContext): Promise<void> {
    if (!this.artifactResolver) return Promise.resolve();
    const artifactId = stableArtifactId(
      context.sid ?? this.sid,
      context.turnId,
      context.checkpointMsgId,
    );
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
      if (prior.some((event) => event.type === "artifact:resolved"
        && event.payload?.artifactId === payload.artifactId)) return;
      const event: Event = {
        type: "artifact:resolved",
        source: "host:artifact-deriver",
        ts: Date.now(),
        payload: payload as unknown as Record<string, unknown>,
      };
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
      // Runtime lifecycle has its own required canonical EventStore writes.
      // These additive wire projections must not create a second fact.
      if (event.type.startsWith("runtime:")) return;
      // file-activity:* 是给 UI / file-activity-ledger 的信号事件，不是对话事件 ——
      // 已经写入 `<sid>/file-activity.jsonl`，再写一份到 per-agent EventLedger 只
      // 是双倍噪声 + LLM 历史污染。用专门的 LLM slot（file-activity-recent）按需
      // 注入，比每个 write 自动塞 prompt 更可控。
      if (event.type.startsWith("file-activity:")) return;
      // _resolveArtifact persists this host-owned event before broadcasting;
      // do not append a second WAL row from the general observer.
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
          const instance = this.tree.resolve(agentPath);
          const store = instance
            ? this.supervisor.getEventStore(instance.instanceId)
            : undefined;
          if (store) {
            // Bus observers are synchronous and ContextWindow may read this
            // event in the same tick. EventStore still owns the ledger/path;
            // required lifecycle writes continue through its durability queue.
            const turnId = this.activeTurnIds.get(agentPath);
            store.ledger.append(event, emitterId, turnId ? { turnId } : undefined);
          } else {
            const turnId = this.activeTurnIds.get(agentPath);
            this.getOrCreateLedger(agentPath).append(
              event,
              emitterId,
              turnId ? { turnId } : undefined,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
          this.logger.error(agentPath, undefined, `WAL append "${event.type}" failed: ${msg}`);
        }
      }
      if (event.type === "hook:turnEnd" && emitterId) this.activeTurnIds.delete(emitterId);
    });
  }

  private _bindRuntimeTreeEvents(): () => void {
    return this.runtimeTree.onChange((change) => {
      const instance = change.instance;
      const address = this.tree.addressOf(instance);
      const kind =
        change.kind === "inserted"
          ? "runtime:instance-added"
          : change.kind === "removed"
            ? "runtime:instance-removed"
            : "runtime:instance-state-changed";
      this.eventBus.publish(
        {
          source: "runtime",
          type: kind,
          payload: {
            sid: this.sid,
            agentInstanceId: instance.instanceId,
            runtimeEpochId: instance.runtimeEpochId,
            parentInstanceId: instance.parentInstanceId,
            lifetime: instance.lifetime,
            ...(instance.residentPath
              ? { residentPath: instance.residentPath }
              : {}),
            templateRef: instance.templateRef,
            displayName:
              instance.template.definition.displayName ??
              instance.template.definition.id,
            state: instance.state,
            address,
            ...(change.kind === "removed" && change.reason
              ? { reason: change.reason }
              : {}),
          },
          ts: Date.now(),
        },
        address,
      );
    });
  }

  // ─── Per-agent ledger lookup ─────────────────────────────────────────────

  /** Lazy-init per-agent ledger。SessionManager / agentFactory 可以提前 prime。 */
  getOrCreateLedger(agentPath: string): EventLedger {
    const instance = this.tree.resolve(agentPath);
    if (instance) {
      const runtimeLedger = this.supervisor.getEventStore(instance.instanceId)?.ledger;
      if (runtimeLedger) {
        this.ledgers.set(agentPath, runtimeLedger);
        return runtimeLedger;
      }
    }
    let ledger = this.ledgers.get(agentPath);
    if (!ledger) {
      const layer = this.init.paths.session(this.sid).agent(agentPath);
      ledger = new EventLedger(
        {
          ownerInstanceId: agentPath,
          runtimeEpochId: `legacy:${this.sid}:${agentPath}`,
          storeId: `legacy:${this.sid}:${agentPath}`,
          locator: {
            relativeDir: relative(this.paths.root(), layer.eventsDir()),
          },
        },
        {
          eventsDir: layer.eventsDir(),
          blobsDir: layer.eventLedgerBlobs(),
        },
      );
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
    this.finishDelegationsForTarget(agentPath);
    this.blackboard.removeAll(agentPath);
    this.ledgers.delete(agentPath);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Soft dispose —— SessionManager.close 调，**不**删盘。
   *
   *  Runtime 释放顺序：
   *    1. _busUnsub                    ← 先停 ledger persistence observer
   *    2. supervisor.shutdown()        ← 等所有实例停止并 flush
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
    await this.supervisor.shutdown();
    this.kitReloadCoordinator.stopWatching();
    this.memoryTemplates.clear();
    this.templateCatalog.unregisterByLifetime("session");
    this.blackboard.flush();
    this.ledgers.clear();
    this.fileActivity.dispose();
    this.fileLocks.clear();
    clearRememberedForSession(this.sid); // 清本会话的工具审批 remember(不跨会话残留)
    clearUiStateForSession(this.sid); // 清本会话的 UI 语义操作层 lease + manifest 缓存
    await this.logger.close();
  }
}

function isRuntimeEvent(value: unknown): value is import("./types").Event {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<import("./types").Event>;
  return typeof candidate.source === "string"
    && typeof candidate.type === "string"
    && typeof candidate.ts === "number"
    && Boolean(candidate.payload && typeof candidate.payload === "object");
}
