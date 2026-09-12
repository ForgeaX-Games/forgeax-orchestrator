import type { RegisteredResidentDefinition } from "../agents/resident-template-adapter";
import type { EventStore } from "../ledger/event-store";
import type { EventLedger } from "../ledger/event-ledger";
import type {
  AgentHandle,
  AgentCompletion,
} from "./agent-handle";
import { ManagedAgentHandle } from "./agent-handle";
import type {
  RegisteredAgent,
} from "./agent-registrar";
import { AgentRegistrar } from "./agent-registrar";
import type {
  ControllerTerminal,
  AgentRuntimeController,
} from "./agent-runtime-controller";
import type { MemoryTemplateRegistry } from "./agent-template-locator";
import type {
  EphemeralAgentSpawner,
  SpawnEphemeralRequest,
} from "./ephemeral-agent-spawner";
import { SessionLease } from "./session-lease";
import type { AgentInstance } from "./types";
import { RuntimeTree } from "./runtime-tree";

interface ManagedRecord {
  readonly instance: AgentInstance;
  readonly controller: AgentRuntimeController;
  readonly eventStore: EventStore;
  readonly unsubscribeTerminal: () => void;
  readonly unsubscribeState: () => void;
  readonly memoryRegistrationId?: string;
  readonly handle?: ManagedAgentHandle;
  readonly releaseLease?: () => void;
  terminal?: ControllerTerminal;
  terminalPersisted?: Promise<void>;
  releasing?: Promise<void>;
}

export interface RuntimeSupervisorOptions {
  readonly sid: string;
  readonly workspaceRoot: string;
  readonly tree: RuntimeTree;
  readonly registrar: AgentRegistrar;
  readonly spawner: EphemeralAgentSpawner;
  readonly memoryTemplates: MemoryTemplateRegistry;
  readonly lease?: SessionLease;
  readonly removeRuntimeState?: (instanceId: string) => void;
}

/**
 * The only Session-level authority allowed to own live controllers, mutate the
 * RuntimeTree, propagate cancellation or release an Agent instance.
 */
export class RuntimeSupervisor {
  readonly lease: SessionLease;
  private readonly records = new Map<string, ManagedRecord>();
  private acceptingSpawns = true;
  private acceptingTurns = true;
  private shutdownStarted = false;

  constructor(private readonly options: RuntimeSupervisorOptions) {
    if (options.tree.sid !== options.sid) {
      throw new Error(
        `RuntimeSupervisor session mismatch: ${options.tree.sid} !== ${options.sid}`,
      );
    }
    this.lease = options.lease ?? new SessionLease();
  }

  async bootstrapResidents(
    definitions: readonly RegisteredResidentDefinition[],
  ): Promise<readonly AgentInstance[]> {
    const registeredIds: string[] = [];
    const byLogicalPath = new Map<string, string>();
    try {
      for (const prepared of definitions) {
        const parentId = prepared.definition.parentLogicalPath
          ? byLogicalPath.get(prepared.definition.parentLogicalPath)
          : null;
        if (prepared.definition.parentLogicalPath && !parentId) {
          throw new Error(
            `resident parent was not bootstrapped: ${prepared.definition.parentLogicalPath}`,
          );
        }
        const registered = await this.options.registrar.register(
          this.buildResidentRegisterRequest(prepared, parentId ?? null, "bootstrap"),
        );
        this.adopt(registered);
        registeredIds.push(registered.instance.instanceId);
        byLogicalPath.set(
          prepared.definition.logicalPath,
          registered.instance.instanceId,
        );
      }
      return Object.freeze(
        registeredIds.map((instanceId) => this.requireRecord(instanceId).instance),
      );
    } catch (error) {
      for (const instanceId of registeredIds.reverse()) {
        await this.removeRecord(instanceId, "resident bootstrap rollback");
      }
      throw error;
    }
  }

  /**
   * Register exactly one already-scaffolded resident definition at runtime
   * (outside the bootstrap sweep) and insert it into the live tree
   * immediately — e.g. a marketplace/extension persona materialized on its
   * first message. `AgentRegistrationPolicy` already permits
   * `trigger: "runtime"` resident registrations (only `trigger: "bootstrap"`
   * is filesystem-only-at-boot-gated); this method is simply the first
   * runtime-side caller of that allowed shape.
   */
  async registerResident(
    prepared: RegisteredResidentDefinition,
    parentId: string | null = null,
  ): Promise<AgentInstance> {
    if (!this.acceptingSpawns) {
      throw new Error("RuntimeSupervisor is not accepting new agents");
    }
    const registered = await this.options.registrar.register(
      this.buildResidentRegisterRequest(prepared, parentId, "runtime"),
    );
    this.adopt(registered);
    return registered.instance;
  }

