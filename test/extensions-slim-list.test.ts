import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeManifest, type ExtensionManifestV2 } from '@forgeax/types';

describe('extension slim list', () => {
  it('projects a browser-safe source descriptor for an agent extension', async () => {
    const module = await import('../src/extensions/slim-list') as Record<string, unknown>;
    const project = module.projectExtensionInfoForTest;

    expect(typeof project).toBe('function');
    if (typeof project !== 'function') return;

    const manifest = {
        schemaVersion: 1,
        id: '@forgeax-extension/agent-arin',
        version: '0.1.0',
        kind: 'agent',
        displayName: { zh: 'Arin' },
        provides: {
          agent: {
            id: 'arin',
            role: 'orchestrator',
            card: { name: { zh: 'Arin' }, color: '#fff', avatar: './avatar.png' },
            personaFile: './persona.md',
          },
        },
      } as const;
    const item = project({
      manifest,
      normalizedManifest: normalizeManifest(manifest),
      origin: 'user',
      originPath: '/Users/you/.forgeax/extensions/agent-arin/forgeax-extension.json',
      shadowedBy: [],
    }) as Record<string, unknown> | null;

    expect(item).toMatchObject({
      source: {
        origin: 'user',
        relativeManifestPath: 'agent-arin/forgeax-extension.json',
      },
    });
    expect(JSON.stringify(item)).not.toContain('/Users/you');
  });

  it('projects the authoritative registry manifests instead of rescanning origins', async () => {
    const module = await import('../src/extensions/slim-list') as Record<string, unknown>;
    const projectList = module.projectExtensionListForTest;
    expect(typeof projectList).toBe('function');
    if (typeof projectList !== 'function') return;

    const manifest = {
      schemaVersion: 2,
      id: '@forgeax-extension/bgm',
      version: '0.5.3',
      displayName: { en: 'BGM & SFX' },
      contributes: {
        activities: [{
          id: 'bgm.launcher',
          title: { en: 'BGM & SFX' },
          pageType: { extension: 'self', id: 'bgm' },
        }],
      },
    } satisfies ExtensionManifestV2;
    const items = projectList([{
      manifest,
      normalizedManifest: normalizeManifest(manifest),
      origin: 'npm',
      originPath: '/product/node_modules/@forgeax-extension/bgm/forgeax-extension.json',
      shadowedBy: [],
    }]) as Array<Record<string, unknown>>;

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '@forgeax-extension/bgm',
      version: '0.5.3',
      source: { origin: 'npm' },
    });

    const apiSource = readFileSync(new URL('../src/api/extensions.ts', import.meta.url), 'utf8');
    expect(apiSource).toContain('const snapshot = getExtensionSnapshot();');
    expect(apiSource).toContain('loadExtensionList(snapshot.manifests, snapshot.generation)');
  });
});
