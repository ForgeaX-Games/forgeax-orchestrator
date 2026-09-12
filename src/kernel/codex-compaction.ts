import type { CodexAppServerClient } from './codex-appserver-client';

export interface CompactionStatus { id: string; phase: 'started' | 'completed' | 'failed' | 'cancelled'; count: number; durationMs?: number }
export class CodexCompactionTracker {
  private count = 0;
  private active = new Map<string, { count: number; started: number }>();
  private completed = new Set<string>();

  observe(method: string, params: any): CompactionStatus[] {
    const item = params?.item;
    if ((method === 'item/started' || method === 'item/completed') && item?.type === 'contextCompaction' && typeof item.id === 'string') {
      if (this.completed.has(item.id)) return [];
      const previous = this.active.get(item.id);
      const state = previous ?? { count: ++this.count, started: Date.now() };
      if (method === 'item/started') {
        if (previous) return [];
        this.active.set(item.id, state);
        return [{ id: item.id, phase: 'started', count: state.count }];
      }
      this.active.delete(item.id);
      this.completed.add(item.id);
      return [{ id: item.id, phase: 'completed', count: state.count, durationMs: Date.now() - state.started }];
    }
    if (method === 'error' || (method === 'turn/completed' && params?.turn?.status !== 'completed')) {
      return this.finish(params?.turn?.status === 'interrupted' ? 'cancelled' : 'failed');
    }
    return [];
  }

  finish(phase: 'failed' | 'cancelled'): CompactionStatus[] {
    const statuses = [...this.active].map(([id, value]) => {
      this.completed.add(id);
      return { id, phase, count: value.count, durationMs: Date.now() - value.started };
    });
    this.active.clear();
    return statuses;
  }
}

/** Use the selected native thread's own compactor. No provider fallback and no
 * invented replacement summary in the host ledger. */
export async function compactCodexThread(client: CodexAppServerClient, threadId: string,
  tracker: CodexCompactionTracker, onStatus: (status: CompactionStatus) => void): Promise<void> {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error('Native context compaction did not complete within 120 seconds.')), 120_000);
  const restore = client.setTurnHandlers({
    onServerRequest: async () => { throw new Error('Unexpected tool request during context compaction'); },
    onNotification: (method, params) => {
      if (params?.threadId && params.threadId !== threadId) return;
      for (const status of tracker.observe(method, params)) {
        onStatus(status);
        if (status.phase === 'completed') resolve();
        if (status.phase === 'failed' || status.phase === 'cancelled') reject(new Error('Native context compaction failed.'));
      }
      if (method === 'error') reject(new Error(params?.error?.message ?? 'Native context compaction failed.'));
    },
    onExit: () => reject(new Error('Native context owner exited during compaction.')),
  });
  try {
    // Attach the rejection handler before dispatch: an early notification may
    // arrive before the RPC acknowledgement.
    await Promise.all([done, client.request('thread/compact/start', { threadId })]);
  } finally {
    for (const status of tracker.finish('failed')) onStatus(status);
    clearTimeout(timer);
    restore();
  }
}
