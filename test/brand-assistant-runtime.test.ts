import { synchronizeResidentExternalSkillSources } from '../src/agents/extension-template-adapter';
import { loadFileSystemAgentTemplate } from '../src/agents/agent-template-loader';
import { COORDINATOR_TOOL_GRANTS } from '../src/agents/tool-grants';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetBrand } from '../src/brand';
import { _resetSnapshotForTests, reloadExtensions } from '../src/extensions/registry';
import { composeSystemPrompt, listAgents, resolveExternalAgentTemplate } from '../src/agents/loader';
import { resolveBrandMainAgent } from '../src/api/lib/session-create';
import { brandAssistantAgentId, livePersonaTools } from '../src/tools/host-tool-allow';
import { ensureAgentScaffold } from '../src/core/agent-scaffold';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { AgentTemplateCatalog } from '../src/agents/agent-template-catalog';
import { ResidentDefinitionStore } from '../src/agents/resident-definition-store';
import { registerResidentDefinition } from '../src/agents/resident-template-adapter';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';

const ROOT = `/tmp/forgeax-brand-assistant-${process.pid}`;
const previousBrandDir = process.env.FORGEAX_BRAND_DIR;
const previousBrand = process.env.FORGEAX_BRAND;

beforeEach(async () => {
  resetOrchestrationSeams();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'defaults.test', 'persona'), { recursive: true });
  writeFileSync(join(ROOT, 'defaults.test', 'persona', 'zh.md'), '# Brand Assistant\n');
  writeFileSync(join(ROOT, 'defaults.test.json'), JSON.stringify({
    id: 'test',
    schemaVersion: 1,
    product: { name: 'Test', shortName: 'Test', tagline: 'Test' },
    assistant: {
      name: 'Guide',
      agent: {
        id: 'guide',
        personaFiles: { zh: 'persona/zh.md' },
        tools: ['project:*'],
      },
    },
    splash: { title: 'Test', subtitle: 'Test', theme: 'classic-lime' },
    providers: { native: { id: 'native', label: 'Native', title: 'Native' } },
    links: { repoUrl: 'https://example.com/repo', communityUrl: 'https://example.com/community' },
  }));
  process.env.FORGEAX_BRAND_DIR = ROOT;
  process.env.FORGEAX_BRAND = 'test';
  resetBrand();
  _resetSnapshotForTests();
  const empty = join(ROOT, 'extensions');
  for (const kind of ['builtin', 'user', 'project']) mkdirSync(join(empty, kind), { recursive: true });
  await reloadExtensions({ roots: {
    builtin: join(empty, 'builtin'),
    user: join(empty, 'user'),
    project: join(empty, 'project'),
  } });
});

afterEach(() => {
  resetOrchestrationSeams();
  resetPathManager();
  if (previousBrandDir === undefined) delete process.env.FORGEAX_BRAND_DIR;
  else process.env.FORGEAX_BRAND_DIR = previousBrandDir;
  if (previousBrand === undefined) delete process.env.FORGEAX_BRAND;
  else process.env.FORGEAX_BRAND = previousBrand;
  resetBrand();
  _resetSnapshotForTests();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('Brand-backed main assistant runtime', () => {
  test('uses the Brand assistant contract for bootstrap, persona, and tools', async () => {
    expect(resolveBrandMainAgent()).toBe('guide');
    expect(brandAssistantAgentId()).toBe('guide');
    expect(livePersonaTools('guide')).toEqual(['project:*']);
    expect((await resolveExternalAgentTemplate('guide'))?.source).toBe('brand');
    expect((await composeSystemPrompt('guide'))?.persona).toContain('Brand Assistant');
  });

  test('does not add Brand or legacy Marketplace peers to the extension roster', () => {
    expect(listAgents()).toEqual([]);
  });
});


test('Brand source migration installs explicit coordinator grants and preserves author policy', async () => {
  const templateRoot = join(ROOT, 'resident');
  mkdirSync(templateRoot, { recursive: true });
  const file = join(templateRoot, 'agent.json');
  const definition = { templateRoot, logicalPath: 'guide' } as any;
  const personaFile = join(ROOT, 'defaults.test', 'persona', 'zh.md');
  writeFileSync(file, JSON.stringify({ personaFile, skillSources: [] }));
  await synchronizeResidentExternalSkillSources(definition);
  expect(loadFileSystemAgentTemplate(templateRoot, 'guide').configuration?.toolGrants).toEqual(COORDINATOR_TOOL_GRANTS);
  const explicit = { host: ['query_world'] };
  writeFileSync(file, JSON.stringify({ personaFile, skillSources: [], toolGrants: explicit }));
  await synchronizeResidentExternalSkillSources(definition);
  expect(JSON.parse(readFileSync(file, 'utf8')).toolGrants).toEqual(explicit);
  const after = readFileSync(file, 'utf8');
  await synchronizeResidentExternalSkillSources(definition);
  expect(readFileSync(file, 'utf8')).toBe(after);
  writeFileSync(join(templateRoot, 'custom.md'), '# Custom persona');
  writeFileSync(file, JSON.stringify({ personaFile: join(templateRoot, 'custom.md'), skillSources: [] }));
  await synchronizeResidentExternalSkillSources(definition);
  expect(loadFileSystemAgentTemplate(templateRoot, 'guide').configuration?.toolGrants).toBeUndefined();
});

test('new Brand resident keeps own trust and coordinator grants after source removal and registry reset', async () => {
  initOrchestrationSeams({ residentResourcePolicy: {
    persistence: 'snapshot',
    acceptsSource: source => source.kind === 'brand',
    matchesLegacyPath: () => false,
  } });
  const pm = initPathManager({ userRoot: join(ROOT, 'state'), projectRoot: ROOT });
  const external = await resolveExternalAgentTemplate('guide');
  expect(external?.source).toBe('brand');
  await ensureAgentScaffold('portable-brand', 'guide', { overrides: {
    personaFile: external!.personaPath, skillSources: [],
  } });
  const config = JSON.parse(readFileSync(pm.session('portable-brand').agent('guide').agentJson(), 'utf8'));
  expect(config.trustTier).toBe('own');
  expect(config.toolGrants).toEqual(COORDINATOR_TOOL_GRANTS);
  rmSync(join(ROOT, 'defaults.test'), { recursive: true, force: true });
  resetBrand();
  _resetSnapshotForTests();
  const definition = ResidentDefinitionStore.scan('portable-brand', pm.session('portable-brand').agentsDir()).list()[0]!;
  const catalog = new AgentTemplateCatalog();
  const resident = await registerResidentDefinition(catalog, 'portable-brand', definition);
  expect(catalog.get(resident.templateRef)?.trust).toBe('own');
  const template = await catalog.resolve(resident.templateRef);
  expect(template.execution.persona).toMatchObject({ kind: 'inline', text: '# Brand Assistant\n' });
});
