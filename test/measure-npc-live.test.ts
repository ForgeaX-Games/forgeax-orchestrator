import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { appendAttempt, classifyAttempt, nearestRank, summarizeAttempts } from '../scripts/measure-npc-live';

const candidate = {
  endpoint: 'http://127.0.0.1:18900/api/npc',
  game: 'fixture',
  npcId: 'guide',
  expectedModel: 'fixture-model',
  candidateSha: '0123456789abcdef',
};

function decision(seq: number) {
  return { v: 1 as const, npcId: 'guide', seq, intent: { action: 'idle', ttlSec: 1 } };
}

describe('live attempt ledger', () => {
  test('keeps every failure classification as an append-only row', () => {
    const bodies = [
      { ok: true, decision: decision(1) },
      { ok: true, fallback: true, reason: 'timeout' },
      { ok: false, providerError: true, error: 'bad gateway' },
      { ok: true, decision: null },
      { ok: true, fallback: true, reason: 'no_decision' },
      { ok: true, thinking: true, decision: decision(2) },
    ];
    const rows = bodies.map((body, index) => classifyAttempt(body, index + 1, index + 1, `e-${index}`, candidate));
    expect(rows.map((row) => row.kind)).toEqual([
      'success', 'timeout', 'provider-error', 'invalid', 'fallback', 'thinking',
    ]);
    expect(rows.every((row) => row.schema === 'forgeax.npc.live-attempt' && row.version === 1)).toBe(true);
    expect(rows.every((row) => row.candidate === candidate)).toBe(true);
  });

  test('rejects twenty independently malformed decisions', () => {
    const malformed = Array.from({ length: 20 }, (_, index) => ({
      ok: true,
      decision: { v: 1, npcId: 'guide', seq: -index },
    }));
    expect(
      malformed.map((body, index) => classifyAttempt(body, 1, index + 1, `bad-${index}`, candidate).kind),
    ).toEqual(Array.from({ length: 20 }, () => 'invalid'));
  });

  test('uses nearest-rank and excludes fallback/thinking rows from successful metrics', () => {
    const rows = Array.from(
      { length: 20 },
      (_, index) => classifyAttempt({ ok: true, decision: decision(index + 1) }, index + 1, index + 1, `s-${index}`, candidate),
    );
    rows.push(classifyAttempt({ ok: true, fallback: true }, 1, 21, 'fallback', candidate));
    rows.push(classifyAttempt({ ok: true, cache: true }, 1, 22, 'thinking', candidate));
    expect(nearestRank(rows.slice(0, 20).map((row) => row.elapsedMs), 0.5)).toBe(10);
    const summary = summarizeAttempts(rows, candidate);
    expect(summary.successes).toBe(20);
    expect(summary.failures).toBe(2);
    expect(summary.p50Ms).toBe(10);
    expect(summary.p95Ms).toBe(19);
    expect(summary.prdGate).toMatchObject({ passed: true });
  });

  test('writes JSONL rows without deleting previous failures', () => {
    const path = '/tmp/forgeax-live-attempts-test.jsonl';
    rmSync(path, { force: true });
    appendAttempt(path, classifyAttempt({ error: 'bad gateway' }, 12, 1, 'failure', candidate));
    appendAttempt(path, classifyAttempt({ ok: true, decision: decision(1) }, 8, 2, 'success', candidate));
    const saved = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(saved).toHaveLength(2);
    expect(saved.map((row) => row.kind)).toEqual(['provider-error', 'success']);
  });
});
