import { describe, expect, test } from 'bun:test';
import { runCapture } from '../src/lib/node-spawn';

describe('runCapture', () => {
  test('reports a bounded child timeout distinctly', async () => {
    const started = Date.now();
    const result = await runCapture(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
    });

    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('cleans up descendants when the launcher times out', async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });',
      'console.log(child.pid);',
      'setTimeout(() => {}, 10000);',
    ].join('');
    const result = await runCapture(process.execPath, ['-e', script], { timeoutMs: 100 });
    const descendantPid = Number(result.stdout.trim());

    expect(result.timedOut).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    let descendantAlive = false;
    try {
      process.kill(descendantPid, 0);
      descendantAlive = true;
    } catch {
      // The detached process group should have taken the descendant down.
    } finally {
      if (descendantAlive) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
    expect(descendantAlive).toBe(false);
  });

  test('does not mark normally completed commands as timed out', async () => {
    const result = await runCapture(process.execPath, ['-e', 'process.stdout.write("ok")']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.timedOut).toBeUndefined();
  });
});
