import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNpcMemoryAuditSink } from '../src/npc-brain/memory/npc-memory-audit-sink';

const TMP = mkdtempSync(join(tmpdir(), 'fx-npc-memory-audit-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function project(name: string): string {
  const root = join(TMP, name);
  // The sink intentionally creates its fixed audit path lazily.
  return root;
}

function rows(sink: { path: string }): Array<Record<string, unknown>> {
  return readFileSync(sink.path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('NpcMemoryAuditSink', () => {
  test('writes ordered, non-authoritative projection rows under the fixed product path', async () => {
    const sink = createNpcMemoryAuditSink({ projectRoot: project('ordered'), now: () => 123 });
    sink.write({ source: 'brain', eventId: 'evt-1', ownerNpcId: 'alice', operation: 'recall', status: 'succeeded' });
    sink.write({
      source: 'provider', requestId: 'provider:recall:1', eventId: 'evt-1', providerId: 'file-soul-memory',
      operation: 'recall', commandId: 'command-1', latencyMs: 2, subject: { ownerNpcId: 'alice' },
    });
    await sink.drain();

    expect(sink.path).toBe(join(project('ordered'), '.forgeax', 'npc-brain', 'audit', 'memory-audit.v1.jsonl'));
    expect(rows(sink)).toEqual([
      { version: 1, at: 123, source: 'brain', eventId: 'evt-1', ownerNpcId: 'alice', operation: 'recall', status: 'succeeded' },
      {
        version: 1, at: 123, source: 'provider', requestId: 'provider:recall:1', eventId: 'evt-1',
        providerId: 'file-soul-memory', operation: 'recall', commandId: 'command-1', latencyMs: 2,
        subject: { ownerNpcId: 'alice' },
      },
    ]);
    await sink.stop();
  });

  test('normalizes Error and circular JSON without manufacturing correlation fields', async () => {
    const sink = createNpcMemoryAuditSink({ projectRoot: project('normalize'), now: () => 456 });
    const cyclic: { self?: unknown; text: string } = { text: 'details' };
    cyclic.self = cyclic;
    const error = Object.assign(new Error('provider unavailable'), { code: 'E_DOWN' });
    sink.write({ source: 'provider', providerId: 'reference-snapshot-reader', operation: 'recall', error, detail: cyclic });
    await sink.stop();

    expect(rows(sink)[0]).toEqual({
      version: 1, at: 456, source: 'provider', providerId: 'reference-snapshot-reader', operation: 'recall',
      error: { name: 'Error', message: 'provider unavailable', code: 'E_DOWN' },
      detail: { text: 'details', self: '[circular]' },
    });
  });

  test('invalid records and I/O failures report best-effort diagnostics without throwing or leaving a file', async () => {
    const invalidErrors: unknown[] = [];
    const invalid = createNpcMemoryAuditSink({ projectRoot: project('invalid'), onError: (error) => invalidErrors.push(error) });
    expect(() => invalid.write({ source: 'bad' as never })).not.toThrow();
    await invalid.stop();
    expect(invalidErrors).toHaveLength(1);
    expect(existsSync(invalid.path)).toBe(false);

    const rootFile = join(TMP, 'root-file');
    writeFileSync(rootFile, 'not a directory');
    const ioErrors: unknown[] = [];
    const unavailable = createNpcMemoryAuditSink({ projectRoot: rootFile, onError: (error) => ioErrors.push(error) });
    expect(() => unavailable.write({ source: 'brain', operation: 'handoff' })).not.toThrow();
    await expect(unavailable.drain()).resolves.toBeUndefined();
    await unavailable.stop();
    expect(ioErrors).toHaveLength(1);
  });

  test('bounds the best-effort queue and drains only the surviving latest row', async () => {
    const sink = createNpcMemoryAuditSink({ projectRoot: project('bounded'), highWater: 1, now: () => 789 });
    sink.write({ source: 'brain', eventId: 'evt-1' });
    sink.write({ source: 'brain', eventId: 'evt-2' });
    sink.write({ source: 'brain', eventId: 'evt-3' });
    await sink.drain();

    expect(sink.dropped).toBe(2);
    expect(rows(sink).map((row) => row.eventId)).toEqual(['evt-3']);
    await sink.stop();
  });

  test('rotates the projection asynchronously instead of growing without bound', async () => {
    const sink = createNpcMemoryAuditSink({
      projectRoot: project('rotate'),
      maxFileBytes: 1,
      now: () => 789,
    });
    sink.write({ source: 'brain', eventId: 'evt-before-rotation' });
    sink.write({ source: 'brain', eventId: 'evt-after-rotation' });
    await sink.stop();

    expect(rows({ path: `${sink.path}.1` }).map((row) => row.eventId)).toEqual(['evt-before-rotation']);
    expect(rows(sink).map((row) => row.eventId)).toEqual(['evt-after-rotation']);
  });

  test('refuses a symlinked project component and remains best-effort', async () => {
    const target = project('symlink-target');
    const link = join(TMP, 'symlink-project');
    symlinkSync(target, link);
    const errors: unknown[] = [];
    const sink = createNpcMemoryAuditSink({ projectRoot: link, onError: (error) => errors.push(error) });
    sink.write({ source: 'brain', eventId: 'evt-symlink' });
    await sink.stop();

    expect(errors).toHaveLength(1);
    expect(existsSync(join(target, '.forgeax', 'npc-brain', 'audit', 'memory-audit.v1.jsonl'))).toBe(false);
  });

  test('checks an internal fixed audit component before mkdir can escape through it', async () => {
    const root = project('internal-symlink-root');
    const target = project('internal-symlink-target');
    mkdirSync(root, { recursive: true });
    symlinkSync(target, join(root, '.forgeax'));
    const errors: unknown[] = [];
    const sink = createNpcMemoryAuditSink({ projectRoot: root, onError: (error) => errors.push(error) });
    sink.write({ source: 'provider', operation: 'recall', latencyMs: 0 });
    await sink.stop();

    expect(errors).toHaveLength(1);
    expect(existsSync(join(target, 'npc-brain', 'audit'))).toBe(false);
  });

  test('drops invalid negative latency without affecting caller control flow', async () => {
    const errors: unknown[] = [];
    const sink = createNpcMemoryAuditSink({ projectRoot: project('negative-latency'), onError: (error) => errors.push(error) });
    expect(() => sink.write({ source: 'brain', latencyMs: -1 })).not.toThrow();
    await sink.stop();
    expect(errors).toHaveLength(1);
    expect(existsSync(sink.path)).toBe(false);
  });
});
