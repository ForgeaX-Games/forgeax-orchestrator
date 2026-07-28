/**
 * Phase B1 unit tests for scanner+merger. Builds disposable plugin trees in
 * /tmp and verifies the project>user>builtin override + topo + zod rejection paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllExtensionOrigins } from '../src/extensions/scanner';
import { mergeManifests } from '../src/extensions/merger';

const TMP = `/tmp/forgeax-plugins-${process.pid}`;

function mkplugin(origin: 'builtin' | 'user' | 'project', id: string, body: Record<string, unknown>): void {
  const layerDir = join(TMP, origin, id.replace(/^@[^/]+\//, ''));
  mkdirSync(layerDir, { recursive: true });
  writeFileSync(
    join(layerDir, 'forgeax-extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: '0.1.0',
      kind: 'workbench',
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
  it('finds manifests in each origin', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-a', { provides: { workbench: { id: 'a' } } });
    mkplugin('user', '@forgeax-extension/wb-b', { provides: { workbench: { id: 'b' } } });
    mkplugin('project', '@forgeax-extension/wb-c', { provides: { workbench: { id: 'c' } } });
    const r = await scanAllExtensionOrigins(ROOTS());
    expect(r.errors.length).toBe(0);
    expect(r.found.map((f) => f.origin).sort()).toEqual(['builtin', 'project', 'user']);
  });

  it('follows symlinked plugin directories in user', async () => {
    mkplugin('project', '@forgeax-extension/wb-linked', { provides: { workbench: { id: 'linked' } } });
    const target = join(TMP, 'project', 'wb-linked');
    rmSync(join(TMP, 'project', 'wb-linked'), { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'forgeax-extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@forgeax-extension/wb-linked',
        version: '0.1.0',
        kind: 'workbench',
        displayName: { zh: 'linked' },
        provides: { workbench: { id: 'linked' } },
      }),
      'utf-8',
    );
    symlinkSync(target, join(TMP, 'user', 'wb-linked'), 'dir');

    const r = await scanAllExtensionOrigins({ ...ROOTS(), project: null });
    expect(r.errors).toEqual([]);
    expect(r.found.map((f) => [f.origin, f.manifest.id])).toEqual([
      ['user', '@forgeax-extension/wb-linked'],
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
    const id = '@forgeax-extension/wb-shared';
    mkplugin('builtin', id, { version: '0.1.0', provides: { workbench: { id: 'shared' } } });
    mkplugin('user', id, { version: '0.2.0', provides: { workbench: { id: 'shared' } } });
    mkplugin('project', id, { version: '0.3.0', provides: { workbench: { id: 'shared' } } });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.manifests.length).toBe(1);
    expect(merged.manifests[0].origin).toBe('project');
    expect(merged.manifests[0].manifest.version).toBe('0.3.0');
    expect(merged.manifests[0].shadowedBy.map((s) => s.origin)).toEqual(['user', 'builtin']);
  });

  it('topologically sorts by dependencies (deps before dependents)', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-base', { provides: { workbench: { id: 'base' } } });
    mkplugin('builtin', '@forgeax-extension/wb-mid', {
      provides: { workbench: { id: 'mid' } },
      dependencies: [{ id: '@forgeax-extension/wb-base' }],
    });
    mkplugin('builtin', '@forgeax-extension/wb-top', {
      provides: { workbench: { id: 'top' } },
      dependencies: [{ id: '@forgeax-extension/wb-mid' }],
    });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    const order = merged.manifests.map((m) => m.manifest.id);
    expect(order.indexOf('@forgeax-extension/wb-base'))
      .toBeLessThan(order.indexOf('@forgeax-extension/wb-mid'));
    expect(order.indexOf('@forgeax-extension/wb-mid'))
      .toBeLessThan(order.indexOf('@forgeax-extension/wb-top'));
    expect(merged.issues.length).toBe(0);
  });

  it('reports unknown-dependency without dropping the plugin', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-orphan', {
      provides: { workbench: { id: 'orphan' } },
      dependencies: [{ id: '@forgeax-extension/missing' }],
    });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.issues.some((i) => i.kind === 'unknown-dependency')).toBe(true);
    expect(merged.manifests.map((m) => m.manifest.id)).toContain('@forgeax-extension/wb-orphan');
  });

  it('detects dependency cycles', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-x', {
      provides: { workbench: { id: 'x' } },
      dependencies: [{ id: '@forgeax-extension/wb-y' }],
    });
    mkplugin('builtin', '@forgeax-extension/wb-y', {
      provides: { workbench: { id: 'y' } },
      dependencies: [{ id: '@forgeax-extension/wb-x' }],
    });
    const scan = await scanAllExtensionOrigins(ROOTS());
    const merged = mergeManifests(scan.found);
    expect(merged.issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('FORGEAX_SAFE_BOOT=1 skips user+project scans (Doc 14 §4 spike)', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-l0', { provides: { workbench: { id: 'l0' } } });
    mkplugin('user', '@forgeax-extension/wb-l1', { provides: { workbench: { id: 'l1' } } });
    mkplugin('project', '@forgeax-extension/wb-l2', { provides: { workbench: { id: 'l2' } } });
    const prev = process.env.FORGEAX_SAFE_BOOT;
    process.env.FORGEAX_SAFE_BOOT = '1';
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.errors).toEqual([]);
      expect(r.found.map((f) => f.origin)).toEqual(['builtin']);
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-extension/wb-l0']);
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_SAFE_BOOT;
      else process.env.FORGEAX_SAFE_BOOT = prev;
    }
  });

  it('rejects entry.standalone.devOnly:true under FORGEAX_NODE_ENV=production', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-dev', {
      provides: { workbench: { id: 'dev' } },
      entry: { standalone: { start: 'bun --watch dev.ts', devOnly: true } },
    });
    mkplugin('builtin', '@forgeax-extension/wb-prod', {
      provides: { workbench: { id: 'prod' } },
      entry: { standalone: { start: 'node prod.js' } },
    });
    const prev = process.env.FORGEAX_NODE_ENV;
    process.env.FORGEAX_NODE_ENV = 'production';
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-extension/wb-prod']);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0].reason).toContain('devOnly');
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_NODE_ENV;
      else process.env.FORGEAX_NODE_ENV = prev;
    }
  });

  it('accepts entry.standalone.devOnly:true outside production', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-dev', {
      provides: { workbench: { id: 'dev' } },
      entry: { standalone: { start: 'bun --watch dev.ts', devOnly: true } },
    });
    const prev = process.env.FORGEAX_NODE_ENV;
    delete process.env.FORGEAX_NODE_ENV;
    try {
      const r = await scanAllExtensionOrigins(ROOTS());
      expect(r.errors).toEqual([]);
      expect(r.found.map((f) => f.manifest.id)).toEqual(['@forgeax-extension/wb-dev']);
    } finally {
      if (prev !== undefined) process.env.FORGEAX_NODE_ENV = prev;
    }
  });

  it('FORGEAX_SAFE_BOOT unset still scans all three origins', async () => {
    mkplugin('builtin', '@forgeax-extension/wb-l0', { provides: { workbench: { id: 'l0' } } });
    mkplugin('user', '@forgeax-extension/wb-l1', { provides: { workbench: { id: 'l1' } } });
    mkplugin('project', '@forgeax-extension/wb-l2', { provides: { workbench: { id: 'l2' } } });
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
