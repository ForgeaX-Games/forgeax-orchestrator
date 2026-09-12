import type { AgentExecutionSnapshot } from "../agents/template-types";
import type { RuntimeConfigSnapshot } from "./runtime-config";
import type { AgentInstance, AgentRuntimeState } from "./types";

export interface TurnBindings {
  readonly definitionRevision: string;
  readonly runtimeConfig: RuntimeConfigSnapshot;
  readonly execution: AgentExecutionSnapshot;
  readonly runtime: AgentInstance["runtime"];
}

export interface AgentTurnResult {
  /** Ephemeral instances are eligible for GC after a final result. */
  readonly final: boolean;
  readonly output?: unknown;
  readonly usage?: Record<string, unknown>;
}

export interface AgentTurnExecutor {
  execute(
    instance: AgentInstance,
    input: unknown,
    bindings: TurnBindings,
    signal: AbortSignal,
  ): Promise<AgentTurnResult>;
  dispose?(): void | Promise<void>;
}

interface QueuedTurn {
  readonly input: unknown;
  readonly resolve: (result: AgentTurnResult) => void;
  readonly reject: (error: unknown) => void;
}

const MAX_QUEUED_TURNS = 50;

export interface RuntimeTurnBatch {
  readonly kind: "runtime-turn-batch";
  readonly inputs: readonly unknown[];
}

export type ControllerTerminal =
  | { readonly kind: "completed"; readonly result: AgentTurnResult }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "cancelled"; readonly reason?: string };

/**
 * Owns one instance's queue, active turn and abort signal. It deliberately has
 * no parent/children map; RuntimeSupervisor is the only tree authority.
 */
export class AgentRuntimeController {
  private readonly queue: QueuedTurn[] = [];
  private currentAbort: AbortController | null = null;
  private wakeCoalesce: (() => void) | null = null;
  private processing = false;
  private pumpTask: Promise<void> | null = null;
  private disposed = false;
  private cancelNotified = false;
  private readonly terminalListeners = new Set<(event: ControllerTerminal) => void>();
  private readonly stateListeners = new Set<(state: AgentRuntimeState) => void>();

  constructor(
    readonly instance: AgentInstance,
    private readonly executor: AgentTurnExecutor,
  ) {}

  start(): void {
    if (this.disposed) throw new Error(`controller disposed: ${this.instance.instanceId}`);
    if (this.instance.state === "registered") this.setState("idle");
  }

