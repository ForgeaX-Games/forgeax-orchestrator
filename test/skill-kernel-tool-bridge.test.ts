import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKindRegistry } from '../src/extensions/kinds';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import { runSkillKernelTool } from '../src/skills/kernel-tool-bridge';
import type { MergedManifest } from '../src/extensions/merger';

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
