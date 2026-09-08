import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');
const allowedHostImports = new Set([
  '@forgeax/extension-host/contracts',
  '@forgeax/extension-host/http/hono',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('extension host dependency boundary', () => {
  test('declares the shared host only through the Extension Host identity', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.dependencies?.['@forgeax/extension-host']).toBeDefined();
    expect(manifest.dependencies?.['@forgeax/workbench-host']).toBeUndefined();
  });

  test('imports only contracts and Hono adapter subpaths', () => {
    const violations = sourceFiles(join(packageRoot, 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](@forgeax\/extension-host[^'"]*)['"]/g)]
        .map((match) => match[1])
        .filter((specifier) => !allowedHostImports.has(specifier))
        .map((specifier) => `${file}: ${specifier}`);
    });
    expect(violations).toEqual([]);
  });
});
