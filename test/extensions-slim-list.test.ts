import { describe, expect, it } from 'bun:test';

describe('extension slim list', () => {
  it('projects a browser-safe source descriptor for an agent extension', async () => {
    const module = await import('../src/extensions/slim-list') as Record<string, unknown>;
    const project = module.projectExtensionInfoForTest;

    expect(typeof project).toBe('function');
    if (typeof project !== 'function') return;

    const item = project({
      manifest: {
        schemaVersion: 1,
        id: '@forgeax-extension/agent-arin',
        version: '0.1.0',
        kind: 'agent',
        displayName: { zh: 'Arin' },
        provides: { agent: { id: 'arin', role: 'orchestrator' } },
      },
      layer: 'L1',
      originPath: '/Users/you/.forgeax/extensions/agent-arin/forgeax-extension.json',
      shadowedBy: [],
    }) as Record<string, unknown> | null;

    expect(item).toMatchObject({
      source: {
        layer: 'L1',
        relativeManifestPath: 'agent-arin/forgeax-extension.json',
      },
    });
    expect(JSON.stringify(item)).not.toContain('/Users/you');
  });
});
