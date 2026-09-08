import { describe, expect, test } from 'bun:test';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';
import {
  HISTORY_RESYNC_REQUIRED_MESSAGE,
  runWithHistoryResync,
} from '../src/kernel/history-resync';

const request = (mode: 'none' | 'snapshot'): TurnRequest => ({
  session: { threadId: 'thread', agentId: 'forge' },
  input: { text: 'continue' },
  systemPrompt: { charter: '', persona: '' },
  tools: [],
  budget: {},
  trustTier: 'own',
  historyPlan: { mode, messages: [], patchId: mode, laneId: 'codex-lane', epoch: 1, estimatedTokens: 0, redactedParts: 0 },
});

async function collect(stream: AsyncIterable<KernelEvent>): Promise<KernelEvent[]> {
  const events: KernelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('runWithHistoryResync', () => {
  test('suppresses a pre-admission sentinel and reruns exactly once with a snapshot', async () => {
    const initial = request('none');
    const retry = request('snapshot');
    const seen: TurnRequest[] = [];
    const events = await collect(runWithHistoryResync({
      initial,
      retrySnapshot: async () => retry,
      run: async function* (current) {
        seen.push(current);
        if (current === initial) {
          yield { kind: 'turn.usage' };
          yield { kind: 'error', error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE } };
          yield { kind: 'turn.done', reason: 'error' };
          return;
        }
        yield { kind: 'message.delta', role: 'assistant', text: 'resumed' };
        yield { kind: 'turn.done', reason: 'stop' };
      },
    }));

    expect(seen).toEqual([initial, retry]);
    expect(events).toEqual([
      { kind: 'message.delta', role: 'assistant', text: 'resumed' },
      { kind: 'turn.done', reason: 'stop' },
    ]);
  });

  test('never retries after model-visible output', async () => {
    const initial = request('none');
    let retries = 0;
    const events = await collect(runWithHistoryResync({
      initial,
      retrySnapshot: async () => { retries += 1; return request('snapshot'); },
      run: async function* () {
        yield { kind: 'message.delta', role: 'assistant', text: 'already started' };
        yield { kind: 'error', error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE } };
        yield { kind: 'turn.done', reason: 'error' };
      },
    }));

    expect(retries).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['message.delta', 'error', 'turn.done']);
  });

  test('never retries after a non-bare usage frame', async () => {
    const initial = request('none');
    let retries = 0;
    const events = await collect(runWithHistoryResync({
      initial,
      retrySnapshot: async () => { retries += 1; return request('snapshot'); },
      run: async function* () {
        yield { kind: 'turn.usage', inputTokens: 12 };
        yield { kind: 'error', error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE } };
        yield { kind: 'turn.done', reason: 'error' };
      },
    }));

    expect(retries).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
  });

  test('forwards a second-attempt sentinel instead of retrying indefinitely', async () => {
    const initial = request('none');
    const retry = request('snapshot');
    let retries = 0;
    const events = await collect(runWithHistoryResync({
      initial,
      retrySnapshot: async () => { retries += 1; return retry; },
      run: async function* (current) {
        yield { kind: 'turn.usage' };
        yield { kind: 'error', error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE } };
        yield { kind: 'turn.done', reason: 'error' };
        void current;
      },
    }));

    expect(retries).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
  });

  test('preserves a malformed sentinel followed by substantive output and terminal done', async () => {
    const initial = request('none');
    let retries = 0;
    const events = await collect(runWithHistoryResync({
      initial,
      retrySnapshot: async () => { retries += 1; return request('snapshot'); },
      run: async function* () {
        yield { kind: 'turn.usage' };
        yield { kind: 'error', error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE } };
        yield { kind: 'message.delta', role: 'assistant', text: 'unexpected output' };
        yield { kind: 'turn.done', reason: 'error' };
      },
    }));

    expect(retries).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['turn.usage', 'error', 'message.delta', 'turn.done']);
  });

  test('does not drop a bare usage frame when a malformed stream ends before a terminal event', async () => {
    const events = await collect(runWithHistoryResync({
      initial: request('none'),
      retrySnapshot: async () => request('snapshot'),
      run: async function* () { yield { kind: 'turn.usage' }; },
    }));

    expect(events).toEqual([{ kind: 'turn.usage' }]);
  });
});
