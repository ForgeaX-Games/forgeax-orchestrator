import { expect, test } from 'bun:test';
import { CodexCompactionTracker, compactCodexThread } from '../src/kernel/codex-compaction';
import type { CodexAppServerClient, CodexAppServerOptions } from '../src/kernel/codex-appserver-client';

test('native compaction lifecycle is deduplicated and counts across turns', () => {
  const tracker = new CodexCompactionTracker();
  const params = { item: { type: 'contextCompaction', id: 'one' } };
  expect(tracker.observe('item/started', params)).toEqual([{ id: 'one', phase: 'started', count: 1 }]);
  expect(tracker.observe('item/started', params)).toEqual([]);
  expect(tracker.observe('item/completed', params)[0]).toMatchObject({ phase: 'completed', count: 1 });
  expect(tracker.observe('item/completed', params)).toEqual([]);
  expect(tracker.observe('item/started', { item: { ...params.item, id: 'two' } })[0].count).toBe(2);
  expect(tracker.observe('error', { error: { message: 'private error body' } })[0]).toMatchObject({id:'two', phase: 'failed', count: 2});
});

test('manual compaction waits for native completion and restores turn handlers', async () => {
  let handlers!: Pick<CodexAppServerOptions, 'onNotification' | 'onServerRequest' | 'onExit'>;
  let restored = false;
  let finished = false;
  const client = {
    setTurnHandlers(next: typeof handlers) { handlers = next; return () => { restored = true; }; },
    async request(method: string, params: unknown) {
      expect(method).toBe('thread/compact/start');
      expect(params).toEqual({threadId:'native'});
    },
  } as unknown as CodexAppServerClient;
  const statuses: unknown[] = [];
  const work = compactCodexThread(client, 'native', new CodexCompactionTracker(), s => statuses.push(s)).then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  handlers.onNotification('item/completed', {threadId:'other', item:{id:'wrong',type:'contextCompaction'}});
  expect(finished).toBe(false);
  handlers.onNotification('item/started', {threadId:'native', item:{id:'compact',type:'contextCompaction'}});
  handlers.onNotification('item/completed', {threadId:'native', item:{id:'compact',type:'contextCompaction'}});
  await work;
  expect(restored).toBe(true);
  expect(statuses).toHaveLength(2);
});

test('local cancellation closes active compaction once and fences late native completion', () => {
  const tracker = new CodexCompactionTracker();
  const params = { item: { type: 'contextCompaction', id: 'cancelled-item' } };
  tracker.observe('item/started', params);
  expect(tracker.finish('cancelled')).toEqual([{ id: 'cancelled-item', phase: 'cancelled', count: 1, durationMs: expect.any(Number) }]);
  expect(tracker.finish('cancelled')).toEqual([]);
  expect(tracker.observe('item/completed', params)).toEqual([]);
  expect(tracker.observe('item/started', params)).toEqual([]);
});