  /** Accept one input synchronously and return its eventual turn completion.
   *
   * Callers that only need an acceptance receipt can treat a successful
   * return as "queued": all rejection conditions are checked before this
   * method returns. `enqueue()` preserves the older promise-only API by
   * converting those synchronous errors back into rejected promises. */
  acceptTurn(input: unknown): Promise<AgentTurnResult> {
    if (this.disposed) {
      throw new Error(`controller disposed: ${this.instance.instanceId}`);
    }
    if (
      this.instance.state === "cancelled" ||
      this.instance.state === "failed" ||
      this.instance.state === "draining"
    ) {
      throw new Error(
        `controller does not accept turns in state ${this.instance.state}: ${this.instance.instanceId}`,
      );
    }
    const handoff = eventHandoff(input);
    if (handoff === "passive" && !this.processing) {
      return Promise.resolve({ final: false });
    }
    const promise = new Promise<AgentTurnResult>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      if (this.queue.length > MAX_QUEUED_TURNS) {
        this.queue.shift()!.reject(
          new Error(
            `runtime turn queue overflow: ${this.instance.instanceId}`,
          ),
        );
      }
    });
    if (handoff === "steer") {
      this.currentAbort?.abort("steered by inbound event");
      this.wakeCoalesce?.();
    }
    if (handoff !== "silent") this.schedulePump();
    return promise;
  }

  enqueue(input: unknown): Promise<AgentTurnResult> {
    try {
      return this.acceptTurn(input);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  cancel(reason?: string): void {
    if (this.disposed) return;
    this.abortAndRejectQueued(reason ?? "agent cancelled");
    this.setState("cancelled");
    if (!this.cancelNotified) {
      this.cancelNotified = true;
      this.emitTerminal({ kind: "cancelled", ...(reason ? { reason } : {}) });
    }
  }

  /** Abort only the active turn; resident instance identity remains live. */
  interruptTurn(reason?: string): void {
    if (this.disposed) return;
    const message = reason ?? "turn interrupted";
    if (this.currentAbort) {
      this.currentAbort.abort(message);
      return;
    }
    if (this.wakeCoalesce) {
      this.rejectQueued(message);
      this.wakeCoalesce();
    }
  }

  /** Explicit user stop: retain peer results as context without waking a turn.
   * Human inputs already queued remain actionable. */
  stopTurn(reason = "stopped by user"): void {
    if (this.disposed) return;
    for (let i = 0; i < this.queue.length; i++) {
      const turn = this.queue[i]!;
      if (turn.input && typeof turn.input === "object" &&
          (turn.input as { source?: unknown }).source === "agent") {
        if ((turn.input as { type?: unknown }).type === "user_input") {
          // An unstarted delegated assignment must not execute on continuation.
          this.queue.splice(i--, 1);
          turn.reject(new Error(reason));
        } else {
          this.queue[i] = { ...turn, input: { ...turn.input, handoff: "silent" } };
        }
      }
    }
    this.currentAbort?.abort(reason);
    this.wakeCoalesce?.();
  }

  /** Session mutation barrier: abort active work and reject queued turns. */
  interruptAndClear(reason?: string): void {
    if (this.disposed) return;
    const message = reason ?? "turn interrupted by Session mutation";
    this.currentAbort?.abort(message);
    this.rejectQueued(message);
    this.wakeCoalesce?.();
  }

  async waitForQuiescence(): Promise<void> {
    while (this.pumpTask) await this.pumpTask;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortAndRejectQueued("agent disposed");
    await this.pumpTask;
    this.setState("disposed");
    await this.executor.dispose?.();
    this.terminalListeners.clear();
    this.stateListeners.clear();
  }

  onTerminal(listener: (event: ControllerTerminal) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  onState(listener: (state: AgentRuntimeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  get pendingTurns(): number {
    return this.queue.length + (this.currentAbort ? 1 : 0);
  }

  get turnExecutor(): AgentTurnExecutor {
    return this.executor;
  }

  private async pump(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      while (!this.disposed && this.queue.length) {
        const triggerIndex = this.queue.findIndex(
          (turn) => eventHandoff(turn.input) !== "silent",
        );
        if (triggerIndex < 0) break;
        const trigger = this.queue[triggerIndex]!;
        const coalesceMs =
          this.instance.runtimeConfig.next().value.coalesceMs ?? 0;
        if (
          eventHandoff(trigger.input) !== "steer" &&
          !isAgentCommand(trigger.input) &&
          eventPriority(trigger.input) > 0 &&
          coalesceMs > 0
        ) {
          await this.waitForCoalesce(coalesceMs);
          if (this.disposed) break;
          if (
            !this.queue.some(
              (turn) => eventHandoff(turn.input) !== "silent",
            )
          ) {
            continue;
          }
        }
        // `agent_command` used to live in ConsciousAgent.commandQueue and was
        // executed independently from the coalesced inbound-message batch.
        // Preserve that boundary: commands must reach RuntimeAgentHost with
        // their original type, never be rewritten into a synthetic user_input.
        const commandIndex = this.queue.findIndex((turn) =>
          isAgentCommand(turn.input)
        );
        const turns = commandIndex >= 0
          ? this.queue.splice(commandIndex, 1)
          : this.queue.splice(0);
        if (turns.length === 0) continue;
        const input: unknown = turns.length === 1
          ? turns[0]!.input
          : Object.freeze({
              kind: "runtime-turn-batch",
              inputs: Object.freeze(turns.map((turn) => turn.input)),
            } satisfies RuntimeTurnBatch);
        this.currentAbort = new AbortController();
        this.setState("running");
        const bindings: TurnBindings = {
          definitionRevision: this.instance.template.definitionRevision,
          runtimeConfig: this.instance.runtimeConfig.pinForTurn(),
          execution: this.instance.execution.pinForTurn(),
          runtime: this.instance.runtime,
        };
        try {
          const result = await this.executor.execute(
            this.instance,
            input,
            bindings,
            this.currentAbort.signal,
          );
          for (const turn of turns) turn.resolve(result);
          if (result.final) this.emitTerminal({ kind: "completed", result });
        } catch (error) {
          if (this.currentAbort.signal.aborted) {
            for (const turn of turns) turn.reject(error);
            // A resident turn interruption does not terminate its identity.
            // Ephemeral instances have no next durable turn, so interruption
            // is terminal and lets the Supervisor release their subtree.
            if (
              this.instance.lifetime === "ephemeral" &&
              !this.cancelNotified &&
              !this.disposed
            ) {
              this.cancelNotified = true;
              this.emitTerminal({
                kind: "cancelled",
                reason: String(this.currentAbort.signal.reason ?? ""),
              });
            }
          } else if (this.instance.lifetime === "ephemeral") {
            // Ephemeral has no durable next turn — terminal failure lets the
            // Supervisor release the subtree.
            this.setState("failed");
            for (const turn of turns) turn.reject(error);
            this.emitTerminal({ kind: "failed", error });
          } else {
            // Resident identity survives a single turn error (old ConsciousAgent
            // loop logged and kept waiting). Reject this batch, stay idle so
            // later enqueue still works.
            for (const turn of turns) turn.reject(error);
          }
        } finally {
          this.currentAbort = null;
          this.instance.runtimeConfig.reconcileAtTurnBoundary();
          this.instance.execution.reconcileAtTurnBoundary();
          if (
            !this.disposed &&
            this.instance.state !== "cancelled" &&
            this.instance.state !== "failed" &&
            this.instance.state !== "draining"
          ) {
            this.setState("idle");
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private schedulePump(): void {
    if (this.pumpTask || this.disposed) return;
    this.pumpTask = this.pump().finally(() => {
      this.pumpTask = null;
      if (
        !this.disposed &&
        this.queue.some((turn) => eventHandoff(turn.input) !== "silent")
      ) {
        this.schedulePump();
      }
    });
  }

  private setState(state: AgentRuntimeState): void {
    if (this.instance.state === state) return;
    this.instance.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private emitTerminal(event: ControllerTerminal): void {
    for (const listener of this.terminalListeners) listener(event);
  }

  private abortAndRejectQueued(reason: string): void {
    this.currentAbort?.abort(reason);
    this.rejectQueued(reason);
    this.wakeCoalesce?.();
  }

  private rejectQueued(reason: string): void {
    const error = new Error(reason);
    while (this.queue.length) this.queue.shift()!.reject(error);
  }

  private waitForCoalesce(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (this.wakeCoalesce !== finish) return;
        this.wakeCoalesce = null;
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.wakeCoalesce = finish;
      timer = setTimeout(finish, ms);
    });
  }
}

function eventHandoff(
  input: unknown,
): "silent" | "passive" | "turn" | "innerLoop" | "steer" {
  if (!input || typeof input !== "object") return "turn";
  const handoff = (input as { handoff?: unknown }).handoff;
  return handoff === "silent" ||
      handoff === "passive" ||
      handoff === "turn" ||
      handoff === "innerLoop" ||
      handoff === "steer"
    ? handoff
    : "turn";
}

function eventPriority(input: unknown): number {
  if (!input || typeof input !== "object") return 1;
  const priority = (input as { priority?: unknown }).priority;
  return typeof priority === "number" ? priority : 1;
}

function isAgentCommand(input: unknown): boolean {
  return Boolean(
    input &&
      typeof input === "object" &&
      (input as { type?: unknown }).type === "agent_command",
  );
}
