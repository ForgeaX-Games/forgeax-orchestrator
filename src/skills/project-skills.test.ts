import { afterEach, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'project-skills-'));
mock.module('../extensions/registry', () => ({ getExtensionSnapshot: () => ({ kinds: { skills: [] } }) }));
mock.module('../tools/registry', () => ({ callTool: () => { throw new Error('unexpected tool'); } }));
mock.module('../events/bus', () => ({ getEventBus: () => ({ emit: () => {} }) }));
mock.module('../permissions/engine', () => ({ compilePermissions: () => ({}) }));
mock.module('../runtime/pause', () => ({ isPaused: () => false }));
const { initOrchestrationSeams, resetOrchestrationSeams } = await import('../orchestration-seams');
const { sessionProjectSkills } = await import('./project-skills');
const { skillToolSpecs } = await import('./tool-specs');
const { runSkillKernelTool } = await import('./kernel-tool-bridge');
const { runSkill, listSkills } = await import('./runner');
afterEach(() => { resetOrchestrationSeams(); rmSync(root, { recursive: true, force: true }); });
test('catalog and invocation use the exact session directory supplied by a generic host', async () => {
  const roots = new Map([['a', join(root, 'workspace-a/skills')], ['b', join(root, 'workspace-b/skills')]]);
  initOrchestrationSeams({ sessionSkillRootProvider: (sid) => roots.get(sid) });
  for (const scope of ['workspace-a', 'workspace-b']) {
    mkdirSync(join(root, scope, 'skills/engine-app'), { recursive: true });
    writeFileSync(join(root, scope, 'skills/engine-app/SKILL.md'), `---\nname: Engine App\ndescription: >-\n  Create\n  games\n---\n${scope}`);
  }
  expect(sessionProjectSkills()).toEqual([]);
  expect(sessionProjectSkills('unknown')).toEqual([]);
  const a = sessionProjectSkills('a');
  expect(a[0].triggers).toEqual([{ kind: 'slash', command: 'engine-app' }]);
  expect(a[0].description).toBe('Create games');
  expect(a[0].text).toContain('workspace-a');
  expect(a[0].text).not.toContain('workspace-b');
  expect(sessionProjectSkills('b')[0].text).toContain('workspace-b');
  expect(listSkills('a')[0].id).toBe(a[0].id);
  expect(skillToolSpecs(undefined, 'a')[0].name).toBe('skill_engine_app');
  const result = await runSkillKernelTool('skill_engine_app', {}, { kind: 'ai', sessionId: 'a' });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).toContain('workspace-a');
  expect(JSON.stringify(result)).not.toContain('workspace-b');
  const direct = await runSkill({ skillId: 'engine-app', extensionId: 'project', caller: { kind: 'user', sessionId: 'b' } });
  expect(direct).toMatchObject({ ok: true, text: expect.stringContaining('workspace-b') });
  roots.set('a', join(root, 'workspace-b/skills'));
  expect(sessionProjectSkills('a')[0].text).toContain('workspace-b');
  expect((await runSkill({ skillId: 'engine-app', extensionId: 'project', caller: { kind: 'user', sessionId: 'unknown' } })).ok).toBe(false);
});

test('standalone and missing-session callers receive no host directory', () => {
  expect(sessionProjectSkills('a')).toEqual([]);
  expect(skillToolSpecs(undefined, 'a')).toEqual([]);
  let calls = 0;
  initOrchestrationSeams({ sessionSkillRootProvider: () => { calls += 1; return root; } });
  expect(sessionProjectSkills()).toEqual([]);
  expect(calls).toBe(0);
  sessionProjectSkills('a');
  expect(calls).toBe(1);
  initOrchestrationSeams({});
  expect(sessionProjectSkills('a')).toEqual([]);
  expect(calls).toBe(1);
});
