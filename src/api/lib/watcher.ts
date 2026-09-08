import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

export interface FileChangeEvent {
  type: 'file-event';
  path: string;
  change: 'add' | 'update' | 'unlink';
}

export interface AssetDiskChangedEvent {
  type: 'asset-disk-changed';
  path: string;
  change: FileChangeEvent['change'];
  gameSlug: string;
  /** Path relative to the game root, e.g. assets/scenes/main.pack.json. */
  gamePath: string;
  /** File category aligned with vite-plugin-pack's watched asset classes. */
  assetFileKind: 'pack' | 'meta' | 'source';
  /** Primary asset kind in the changed pack. Scene wins when present. */
  assetKind?: string;
  /** All top-level asset kinds declared by the pack, deduped in file order. */
  assetKinds?: string[];
  sceneGuid?: string;
  parseOk: boolean;
}

export type FsWatcherEvent = FileChangeEvent | AssetDiskChangedEvent;

export type FsWatcherState = 'idle' | 'starting' | 'ready' | 'error' | 'stopped';

export interface FsWatcherStatus {
  state: FsWatcherState;
  rootDir: string;
  paths: string[];
  error?: string;
}

type Listener = (ev: FsWatcherEvent) => void;
type StatusListener = (status: FsWatcherStatus) => void;

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'event'; change: FileChangeEvent['change']; path: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

export interface FsWatcherOptions {
  /** Override used by deterministic lifecycle tests. */
  workerUrl?: URL;
  startupWarningMs?: number;
}

// Skip standard cache/vcs dirs everywhere. Keep authored files under
// .forgeax/games/, but ignore each game's runtime-owned state. Watching
// <game>/.forgeax/ddc on Windows can hold a staging directory open while the
// DDC atomically renames it, causing an EPERM/rebind loop; sessions are likewise
// high-churn runtime output rather than authored game source.
const SKIP_RX = /(?:^|[\\/])(?:node_modules|\.git|dist|build|\.cache)(?:[\\/]|$)|(?:^|[\\/])\.forgeax[\\/](?:agenteam-state|cache)(?:[\\/]|$)|(?:^|[\\/])\.forgeax[\\/]games[\\/][^\\/]+[\\/](?:sessions|\.forgeax)(?:[\\/]|$)/;

/** Pure path predicate shared by chokidar and regression tests. */
export function isIgnoredFsWatcherPath(path: string): boolean {
  return SKIP_RX.test(path);
}

function defaultWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  return moduleUrl.pathname.endsWith('/dist/index.js')
    ? new URL('./api/lib/watcher-worker.mjs', moduleUrl)
    : new URL('./watcher-worker.mjs', moduleUrl);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export class FsWatcher {
  private worker?: Worker;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private rootDir = '';
  private paths: string[] = [];
  private generation = 0;
  private startupWarning?: ReturnType<typeof setTimeout>;
  private statusValue: FsWatcherStatus = { state: 'idle', rootDir: '', paths: [] };

  constructor(private readonly options: FsWatcherOptions = {}) {}

  // Default to instance-local games dir under .forgeax/. Each studio dev /
  // release-forgeax instance owns its own .forgeax/games/, gitignored.
  start(rootDir: string, paths: string[] = ['.forgeax/games']): void {
    if (this.worker) return;
    this.rootDir = rootDir;
    this.paths = [...paths];
    const generation = ++this.generation;
    this.publishStatus({ state: 'starting', rootDir, paths: [...paths] });
    console.log(`[fs-watcher] starting worker for ${paths.join(', ')} under ${rootDir}`);

    let worker: Worker;
    try {
      worker = new Worker(this.options.workerUrl ?? defaultWorkerUrl(), {
        name: 'forgeax-fs-watcher',
        workerData: {
          rootDir,
          paths,
          ignoredSource: SKIP_RX.source,
          ignoredFlags: SKIP_RX.flags,
        },
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    this.worker = worker;
    worker.on('message', (message: WorkerMessage) => {
      if (generation !== this.generation || worker !== this.worker) return;
      if (message.type === 'ready') {
        this.clearStartupWarning();
        this.publishStatus({ state: 'ready', rootDir, paths: [...paths] });
        console.log(`[fs-watcher] ready for ${paths.join(', ')} under ${rootDir}`);
      } else if (message.type === 'event') {
        this.emit(message.change, message.path);
      } else if (message.type === 'error') {
        this.fail(message.message);
      }
    });
    worker.on('error', (error) => {
      if (generation === this.generation && worker === this.worker) this.fail(error);
    });
    worker.on('exit', (code) => {
      if (generation !== this.generation || worker !== this.worker) return;
      this.worker = undefined;
      this.clearStartupWarning();
      if (this.statusValue.state !== 'stopped' && this.statusValue.state !== 'error') {
        this.fail(`watcher worker exited unexpectedly with code ${code}`);
      }
    });

    const warningMs = this.options.startupWarningMs ?? 5_000;
    this.startupWarning = setTimeout(() => {
      if (generation !== this.generation || this.statusValue.state !== 'starting') return;
      console.warn(
        `[fs-watcher] backend still starting after ${warningMs}ms; HTTP remains available and file events will begin after readiness`,
      );
    }, warningMs);
    this.startupWarning.unref?.();
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.getStatus());
    return () => this.statusListeners.delete(fn);
  }

  getStatus(): FsWatcherStatus {
    return {
      ...this.statusValue,
      paths: [...this.statusValue.paths],
    };
  }

  private emit(change: FileChangeEvent['change'], rawPath: string) {
    const norm = rawPath.split('\\').join('/');
    const ev: FileChangeEvent = { type: 'file-event', path: norm, change };
    this.broadcast(ev);
    void this.emitAssetDiskChanged(change, norm);
  }

  private async emitAssetDiskChanged(change: FileChangeEvent['change'], normPath: string): Promise<void> {
    const assetFileKind = this.assetFileKind(normPath);
    if (assetFileKind === null) return;
    const m = normPath.match(/^(?:\.forgeax\/games|games)\/([^/]+)\/(.+)$/);
    if (!m) return;
    const [, gameSlug, gamePath] = m;
    const ev: AssetDiskChangedEvent = {
      type: 'asset-disk-changed',
      path: normPath,
      change,
      gameSlug,
      gamePath,
      assetFileKind,
      parseOk: false,
    };
    if (change !== 'unlink' && (assetFileKind === 'pack' || assetFileKind === 'meta')) {
      try {
        const raw = await readFile(resolve(this.rootDir, normPath), 'utf8');
        const parsed = JSON.parse(raw) as { assets?: Array<{ kind?: unknown; guid?: unknown }> };
        const kinds: string[] = [];
        if (Array.isArray(parsed.assets)) {
          for (const asset of parsed.assets) {
            if (typeof asset?.kind !== 'string' || kinds.includes(asset.kind)) continue;
            kinds.push(asset.kind);
          }
          const scene = parsed.assets.find((asset) => asset?.kind === 'scene');
          ev.sceneGuid = typeof scene?.guid === 'string' ? scene.guid : undefined;
        }
        ev.assetKinds = kinds;
        ev.assetKind = kinds.includes('scene') ? 'scene' : kinds[0];
        ev.parseOk = true;
      } catch {
        ev.assetKind = 'unknown';
      }
    }
    this.broadcast(ev);
  }

  private assetFileKind(path: string): AssetDiskChangedEvent['assetFileKind'] | null {
    if (path.endsWith('.pack.json')) return 'pack';
    if (path.endsWith('.meta.json')) return 'meta';
    if (
      path.endsWith('.jpg') ||
      path.endsWith('.jpeg') ||
      path.endsWith('.png') ||
      path.endsWith('.gltf')
    ) return 'source';
    return null;
  }

  private broadcast(ev: FsWatcherEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('[fs-watcher] listener error:', (e as Error).message);
      }
    }
  }

  private publishStatus(status: FsWatcherStatus): void {
    this.statusValue = status;
    for (const listener of this.statusListeners) {
      try {
        listener(this.getStatus());
      } catch (error) {
        console.error('[fs-watcher] status listener error:', errorMessage(error));
      }
    }
  }

  private fail(error: unknown): void {
    this.clearStartupWarning();
    const message = errorMessage(error);
    this.publishStatus({
      state: 'error',
      rootDir: this.rootDir,
      paths: [...this.paths],
      error: message,
    });
    console.error('[fs-watcher] worker error:', message);
  }

  private clearStartupWarning(): void {
    if (this.startupWarning !== undefined) clearTimeout(this.startupWarning);
    this.startupWarning = undefined;
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    ++this.generation;
    this.clearStartupWarning();
    this.publishStatus({ state: 'stopped', rootDir: this.rootDir, paths: [...this.paths] });
    this.listeners.clear();
    this.statusListeners.clear();
    if (!worker) return;

    let exited = false;
    const exit = new Promise<void>((resolveExit) => {
      worker.once('exit', () => {
        exited = true;
        resolveExit();
      });
    });
    try {
      worker.postMessage({ type: 'stop' });
    } catch {
      // A worker that failed during construction is handled by terminate below.
    }
    await Promise.race([exit, wait(500)]);
    if (exited) return;

    console.warn('[fs-watcher] worker did not stop within 500ms; terminating it');
    worker.unref();
    const terminated = worker.terminate().then(() => undefined, (error) => {
      console.error('[fs-watcher] worker termination error:', errorMessage(error));
    });
    await Promise.race([terminated, wait(500)]);
  }
}
