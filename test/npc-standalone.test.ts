import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveStandaloneNpcBrainConfig,
  startStandaloneNpcBrain,
  type StandaloneNpcBrainServer,
} from '../src/npc-brain/standalone';

const roots: string[] = [];
const servers: StandaloneNpcBrainServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'npc-standalone-'));
  roots.push(root);
  const pack = join(root, '.forgeax/souls-builtin/demo.guide');
  mkdirSync(join(pack, 'persona'), { recursive: true });
  writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ id: 'demo.guide' }));
  writeFileSync(join(pack, 'persona/identity.md'), 'A concise guide.');
  return root;
}

describe('standalone NPC Brain deployment', () => {
  test('requires explicit dataDir and a strong service credential', () => {
    expect(() => resolveStandaloneNpcBrainConfig([], {})).toThrow('data-dir');
    expect(() => resolveStandaloneNpcBrainConfig([], {
      FORGEAX_NPC_BRAIN_DATA_DIR: '/tmp/brain',
      FORGEAX_NPC_BRAIN_AUTH_TOKEN: 'short',
    })).toThrow('at least 16');
  });

  test('starts one Bun service with health, auth, budget, and canonical session protocol', async () => {
    const service = startStandaloneNpcBrain({
      dataDir: dataDir(),
      authToken: 'standalone-test-secret',
      port: 0,
      maxCallsPerMinute: 7,
      maxTokensPerMinute: 9_000,
      maxConcurrent: 2,
    });
    servers.push(service);

    const health = await fetch(`${service.url}/healthz`).then((response) => response.json()) as any;
    expect(health).toMatchObject({
      ok: true,
      service: 'forgeax-npc-brain',
      protocol: 1,
      budget: { maxCallsPerMinute: 7, maxTokensPerMinute: 9_000, maxConcurrent: 2 },
    });

    const unauthorized = await fetch(`${service.url}/api/npc/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'demo', npcIds: ['guide'] }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${service.url}/api/npc/session`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer standalone-test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ game: 'demo', playerId: 'p1', npcIds: ['guide'] }),
    });
    expect(authorized.status).toBe(200);
    const session = await authorized.json() as any;
    expect(session).toMatchObject({
      ok: true,
      epoch: 1,
      loaded: [{ npcId: 'guide', soulId: 'demo.guide', trustTier: 'own' }],
      wsUrl: '/api/npc/ws',
    });
    expect(session.token.length).toBeGreaterThan(16);

    const secondPlayer = await fetch(`${service.url}/api/npc/session`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer standalone-test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ game: 'demo', playerId: 'p2', npcIds: ['guide'] }),
    });
    expect(secondPlayer.status).toBe(200);
    expect(service.runtime.brain.cachedSoulCount).toBe(2);
  });

  test('keeps the standalone dependency surface outside the agent session stack', () => {
    const sourceRoot = join(import.meta.dir, '../src/npc-brain');
    for (const file of ['standalone.ts', 'standalone-soul-loader.ts', 'service.ts']) {
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      expect(source).not.toMatch(/core\/session-registry|kernel\/|api\/sessions/);
    }
    expect(readFileSync(join(sourceRoot, 'standalone-soul-loader.ts'), 'utf8')).not.toContain('../agents/');
  });

  test('supports concurrent ephemeral instances and immediate port reuse after awaited close', async () => {
    const first = startStandaloneNpcBrain({ dataDir: dataDir(), authToken: 'standalone-test-secret', port: 0 });
    const second = startStandaloneNpcBrain({ dataDir: dataDir(), authToken: 'standalone-test-secret', port: 0 });
    servers.push(first, second);
    expect(first.server.port).toBeGreaterThan(0);
    expect(second.server.port).toBeGreaterThan(0);
    expect(first.server.port).not.toBe(second.server.port);
    expect(new URL(first.url).port).toBe(String(first.server.port));
    expect(new URL(second.url).port).toBe(String(second.server.port));
    expect((await fetch(`${first.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${second.url}/healthz`)).status).toBe(200);

    const oldPort = first.server.port;
    await first.stop();
    servers.splice(servers.indexOf(first), 1);
    const rebound = startStandaloneNpcBrain({ dataDir: dataDir(), authToken: 'standalone-test-secret', port: oldPort });
    servers.push(rebound);
    expect(rebound.server.port).toBe(oldPort);
    await rebound.stop();
    servers.splice(servers.indexOf(rebound), 1);
  });

  test('can repeatedly start and stop ephemeral services without EADDRINUSE', async () => {
    for (let index = 0; index < 3; index += 1) {
      const service = startStandaloneNpcBrain({ dataDir: dataDir(), authToken: 'standalone-test-secret', port: 0 });
      expect((await fetch(`${service.url}/healthz`)).status).toBe(200);
      await service.stop();
    }
  });
});
