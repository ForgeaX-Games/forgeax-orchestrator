import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');
const allowedHostImports = new Set([
  '@forgeax/workbench-host/contracts',
  '@forgeax/workbench-host/http/hono',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('workbench host dependency boundary', () => {
  test('pins the shared host release exactly', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.dependencies?.['@forgeax/workbench-host']).toBe('0.2.0');
  });

  test('imports only contracts and Hono adapter subpaths', () => {
    const violations = sourceFiles(join(packageRoot, 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](@forgeax\/workbench-host[^'"]*)['"]/g)]
        .map((match) => match[1])
        .filter((specifier) => !allowedHostImports.has(specifier))
        .map((specifier) => `${file}: ${specifier}`);
    });
    expect(violations).toEqual([]);
  });
});
