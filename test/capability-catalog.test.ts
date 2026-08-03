import { describe, expect, it } from 'bun:test';
import { parseManifest } from '@forgeax/types';
import { buildCapabilitySnapshot, findCapabilities } from '../src/capabilities/catalog';
import { buildKindRegistry } from '../src/extensions/kinds';
import type { MergedManifest } from '../src/extensions/merger';

function merged(
  origin: 'builtin' | 'user' | 'project',
  manifest: MergedManifest['manifest'],
): MergedManifest {
  return {
    manifest,
    origin,
    originPath: `/tmp/${origin}/${manifest.id}/forgeax-extension.json`,
    shadowedBy: [],
  };
}

describe('capability catalog', () => {
  it('derives shared metadata from one extension manifest', () => {
    const manifest = {
      schemaVersion: 1 as const,
      id: '@example/shared',
      version: '1.2.3',
      kind: 'workbench' as const,
      displayName: { zh: '共享能力' },
      hot: true,
      permissions: ['memory:read:iori'],
      provides: {
        workbench: { id: 'shared' },
        skills: [{ id: 'hello', entry: './SKILL.md', trigger: '/hello' }],
        commands: [{ id: 'hello-command', description: 'hello' }],
        mcp: [{ id: 'shared-mcp', requiresRestart: true }],
        memory: [{ id: 'shared-memory', memoryTiers: ['traits' as const] }],
      },
    };
    const manifests = [merged('user', manifest)];
    expect(parseManifest(manifest).ok).toBe(true);
    const kinds = buildKindRegistry(manifests);
    const snapshot = buildCapabilitySnapshot({
      generation: 7,
      loadedAt: 123,
      manifests,
      kinds,
      scanErrors: [],
      mergeIssues: [],
    });

    expect(snapshot.generation).toBe(7);
    expect(snapshot.issues).toEqual([]);
    expect(findCapabilities(snapshot, { kind: 'skill' }).map((c) => c.localId)).toEqual(['hello']);

    const command = findCapabilities(snapshot, { kind: 'command' })[0];
    expect(command.extensionVersion).toBe('1.2.3');
    expect(command.origin).toBe('user');
    expect(command.trustTier).toBe('imported');
    expect(command.permissions).toEqual(['memory:read:iori']);

    const mcp = findCapabilities(snapshot, { kind: 'mcp' })[0];
    expect(mcp.lifecycle.requiresRestart).toBe(true);
    const memory = findCapabilities(snapshot, { kind: 'memory' })[0];
    expect(memory.isolation.memoryTiers).toEqual(['traits']);
  });

  it('keeps diagnostics and trust derived from the load origin', () => {
    const manifest = {
      schemaVersion: 1 as const,
      id: '@forgeax-extension/builtin',
      version: '1.0.0',
      kind: 'skill' as const,
      displayName: { en: 'Builtin' },
      provides: {
        skills: [{ id: 'safe', entry: './SKILL.md' }],
      },
    };
    const manifests = [merged('builtin', manifest)];
    const snapshot = buildCapabilitySnapshot({
      generation: 2,
      loadedAt: 456,
      manifests,
      kinds: buildKindRegistry(manifests),
      scanErrors: [{ reason: 'broken optional extension' }],
      mergeIssues: [{ detail: 'dependency cycle' }],
    });

    expect(snapshot.capabilities.every((c) => c.trustTier === 'own')).toBe(true);
    expect(snapshot.issues).toEqual(['broken optional extension', 'dependency cycle']);
  });
});
