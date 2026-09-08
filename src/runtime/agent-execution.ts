import type { AgentExecutionSnapshot } from "../agents/template-types";

/** Keeps execution updates out of an in-flight turn. */
export class AgentExecutionBinding {
  private currentSnapshot: AgentExecutionSnapshot;
  private pendingSnapshot: AgentExecutionSnapshot | null = null;

  constructor(initial: AgentExecutionSnapshot) {
    this.currentSnapshot = initial;
  }

  current(): AgentExecutionSnapshot {
    return this.currentSnapshot;
  }

  next(): AgentExecutionSnapshot {
    return this.pendingSnapshot ?? this.currentSnapshot;
  }

  pinForTurn(): AgentExecutionSnapshot {
    if (this.pendingSnapshot) {
      this.currentSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
    }
    return this.currentSnapshot;
  }

  stage(next: AgentExecutionSnapshot): void {
    this.pendingSnapshot = next;
  }

  reconcileAtTurnBoundary(): AgentExecutionSnapshot {
    if (this.pendingSnapshot) {
      this.currentSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
    }
    return this.currentSnapshot;
  }
}
