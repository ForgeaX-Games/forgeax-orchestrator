/**
 * LiveTurnTracker — hasAssistantOutput / thinkingOnlyEmitterIds for
 * viewer-gone abort policy (refresh mid-thinking vs mid-assistant-text).
 */
import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/core/event-bus';
import {
  hasAssistantOutput,
  LiveTurnTracker,
} from '../src/core/live-turn-tracker';

describe('hasAssistantOutput', () => {
  test('false for empty / thinking-only', () => {
    expect(hasAssistantOutput({ text: '', sealedTextLen: 0 })).toBe(false);
    expect(hasAssistantOutput({ text: '   ', sealedTextLen: 0 })).toBe(false);
  });

  test('true when streaming text or sealed text', () => {
    expect(hasAssistantOutput({ text: 'hi', sealedTextLen: 0 })).toBe(true);
    expect(hasAssistantOutput({ text: '', sealedTextLen: 3 })).toBe(true);
  });
});

describe('LiveTurnTracker.thinkingOnlyEmitterIds', () => {
  test('thinking stream alone stays thinking-only', () => {
    const bus = new EventBus();
    const tracker = new LiveTurnTracker(bus);
    bus.publish(
      { source: 'agent:forge', type: 'hook:turnStart', payload: { turn: 1 }, ts: 1 },
      'forge',
    );
    bus.publish(
      {
        source: 'agent:forge',
        type: 'stream:llm',
        payload: { chunk: { type: 'thinking', text: 'hmm' } },
        ts: 2,
      },
      'forge',
    );
    expect(tracker.thinkingOnlyEmitterIds()).toEqual(['forge']);
    expect(tracker.snapshots()[0]?.thinking).toBe('hmm');
    tracker.dispose();
  });

  test('text chunk clears thinking-only', () => {
    const bus = new EventBus();
    const tracker = new LiveTurnTracker(bus);
    bus.publish(
      { source: 'agent:forge', type: 'hook:turnStart', payload: { turn: 1 }, ts: 1 },
      'forge',
    );
    bus.publish(
      {
        source: 'agent:forge',
        type: 'stream:llm',
        payload: { chunk: { type: 'text', text: 'Hello' } },
        ts: 2,
      },
      'forge',
    );
    expect(tracker.thinkingOnlyEmitterIds()).toEqual([]);
    expect(hasAssistantOutput(tracker.snapshots()[0]!)).toBe(true);
    tracker.dispose();
  });

  test('assistantMessage seal with text clears thinking-only even if later empty pause', () => {
    const bus = new EventBus();
    const tracker = new LiveTurnTracker(bus);
    bus.publish(
      { source: 'agent:forge', type: 'hook:turnStart', payload: { turn: 1 }, ts: 1 },
      'forge',
    );
    bus.publish(
      {
        source: 'agent:forge',
        type: 'stream:llm',
        payload: { chunk: { type: 'text', text: 'step1' } },
        ts: 2,
      },
      'forge',
    );
    bus.publish(
      { source: 'agent:forge', type: 'hook:assistantMessage', payload: {}, ts: 3 },
      'forge',
    );
    expect(tracker.snapshots()[0]?.sealedTextLen).toBe(5);
    expect(tracker.thinkingOnlyEmitterIds()).toEqual([]);
    tracker.dispose();
  });

  test('sealed assistantMessage without stream text is recoverable', () => {
    const bus = new EventBus();
    const tracker = new LiveTurnTracker(bus);
    bus.publish(
      { source: 'agent:forge', type: 'hook:turnStart', payload: { turn: 1 }, ts: 1 },
      'forge',
    );
    bus.publish(
      {
        source: 'agent:forge',
        type: 'hook:assistantMessage',
        payload: {
          llmMessage: {
            role: 'assistant',
            content: [{ type: 'text', text: 'sealed reply' }],
            thinking: 'reasoning',
          },
        },
        ts: 2,
      },
      'forge',
    );
    expect(tracker.thinkingOnlyEmitterIds()).toEqual([]);
    expect(tracker.snapshots()[0]).toMatchObject({
      text: 'sealed reply',
      thinking: 'reasoning',
      sealedTextLen: 12,
      sealedThinkingLen: 9,
    });
    tracker.dispose();
  });

  test('tool activity is not treated as thinking-only', () => {
    const bus = new EventBus();
    const tracker = new LiveTurnTracker(bus);
    bus.publish(
      { source: 'agent:forge', type: 'hook:turnStart', payload: { turn: 1 }, ts: 1 },
      'forge',
    );
    bus.publish(
      {
        source: 'agent:forge',
        type: 'hook:toolCall',
        payload: { toolCall: { id: 'call-1', name: 'read_file' }, args: {} },
        ts: 2,
      },
      'forge',
    );
    expect(tracker.thinkingOnlyEmitterIds()).toEqual([]);
    tracker.dispose();
  });

  test('CLI stream tool activity is snapshotted and not aborted', () => {
    const bus = new EventBus();
    const tracker = new LiveTurnTracker(bus);
    bus.publish(
      { source: 'agent:coder', type: 'hook:turnStart', payload: { turn: 1 }, ts: 1 },
      'coder',
    );
    bus.publish(
      {
        source: 'agent:coder',
        type: 'stream:tool_use',
        payload: { toolUseId: 'cli-call', name: 'Read', input: { path: 'a.ts' } },
        ts: 2,
      },
      'coder',
    );
    bus.publish(
      {
        source: 'agent:coder',
        type: 'stream:tool_result',
        payload: { toolUseId: 'cli-call', output: 'ok', isError: false },
        ts: 3,
      },
      'coder',
    );
    expect(tracker.thinkingOnlyEmitterIds()).toEqual([]);
    expect(tracker.snapshots()[0]?.toolCalls).toEqual([
      {
        callId: 'cli-call',
        name: 'Read',
        args: { path: 'a.ts' },
        status: 'done',
      },
    ]);
    tracker.dispose();
  });
});
