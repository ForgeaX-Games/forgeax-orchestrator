import { expect, test } from 'bun:test';
import { LedgerHistorySource, REPLAY_TOOL_PREVIEW_CHARS } from '../src/history/ledger-history';
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
