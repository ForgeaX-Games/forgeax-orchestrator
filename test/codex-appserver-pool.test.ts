import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { CodexAppServerClient } from '../src/kernel/codex-appserver-client';
import { CodexAppServerPool } from '../src/kernel/codex-appserver-pool';
import { codexNativeSourceFingerprint } from '../src/kernel/codex-session-home';

function fakeOwned(log: string[]) {
  const fake: { alive: boolean; shutdown(): void; close(): Promise<void> } = {
    alive: true,
    shutdown() {
      this.alive = false;
      log.push('shutdown');
    },
    async close() {
      this.shutdown();
    },
  };
  const client = fake as unknown as CodexAppServerClient;
  return {
    client,
    cleanup: async () => { log.push('cleanup'); },
  };
}

function deferredOwned(log: string[], closing: Promise<void>) {
  const owned = fakeOwned(log);
  owned.client.close = async () => {
    log.push('closing');
    await closing;
    Object.defineProperty(owned.client, 'alive', { value: false, writable: true });
    log.push('closed');
  };
  return owned;
}

describe('CodexAppServerPool', () => {
  test('reuses an alive exact-fingerprint app-server', async () => {
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    let creates = 0;
    const first = await pool.acquire('home', 'surface-a', async () => {
      creates += 1;
      return fakeOwned(log);
    });
    pool.release('home', first.session);
    const second = await pool.acquire('home', 'surface-a', async () => {
      creates += 1;
      return fakeOwned(log);
    });
    expect(second.reused).toBe(true);
    expect(second.session.client).toBe(first.session.client);
    expect(creates).toBe(1);
    expect(log).toEqual([]);
    await pool.closeAll();
  });

  test('capability/config fingerprint change closes runtime before replacement', async () => {
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    const first = await pool.acquire('home', 'surface-a', async () => fakeOwned(log));
    pool.release('home', first.session);
    const second = await pool.acquire('home', 'surface-b', async () => {
      log.push('create-b');
      return fakeOwned(log);
    });
    expect(second.reused).toBe(false);
    expect(log).toEqual(['shutdown', 'cleanup', 'create-b']);
    await pool.closeAll();
  });

  test('symlinked capability edit replaces the warm owner', async () => {
    const priorHome = process.env.CODEX_HOME;
    const home = mkdtempSync(resolvePath(tmpdir(), 'codex-pool-link-home-'));
    const target = mkdtempSync(resolvePath(tmpdir(), 'codex-pool-link-target-'));
    process.env.CODEX_HOME = home;
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    try {
      mkdirSync(resolvePath(home, 'skills'), { recursive: true });
      const skill = resolvePath(target, 'SKILL.md');
      writeFileSync(skill, 'version-one');
      symlinkSync(target, resolvePath(home, 'skills', 'linked-skill'));

      const firstFingerprint = codexNativeSourceFingerprint();
      const first = await pool.acquire('home', firstFingerprint, async () => fakeOwned(log));
      pool.release('home', first.session);

      writeFileSync(skill, 'version-two-with-different-size');
      const secondFingerprint = codexNativeSourceFingerprint();
      const second = await pool.acquire('home', secondFingerprint, async () => {
        log.push('create-new');
        return fakeOwned(log);
      });

      expect(secondFingerprint).not.toBe(firstFingerprint);
      expect(second.reused).toBe(false);
      expect(second.session.client).not.toBe(first.session.client);
      expect(log).toEqual(['shutdown', 'cleanup', 'create-new']);
    } finally {
      await pool.closeAll();
      if (priorHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('dead app-server is never reused', async () => {
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    let creates = 0;
    const first = await pool.acquire('home', 'surface-a', async () => {
      creates += 1;
      return fakeOwned(log);
    });
    Object.defineProperty(first.session.client, 'alive', { value: false, writable: true });
    const second = await pool.acquire('home', 'surface-a', async () => {
      creates += 1;
      return fakeOwned(log);
    });
    expect(second.reused).toBe(false);
    expect(creates).toBe(2);
    await pool.closeAll();
  });

  test('concurrent same-home acquire creates exactly one owner', async () => {
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    let creates = 0;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const create = async () => {
      creates += 1;
      await blocked;
      return fakeOwned(log);
    };
    const firstPromise = pool.acquire('home', 'surface-a', create);
    const secondPromise = pool.acquire('home', 'surface-a', create);
    unblock();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(creates).toBe(1);
    expect(first.session.client).toBe(second.session.client);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    await pool.closeAll();
  });

  test('closeAll waits for admitted create and rejects later admission', async () => {
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const acquiring = pool.acquire('home', 'surface-a', async () => {
      await blocked;
      return fakeOwned(log);
    });
    const closing = pool.closeAll();
    unblock();
    await acquiring;
    await closing;
    expect(log).toEqual(['shutdown', 'cleanup']);
    await expect(pool.acquire('late', 'surface-a', async () => fakeOwned(log))).rejects.toThrow('shutting down');
  });

  test('replacement waits until an idle close fully releases the home', async () => {
    const priorTtl = process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS;
    process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS = '0';
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    const first = await pool.acquire('home', 'surface-a', async () => deferredOwned(log, closing));
    pool.release('home', first.session);
    await new Promise((resolve) => setTimeout(resolve, 5));
    let replacementCreated = false;
    const replacement = pool.acquire('home', 'surface-b', async () => {
      replacementCreated = true;
      return fakeOwned(log);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(replacementCreated).toBe(false);
    finishClose();
    await replacement;
    expect(log.slice(0, 3)).toEqual(['closing', 'closed', 'cleanup']);
    await pool.closeAll();
    if (priorTtl === undefined) delete process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS;
    else process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS = priorTtl;
  });

  test('exec handoff eviction waits for an idle close after its map entry was removed', async () => {
    const priorTtl = process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS;
    process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS = '0';
    const pool = new CodexAppServerPool();
    const log: string[] = [];
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    const first = await pool.acquire('home', 'surface-a', async () => deferredOwned(log, closing));
    pool.release('home', first.session);
    await new Promise((resolve) => setTimeout(resolve, 5));
    let evicted = false;
    const handoff = pool.evict('home').then(() => { evicted = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(evicted).toBe(false);
    finishClose();
    await handoff;
    expect(evicted).toBe(true);
    await pool.closeAll();
    if (priorTtl === undefined) delete process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS;
    else process.env.FORGEAX_CODEX_APP_SERVER_IDLE_TTL_MS = priorTtl;
  });
});
