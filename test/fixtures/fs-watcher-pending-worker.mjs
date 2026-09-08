import { parentPort } from 'node:worker_threads';

if (parentPort === null) throw new Error('pending watcher fixture requires a parent port');

const gate = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(gate, 0, 0, 1_000);
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (event) => {
  if (event?.type !== 'stop') return;
  parentPort.postMessage({ type: 'stopped' });
  parentPort.close();
  process.exit(0);
});
