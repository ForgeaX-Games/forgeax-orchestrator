import { describe, expect, it } from 'bun:test';
import { applyExtensionDevPortOverridesForTest } from '../src/extensions/slim-list';

describe('bus plugin dev port overrides', () => {
  it('overrides standalone ports by plugin id only', () => {
    const items = applyExtensionDevPortOverridesForTest(
      [
        {
          id: '@forgeax-extension/scene-generator',
          version: '0.1.0',
          kind: 'extension',
          displayName: { zh: 'scene' },
          source: { origin: 'builtin', relativeManifestPath: 'wb-scene-generator/forgeax-extension.json' },
          entry: { standalone: { start: 'pnpm dev', port: 9555, readyProbe: '/', embeddedAlso: false } },
        },
        {
          id: '@forgeax-extension/3d-lowpoly',
          version: '0.1.0',
          kind: 'extension',
          displayName: { zh: 'lowpoly' },
          source: { origin: 'builtin', relativeManifestPath: 'wb-3d-lowpoly/forgeax-extension.json' },
          entry: { standalone: { start: 'pnpm dev', port: 9565, readyProbe: '/', embeddedAlso: false } },
        },
      ],
      {
        plugins: {
          '@forgeax-extension/scene-generator': { frontendPort: 9755, backendPort: 9757 },
        },
      },
    );

    expect(items[0].entry?.standalone?.port).toBe(9755);
    expect(items[1].entry?.standalone?.port).toBe(9565);
  });
});
