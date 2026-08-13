import type { CodexAppServerClient } from './codex-appserver-client';

export interface OwnedCodexAppServer {
  client: CodexAppServerClient;
  cleanup(): Promise<void>;
}

interface PoolEntry extends OwnedCodexAppServer {
  fingerprint: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

function configuredIdleTtlMs(): number {
  const raw = process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_TTL_MS;
}

/**
 * Session-home scoped owner for Codex's documented persistent app-server.
 *
 * Callers serialize one logical home with `codexHomeMutex`. The pool therefore
 * only owns lifecycle: reuse an exact capability/configuration fingerprint,
 * replace a stale/dead process, and retain its per-process MCP runtime until
 * the process is actually closed. A per-turn temporary MCP config must never
 * be deleted while a warm app-server still references it.
 */
export class CodexAppServerPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly acquisitions = new Map<string, Promise<void>>();
  private readonly closings = new Map<string, Promise<void>>();
  private closing = false;

  async acquire(
    homeKey: string,
    fingerprint: string,
    create: () => Promise<OwnedCodexAppServer>,
  ): Promise<{ session: OwnedCodexAppServer; reused: boolean }> {
    if (this.closing) throw new Error('codex app-server pool is shutting down');

    // Keep the lifecycle owner correct even if a future caller forgets the
    // outer session-home mutex: one key may create/replace only one process at
    // a time. Different homes still proceed independently.
    const previous = this.acquisitions.get(homeKey) ?? Promise.resolve();
    let unlock!: () => void;
    const currentAcquisition = previous.then(() => new Promise<void>((resolve) => { unlock = resolve; }));
    this.acquisitions.set(homeKey, currentAcquisition);
    await previous;
    try {
      return await this.acquireOwned(homeKey, fingerprint, create);
    } finally {
      unlock();
      if (this.acquisitions.get(homeKey) === currentAcquisition) this.acquisitions.delete(homeKey);
    }
  }

  private async acquireOwned(
    homeKey: string,
    fingerprint: string,
    create: () => Promise<OwnedCodexAppServer>,
  ): Promise<{ session: OwnedCodexAppServer; reused: boolean }> {
    await this.closings.get(homeKey);
    const current = this.entries.get(homeKey);
    if (current && current.fingerprint === fingerprint && current.client.alive) {
      if (current.idleTimer) clearTimeout(current.idleTimer);
      current.idleTimer = undefined;
      return { session: current, reused: true };
    }
    if (current) await this.closeEntry(homeKey, current);

    const owned = await create();
    const entry: PoolEntry = { ...owned, fingerprint };
    this.entries.set(homeKey, entry);
    return { session: entry, reused: false };
  }

  release(homeKey: string, session: OwnedCodexAppServer): void {
    const entry = this.entries.get(homeKey);
    if (!entry || entry.client !== session.client) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.closeEntry(homeKey, entry);
    }, configuredIdleTtlMs());
    entry.idleTimer.unref?.();
  }

  async evict(homeKey: string, session?: OwnedCodexAppServer): Promise<void> {
    const entry = this.entries.get(homeKey);
    if (!entry) {
      // An idle timer removes the entry before awaiting the real process exit.
      // Exec ownership handoff must still wait for that in-flight close, or two
      // processes can overlap one CODEX_HOME.
      await this.closings.get(homeKey);
      return;
    }
    if (session && entry.client !== session.client) return;
    await this.closeEntry(homeKey, entry);
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.acquisitions.values()]);
    await Promise.all([...this.entries].map(([key, entry]) => this.closeEntry(key, entry)));
    await Promise.all([...this.closings.values()]);
  }

  private async closeEntry(homeKey: string, entry: PoolEntry): Promise<void> {
    const prior = this.closings.get(homeKey);
    if (prior) await prior;
    if (this.entries.get(homeKey) !== entry) return;
    let settle!: () => void;
    const closing = new Promise<void>((resolve) => { settle = resolve; });
    this.closings.set(homeKey, closing);
    if (this.entries.get(homeKey) === entry) this.entries.delete(homeKey);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      await entry.client.close();
      await entry.cleanup();
    } finally {
      settle();
      if (this.closings.get(homeKey) === closing) this.closings.delete(homeKey);
    }
  }
}
