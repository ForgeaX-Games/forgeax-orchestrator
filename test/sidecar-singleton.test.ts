/** ensureSidecar 的 external agent-host 模式。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import {
  ensureSidecar,
  restartSidecar,
  resetSidecarSingleton,
} from '../src/kernel/sidecar-singleton';

const savedEnv = new Map<string, string | undefined>();
const envKeys = [
  'FORGEAX_AGENT_HOST_EXTERNAL_ONLY',
  'FORGEAX_AGENT_HOST_SOCK',
  'FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS',
];
let sock = '';
let seq = 0;
let fakeServer: Server | null = null;
const fakeSockets = new Set<Socket>();
const fakeMethods: string[] = [];

function startFakeSidecar(): Promise<void> {
  fakeMethods.length = 0;
  const server = createServer((socket) => {
    fakeSockets.add(socket);
    socket.on('close', () => fakeSockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.method) fakeMethods.push(message.method);
          if (message.method === 'ping' && typeof message.id === 'number') {
            socket.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { pid: process.pid, uptimeMs: 1, version: 'fake', sessions: 0 },
            })}\n`);
          } else if (message.method === 'shutdown' && typeof message.id === 'number') {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null })}\n`);
          }
        } catch {
          // SidecarClient only sends valid JSON-RPC; malformed test input is ignored.
        }
      }
    });
  });
  fakeServer = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function stopFakeSidecar(): Promise<void> {
  const server = fakeServer;
  fakeServer = null;
  for (const socket of fakeSockets) socket.destroy();
  fakeSockets.clear();
  if (!server?.listening) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    server.close(finish);
  });
}

beforeEach(() => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  sock = `/tmp/fxse-${process.pid}-${seq++}.sock`;
  process.env.FORGEAX_AGENT_HOST_EXTERNAL_ONLY = '1';
  process.env.FORGEAX_AGENT_HOST_SOCK = sock;
  resetSidecarSingleton();
});

afterEach(async () => {
  resetSidecarSingleton();
  await stopFakeSidecar();
  await new Promise((r) => setTimeout(r, 100));
  for (const p of [sock, `${sock}.pid`]) { try { rmSync(p, { force: true }); } catch {} }
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('ensureSidecar external-only mode', () => {
  test('does not spawn agent-host when no external sidecar is reachable', async () => {
    process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS = '2500';

    await expect(ensureSidecar()).rejects.toThrow(/external agent-host sidecar not reachable/);
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(`${sock}.pid`)).toBe(false);
  }, 5000);

  test('retries until an external sidecar becomes reachable', async () => {
    process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS = '3000';
    const ensure = ensureSidecar();
    await new Promise((r) => setTimeout(r, 300));
    await startFakeSidecar();

    const client = await ensure;
    expect(await client.ping()).toMatchObject({ version: 'fake' });
    client.close();
  }, 10000);

  test('restart clears only the local client and leaves the external host running', async () => {
    process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS = '2000';
    await startFakeSidecar();
    const client = await ensureSidecar();
    client.close();

    const outcome = await restartSidecar();
    expect(outcome).toMatchObject({ restarted: false, restartRequired: true });
    if (!outcome.restartRequired) throw new Error('external restart must require the owning launcher');
    expect(outcome.warning).toContain('external agent-host');
    expect(fakeMethods).not.toContain('shutdown');
    expect(fakeServer?.listening).toBe(true);

    const reconnected = await ensureSidecar();
    expect(await reconnected.ping()).toMatchObject({ version: 'fake' });
    reconnected.close();
  }, 10000);

  test('reports the external sidecar timeout explicitly', async () => {
    process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS = '250';
    const startedAt = Date.now();
    await expect(ensureSidecar()).rejects.toThrow(/external agent-host sidecar not reachable within 250ms/);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  }, 5000);
});
