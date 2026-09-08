/**
 * Phase B1 unit tests for scanner+merger. Builds disposable plugin trees in
 * /tmp and verifies the project>user>builtin override + topo + zod rejection paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultExtensionRoots, scanAllExtensionOrigins } from '../src/extensions/scanner';
import { mergeManifests } from '../src/extensions/merger';

const TMP = `/tmp/forgeax-plugins-${process.pid}`;

function mkplugin(origin: 'builtin' | 'user' | 'project', id: string, body: Record<string, unknown>): void {
  const layerDir = join(TMP, origin, id.replace(/^@[^/]+\//, ''));
  mkdirSync(layerDir, { recursive: true });
  writeFileSync(
    join(layerDir, 'forgeax-extension.json'),
    JSON.stringify({
      schemaVersion: 2,
      id,
      version: '0.1.0',
      displayName: { zh: id },
      ...body,
    }),
    'utf-8',
  );
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['builtin', 'user', 'project'] as const) mkdirSync(join(TMP, l), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ROOTS = () => ({
  builtin: join(TMP, 'builtin'),
  user: join(TMP, 'user'),
  project: join(TMP, 'project'),
});

describe('scanner + merger', () => {
  it('does not infer a built-in extension root from the Marketplace checkout', () => {
    const marketplaceRoot = join(TMP, 'repo', 'packages', 'marketplace', 'extensions');
    mkdirSync(marketplaceRoot, { recursive: true });

    const roots = defaultExtensionRoots({
      repoRoot: join(TMP, 'repo'),
      projectRoot: join(TMP, 'project-root'),
    });

    expect(roots.builtin).toBeNull();
  });

  it('accepts manifest v2 and publishes the normalized contribution catalog', async () => {
    const dir = join(TMP, 'builtin', 'page-v2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'forgeax-extension.json'), JSON.stringify({
      schemaVersion: 2,
      id: '@forgeax-extension/page-v2',
      version: '1.0.0',
      displayName: 'Page v2',
      contributes: {
        panelTypes: [{ id: 'content', runtime: 'iframe', entry: './index.html' }],
        pages: [{
          id: 'main', title: 'Main', cardinality: 'singleton',
          layout: { version: 1, root: { kind: 'tabs', placements: ['content'], active: 'content' } },
          layoutVersion: 1,
          panels: [{ id: 'content', panelType: { extension: 'self', id: 'content' } }],
        }],
        activities: [{ id: 'launcher', title: 'Page v2', pageType: { extension: 'self', id: 'main' } }],
      },
    }), 'utf-8');
    const result = await scanAllExtensionOrigins(ROOTS());
    expect(result.errors).toEqual([]);
    expect(result.found[0]?.normalizedManifest?.contributes.pages?.[0]?.id).toBe('main');
    expect(result.found[0]?.manifest.schemaVersion).toBe(2);
  });

  it('finds manifests in each origin', async () => {
    mkplugin('builtin', '@forgeax-extension/a', { contributes: {} });
    mkplugin('user', '@forgeax-extension/b', { contributes: {} });
    mkplugin('project', '@forgeax-extension/c', { contributes: {} });
    const r = await scanAllExtensionOrigins(ROOTS());
    expect(r.errors.length).toBe(0);
    expect(r.found.map((f) => f.origin).sort()).toEqual(['builtin', 'project', 'user']);
  });

  it('finds manifests from resolved npm extension directories', async () => {
    const dir = join(TMP, 'npm', 'embedded-extension');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'forgeax-extension.json'), JSON.stringify({
      schemaVersion: 1,
      id: '@forgeax-extension/embedded',
      version: '1.0.0',
      kind: 'workbench',
      displayName: { en: 'Embedded' },
      provides: { workbench: { id: 'embedded' } },
    }), 'utf-8');

    const result = await scanAllExtensionOrigins(ROOTS(), [join(TMP, 'npm')]);
    expect(result.errors).toEqual([]);
    expect(result.found.map((entry) => entry.origin)).toEqual(['npm']);
    expect(result.found[0]?.manifest.id).toBe('@forgeax-extension/embedded');
  });

  it('follows symlinked plugin directories in user', async () => {
    mkplugin('project', '@forgeax-extension/linked', { contributes: {} });
    const target = join(TMP, 'project', 'linked');
    rmSync(join(TMP, 'project', 'linked'), { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'forgeax-extension.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: '@forgeax-extension/linked',
        version: '0.1.0',
        displayName: { zh: 'linked' },
        contributes: {},
      }),
      'utf-8',
    );
    symlinkSync(target, join(TMP, 'user', 'linked'), 'dir');

    const r = await scanAllExtensionOrigins({ ...ROOTS(), project: null });
    expect(r.errors).toEqual([]);
    expect(r.found.map((f) => [f.origin, f.manifest.id])).toEqual([
      ['user', '@forgeax-extension/linked'],
    ]);
  });

  it('rejects malformed manifest with a structured error', async () => {
    mkdirSync(join(TMP, 'builtin', 'broken'), { recursive: true });
    writeFileSync(join(TMP, 'builtin', 'broken', 'forgeax-extension.json'), '{not json', 'utf-8');
    const r = await scanAllExtensionOrigins(ROOTS());
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].origin).toBe('builtin');
  });

  it('project wins over user wins over builtin with shadowedBy chain', async () => {
    const id = '@forgeax-extension/shared';
    mkplugin('builtin', id, { version: '0.1.0', contributes: {} });
    mkplugin('user', id, { version: '0.2.0', contributes: {} });
    mkplugin('project', id, { version: '0.3.0', contributes: {} });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.manifests.length).toBe(1);
    expect(merged.manifests[0].origin).toBe('project');
    expect(merged.manifests[0].manifest.version).toBe('0.3.0');
    expect(merged.manifests[0].shadowedBy.map((s) => s.origin)).toEqual(['user', 'builtin']);
  });

  it('merges the installed legacy video-game id with its current built-in identity', async () => {
    mkplugin('builtin', '@forgeax-extension/video-game', {
      version: '0.2.0',
      contributes: {},
    });
    mkplugin('user', '@forgeax-extension/video-game', {
      version: '0.1.5',
      contributes: {},
    });

    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);

    expect(scan.found.map((entry) => entry.manifest.id)).toEqual([
      '@forgeax-extension/video-game',
      '@forgeax-extension/video-game',
    ]);
    expect(merged.manifests).toHaveLength(1);
    expect(merged.manifests[0]).toMatchObject({
      origin: 'user',
      manifest: { id: '@forgeax-extension/video-game', version: '0.1.5' },
    });
    expect(merged.manifests[0]?.shadowedBy).toHaveLength(1);
  });

  it('normalizes the legacy wb-observatory identity to Agent Monitor', async () => {
    mkplugin('user', '@forgeax-extension/wb-observatory', { contributes: {} });

    const scan = await scanAllExtensionOrigins(ROOTS());

    expect(scan.errors).toEqual([]);
    expect(scan.found[0]?.manifest.id).toBe('@forgeax-extension/agent-monitor');
  });

  it('topologically sorts by dependencies (deps before dependents)', async () => {
    mkplugin('builtin', '@forgeax-extension/base', { contributes: {} });
    mkplugin('builtin', '@forgeax-extension/mid', {
      contributes: {},
      dependencies: [{ id: '@forgeax-extension/base' }],
    });
    mkplugin('builtin', '@forgeax-extension/top', {
      contributes: {},
      dependencies: [{ id: '@forgeax-extension/mid' }],
    });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    const order = merged.manifests.map((m) => m.manifest.id);
    expect(order.indexOf('@forgeax-extension/base'))
      .toBeLessThan(order.indexOf('@forgeax-extension/mid'));
    expect(order.indexOf('@forgeax-extension/mid'))
      .toBeLessThan(order.indexOf('@forgeax-extension/top'));
    expect(merged.issues.length).toBe(0);
  });

  it('reports unknown-dependency without dropping the plugin', async () => {
    mkplugin('builtin', '@forgeax-extension/orphan', {
      contributes: {},
      dependencies: [{ id: '@forgeax-extension/missing' }],
    });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.issues.some((i) => i.kind === 'unknown-dependency')).toBe(true);
    expect(merged.manifests.map((m) => m.manifest.id)).toContain('@forgeax-extension/orphan');
  });

  it('detects dependency cycles', async () => {
    mkplugin('builtin', '@forgeax-extension/x', {
      contributes: {},
      dependencies: [{ id: '@forgeax-extension/y' }],
    });
    mkplugin('builtin', '@forgeax-extension/y', {
      contributes: {},
      dependencies: [{ id: '@forgeax-extension/x' }],
    });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('FORGEAX_SAFE_BOOT=1 skips user+project scans (Doc 14 §4 spike)', async () => {
    mkplugin('builtin', '@forgeax-extension/l0', { contributes: {} });
    mkplugin('user', '@forgeax-extension/l1', { contributes: {} });
    mkplugin('project', '@forgeax-extension/l2', { contributes: {} });
    const prev = process.env.FORGEAX_SAFE_BOOT;
    process.env.FORGEAX_SAFE_BOOT = '1';
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.errors).toEqual([]);
      expect(r.found.map((f) => f.origin)).toEqual(['builtin']);
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-extension/l0']);
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_SAFE_BOOT;
      else process.env.FORGEAX_SAFE_BOOT = prev;
    }
  });

  it('rejects entry.standalone.devOnly:true under FORGEAX_NODE_ENV=production', async () => {
    mkplugin('builtin', '@forgeax-extension/dev', {
      contributes: {},
      entry: { standalone: { start: 'bun --watch dev.ts', devOnly: true } },
    });
    mkplugin('builtin', '@forgeax-extension/prod', {
      contributes: {},
      entry: { standalone: { start: 'node prod.js' } },
    });
    const prev = process.env.FORGEAX_NODE_ENV;
    process.env.FORGEAX_NODE_ENV = 'production';
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-extension/prod']);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0].reason).toContain('devOnly');
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_NODE_ENV;
      else process.env.FORGEAX_NODE_ENV = prev;
    }
  });

  it('accepts entry.standalone.devOnly:true outside production', async () => {
    mkplugin('builtin', '@forgeax-extension/dev', {
      contributes: {},
      entry: { standalone: { start: 'bun --watch dev.ts', devOnly: true } },
    });
    const prev = process.env.FORGEAX_NODE_ENV;
    delete process.env.FORGEAX_NODE_ENV;
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.errors).toEqual([]);
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-extension/dev']);
    } finally {
      if (prev !== undefined) process.env.FORGEAX_NODE_ENV = prev;
    }
  });

  it('FORGEAX_SAFE_BOOT unset still scans all three origins', async () => {
    mkplugin('builtin', '@forgeax-extension/l0', { contributes: {} });
    mkplugin('user', '@forgeax-extension/l1', { contributes: {} });
    mkplugin('project', '@forgeax-extension/l2', { contributes: {} });
    const prev = process.env.FORGEAX_SAFE_BOOT;
    delete process.env.FORGEAX_SAFE_BOOT;
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.found.map((f) => f.origin).sort()).toEqual(['builtin', 'project', 'user']);
    } finally {
      if (prev !== undefined) process.env.FORGEAX_SAFE_BOOT = prev;
    }
  });
});
