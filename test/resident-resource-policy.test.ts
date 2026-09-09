import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { reloadExtensions, _resetSnapshotForTests } from '../src/extensions/registry';
import { ResidentDefinitionStore } from '../src/agents/resident-definition-store';
import { synchronizeResidentExternalSkillSources } from '../src/agents/extension-template-adapter';
import { loadFileSystemAgentTemplate } from '../src/agents/agent-template-loader';
import { ensureAgentScaffold } from '../src/core/agent-scaffold';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { getResidentResourcePolicy, initOrchestrationSeams, resetOrchestrationSeams, type ResidentResourcePolicy } from '../src/orchestration-seams';
import { snapshotResidentResources } from '../src/agents/resident-resources';
import { resolveExternalAgentTemplate } from '../src/agents/loader';

let root: string;
let current: string;
let agentRoot: string;
let previous: string;
const legacyPaths = new Map<string, string>();
const policy: ResidentResourcePolicy = {
  persistence: 'snapshot',
  acceptsSource: source => source.origin === 'builtin',
  matchesLegacyPath: (configured, current) => legacyPaths.get(configured) === current,
};
function write(file: string, value: string) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, value);
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'resident-relocation-'));
  current = join(root, 'resources', 'agent-poly');
  previous = join(root, 'previous', 'agent-poly');
  legacyPaths.clear();
  legacyPaths.set(join(previous, 'persona/zh.md'), join(current, 'persona/zh.md'));
  initOrchestrationSeams({ residentResourcePolicy: policy });
  agentRoot = join(root, 'session', 'agents', 'poly');
  _resetSnapshotForTests();
  write(join(current, 'persona/zh.md'), '# Current built-in persona\n');
  write(join(current, 'forgeax-extension.json'), JSON.stringify({
    schemaVersion: 1, version: '0.1.0', id: '@forgeax-extension/agent-poly',
    kind: 'agent', displayName: { zh: 'Poly' },
    provides: { agent: { id: 'poly', role: 'modeling',
      card: { name: { zh: 'Poly' }, color: '#56B6C2', avatar: 'P' },
      personaFile: './persona/zh.md',
    } },
  }));
  const roots = { builtin: resolve(current, '..'), user: join(root, 'user'), project: join(root, 'project') };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  await reloadExtensions({ roots });
});
afterEach(() => {
  resetOrchestrationSeams();
  resetPathManager();
  _resetSnapshotForTests();
  rmSync(root, { recursive: true, force: true });
});

test('new main and nested residents retain their persona after the installation is removed', async () => {
  const pm = initPathManager({ userRoot: join(root, 'state'), projectRoot: root });
  for (const agent of ['poly', 'parent/agents/poly']) {
    await ensureAgentScaffold('new-resident', agent, { overrides: {
      personaFile: join(current, 'persona/zh.md'), skillSources: [],
    } });
    const file = pm.session('new-resident').agent(agent).agentJson();
    const config = JSON.parse(readFileSync(file, 'utf8'));
    expect(isAbsolute(config.personaFile)).toBe(false);
  }
  rmSync(join(root, 'resources'), { recursive: true, force: true });
  for (const agent of ['poly', 'parent/agents/poly']) {
    expect(() => loadFileSystemAgentTemplate(pm.session('new-resident').agent(agent).root(), 'poly')).not.toThrow();
  }
});

test('concurrent initial scaffolds publish one complete definition without failing or overwriting it', async () => {
  const pm = initPathManager({ userRoot: join(root, 'state'), projectRoot: root });
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    ensureAgentScaffold('concurrent', 'poly', { overrides: { personaFile: join(current, 'persona/zh.md'), skillSources: [] } }),
  ));
  expect(results.filter(result => result.scaffolded)).toHaveLength(1);
  expect(() => loadFileSystemAgentTemplate(pm.session('concurrent').agent('poly').root(), 'poly')).not.toThrow();
});

