import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { isPathInside, materializeFileAttachments } from '../src/kernel/materialize-file-attachments';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fx-uploads-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const uploads = () => join(dir, 'uploads');

describe('materializeFileAttachments', () => {
  test('rented fallback materializes image/document/file and emits path notes only', () => {
    const data = Buffer.from('ABC').toString('base64');
    const result = materializeFileAttachments([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data },
      { kind: 'document', name: 'brief.pdf', mediaType: 'application/pdf', data },
      { kind: 'file', name: 'data.zip', mediaType: 'application/zip', data },
    ], uploads(), []);

    expect(result.attachments).toBeUndefined();
    for (const name of ['shot.png', 'brief.pdf', 'data.zip']) {
      const path = join(uploads(), name);
      expect(existsSync(path)).toBe(true);
      expect(result.note).toContain(path);
    }
    expect(JSON.stringify(result)).not.toContain(data);
  });

  test('core native image/document are path-only; generic file remains note-only', () => {
    const data = Buffer.from('ABC').toString('base64');
    const result = materializeFileAttachments([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data },
      { kind: 'document', name: 'brief.pdf', mediaType: 'application/pdf', data },
      { kind: 'file', name: 'data.zip', mediaType: 'application/zip', data },
    ], uploads(), ['image', 'document']);

    expect(result.attachments).toEqual([
      { kind: 'image', path: join(uploads(), 'shot.png'), mediaType: 'image/png' },
      { kind: 'document', path: join(uploads(), 'brief.pdf'), mediaType: 'application/pdf' },
    ]);
    expect(JSON.stringify(result.attachments)).not.toContain('data');
    expect(result.note).toContain(join(uploads(), 'data.zip'));
    expect(readFileSync(join(uploads(), 'shot.png'), 'utf8')).toBe('ABC');
  });

  test('path input is copied into durable uploads rather than referenced in place', () => {
    const source = join(dir, 'temporary.pdf');
    writeFileSync(source, 'pdf');
    const result = materializeFileAttachments([
      { kind: 'document', name: 'copy.pdf', mediaType: 'application/pdf', path: source },
    ], uploads(), ['document']);
    expect(result.attachments?.[0]?.path).toBe(join(uploads(), 'copy.pdf'));
    expect(readFileSync(join(uploads(), 'copy.pdf'), 'utf8')).toBe('pdf');
  });

  test('strict containment uses platform path semantics, including Windows backslashes', () => {
    expect(isPathInside('C:\\session\\uploads', 'C:\\session\\uploads\\image.png', win32.relative, win32.sep, win32.isAbsolute)).toBe(true);
    expect(isPathInside('C:\\session\\uploads', 'C:\\session\\uploads', win32.relative, win32.sep, win32.isAbsolute)).toBe(false);
    expect(isPathInside('C:\\session\\uploads', 'C:\\session\\outside.png', win32.relative, win32.sep, win32.isAbsolute)).toBe(false);
    expect(isPathInside('C:\\session\\uploads', 'D:\\image.png', win32.relative, win32.sep, win32.isAbsolute)).toBe(false);
  });

  test('filename traversal is stripped and failures degrade to a note', () => {
    const ok = materializeFileAttachments([{ kind: 'file', name: '../../secret.bin', data: 'QUJD' }], uploads());
    expect(existsSync(join(uploads(), 'secret.bin'))).toBe(true);
    expect(existsSync(join(dir, 'secret.bin'))).toBe(false);

    writeFileSync(join(dir, 'occupied'), 'x');
    const failed = materializeFileAttachments([{ kind: 'file', name: 'x.bin', data: 'QUJD' }], join(dir, 'occupied'));
    expect(failed.note).toContain('could not be saved');
  });
});
