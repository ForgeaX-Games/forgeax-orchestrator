import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearUiStateForSession,
  isUiActionRuntimeAvailable,
} from '../src/api/lib/ui-manifest-registry';
import { _resetSnapshotForTests } from '../src/extensions/registry';
import { buildActionCatalog } from '../src/kernel/action-catalog';
import { runForgeaxBuiltinTool } from '../src/kernel/forgeax-builtin-tools';
import { getBuiltinHeadlessUiAction } from '../src/kernel/ui-headless-actions';
import { resetOrchestrationSeams } from '../src/orchestration-seams';
import { createHostAuthoring, getHostAuthoring } from '../src/tools/host-authoring';

const COLD_START_SID = `r3-role-cold-${process.pid}`;

let projectRoot = '';
let previousProjectRoot: string | undefined;
let previousSafeBoot: string | undefined;
let roleSequence = 0;

function roleId(label: string): string {
  roleSequence += 1;
  return `r3-${label}-${process.pid}-${roleSequence}`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  previousSafeBoot = process.env.FORGEAX_SAFE_BOOT;
  projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-host-authoring-'));
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  delete process.env.FORGEAX_SAFE_BOOT;
  _resetSnapshotForTests();
  buildActionCatalog();
  clearUiStateForSession(COLD_START_SID);
  resetOrchestrationSeams();
});

