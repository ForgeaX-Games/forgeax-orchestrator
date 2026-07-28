import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SELF = 'test/extension-origin-language.test.ts';
const SOURCE_EXTENSIONS = new Set(['.md', '.ts', '.tsx']);

function sourceFiles(): string[] {
  const files = ['README.md'];
  const pending = [resolve(ROOT, 'src'), resolve(ROOT, 'test')];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        const file = relative(ROOT, absolute);
        if (file !== SELF) files.push(file);
      }
    }
  }
  return files.sort();
}

describe('extension origin language', () => {
  it('keeps numeric labels and the retired runtime contract out of maintained source', () => {
    const opaqueNumericLabel = new RegExp(
      `(?<![A-Za-z0-9_])${['L', '[0-3]'].join('')}(?![A-Za-z0-9_])`,
      'g',
    );
    const retiredIdentifiers = [
      ['Extension', 'Layer'].join(''),
      ['default', 'LayerRoots'].join(''),
      ['scanAll', 'Layers'].join(''),
      ['dest', 'Layer'].join(''),
      ['existing', 'Layer'].join(''),
    ];
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      for (const [lineIndex, line] of readFileSync(resolve(ROOT, file), 'utf8').split('\n').entries()) {
        opaqueNumericLabel.lastIndex = 0;
        if (opaqueNumericLabel.test(line) || retiredIdentifiers.some((identifier) => line.includes(identifier))) {
          violations.push(`${file}:${lineIndex + 1}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
