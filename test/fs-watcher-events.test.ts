import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsWatcher, type FileChangeEvent, type FsWatcherState } from '../src/api/lib/watcher';

async function eventually<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('FsWatcher worker lifecycle', () => {
  test('keeps the caller responsive while the backend is still starting', async () => {
    const watcher = new FsWatcher({
      workerUrl: new URL('./fixtures/fs-watcher-pending-worker.mjs', import.meta.url),
      startupWarningMs: 2_000,
    });
    const states: FsWatcherState[] = [];
    watcher.onStatus((status) => states.push(status.state));
    const startedAt = performance.now();
    watcher.start(tmpdir());
    const startElapsedMs = performance.now() - startedAt;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(startElapsedMs).toBeLessThan(200);
      expect(watcher.getStatus().state).toBe('starting');
      await eventually(() => watcher.getStatus().state === 'ready' ? true : undefined);
      expect(states).toEqual(['idle', 'starting', 'ready']);
    } finally {
      server.stop(true);
      await watcher.stop();
    }
  });

  test('reports worker startup failures without throwing from start', async () => {
    const watcher = new FsWatcher({
      workerUrl: new URL('./fixtures/fs-watcher-missing-worker.mjs', import.meta.url),
    });
    const startedAt = performance.now();
    watcher.start(tmpdir());

    try {
      expect(performance.now() - startedAt).toBeLessThan(200);
      await eventually(() => watcher.getStatus().state === 'error' ? true : undefined);
      expect(watcher.getStatus().error).toContain('fs-watcher-missing-worker.mjs');
    } finally {
      await watcher.stop();
    }
  });

  test('stops within a bounded time when the backend is synchronously blocked', async () => {
    const watcher = new FsWatcher({
      workerUrl: new URL('./fixtures/fs-watcher-pending-worker.mjs', import.meta.url),
    });
    watcher.start(tmpdir());
    const stoppedAt = performance.now();
    await watcher.stop();

    expect(performance.now() - stoppedAt).toBeLessThan(1_100);
    expect(watcher.getStatus().state).toBe('stopped');
  });

  test('reports add, update, and unlink events under .forgeax/games', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-fs-watcher-'));
    const gameDir = join(root, '.forgeax', 'games', 'demo');
    const source = join(gameDir, 'main.ts');
    const watcher = new FsWatcher();
    const events: FileChangeEvent[] = [];
    watcher.on((event) => {
      if (event.type === 'file-event') events.push(event);
    });

    try {
      await mkdir(gameDir, { recursive: true });
      watcher.start(root);
      await eventually(() => watcher.getStatus().state === 'ready' ? true : undefined);

      await writeFile(source, 'export const version = 1;\n');
      await eventually(() => events.find((event) => event.change === 'add'));
      await writeFile(source, 'export const version = 2;\n');
      await eventually(() => events.find((event) => event.change === 'update'));
      await unlink(source);
      await eventually(() => events.find((event) => event.change === 'unlink'));

      expect(events.map(({ change, path }) => ({ change, path }))).toEqual([
        { change: 'add', path: '.forgeax/games/demo/main.ts' },
        { change: 'update', path: '.forgeax/games/demo/main.ts' },
        { change: 'unlink', path: '.forgeax/games/demo/main.ts' },
      ]);
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