afterEach(() => {
  clearUiStateForSession(COLD_START_SID);
  resetOrchestrationSeams();
  _resetSnapshotForTests();
  restoreEnv('FORGEAX_PROJECT_ROOT', previousProjectRoot);
  restoreEnv('FORGEAX_SAFE_BOOT', previousSafeBoot);
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

describe('host authoring', () => {
  test('createAgentPack writes a validated project-scoped agent pack', async () => {
    const id = roleId('create');
    const host = createHostAuthoring();
    const result = await host.createAgentPack({
      id,
      persona: '# Test Persona',
      displayName: { zh: 'Test Role', en: 'Test Role' },
      role: 'artist',
      avatar: 'A',
      color: '#123456',
      scope: 'project',
      tools: ['asset:*', 'world:read'],
    });

    expect(result).toMatchObject({
      ok: true,
      id,
      extensionId: `@user/agent-${id}`,
      scope: 'project',
    });
    if (!result.ok) throw new Error(result.error);
    const expectedDir = join(projectRoot, '.forgeax', 'extensions', `agent-${id}`);
    expect(result.dir).toBe(expectedDir);
    const manifest = JSON.parse(
      readFileSync(join(expectedDir, 'forgeax-extension.json'), 'utf-8'),
    );
    expect(manifest).toMatchObject({
      id: `@user/agent-${id}`,
      kind: 'agent',
      provides: {
        agent: {
          id,
          role: 'artist',
          card: {
            name: { zh: 'Test Role', en: 'Test Role' },
            avatar: 'A',
            color: '#123456',
          },
          personaFile: './persona/zh.md',
          tools: ['asset:*', 'world:read'],
        },
      },
    });
    expect(readFileSync(join(expectedDir, 'persona', 'zh.md'), 'utf-8')).toBe(
      '# Test Persona\n',
    );
  });

  test('createAgentPack rejects a duplicate id after reload', async () => {
    const id = roleId('duplicate');
    const host = createHostAuthoring();
    const first = await host.createAgentPack({
      id,
      persona: '# Original Persona',
      scope: 'project',
    });
    expect(first.ok).toBe(true);
    await host.reloadExtensions();

    const duplicate = await host.createAgentPack({
      id,
      persona: '# Replacement Persona',
      scope: 'project',
    });
    expect(duplicate).toMatchObject({ ok: false, code: 'exists' });
    expect(
      readFileSync(
        join(projectRoot, '.forgeax', 'extensions', `agent-${id}`, 'persona', 'zh.md'),
        'utf-8',
      ),
    ).toBe('# Original Persona\n');
  });

  test('createAgentPack rejects an invalid id without writing', async () => {
    const host = createHostAuthoring();
    const result = await host.createAgentPack({
      id: 'bad/id',
      persona: '# Invalid Role',
      scope: 'project',
    });

    expect(result).toMatchObject({ ok: false, code: 'bad_input' });
    expect(existsSync(join(projectRoot, '.forgeax', 'extensions'))).toBe(false);
  });

  test('listRoles sees a created role only after extension reload', async () => {
    const id = roleId('roundtrip');
    const host = createHostAuthoring();
    expect(host.listRoles().some((role) => role.id === id)).toBe(false);

    const result = await host.createAgentPack({
      id,
      persona: '# Roundtrip Role',
      displayName: { en: 'Roundtrip Role' },
      role: 'scout',
      scope: 'project',
    });
    expect(result.ok).toBe(true);
    expect(host.listRoles().some((role) => role.id === id)).toBe(false);

    await host.reloadExtensions();
    expect(host.listRoles().find((role) => role.id === id)).toMatchObject({
      id,
      role: 'scout',
      displayName: 'Roundtrip Role',
      source: 'plugin',
    });
  });

  test('reloadPlugins exists and reloads extensions through the compatibility alias', async () => {
    const id = roleId('reload-plugins');
    const host = getHostAuthoring();
    expect(typeof host.reloadPlugins).toBe('function');

    const result = await host.createAgentPack({
      id,
      persona: '# Reload Plugins Role',
      displayName: { en: 'Reload Plugins Role' },
      role: 'scout',
      scope: 'project',
    });
    expect(result.ok).toBe(true);
    expect(host.listRoles().some((role) => role.id === id)).toBe(false);

    await host.reloadPlugins();
    expect(host.listRoles().find((role) => role.id === id)).toMatchObject({
      id,
      role: 'scout',
      displayName: 'Reload Plugins Role',
      source: 'plugin',
    });
  });
});

describe('role actions in a true cold start', () => {
  test('ui_invoke creates and lists a role without a UI manifest or lease', async () => {
    const id = roleId('cold');
    let publishes = 0;
    const context = {
      projectRoot,
      agentId: 'forge',
      sid: COLD_START_SID,
      eventBus: { publish: () => publishes++ },
    };

    expect(isUiActionRuntimeAvailable(COLD_START_SID, 'role.create')).toBe(false);
    expect(getBuiltinHeadlessUiAction('role.open')).toBeUndefined();

    const created = await runForgeaxBuiltinTool(
      'ui_invoke',
      {
        actionId: 'role.create',
        args: {
          id,
          persona: '# Cold Start Scout',
          displayName: { en: 'Cold Start Scout' },
          role: 'scout',
          avatar: 'S',
          color: '#345678',
          scope: 'project',
          tools: ['world:read'],
        },
      },
      context,
    );

    expect(created).toEqual({
      status: 'completed',
      stateDigest: { id, scope: 'project' },
      executedVia: 'headless',
    });
    expect(publishes).toBe(0);
    expect(isUiActionRuntimeAvailable(COLD_START_SID, 'role.create')).toBe(false);

    const manifest = JSON.parse(
      readFileSync(
        join(
          projectRoot,
          '.forgeax',
          'extensions',
          `agent-${id}`,
          'forgeax-extension.json',
        ),
        'utf-8',
      ),
    );
    expect(manifest.provides.agent).toMatchObject({
      id,
      role: 'scout',
      card: {
        name: { en: 'Cold Start Scout' },
        avatar: 'S',
        color: '#345678',
      },
      tools: ['world:read'],
    });

    const listed = (await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'role.list', args: {} },
      context,
    )) as {
      status: string;
      executedVia?: string;
      stateDigest: {
        count: number;
        roles: Array<{
          id: string;
          role: string;
          displayName: string;
          source: string;
        }>;
      };
    };
    expect(listed.status).toBe('completed');
    expect(listed.executedVia).toBe('headless');
    expect(listed.stateDigest.count).toBe(listed.stateDigest.roles.length);
    expect(listed.stateDigest.roles.find((role) => role.id === id)).toMatchObject({
      id,
      role: 'scout',
      displayName: 'Cold Start Scout',
      source: 'plugin',
    });
    expect(publishes).toBe(0);
  });
});
