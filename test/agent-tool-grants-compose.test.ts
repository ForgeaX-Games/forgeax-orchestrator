import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeTurnRequest } from '../src/kernel/compose-turn-request';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { initSessionManager, getSessionManager, resetSessionManager } from '../src/core/session-manager';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/extensions/registry';
import { buildKindRegistry } from '../src/extensions/kinds';
import { NATIVE_KERNEL_PROFILE, RENTED_KERNEL_PROFILE } from '../src/kernel/kernel-profile';
import { COORDINATOR_TOOL_GRANTS, type AgentToolGrants } from '../src/agents/tool-grants';
import { buildActionCatalog } from '../src/kernel/action-catalog';
import { MemoryTemplateSource } from '../src/agents/memory-template-source';
import { RuntimeConfigBinding } from '../src/runtime/runtime-config';

let root: string;
let previousRoot: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tool-grants-compose-'));
  previousRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = root;
  resetPathManager();
  await resetSessionManager();
  initSessionManager(initPathManager({ userRoot: root }));
  initOrchestrationSeams({
    enabledBuiltinTools: ['todo_write', 'ui_invoke'],
    hostTools: [
      { name: 'scene_create', description: 'Declared scene operation', inputSchema: {} },
      { name: 'search_audio', description: 'Unrelated audio operation', inputSchema: {} },
    ],
  });
  buildActionCatalog();
  const kinds = buildKindRegistry([]);
  kinds.skills = [
    { definition: { id: 'scene-guide', description: 'Resident prompt', entry: { kind: 'prompt' } } },
    { definition: { id: 'audio-guide', description: 'Unrelated global prompt', entry: { kind: 'prompt' } } },
  ] as any;
  _setSnapshotForTests({ generation: 1, loadedAt: Date.now(), manifests: [], kinds, scanErrors: [], mergeIssues: [] });
});
afterEach(async () => {
  _resetSnapshotForTests();
  resetOrchestrationSeams();
  await resetSessionManager();
  resetPathManager();
  if (previousRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

async function compose(grants: AgentToolGrants | undefined, profile: typeof NATIVE_KERNEL_PROFILE) {
  const session = await getSessionManager().create({ displayName: 'grant fixture' });
  // The production seam reads a frozen runtime template; this fixture supplies
  // it directly so no provider or App process is involved.
  const template = {
    templateRef: 'scope-template', definition: { id: 'arbitrary-persona' },
    configuration: grants ? { toolGrants: grants } : {},
    execution: { revision: '1', skills: [{ id: 'scene-guide', executor: 'prompt', source: { kind: 'inline', text: 'Scene guide' } }], kits: [] },
    resources: { skills: [], kits: [], memorySeeds: [] }, runtimeConfigDefaults: {},
  };
  template.templateRef = session.templateCatalog.register({
    entryId: template.definition.id,
    source: new MemoryTemplateSource({ sourceId: 'grant-fixture', templates: { [template.definition.id]: template } }),
    scope: { kind: 'session', sid: session.sid }, registrationLifetime: 'session',
    trust: 'imported', provenance: { adapter: 'test' }, revisionPolicy: { kind: 'immutable' },
  });
  session.tree.resolve = (() => ({
    template, templateRef: template.templateRef, sid: session.sid,
    instanceId: 'grant-fixture', parentInstanceId: null,
    runtimeConfig: new RuntimeConfigBinding({ revision: '1', value: {} }),
  })) as any;
  const request = await composeTurnRequest({
    sessionId: session.sid, agentId: 'arbitrary-persona', message: 'Create a scene', prewarm: true,
    kernel: { id: 'fixture', orchestrationProfile: profile } as any,
    extraTools: [{ name: 'scene_create' }, { name: 'read_file' }],
  });
  return request.tools.map((tool) => tool.name);
}

for (const [label, profile] of [['native', NATIVE_KERNEL_PROFILE], ['rented', RENTED_KERNEL_PROFILE]] as const) {
  test(`${label}: specialist projection excludes unrelated skills, host tools and UI`, async () => {
    const names = await compose(undefined, profile);
    expect(names).toEqual(['todo_write', 'scene_create', 'read_file']);
  });
  test(`${label}: explicit coordinator grants retain ordinary host, UI and shared skills`, async () => {
    const names = await compose(COORDINATOR_TOOL_GRANTS, profile);
    expect(names).toContain('search_audio');
    expect(names).toContain('ui_invoke');
    expect(names.some((name) => name.startsWith('ui_act_'))).toBe(true);
    expect(names).toContain('skill_audio_guide');
    expect(names).not.toContain('skill_scene_guide');
  });
}
