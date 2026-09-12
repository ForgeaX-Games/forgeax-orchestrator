import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKindRegistry } from '../src/extensions/kinds';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import { runSkillKernelTool } from '../src/skills/kernel-tool-bridge';
import type { MergedManifest } from '../src/extensions/merger';
import { normalizeManifest } from '@forgeax/types';

const ROOT = `/tmp/forgeax-skill-bridge-${process.pid}`;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  _resetSnapshotForTests();
});

describe('skill kernel tool bridge', () => {
  it('executes a shared prompt skill through the neutral kernel tool name', async () => {
    const extensionDir = join(ROOT, 'shared-skill');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, 'SKILL.md'), 'shared skill result', 'utf8');
    const manifest = {
      schemaVersion: 1 as const,
      id: '@example/shared-skill',
      version: '1.0.0',
      kind: 'skill' as const,
      displayName: { en: 'Shared skill' },
      provides: {
        skills: [{ id: 'hello', entry: './SKILL.md', trigger: '/hello' }],
      },
    };
    const merged: MergedManifest = {
      manifest,
      normalizedManifest: normalizeManifest(manifest),
      origin: 'user',
      originPath: join(extensionDir, 'forgeax-extension.json'),
      shadowedBy: [],
    };
    _setSnapshotForTests({
      generation: 3,
      loadedAt: Date.now(),
      manifests: [merged],
      kinds: buildKindRegistry([merged]),
      scanErrors: [],
      mergeIssues: [],
    });

    const result = await runSkillKernelTool(
      'skill_hello',
      { input: { request: 'hello' } },
      { kind: 'ai', sessionId: 'sid', threadId: 'thread', agentId: 'agent' },
    );

    expect(result).toEqual({ ok: true, result: { text: 'shared skill result' } });
  });
});

import { skillToolSpecs } from '../src/skills/tool-specs';
import { initOrchestrationSeams } from '../src/orchestration-seams';

const caller = { kind: 'ai' as const, sessionId: 'sid', agentId: 'forge' };
function installSources(sources: Array<{ source: string; skill?: string; text: string }>) {
  const manifests = sources.map(({ source, skill = 'hello', text }, i): MergedManifest => {
    const dir = join(ROOT, `extension-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), text);
    const manifest = {
      schemaVersion: 1 as const, id: source, version: '1.0.0', kind: 'skill' as const,
      displayName: { en: source }, provides: { skills: [{ id: skill, entry: './SKILL.md', trigger: `/${skill}` }] },
    };
    return { manifest, normalizedManifest: normalizeManifest(manifest), origin: 'user', originPath: join(dir, 'forgeax-extension.json'), shadowedBy: [] };
  });
  _setSnapshotForTests({ generation: 4, loadedAt: Date.now(), manifests, kinds: buildKindRegistry(manifests), scanErrors: [], mergeIssues: [] });
}
afterEach(() => initOrchestrationSeams({}));

it('binds a unique extension tool despite a legacy argument containing the skill id', async () => {
  installSources([{ source: '@example/ecs', skill: 'forgeax-engine-ecs', text: 'ecs instructions' }]);
  const spec = skillToolSpecs()[0]!;
  expect(spec.inputSchema).toMatchObject({ properties: { input: { type: 'object' } }, additionalProperties: false });
  expect(spec.inputSchema?.properties).not.toHaveProperty('extensionId');
  expect(await runSkillKernelTool(spec.name, { extensionId: 'forgeax-engine-ecs' }, caller))
    .toEqual({ ok: true, result: { text: 'ecs instructions' } });
});

it('requires an actual source for duplicate names and executes both sources correctly', async () => {
  installSources([{ source: '@example/a', text: 'A' }, { source: '@example/b', text: 'B' }]);
  const specs = skillToolSpecs();
  expect(specs).toHaveLength(1);
  expect(specs[0]!.inputSchema).toMatchObject({ required: ['extensionId'], properties: { extensionId: { enum: ['@example/a', '@example/b'] } } });
  for (const args of [{}, { extensionId: 'hello' }]) {
    expect(await runSkillKernelTool('skill_hello', args, caller)).toMatchObject({ ok: false, code: 'ambiguous_skill' });
  }
  expect(await runSkillKernelTool('skill_hello', { extensionId: '@example/a' }, caller)).toEqual({ ok: true, result: { text: 'A' } });
  expect(await runSkillKernelTool('skill_hello', { extensionId: '@example/b' }, caller)).toEqual({ ok: true, result: { text: 'B' } });
});

it('disambiguates different skill ids that normalize to the same tool name', async () => {
  installSources([{ source: '@example/a', skill: 'hello-world', text: 'A' }, { source: '@example/b', skill: 'hello_world', text: 'B' }]);
  expect(skillToolSpecs()).toHaveLength(1);
  expect(await runSkillKernelTool('skill_hello_world', { extensionId: '@example/b' }, caller)).toEqual({ ok: true, result: { text: 'B' } });
});

it('binds injected project skills by session, handles a global duplicate, and reads refreshed content', async () => {
  const root = join(ROOT, 'installed');
  const dir = join(root, 'hello');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'project v1');
  initOrchestrationSeams({ sessionSkillRootProvider: (sid) => sid === 'sid' ? root : undefined });
  installSources([]);
  const spec = skillToolSpecs(undefined, 'sid')[0]!;
  expect(spec.inputSchema?.properties).not.toHaveProperty('extensionId');
  expect(await runSkillKernelTool(spec.name, { extensionId: 'hello' }, caller)).toMatchObject({ ok: true, result: { text: expect.stringContaining('project v1') } });
  expect(await runSkillKernelTool(spec.name, {}, { ...caller, sessionId: 'other' })).toMatchObject({ ok: false, code: 'not_found' });
  installSources([{ source: '@example/global', text: 'global' }]);
  expect(skillToolSpecs(undefined, 'sid')[0]!.inputSchema).toMatchObject({ required: ['extensionId'] });
  expect(await runSkillKernelTool(spec.name, {}, caller)).toMatchObject({ ok: false, code: 'ambiguous_skill' });
  expect(await runSkillKernelTool(spec.name, { extensionId: '@example/global' }, caller)).toEqual({ ok: true, result: { text: 'global' } });
  writeFileSync(join(dir, 'SKILL.md'), 'project v2');
  expect(await runSkillKernelTool(spec.name, { extensionId: 'project' }, caller)).toMatchObject({ ok: true, result: { text: expect.stringContaining('project v2') } });
  rmSync(dir, { recursive: true });
  installSources([]);
  expect(skillToolSpecs(undefined, 'sid')).toHaveLength(0);
  expect(await runSkillKernelTool(spec.name, {}, caller)).toMatchObject({ ok: false, code: 'not_found' });
});
