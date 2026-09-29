import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForgeaxApp } from '../src/app';
import type { AgentRecord } from '../src/soul';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('createForgeaxApp wires the optional product resolver into the shared NPC runtime only when supplied', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'app-npc-product-resolver-'));
  roots.push(instanceRoot);
  const resolved: AgentRecord = {
    agentId: 'asiw.elara',
    source: 'builtin',
    trustTier: 'own',
    persona: 'Elara from the ASIW product.',
    skills: [],
    tools: [],
    memory: { root: join(instanceRoot, 'external-memory'), game: 'asiw' },
    warnings: [],
  };
  const calls: Array<[string, Readonly<{ projectRoot: string; game: string }>]> = [];

  const forgeax = await createForgeaxApp({
    instanceRoot,
    npcSoulResolver: async (agentId, options) => {
      calls.push([agentId, options]);
      return agentId === 'asiw.elara' ? resolved : undefined;
    },
  });

  await forgeax.npcRuntime.brain.preload('asiw', [{ soulId: 'asiw.elara' }]);
  expect(calls).toEqual([['asiw.elara', { projectRoot: instanceRoot, game: 'asiw' }]]);

  const legacySession = forgeax.npcRuntime.createSession({
    game: 'asiw',
    npcs: [{ npcId: 'legacy', soulId: 'missing.explicit.pack' }],
  });
  const authorized = forgeax.npcRuntime.authorize(legacySession.sessionId, legacySession.token)!;
  await expect(forgeax.npcRuntime.preloadSession(authorized)).rejects.toThrow('Declared Soul pack not found');
  // A full createForgeaxApp boot is dominated by sessionManager.bootAutoStart()
  // (~6.4s on this base), so the 5s bun default would time this out.
}, 30_000);
