import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runForgeaxBuiltinTool } from '../src/kernel/forgeax-builtin-tools';
import { loadAgentRecord } from '../src/soul';

describe('soul_create adoption tool', () => {
  test('writes a native soul-pack that loadAgentRecord can load as own', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-soul-create-'));
    try {
      const soulId = 'village.guide';
      const created = (await runForgeaxBuiltinTool(
        'soul_create',
        {
          soulId,
          name: 'Village Guide',
          identity: 'A patient guide who remembers visitors and explains village routines.',
        },
        { projectRoot, agentId: 'forge' },
      )) as { ok?: boolean; soulId?: string; path?: string; error?: string };

      expect(created.ok).toBe(true);
      expect(created.soulId).toBe(soulId);
      expect(created.path).toBe(`.forgeax/souls-builtin/${soulId}`);

      const record = await loadAgentRecord(soulId, { projectRoot });
      expect(record.persona.trim().length).toBeGreaterThan(0);
      expect(record.persona).toContain('Village Guide');
      expect(record.trustTier).toBe('own');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('updates managed files idempotently while preserving unmanaged pack content', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-soul-update-'));
    try {
      const soulId = 'village.guide';
      const packDir = join(projectRoot, '.forgeax', 'souls-builtin', soulId);
      mkdirSync(join(packDir, 'memory'), { recursive: true });
      writeFileSync(join(packDir, 'memory', 'seed.md'), 'keep me\n');
      writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({ customManifestField: true }));
      writeFileSync(join(packDir, 'agent.json'), JSON.stringify({ customAgentField: true, models: { temperature: 0.2 } }));

      const args = {
        soulId,
        name: 'Village Guide',
        identity: 'An updated guide identity.',
        models: ['deepseek-v4-pro', 'deepseek-v4-flash-openai'],
      };
      const first = await runForgeaxBuiltinTool('soul_create', args, { projectRoot, agentId: 'forge' }) as {
        ok?: boolean; created?: boolean; changedPaths?: string[];
      };
      const second = await runForgeaxBuiltinTool('soul_create', args, { projectRoot, agentId: 'forge' }) as {
        ok?: boolean; created?: boolean; changedPaths?: string[];
      };

      expect(first).toMatchObject({ ok: true, created: false });
      expect(second).toEqual({ ...first, created: false });
      expect(readFileSync(join(packDir, 'memory', 'seed.md'), 'utf8')).toBe('keep me\n');
      expect(JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))).toMatchObject({
        id: soulId,
        name: 'Village Guide',
        customManifestField: true,
      });
      expect(JSON.parse(readFileSync(join(packDir, 'agent.json'), 'utf8'))).toMatchObject({
        id: soulId,
        name: 'Village Guide',
        personaFile: './persona/identity.md',
        customAgentField: true,
        models: {
          model: ['deepseek-v4-pro', 'deepseek-v4-flash-openai'],
          temperature: 0.2,
        },
      });
      expect(first.changedPaths).toEqual([
        `.forgeax/souls-builtin/${soulId}/persona/identity.md`,
        `.forgeax/souls-builtin/${soulId}/manifest.json`,
        `.forgeax/souls-builtin/${soulId}/agent.json`,
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('accepts BoundedId-compatible dotted soul ids and rejects traversal', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-soul-create-id-'));
    try {
      const ok = (await runForgeaxBuiltinTool(
        'soul_create',
        { soulId: 'forest.npc-guide:01', name: 'Guide', identity: 'Guide identity.' },
        { projectRoot, agentId: 'forge' },
      )) as { ok?: boolean; error?: string };
      expect(ok.ok).toBe(true);

      const bad = (await runForgeaxBuiltinTool(
        'soul_create',
        { soulId: 'forest/../npc', name: 'Bad', identity: 'Bad identity.' },
        { projectRoot, agentId: 'forge' },
      )) as { ok?: boolean; error?: string };
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('soulId must not contain path traversal');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
