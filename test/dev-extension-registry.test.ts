import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetDevExtensionsForTests, loadDevExtensions, unregisterDevExtension, validateDevRegistration } from '../src/extensions/dev-registry';
import { mergeManifests } from '../src/extensions/merger';
import type { ScannedManifest } from '../src/extensions/scanner';

function fixture(overrides: Record<string, unknown> = {}) {
  const artifactDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-dev-artifact-')));
  writeFileSync(join(artifactDirectory, '.forgeax-artifact.json'), JSON.stringify({ owner: '@forgeax/toolkit', schemaVersion: 1, mode: 'dev' }));
  writeFileSync(join(artifactDirectory, 'package.json'), JSON.stringify({
    name: '@forgeax-extension/counter',
    version: '0.1.0',
    type: 'module',
    exports: { '.': './dist/extension.js', './manifest': './forgeax-extension.json', './package.json': './package.json' },
    forgeaxExtension: { schemaVersion: 1, manifest: 'forgeax-extension.json' },
  }));
  const manifest = {
    schemaVersion: 2,
    id: '@forgeax-extension/counter',
    version: '0.1.0',
    displayName: 'Counter',
    entry: { extension: { source: './src/extension.tsx', module: './dist/extension.js' } },
    capabilities: { required: ['host', 'view'], optional: [] },
    compatibility: { extensionApi: '^1.0.0' },
    contributes: {},
    permissions: [],
  };
  const manifestPath = join(artifactDirectory, 'forgeax-extension.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const now = Date.now();
  return {
    schemaVersion: 2,
    registrationId: `toolkit:counter:${process.pid}`,
    owner: '@forgeax/toolkit',
    extensionId: manifest.id,
    artifactDirectory,
    manifestPath,
    moduleUrl: 'http://127.0.0.1:5173/src/extension.ts',
    allowedOrigin: 'http://127.0.0.1:5173',
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

afterEach(() => _resetDevExtensionsForTests());
describe('dev extension registrations', () => {
  test('validates ownership, canonical paths, origin, manifest id, pid and heartbeat', () => {
    expect(validateDevRegistration(fixture()).ok).toBe(true);
    expect(validateDevRegistration(fixture({ owner: 'forged' })).ok).toBe(false);
    expect(validateDevRegistration(fixture({ allowedOrigin: 'http://127.0.0.1:5174' })).ok).toBe(false);
    expect(validateDevRegistration(fixture({ extensionId: '@forgeax-extension/other' })).ok).toBe(false);
    expect(validateDevRegistration(fixture({ pid: 99999999 })).ok).toBe(false);
    expect(validateDevRegistration(fixture({ heartbeatAt: 1 })).ok).toBe(false);

    const mismatched = fixture();
    const alternateManifestPath = join(mismatched.artifactDirectory, 'alternate.json');
    writeFileSync(alternateManifestPath, readFileSync(mismatched.manifestPath));
    expect(validateDevRegistration({ ...mismatched, manifestPath: alternateManifestPath })).toEqual({
      ok: false,
      reason: 'manifestPath does not match the extension package contract',
    });
  });

  test('restores healthy records at startup and isolates stale records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-dev-index-'));
    const path = join(directory, 'registrations.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, registrations: [fixture(), fixture({ registrationId: 'stale', heartbeatAt: 1 })] }));
    const result = loadDevExtensions(path);
    expect(result.found).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  test('dev shadows project and unregister suppression restores the lower origin', () => {
    const registration = fixture();
    const checked = validateDevRegistration(registration);
    if (!checked.ok) throw new Error(checked.reason);
    const project: ScannedManifest = {
      ...checked.scanned,
      origin: 'project',
      originPath: '/project/forgeax-extension.json',
      runtime: undefined,
    };
    const merged = mergeManifests([project, checked.scanned]);
    expect(merged.manifests[0]?.origin).toBe('dev');
    expect(merged.manifests[0]?.shadowedBy[0]?.origin).toBe('project');
    unregisterDevExtension(registration.registrationId);
    expect(mergeManifests([project]).manifests[0]?.origin).toBe('project');
  });
});