test('host mapping may select a persona outside the extension directory', async () => {
  const brand = join(root, 'resources', 'identities', 'main.zh.md');
  const oldPersona = join(root, 'previous', 'identities', 'main.zh.md');
  legacyPaths.set(oldPersona, brand);
  write(brand, 'Brand main agent identity');
  const manifestFile = join(current, 'forgeax-extension.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.provides.agent.personaFile = brand;
  write(manifestFile, JSON.stringify(manifest));
  await reloadExtensions({ roots: { builtin: resolve(current, '..'), user: join(root, 'user'), project: join(root, 'project') } });
  const result = await migrate({ personaFile: oldPersona, skillSources: [] });
  expect(isAbsolute(result.config.personaFile)).toBe(false);
  expect(readFileSync(resolve(agentRoot, result.config.personaFile), 'utf8')).toBe('Brand main agent identity');
});

test('passes a foreign absolute path unchanged to the host mapping', async () => {
  const old = String.raw`Z:\\previous\\identity.md`;
  legacyPaths.set(old, join(current, 'persona/zh.md'));
  const result = await migrate({ personaFile: old, skillSources: [] });
  expect(isAbsolute(result.config.personaFile)).toBe(false);
  expect(() => loadFileSystemAgentTemplate(agentRoot, 'poly')).not.toThrow();
});

test('snapshots built-in memory and complete skill directories while preserving explicit custom skills', async () => {
  const skill = resolve(current, '..', 'skill-draw');
  write(join(skill, 'SKILL.md'), 'Built-in drawing skill');
  write(join(skill, 'scripts/run.ts'), 'export const marker = 1;');
  write(join(skill, 'forgeax-extension.json'), JSON.stringify({
    schemaVersion: 1, version: '0.1.0', id: '@forgeax-extension/skill-draw',
    kind: 'skill', displayName: { zh: 'Draw' },
    provides: { skills: [{ id: 'draw', entry: './SKILL.md', trigger: '/draw' }] },
  }));
  write(join(current, 'memory/lesson.zh.md'), 'Built-in memory seed');
  const manifestFile = join(current, 'forgeax-extension.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.provides.agent.memoryDir = './memory';
  manifest.provides.agent.defaultSkills = [{ source: 'plugin', pluginId: '@forgeax-extension/skill-draw', skillId: 'draw' }];
  write(manifestFile, JSON.stringify(manifest));
  await reloadExtensions({ roots: { builtin: resolve(current, '..'), user: join(root, 'user'), project: join(root, 'project') } });
  const old = previous;
  legacyPaths.set(join(old, 'memory'), join(current, 'memory'));
  legacyPaths.set(resolve(old, '..', 'skill-draw/SKILL.md'), join(skill, 'SKILL.md'));
  const customSkill = join(root, 'custom/SKILL.md');
  write(customSkill, 'Custom skill');
  const result = await migrate({ personaFile: join(old, 'persona/zh.md'), memoryDir: join(old, 'memory'),
    skillSources: [
      { id: 'draw', path: resolve(old, '..', 'skill-draw/SKILL.md'), executor: 'prompt' },
      { id: 'custom', path: customSkill, executor: 'prompt' },
    ], trustTier: 'own', toolGrants: { host: ['custom-tool'] },
  });
  expect(isAbsolute(result.config.memoryDir)).toBe(false);
  expect(result.config.skillSources[1].path).toBe(customSkill);
  expect(result.config.trustTier).toBe('own');
  expect(result.config.toolGrants).toEqual({ host: ['custom-tool'] });
  rmSync(join(root, 'resources'), { recursive: true, force: true });
  const copiedSkill = resolve(agentRoot, result.config.skillSources[0].path);
  expect(readFileSync(resolve(copiedSkill, '../scripts/run.ts'), 'utf8')).toContain('marker');
  expect(readFileSync(resolve(agentRoot, result.config.memoryDir, 'lesson.zh.md'), 'utf8')).toContain('memory seed');
  expect(() => loadFileSystemAgentTemplate(agentRoot, 'poly')).not.toThrow();
});
async function migrate(config: Record<string, unknown>) {
  write(join(agentRoot, 'agent.json'), JSON.stringify(config));
  const definition = ResidentDefinitionStore.scan('relocation-test', resolve(agentRoot, '..')).list()[0]!;
  await synchronizeResidentExternalSkillSources(definition);
  return { definition, config: JSON.parse(readFileSync(join(agentRoot, 'agent.json'), 'utf8')) };
}

test('repairs a host-mapped missing persona even with an explicit empty skill list', async () => {
  const old = join(previous, 'persona/zh.md');
  const result = await migrate({ personaFile: old, skillSources: [], trustTier: 'imported', models: { model: ['user-choice'] } });
  expect(isAbsolute(result.config.personaFile)).toBe(false);
  expect(readFileSync(resolve(agentRoot, result.config.personaFile), 'utf8')).toContain('Current built-in persona');
  expect(result.config.trustTier).toBe('imported');
  expect(result.config.models).toEqual({ model: ['user-choice'] });
  // No old installation exists; after snapshotting, neither does the new one.
  rmSync(join(root, 'resources'), { recursive: true, force: true });
  expect(() => loadFileSystemAgentTemplate(agentRoot, 'poly')).not.toThrow();
  const before = readFileSync(join(agentRoot, 'agent.json'), 'utf8');
  await synchronizeResidentExternalSkillSources(result.definition);
  expect(readFileSync(join(agentRoot, 'agent.json'), 'utf8')).toBe(before);
});

test('does not replace a missing custom persona that shares a built-in agent id', async () => {
  const custom = join(root, 'custom', 'persona/zh.md');
  const config = { personaFile: custom, skillSources: [], trustTier: 'imported' };
  expect((await migrate(config)).config).toEqual(config);
  expect(() => loadFileSystemAgentTemplate(agentRoot, 'poly')).toThrow('configured personaFile');
});

test('does not replace an existing custom persona', async () => {
  const custom = join(root, 'custom', 'persona/zh.md');
  write(custom, 'Custom author identity');
  const config = { personaFile: custom, skillSources: [] };
  expect((await migrate(config)).config).toEqual(config);
  expect(readFileSync(custom, 'utf8')).toBe('Custom author identity');
});

test('does not bind another extension with a matching persona filename', async () => {
  const old = join(root, 'previous', 'agent-other', 'persona/zh.md');
  const config = { personaFile: old, skillSources: [] };
  expect((await migrate(config)).config).toEqual(config);
});

test('does not invent mappings for unrecognized paths', async () => {
  const old = `${previous}/persona/../persona/zh.md`;
  const config = { personaFile: old, skillSources: [] };
  expect((await migrate(config)).config).toEqual(config);
});

test('no policy preserves new references and disables legacy repair', async () => {
  resetOrchestrationSeams();
  const pm = initPathManager({ userRoot: join(root, 'state'), projectRoot: root });
  const personaFile = join(current, 'persona/zh.md');
  await ensureAgentScaffold('no-policy', 'poly', { overrides: { personaFile, skillSources: [] } });
  const config = JSON.parse(readFileSync(pm.session('no-policy').agent('poly').agentJson(), 'utf8'));
  expect(config.personaFile).toBe(personaFile);
  const legacy = { personaFile: join(previous, 'persona/zh.md'), skillSources: [], trustTier: 'imported' };
  expect((await migrate(legacy)).config).toEqual(legacy);
});

test('no policy retains existing same-file skill synchronization', async () => {
  resetOrchestrationSeams();
  const personaFile = join(current, 'persona/zh.md');
  const result = await migrate({ personaFile, trustTier: 'imported' });
  expect(result.config).toEqual({ personaFile, trustTier: 'imported', skillSources: [] });
});

test('host reinitialization clears the previous snapshot policy', async () => {
  expect(getResidentResourcePolicy()).toBe(policy);
  initOrchestrationSeams({});
  expect(getResidentResourcePolicy()).toBeUndefined();
  const legacy = { personaFile: join(previous, 'persona/zh.md'), skillSources: [] };
  expect((await migrate(legacy)).config).toEqual(legacy);
});

test('a denied source preserves even a current resource reference', async () => {
  initOrchestrationSeams({ residentResourcePolicy: { ...policy, acceptsSource: () => false } });
  const config = { personaFile: join(current, 'persona/zh.md'), skillSources: [], trustTier: 'imported' };
  expect((await migrate(config)).config).toEqual(config);
});

test('existing custom files win even when the host mapping accepts them', async () => {
  const custom = join(root, 'custom', 'identity.md');
  write(custom, 'Authored identity');
  legacyPaths.set(custom, join(current, 'persona/zh.md'));
  const config = { personaFile: custom, skillSources: [], toolGrants: { host: [] } };
  expect((await migrate(config)).config).toEqual(config);
});

test('new source-authorized residents keep own trust; legacy repair cannot promote missing trust', async () => {
  const pm = initPathManager({ userRoot: join(root, 'state'), projectRoot: root });
  await ensureAgentScaffold('trust', 'poly', { overrides: { personaFile: join(current, 'persona/zh.md') } });
  const config = JSON.parse(readFileSync(pm.session('trust').agent('poly').agentJson(), 'utf8'));
  expect(config.trustTier).toBe('own');
  const repaired = await migrate({ personaFile: join(previous, 'persona/zh.md'), toolGrants: { host: [] } });
  expect(repaired.config.trustTier).toBe('imported');
  expect(repaired.config.toolGrants).toEqual({ host: [] });
});

test('resource eligibility comes from the host, not hardcoded origin categories', async () => {
  const external = (await resolveExternalAgentTemplate('poly'))!;
  mkdirSync(agentRoot, { recursive: true });
  const received: Array<{ kind: string; origin?: string }> = [];
  initOrchestrationSeams({ residentResourcePolicy: {
    ...policy,
    acceptsSource: source => { received.push(source); return source.origin === 'user'; },
  } });
  const result = await snapshotResidentResources(agentRoot,
    { personaFile: external.personaPath, trustTier: 'imported', toolGrants: {} },
    { ...external, origin: 'user', trustTier: 'imported' });
  expect(received[0]).toEqual({ kind: 'plugin', origin: 'user' });
  expect(isAbsolute(result.personaFile!)).toBe(false);
  expect(result.trustTier).toBe('imported');
  expect(result.toolGrants).toEqual({});
});

test('host accepts a brand source and explicitly maps its opaque legacy path', async () => {
  const persona = join(root, 'identities', 'assistant.md');
  const old = join(root, 'retired', 'assistant.md');
  write(persona, 'Host-selected identity');
  mkdirSync(agentRoot, { recursive: true });
  const received: Array<{ kind: string; origin?: string }> = [];
  initOrchestrationSeams({ residentResourcePolicy: {
    persistence: 'snapshot',
    acceptsSource: source => { received.push(source); return source.kind === 'brand'; },
    matchesLegacyPath: (configured, current) => configured === old && current === persona,
  } });
  const result = await snapshotResidentResources(agentRoot,
    { personaFile: old, skillSources: [], trustTier: 'imported', toolGrants: { host: [] } },
    { personaPath: persona, source: 'brand', trustTier: 'own', skillSources: [] });
  expect(received).toEqual([{ kind: 'brand', origin: undefined }]);
  expect(readFileSync(resolve(agentRoot, result.personaFile!), 'utf8')).toBe('Host-selected identity');
  expect(result.trustTier).toBe('imported');
  expect(result.toolGrants).toEqual({ host: [] });
});

test('no policy makes the public snapshot helper a no-op for brand sources', async () => {
  resetOrchestrationSeams();
  const config = { personaFile: join(previous, 'persona/zh.md'), trustTier: 'own' as const };
  const result = await snapshotResidentResources(agentRoot, config, {
    personaPath: join(current, 'persona/zh.md'), source: 'brand', trustTier: 'own', skillSources: [],
  });
  expect(result).toBe(config);
});
