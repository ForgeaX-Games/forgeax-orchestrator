import { expect, test } from 'bun:test';
import { LedgerHistorySource, LedgerLaneStore, REPLAY_TOOL_PREVIEW_CHARS } from '../src/history/ledger-history';
import type { EventLedger } from '../src/ledger/event-ledger';

test('replay uses each processed user input once and bounds tool output without changing the WAL', async () => {
  const full = 'START' + 'x'.repeat(180_000) + 'END';
  const rows = [
    { event: { eventId: 'u', type: 'user_input', payload: { content: 'make a game' } }, cursor: { shard: 1, line: 1, eventId: 'u' } },
    { event: { eventId: 'i', type: 'inbound_message', payload: { sourceEventId: 'u', llmMessage: { role: 'user', content: 'make a game' } } }, cursor: { shard: 1, line: 2, eventId: 'i' } },
    { event: { eventId: 't', type: 'hook:toolResult', payload: { callId: 'call', ok: true, result: full } }, cursor: { shard: 1, line: 3, eventId: 't' } },
  ];
  const ledger = { readAllWithCursors: async () => rows } as unknown as EventLedger;
  const entries = await new LedgerHistorySource(ledger).read();
  expect(entries).toHaveLength(2);
  expect(entries[0]?.message).toEqual({ role: 'user', content: 'make a game' });
  const tool = entries[1]!.message;
  expect(tool).toMatchObject({ role: 'tool', callId: 'call', ok: true,
    result: { originalCharacters: full.length, historyReference: { eventId: 't', shard: 1, line: 3, field: 'payload.result' } } });
  expect(JSON.stringify(tool).length).toBeLessThan(REPLAY_TOOL_PREVIEW_CHARS + 500);
  expect(JSON.stringify(tool)).toContain('START');
  expect(JSON.stringify(tool)).toContain('END');
  expect(rows[2]!.event.payload.result).toBe(full);
});


test('late history receipts cannot advance or invalidate a replacement lane', async () => {
  const cursor = { shard: 1, line: 12, eventId: 'safe' };
  const rows = [
    { type: 'kernel_lane_bound', payload: { kernelId: 'codex', laneId: 'new', epoch: 2 } },
    { type: 'kernel_history_applied', payload: { kernelId: 'codex', laneId: 'new', epoch: 2, knownThrough: cursor } },
    { type: 'kernel_history_applied', payload: { kernelId: 'codex', laneId: 'old', epoch: 1, knownThrough: { ...cursor, line: 999 } } },
    { type: 'kernel_lane_invalidated', payload: { kernelId: 'codex', laneId: 'old', epoch: 1 } },
  ].map(event => ({ event }));
  const ledger = { readAllWithCursors: async () => rows } as unknown as EventLedger;
  expect(await new LedgerLaneStore(ledger).get('codex')).toEqual({ kernelId: 'codex', laneId: 'new', epoch: 2, knownThrough: cursor });
});

test('text bridge recovery bounds cumulative results while retaining conversation and durable evidence', async () => {
  const { TEXT_BRIDGE_TOOL_PREVIEW_BUDGET_CHARS } = await import('../src/history/ledger-history');
  const { renderHistoryPatch } = await import('../src/history/text-bridge');
  const { HistoryCoordinator } = await import('../src/history/coordinator');
  const output = 'START' + '\\[payload]'.repeat(1_000) + 'END';
  const rows = [
    { type: 'inbound_message', payload: { content: 'Keep the original requirements, including restart.' } },
    ...Array.from({ length: 305 }, (_, i) => ({ type: 'hook:toolResult', payload: {
      callId: `call-${i}`, ok: i !== 0, ...(i === 0 ? { error: output } : { result: output }),
    } })),
    { type: 'hook:assistantMessage', payload: { content: 'Current status: gameplay is unfinished.' } },
    { type: 'inbound_message', payload: { content: 'Continue without changing the requirements.' } },
  ].map((event, i) => ({ event: { ...event, eventId: `e-${i}`, ts: i }, cursor: { shard: 1, line: i + 1, eventId: `e-${i}` } }));
  const before = JSON.stringify(rows);
  const source = new LedgerHistorySource({ readAllWithCursors: async () => rows } as unknown as EventLedger,
    TEXT_BRIDGE_TOOL_PREVIEW_BUDGET_CHARS);
  const coordinator = new HistoryCoordinator(source, { get: async () => undefined, put: async () => {} });
  const prepared = await coordinator.prepare({ kernelId: 'codex', intake: 'text-bridge', nativeResumeAvailable: false });
  if ('code' in prepared) throw new Error(prepared.message);
  const patch = renderHistoryPatch(prepared.messages, prepared.patchId);
  expect(prepared.mode).toBe('snapshot');
  expect(prepared.messages).toHaveLength(rows.length);
  expect(patch.length).toBeLessThan(400_000);
  expect(patch).toContain('Keep the original requirements, including restart.');
  expect(patch).toContain('Current status: gameplay is unfinished.');
  expect(patch).toContain('Continue without changing the requirements.');
  expect(prepared.messages[1]).toMatchObject({ role: 'tool', ok: false,
    result: { historyReference: { eventId: 'e-1', field: 'payload.error' }, originalCharacters: output.length } });
  expect(JSON.stringify(prepared.messages[1])).not.toContain('START');
  expect(JSON.stringify(prepared.messages[305])).toContain('START');
  expect(JSON.stringify(prepared.messages[305])).toContain('END');
  expect(JSON.stringify(rows)).toBe(before);
  expect(prepared.redactedParts).toBe(0); // Excerpts are not privacy redaction or semantic compaction.
});
