import { describe, expect, test } from 'bun:test';
import { HistoryCoordinator } from '../src/history/coordinator';
import type { HistoryEntry, KernelLane } from '../src/history/types';

function entry(line: number, text: string, kernelId = 'cc', boundary?: HistoryEntry['semanticBoundary']): HistoryEntry {
  return { cursor: { shard: 1, line, eventId: `e${line}` }, turnId: `t${line}`, kernelId, semanticBoundary: boundary, message: { role: 'user', content: text } };
}

function harness(entries: HistoryEntry[], initial?: KernelLane) {
  let lane = initial;
  return {
    source: { read: async () => entries },
    lanes: {
      get: async () => lane,
      put: async (next: KernelLane) => { lane = next; },
    },
    lane: () => lane,
  };
}

describe('HistoryCoordinator', () => {
  test('first text bridge receives a snapshot and subsequent use only receives the gap', async () => {
    const h = harness([entry(1, 'A', 'cc'), entry(2, 'B', 'codex')]);
    const c = new HistoryCoordinator(h.source, h.lanes);
    const first = await c.prepare({ kernelId: 'cc', intake: 'text-bridge', nativeResumeAvailable: false });
    expect(first).toMatchObject({ mode: 'snapshot' });
    if ('code' in first) throw new Error(first.message);
    await c.commit(first, { shard: 1, line: 1, eventId: 'e1' });
    const next = await c.prepare({ kernelId: 'cc', intake: 'text-bridge', nativeResumeAvailable: true });
    expect(next).toMatchObject({ mode: 'delta', messages: [{ content: 'B' }] });
  });

  test('structured intake is authoritative and compaction forces a snapshot', async () => {
    const h = harness([entry(1, 'A'), entry(2, 'summary', 'cc', 'compaction')]);
    const c = new HistoryCoordinator(h.source, h.lanes);
    const structured = await c.prepare({ kernelId: 'forgeax-core', intake: 'structured', nativeResumeAvailable: false });
    expect(structured).toMatchObject({ mode: 'authoritative', messages: [{ content: 'A' }, { content: 'summary' }] });
    const h2 = harness([entry(1, 'A'), entry(2, 'B')], { laneId: 'cc-old', kernelId: 'cc', epoch: 1, knownThrough: { shard: 1, line: 1, eventId: 'e1' } });
    const c2 = new HistoryCoordinator(h2.source, h2.lanes);
    const snapshot = await c2.prepare({ kernelId: 'cc', intake: 'text-bridge', nativeResumeAvailable: true, forceSnapshot: true });
    expect(snapshot).toMatchObject({ mode: 'snapshot', messages: [{ content: 'A' }, { content: 'B' }] });
  });
});
