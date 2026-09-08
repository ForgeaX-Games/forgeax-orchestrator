import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllExtensionOrigins } from '../src/extensions/scanner';

const ROOT = `/tmp/forgeax-extension-package-${process.pid}`;
const roots = () => ({
  builtin: join(ROOT, 'builtin'),
  user: join(ROOT, 'user'),
  project: join(ROOT, 'project'),
});

function writePackage(directory: string, id: string): void {
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: id,
    version: '1.0.0',
    type: 'module',
    exports: { '.': './dist/extension.js', './manifest': './forgeax-extension.json', './package.json': './package.json' },
    forgeaxExtension: { schemaVersion: 1, manifest: 'forgeax-extension.json' },
  }));
  writeFileSync(join(directory, 'forgeax-extension.json'), JSON.stringify({
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: id,
    description: id,
    entry: { extension: { source: './src/extension.ts', module: './dist/extension.js' } },
    capabilities: { required: [], optional: [] },
    compatibility: { extensionApi: '^1.0.0' },
    contributes: {},
    permissions: [],
  }));
  writeFileSync(join(directory, 'dist', 'extension.js'), 'export const extension = { apply() {} };');
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const root of Object.values(roots())) mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('standard extension packages', () => {
  test('builtin, installed user/project, and product-pinned npm origins parse the same package contract', async () => {
    writePackage(join(ROOT, 'builtin', 'builtin-counter'), '@forgeax-extension/builtin-counter');
    writePackage(join(ROOT, 'user', 'user-counter'), '@forgeax-extension/user-counter');
    writePackage(join(ROOT, 'project', 'project-counter'), '@forgeax-extension/project-counter');
    writePackage(join(ROOT, 'npm-counter'), '@forgeax-extension/npm-counter');
    const scan = await scanAllExtensionOrigins(roots(), [join(ROOT, 'npm-counter')]);
    expect(scan.errors).toEqual([]);
    expect(scan.found.every((entry) => entry.runtime?.moduleUrl.endsWith('/dist/extension.js'))).toBe(true);
    expect(scan.found.map((entry) => [entry.origin, entry.manifest.id]).sort()).toEqual([
      ['builtin', '@forgeax-extension/builtin-counter'],
      ['npm', '@forgeax-extension/npm-counter'],
      ['project', '@forgeax-extension/project-counter'],
      ['user', '@forgeax-extension/user-counter'],
    ]);
  });

  test('rejects an install missing its declared artifact module', async () => {
    const directory = join(ROOT, 'user', 'broken-counter');
    writePackage(directory, '@forgeax-extension/broken-counter');
    rmSync(join(directory, 'dist', 'extension.js'));
    const scan = await scanAllExtensionOrigins(roots());
    expect(scan.found).toEqual([]);
    expect(scan.errors[0]?.reason).toContain('artifact module is missing');
  });
});
