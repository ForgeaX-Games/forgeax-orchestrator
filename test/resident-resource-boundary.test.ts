import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('common resident persistence contains no desktop installation mapping or source eligibility rules', () => {
  const source = readFileSync(new URL('../src/agents/resident-resources.ts', import.meta.url), 'utf8');
  // Packaging recognition belongs to the injecting host. These markers guard
  // the former coupling without constraining generic filesystem operations.
  for (const marker of [
    'installedResourceSuffix', 'Contents', 'AppTranslocation', '/Volumes/',
    'node_modules', 'resources/brand', 'resources/product', '.app',
  ]) {
    expect(source).not.toContain(marker);
  }
  expect(source).not.toMatch(/external\.(?:source|origin)\s*[!=]==?\s*["']/);
});
