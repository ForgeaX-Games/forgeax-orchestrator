/** server↔sidecar 控制面冒烟:server 的 SidecarClient 连真 agent-host 进程,跑监督闭环。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { SidecarClient, type ExitInfo, type SessionGrant } from '../src/kernel/sidecar-client';

const AGENT_HOST_MAIN = resolve(import.meta.dir, '../../agent-host/src/main.ts');
let sock = '';
let seq = 0;
let proc: Subprocess | null = null;

beforeEach(() => { sock = `/tmp/fxsc-${process.pid}-${seq++}.sock`; });
afterEach(async () => {
  if (proc) { try { proc.kill(); } catch {} proc = null; }
  await new Promise((r) => setTimeout(r, 100));
  for (const p of [sock, `${sock}.pid`]) { try { rmSync(p, { force: true }); } catch {} }
});

async function startHostAndConnect(): Promise<SidecarClient> {
  proc = Bun.spawn({
    cmd: ['bun', AGENT_HOST_MAIN],
    env: { ...process.env, FORGEAX_AGENT_HOST_SOCK: sock } as Record<string, string>,
    stdout: 'ignore', stderr: 'ignore',
  });
  const deadline = Date.now() + 8000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const c = await SidecarClient.connect(sock, 1000); await c.ping(); return c; }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`sidecar not reachable: ${(last as Error)?.message}`);
}

describe('SidecarClient ↔ agent-host', () => {
  test('ping + startSession + getProcess + cancel(组杀, onExit{cancelled})', async () => {
    const c = await startHostAndConnect();
    const pong = await c.ping();
    expect(pong.version).toBe('0.1.0');

    const exits: ExitInfo[] = [];
    c.onExit((e) => exits.push(e));

    const grant: SessionGrant = await c.startSession({
      sessionId: 'sc1', agentId: 'a', trustTier: 'imported', callId: 'c1',
      kernel: { kind: 'codex', credential: 'user-managed', cmd: 'bash', args: ['-c', 'sleep 30'] },
    });
    expect(grant.pid).toBeGreaterThan(0);
    expect(grant.pgid).toBe(grant.pid);

    const handle = await c.getProcess('sc1');
    expect(handle?.pid).toBe(grant.pid);

    await c.cancel('c1');
    await new Promise((r) => setTimeout(r, 400));
    expect(exits.find((e) => e.sessionId === 'sc1')?.reason).toBe('cancelled');
    c.close();
  }, 20000);

  test('write feeds stdin of a supervised persistent session', async () => {
    const c = await startHostAndConnect();
    const chunks: string[] = [];
    c.onData(({ sessionId, stream, chunk }) => {
      if (sessionId === 'sc-write' && stream === 'stdout') chunks.push(chunk);
    });

    await c.startSession({
      sessionId: 'sc-write',
      agentId: 'a',
      trustTier: 'own',
      kernel: {
        kind: 'claude-code',
        credential: 'user-managed',
        cmd: process.execPath,
        args: [
          '-e',
          "process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => process.stdout.write(String(chunk).toUpperCase()));",
        ],
      },
    });

    await c.write('sc-write', 'ready\n');
    for (let i = 0; i < 40 && !chunks.join('').includes('READY'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(chunks.join('')).toContain('READY');

    await c.shutdownSession('sc-write');
    c.close();
  }, 20000);
});
