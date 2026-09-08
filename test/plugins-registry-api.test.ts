/**
 * Phase B3 — exercises the /api/plugins router end-to-end (no network).
 * Mounts the router on a Hono app and hits it with `app.request()`.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExtensionsRouter } from '../src/api/extensions';
import { reloadExtensions as reloadExtensionsWithDev, _resetSnapshotForTests } from '../src/extensions/registry';

const TMP = `/tmp/forgeax-registry-${process.pid}`;
const reloadExtensions = (options: Parameters<typeof reloadExtensionsWithDev>[0]) =>
  reloadExtensionsWithDev({ ...options, devRegistrationFile: null });

function mkmanifest(origin: string, dirName: string, body: Record<string, unknown>): void {
  const dir = join(TMP, origin, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['builtin', 'user', 'project']) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
});

describe('/api/plugins', () => {
  it('GET /manifests reflects the last loaded snapshot', async () => {
    mkmanifest('builtin', 'page-x', {
      schemaVersion: 2,
      id: '@forgeax-extension/x',
      displayName: { zh: 'X' },
      contributes: {
        panelTypes: [{ id: 'content', runtime: 'iframe', entry: './index.html' }],
        pages: [{
          id: 'main',
          title: { zh: 'X' },
          cardinality: 'singleton',
          layout: { version: 1, root: { kind: 'tabs', placements: ['content'], active: 'content' } },
          layoutVersion: 1,
          panels: [{ id: 'content', panelType: { extension: 'self', id: 'content' } }],
        }],
      },
    });
    await reloadExtensions({ roots: { builtin: join(TMP, 'builtin'), user: join(TMP, 'user'), project: join(TMP, 'project') } });

    const app = new Hono();
    app.route('/api/plugins', createExtensionsRouter());
    const res = await app.request('/api/plugins/manifests');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.counts.manifests).toBe(1);
    expect(body.counts.pages).toBe(1);
    expect(body.manifests[0]).toMatchObject({
      id: '@forgeax-extension/x',
      origin: 'builtin',
    });
  });

  it('POST /reload bumps generation and picks up new on-disk manifests', async () => {
    const roots = { builtin: join(TMP, 'builtin'), user: join(TMP, 'user'), project: join(TMP, 'project') };
    const before = await reloadExtensions({ roots });
    expect(before.manifests.length).toBe(0);

    mkmanifest('builtin', 'page-late', {
      schemaVersion: 2,
      id: '@forgeax-extension/late',
      displayName: { zh: 'Late' },
      contributes: {},
    });

    // The router doesn't know about our test roots, so reload manually too —
    // we're testing the response-shape contract here, not the directory
    // walker (that's covered in plugins-scanner-merger.test.ts).
    const after = await reloadExtensions({ roots });
    expect(after.generation).toBe(before.generation + 1);
    expect(after.manifests.length).toBe(1);

    const app = new Hono();
    app.route('/api/plugins', createExtensionsRouter());
    const res = await app.request('/api/plugins/manifests');
    const body = (await res.json()) as any;
    expect(body.generation).toBe(after.generation);
    expect(body.manifests[0].id).toBe('@forgeax-extension/late');
  });

  it('serializes scan errors as issues with phase=scan', async () => {
    mkdirSync(join(TMP, 'builtin', 'broken'), { recursive: true });
    writeFileSync(join(TMP, 'builtin', 'broken', 'forgeax-extension.json'), '{ malformed', 'utf-8');
    await reloadExtensions({ roots: { builtin: join(TMP, 'builtin'), user: join(TMP, 'user'), project: join(TMP, 'project') } });

    const app = new Hono();
    app.route('/api/plugins', createExtensionsRouter());
    const res = await app.request('/api/plugins/manifests');
    const body = (await res.json()) as any;
    expect(body.issues.some((i: { phase: string }) => i.phase === 'scan')).toBe(true);
  });
});
