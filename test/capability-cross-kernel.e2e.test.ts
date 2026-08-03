import { describe, expect, it } from 'bun:test';
import { buildKindRegistry } from '../src/extensions/kinds';
import { buildCapabilitySnapshot } from '../src/capabilities/catalog';
import { projectToolSpecs } from '../src/capabilities/projection';
import { materializeForgeaxToolsRuntime } from '../src/kernel/mcp/forgeax-tools-runtime';
import type { MergedManifest } from '../src/extensions/merger';

describe('shared capability cross-kernel projection', () => {
  it('preserves identity and generation for native and rented projections', async () => {
    const manifest = {
      schemaVersion: 1 as const,
      id: '@example/shared-tool',
      version: '1.0.0',
      kind: 'tool' as const,
      displayName: { en: 'Shared tool' },
      provides: {
        tools: [{
          id: 'shared.inspect',
          description: { en: 'Inspect shared state' },
          exposedToAI: true,
        }],
      },
    };
    const merged: MergedManifest = {
      manifest,
      origin: 'builtin',
      originPath: '/tmp/shared-tool/forgeax-extension.json',
      shadowedBy: [],
    };
    const kinds = buildKindRegistry([merged]);
    const snapshot = buildCapabilitySnapshot({
      generation: 11,
      loadedAt: 99,
      manifests: [merged],
      kinds,
      scanErrors: [],
      mergeIssues: [],
    });
    const base = [{ name: 'shared.inspect', delivery: 'local' as const }];
    const native = projectToolSpecs(base, snapshot, 'native');
    const rented = projectToolSpecs(base, snapshot, 'rented');

    expect(native[0].capabilityId).toBe(rented[0].capabilityId);
    expect(native[0].capabilityGeneration).toBe(11);
    expect(native[0].delivery).toBe('local');
    expect(rented[0].delivery).toBe('host');

    const runtime = await materializeForgeaxToolsRuntime({
      session: { threadId: 'thread', agentId: 'agent' },
      input: { text: 'test' },
      systemPrompt: { charter: '', persona: '' },
      tools: rented,
      capabilityGeneration: snapshot.generation,
      budget: {},
    }, { runtimeId: 'capability-e2e' });
    expect(runtime?.enabledTools).toEqual(['shared.inspect']);
    expect(runtime?.env.FORGEAX_CAPABILITY_GENERATION).toBe('11');
    await runtime?.cleanup();
  });
});
