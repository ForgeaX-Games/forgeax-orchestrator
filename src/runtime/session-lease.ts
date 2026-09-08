export interface SessionLeaseSnapshot {
  readonly activeCount: number;
  readonly labels: readonly string[];
}

/**
 * Keeps a Session out of the LRU eviction path while runtime-owned work or
 * required lifecycle persistence is still active.
 */
export class SessionLease {
  private readonly active = new Map<symbol, string>();
  private readonly idleWaiters = new Set<() => void>();

  acquire(label: string): () => void {
    const token = Symbol(label);
    this.active.set(token, label);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(token);
      if (this.active.size === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  snapshot(): SessionLeaseSnapshot {
    return Object.freeze({
      activeCount: this.active.size,
      labels: Object.freeze([...this.active.values()].sort()),
    });
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  get activeCount(): number {
    return this.active.size;
  }

  get canEvict(): boolean {
    return this.active.size === 0;
  }
}
