import type { ModelsConfig } from "../core/types";
import type { PermissionMode } from '@forgeax/agent-runtime';

export function parseAgentPermissionMode(value: unknown): PermissionMode {
  if (value === 'gated' || value === 'autoEdits' || value === 'planning' || value === 'unrestricted') return value;
  throw new Error(`invalid agent permissionMode: ${String(value)}`);
}

export interface RuntimeConfig {
  /** Omitted means inherit the live parent execution permission posture. */
  readonly permissionMode?: PermissionMode;
  readonly models?: ModelsConfig;
  readonly coalesceMs?: number;
  readonly maxIterations?: number;
  readonly historyKeep?: {
    readonly recentTools?: number;
    readonly recentMedias?: number;
    readonly idleGapMs?: number;
  };
  readonly timezone?: string;
  readonly defaultDir?: string;
  readonly defaultStatus?: string;
}

export interface RuntimeConfigSnapshot {
  readonly revision: string;
  readonly value: Readonly<RuntimeConfig>;
}

/** Stages updates for the next turn; a pinned turn never observes mutation. */
export class RuntimeConfigBinding {
  private currentSnapshot: RuntimeConfigSnapshot;
  private pendingSnapshot: RuntimeConfigSnapshot | null = null;

  constructor(initial: RuntimeConfigSnapshot) {
    this.currentSnapshot = initial;
  }

  current(): RuntimeConfigSnapshot {
    return this.currentSnapshot;
  }

  /** Runtime config that will be pinned by the next turn. */
  next(): RuntimeConfigSnapshot {
    return this.pendingSnapshot ?? this.currentSnapshot;
  }

  pinForTurn(): RuntimeConfigSnapshot {
    if (this.pendingSnapshot) {
      this.currentSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
    }
    return this.currentSnapshot;
  }

  stage(next: RuntimeConfigSnapshot): void {
    this.pendingSnapshot = next;
  }

  reconcileAtTurnBoundary(): RuntimeConfigSnapshot {
    if (this.pendingSnapshot) {
      this.currentSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
    }
    return this.currentSnapshot;
  }
}
