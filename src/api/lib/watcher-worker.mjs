import chokidar from 'chokidar';
import { parentPort, workerData } from 'node:worker_threads';

if (parentPort === null) throw new Error('FsWatcher worker requires an IPC parent port');

const { rootDir, paths, ignoredSource, ignoredFlags } = workerData;
const ignored = new RegExp(ignoredSource, ignoredFlags);

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

let watcher;
try {
  watcher = chokidar.watch(paths, {
    cwd: rootDir,
    ignored: (path) => ignored.test(path),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 30 },
  });
  watcher.on('add', (path) => parentPort.postMessage({ type: 'event', change: 'add', path }));
  watcher.on('change', (path) => parentPort.postMessage({ type: 'event', change: 'update', path }));
  watcher.on('unlink', (path) => parentPort.postMessage({ type: 'event', change: 'unlink', path }));
  watcher.on('ready', () => parentPort.postMessage({ type: 'ready' }));
  watcher.on('error', (error) => parentPort.postMessage({ type: 'error', message: message(error) }));
} catch (error) {
  parentPort.postMessage({ type: 'error', message: message(error) });
  parentPort.close();
}

parentPort.on('message', async (event) => {
  if (event?.type !== 'stop') return;
  try {
    await watcher?.close();
    parentPort.postMessage({ type: 'stopped' });
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: message(error) });
  } finally {
    parentPort.close();
    process.exit(0);
  }
});
