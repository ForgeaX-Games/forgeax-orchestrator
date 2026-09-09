import { expect, test } from 'bun:test';
import { publicCompactionStatus } from '../src/runtime/compaction-status';

test('only public lifecycle metadata crosses the stored-event bridge', () => {
  for (const phase of ['started', 'completed', 'failed']) {
    const value = publicCompactionStatus({ type: 'compaction.status', ts: 42, payload: {
      id: 'turn-1', phase, count: 2, durationMs: 1500,
      summary: 'PRIVATE', error: 'PRIVATE', replacement: 'PRIVATE', visual_display: 'PRIVATE',
    } });
    expect(value).toEqual({ type: 'compaction.status', ts: 42, payload: { id: 'turn-1', phase, count: 2, durationMs: 1500 } });
  }
});

test('unknown, raw and malformed lifecycle records fail closed', () => {
  const payload = { id: 't', phase: 'started', count: 1 };
  for (const type of ['compaction.pre', 'compaction.post', 'compact_boundary', 'unknown']) {
    expect(publicCompactionStatus({ type, payload })).toBeNull();
  }
  for (const patch of [{ phase: 'secret' }, { count: -1 }, { count: Infinity }, { id: '' }, { visibility: 'private_reasoning' }]) {
    expect(publicCompactionStatus({ type: 'compaction.status', payload: { ...payload, ...patch } })).toBeNull();
  }
});