  private buildResidentRegisterRequest(
    prepared: RegisteredResidentDefinition,
    parentId: string | null,
    trigger: "bootstrap" | "runtime",
  ) {
    return {
      locator: prepared.locator,
      lifetime: "resident" as const,
      parentId,
      trigger,
      residentIdentity: prepared.definition.identity,
      runtime: {
        workspaceRoot: this.options.workspaceRoot,
        runtimeStateRef: `session:resident:${prepared.definition.logicalPath}`,
        templateRoot: prepared.definition.templateRoot,
      },
    };
  }

  async spawnEphemeral(request: SpawnEphemeralRequest): Promise<AgentHandle> {
    if (!this.acceptingSpawns) {
      throw new Error("RuntimeSupervisor is not accepting new ephemeral agents");
    }
    if (request.parentInstanceId !== null) {
      const parent = this.options.tree.get(request.parentInstanceId);
      if (!parent) {
        throw new Error(`ephemeral parent not found: ${request.parentInstanceId}`);
      }
      if (
        parent.state === "draining" ||
        parent.state === "cancelled" ||
        parent.state === "failed" ||
        parent.state === "disposed"
      ) {
        throw new Error(
          `ephemeral parent does not accept children in state ${parent.state}: ${parent.instanceId}`,
        );
      }
    }

    const releaseLease = this.lease.acquire(
      `ephemeral-registration:${request.templateRef}`,
    );
    try {
      const registered = await this.options.spawner.register(request);
      const handle = new ManagedAgentHandle(
        registered.instance.instanceId,
        (reason) => this.cancel(registered.instance.instanceId, reason),
      );
      this.adopt(registered, {
        memoryRegistrationId: registered.memoryRegistrationId,
        handle,
        releaseLease,
      });
      return handle;
    } catch (error) {
      releaseLease();
      throw error;
    }
  }

  async cancel(instanceId: string, reason?: string): Promise<void> {
    const root = this.requireRecord(instanceId);
    const subtree = this.collectSubtree(root.instance.instanceId);
    for (const record of subtree) {
      record.controller.cancel(reason ?? "cancelled by supervisor");
    }
    if (root.handle) await root.handle.completion;
  }

  /** Synchronously validates and queues a turn.
   *
   * Returning means the target Controller accepted the input; the returned
   * promise still represents eventual turn completion. */
  acceptTurn(instanceId: string, input: unknown): Promise<import("./agent-runtime-controller").AgentTurnResult> {
    if (!this.acceptingTurns) {
      throw new Error("RuntimeSupervisor is gated for a Session mutation");
    }
    return this.requireRecord(instanceId).controller.acceptTurn(input);
  }

  enqueue(instanceId: string, input: unknown): Promise<import("./agent-runtime-controller").AgentTurnResult> {
    try {
      return this.acceptTurn(instanceId, input);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  interruptTurn(instanceId: string, reason?: string): void {
    this.requireRecord(instanceId).controller.interruptTurn(reason);
  }

  stopTurn(instanceId: string, reason?: string): void {
    this.requireRecord(instanceId).controller.stopTurn(reason);
  }

  async shutdown(reason = "session closed"): Promise<void> {
    this.shutdownStarted = true;
    this.pauseSpawns();
    this.acceptingTurns = false;
    const ephemeralRecords = [...this.records.values()].filter(
      (record) => record.instance.lifetime === "ephemeral",
    );
    const ephemeralRoots = ephemeralRecords.filter((record) =>
      record.instance.parentInstanceId === null ||
      this.records.get(record.instance.parentInstanceId)?.instance.lifetime !== "ephemeral"
    );
    // 同 prepareForSessionMutation:必须 cancel 全部 ephemeral 记录,只 cancel
    // root 会让子节点永远不终结,root 永远卡 draining,下面死等。
    for (const record of ephemeralRecords) {
      record.controller.cancel(reason);
    }
    await Promise.allSettled(
      ephemeralRoots
        .map((record) => record.handle?.completion)
        .filter((value): value is Promise<AgentCompletion> => Boolean(value)),
    );

    const remaining = [...this.options.tree.list()].reverse();
    for (const instance of remaining) {
      const record = this.records.get(instance.instanceId);
      if (!record) continue;
      try {
        await record.eventStore.append(
          this.options.registrar.eventFactory.agent(instance, "agent.session_closed", {
            reason,
          }),
          "required",
        );
        await record.eventStore.flush();
      } finally {
        await this.removeRecord(instance.instanceId, reason);
      }
    }
  }

  async removeResidentSubtree(
    instanceId: string,
  ): Promise<readonly AgentInstance[]> {
    const root = this.requireRecord(instanceId);
    if (root.instance.lifetime !== "resident") {
      throw new Error(`resident deletion requires a resident root: ${instanceId}`);
    }
    this.pauseSpawns();
    this.acceptingTurns = false;
    try {
      const initial = this.collectSubtree(instanceId);
      for (const record of initial) {
        if (record.instance.lifetime === "ephemeral") {
          record.controller.cancel("resident ancestor deleted");
        }
      }
      await Promise.allSettled(
        initial
          .map((record) => record.handle?.completion)
          .filter((value): value is Promise<AgentCompletion> => Boolean(value)),
      );

      const residents = initial
        .filter((record) =>
          record.instance.lifetime === "resident" &&
          this.records.has(record.instance.instanceId)
        )
        .reverse();
      for (const record of residents) {
        await record.controller.dispose();
        await record.eventStore.append(
          this.options.registrar.eventFactory.agent(
            record.instance,
            "agent.deleted",
            { deletionRootInstanceId: instanceId },
          ),
          "required",
        );
        await record.eventStore.flush();
      }

      // One authoritative topology mutation: observers cannot see a resident
      // parent disappear while one of its resident children remains live.
      const removed = this.options.tree.removeSubtree(
        instanceId,
        "resident deleted",
      );
      for (const instance of removed) {
        const record = this.records.get(instance.instanceId);
        if (!record) continue;
        record.unsubscribeTerminal();
        record.unsubscribeState();
        this.records.delete(instance.instanceId);
        record.eventStore.dispose();
        if (record.memoryRegistrationId) {
          this.options.memoryTemplates.unregister(record.memoryRegistrationId);
        }
        record.releaseLease?.();
      }
      return Object.freeze(
        removed.filter((instance) => instance.lifetime === "resident"),
      );
    } finally {
      if (!this.shutdownStarted) this.acceptingTurns = true;
      this.resumeSpawns();
    }
  }

  async resetResidentsForReload(
    reason = "Session resident tree reloaded",
  ): Promise<void> {
    const { release } = await this.prepareForSessionMutation(reason);
    try {
      const residents = [...this.options.tree.list()]
        .filter((instance) => instance.lifetime === "resident")
        .reverse();
      for (const instance of residents) {
        const record = this.records.get(instance.instanceId);
        if (!record) continue;
        await record.controller.dispose();
        await record.eventStore.append(
          this.options.registrar.eventFactory.agent(
            instance,
            "agent.runtime_reloaded",
            { reason },
          ),
          "required",
        );
        await record.eventStore.flush();
      }
      for (const root of this.options.tree.roots()) {
        this.options.tree.removeSubtree(root.instanceId, reason);
      }
      for (const instance of residents) {
        const record = this.records.get(instance.instanceId);
        if (!record) continue;
        record.unsubscribeTerminal();
        record.unsubscribeState();
        this.records.delete(instance.instanceId);
        record.eventStore.dispose();
        record.releaseLease?.();
      }
    } finally {
      release();
    }
  }

  pauseSpawns(): void {
    this.acceptingSpawns = false;
  }

  resumeSpawns(): void {
    if (!this.shutdownStarted) this.acceptingSpawns = true;
  }

  /**
   * Gate a checkpoint/reload mutation, drain ephemeral work, quiesce resident
   * turns and flush every live instance EventStore. Caller must release the
   * returned barrier in finally.
   *
   * Also returns `retiringEphemeralLedgers` — the `EventLedger`s of every
   * ephemeral instance that existed *before* this call started (root and
   * nested children alike), captured before any of them get cancelled and
   * GC'd. Rationale: by the time this method resolves, every one of those
   * instances has already been cancelled, `RuntimeTree.removeSubtree`'d and
   * `EventStore.dispose()`'d — so a caller that (like CheckpointManager) needs
   * to stamp a `rewind_boundary`-style marker into *every* instance's history,
   * not just whoever is still alive afterward, has no other way to reach
   * them. `EventLedger.append` is a plain synchronous `appendFileSync` with
   * no ties to `EventStore`'s async writer/dispose state and no ties to the
   * ephemeral GC's `removeRuntimeState` (that only deletes `runtime-state/`,
   * a sibling of the events directory — see `SessionEventPaths`), so writing
   * to these captured ledgers after this method returns, even much later
   * inside the caller's own gated operation, is safe and lands in the same
   * WAL shard files this instance's history already lives in.
   */
  async prepareForSessionMutation(
    reason: string,
  ): Promise<{
    release: () => void;
    retiringEphemeralLedgers: readonly EventLedger[];
  }> {
    if (this.shutdownStarted) {
      throw new Error("RuntimeSupervisor is shutting down");
    }
    this.pauseSpawns();
    this.acceptingTurns = false;
    try {
      const ephemeralRecords = [...this.records.values()].filter(
        (record) => record.instance.lifetime === "ephemeral",
      );
      const retiringEphemeralLedgers = Object.freeze(
        ephemeralRecords.map((record) => record.eventStore.ledger),
      );
      const ephemeralRoots = ephemeralRecords.filter((record) =>
        record.instance.parentInstanceId === null ||
        this.records.get(record.instance.parentInstanceId)?.instance.lifetime !== "ephemeral"
      );
      // cancel() 每一个 ephemeral 记录(root + 全部后代),不能只 cancel roots:
      // AgentRuntimeController.cancel() 只影响自己,不会向下级联;而 bottom-up GC
      // (releaseLeaf → maybeRelease)要求 childrenOf().length === 0 才放行 parent。
      // 只 cancel root 会让从未被 cancel 的子节点永远不终结,root 因此永远卡在
      // draining,下面等 root.handle.completion 的 Promise.allSettled 会死等。
      for (const record of ephemeralRecords) record.controller.cancel(reason);
      await Promise.allSettled(
        ephemeralRoots
          .map((record) => record.handle?.completion)
          .filter((completion): completion is Promise<AgentCompletion> =>
            Boolean(completion)
          ),
      );

      const residents = [...this.records.values()].filter(
        (record) => record.instance.lifetime === "resident",
      );
      for (const resident of residents) {
        resident.controller.interruptAndClear(reason);
      }
      await Promise.all(
        residents.map((resident) => resident.controller.waitForQuiescence()),
      );
      await Promise.all(
        [...this.records.values()].map((record) => record.eventStore.flush()),
      );

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (!this.shutdownStarted) {
          this.acceptingTurns = true;
          this.resumeSpawns();
        }
      };
      return { release, retiringEphemeralLedgers };
    } catch (error) {
      this.acceptingTurns = true;
      this.resumeSpawns();
      throw error;
    }
  }

  getController(instanceId: string): AgentRuntimeController | undefined {
    return this.records.get(instanceId)?.controller;
  }

  getEventStore(instanceId: string): EventStore | undefined {
    return this.records.get(instanceId)?.eventStore;
  }

  get size(): number {
    return this.records.size;
  }

  private adopt(
    registered: RegisteredAgent,
    ephemeral?: {
      readonly memoryRegistrationId: string;
      readonly handle: ManagedAgentHandle;
      readonly releaseLease: () => void;
    },
  ): void {
    const instanceId = registered.instance.instanceId;
    if (this.records.has(instanceId)) {
      throw new Error(`RuntimeSupervisor duplicate instanceId: ${instanceId}`);
    }
    const record = {} as ManagedRecord;
    Object.assign(record, {
      instance: registered.instance,
      controller: registered.controller,
      eventStore: registered.eventStore,
      ...(ephemeral ?? {}),
      unsubscribeTerminal: registered.controller.onTerminal((terminal) => {
        const current = this.records.get(instanceId);
        if (!current) return;
        if (current.instance.lifetime === "resident") {
          if (terminal.kind !== "completed") {
            void this.persistResidentTerminal(current, terminal);
          }
          return;
        }
        this.beginTerminal(current, terminal);
      }),
      unsubscribeState: registered.controller.onState(() => {
        this.options.tree.touch(instanceId);
      }),
    });
    this.records.set(instanceId, record);
  }

  private beginTerminal(record: ManagedRecord, terminal: ControllerTerminal): void {
    if (record.terminal) return;
    record.terminal = terminal;
    record.instance.state = "draining";
    this.options.tree.touch(record.instance.instanceId);
    record.terminalPersisted = this.persistTerminal(record, terminal);
    void record.terminalPersisted
      .then(() => this.maybeRelease(record))
      .catch((error) => {
        record.instance.state = "failed";
        this.options.tree.touch(record.instance.instanceId);
        record.handle?.fail(error);
      });
  }

  private async persistTerminal(
    record: ManagedRecord,
    terminal: ControllerTerminal,
  ): Promise<void> {
    await record.eventStore.append(
      this.options.registrar.eventFactory.agent(
        record.instance,
        terminalEventType(terminal),
        terminalPayload(terminal),
      ),
      "required",
    );
    await record.eventStore.flush();
  }

  private async persistResidentTerminal(
    record: ManagedRecord,
    terminal: Exclude<ControllerTerminal, { kind: "completed" }>,
  ): Promise<void> {
    try {
      await record.eventStore.append(
        this.options.registrar.eventFactory.agent(
          record.instance,
          terminalEventType(terminal),
          terminalPayload(terminal),
        ),
        "required",
      );
      await record.eventStore.flush();
    } catch {
      record.instance.state = "failed";
      this.options.tree.touch(record.instance.instanceId);
    }
  }

  private maybeRelease(record: ManagedRecord): Promise<void> {
    if (record.releasing) return record.releasing;
    if (!record.terminal || this.options.tree.childrenOf(record.instance.instanceId).length) {
      return Promise.resolve();
    }
    record.releasing = this.releaseLeaf(record);
    return record.releasing;
  }

  private async releaseLeaf(record: ManagedRecord): Promise<void> {
    await record.terminalPersisted;
    if (this.options.tree.childrenOf(record.instance.instanceId).length) {
      delete record.releasing;
      return;
    }
    await record.eventStore.append(
      this.options.registrar.eventFactory.agent(
        record.instance,
        "agent.disposed",
        { reason: terminalEventType(record.terminal!) },
      ),
      "required",
    );
    await record.eventStore.flush();

    const parentId = record.instance.parentInstanceId;
    const completion = toCompletion(record.terminal!);
    await this.removeRecord(record.instance.instanceId, "ephemeral terminal");
    record.handle?.settle(completion);

    if (parentId) {
      const parent = this.records.get(parentId);
      if (
        parent?.instance.lifetime === "ephemeral" &&
        parent.terminal &&
        this.options.tree.childrenOf(parentId).length === 0
      ) {
        await this.maybeRelease(parent);
      }
    }
  }

  private async removeRecord(instanceId: string, reason: string): Promise<void> {
    const record = this.records.get(instanceId);
    if (!record) return;
    if (this.options.tree.childrenOf(instanceId).length) {
      throw new Error(`cannot release non-leaf runtime instance: ${instanceId}`);
    }
    record.unsubscribeTerminal();
    record.unsubscribeState();
    await record.controller.dispose();
    this.options.tree.removeSubtree(instanceId, reason);
    this.records.delete(instanceId);
    record.eventStore.dispose();
    if (record.memoryRegistrationId) {
      this.options.memoryTemplates.unregister(record.memoryRegistrationId);
    }
    if (record.instance.lifetime === "ephemeral") {
      this.options.removeRuntimeState?.(record.instance.instanceId);
    }
    record.releaseLease?.();
  }

  private collectSubtree(instanceId: string): ManagedRecord[] {
    const result: ManagedRecord[] = [];
    const visit = (currentId: string) => {
      const record = this.requireRecord(currentId);
      result.push(record);
      for (const child of this.options.tree.childrenOf(currentId)) {
        visit(child.instanceId);
      }
    };
    visit(instanceId);
    return result;
  }

  private requireRecord(instanceId: string): ManagedRecord {
    const record = this.records.get(instanceId);
    if (!record) throw new Error(`runtime instance not found: ${instanceId}`);
    return record;
  }
}

function terminalEventType(terminal: ControllerTerminal): string {
  switch (terminal.kind) {
    case "completed":
      return "agent.completed";
    case "failed":
      return "agent.failed";
    case "cancelled":
      return "agent.cancelled";
  }
}

function terminalPayload(
  terminal: ControllerTerminal,
): Readonly<Record<string, unknown>> {
  switch (terminal.kind) {
    case "completed":
      return {
        final: terminal.result.final,
        ...(terminal.result.output !== undefined
          ? { output: terminal.result.output }
          : {}),
        ...(terminal.result.usage ? { usage: terminal.result.usage } : {}),
      };
    case "failed":
      return {
        error: terminal.error instanceof Error
          ? terminal.error.message
          : String(terminal.error),
      };
    case "cancelled":
      return terminal.reason ? { reason: terminal.reason } : {};
  }
}

function toCompletion(terminal: ControllerTerminal): AgentCompletion {
  const releasedAt = Date.now();
  switch (terminal.kind) {
    case "completed":
      return { status: "completed", result: terminal.result, releasedAt };
    case "failed":
      return { status: "failed", error: terminal.error, releasedAt };
    case "cancelled":
      return {
        status: "cancelled",
        ...(terminal.reason ? { reason: terminal.reason } : {}),
        releasedAt,
      };
  }
}
