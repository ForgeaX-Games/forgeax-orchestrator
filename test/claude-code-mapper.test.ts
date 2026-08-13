import { describe, expect, test } from 'bun:test';
import {
  createClaudeMapperState,
  mapClaudeEvent,
  type ClaudeRawEvent,
} from '../src/cli-providers/shared/claude-code-mapper';
import { chatEventToKernel } from '../src/kernel/cc-profile';

describe('claude-code-mapper tool names', () => {
  test('marks raw Claude thinking as private instead of exposing it as a public process summary', () => {
    const state = createClaudeMapperState();
    const [thinking] = mapClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'private chain of thought' },
      },
    } as ClaudeRawEvent, state);
    expect(thinking).toEqual({
      type: 'thinking',
      text: 'private chain of thought',
      visibility: 'private_reasoning',
    });
    expect([...chatEventToKernel(thinking!)]).toEqual([{
      kind: 'thinking.delta',
      text: 'private chain of thought',
      visibility: 'private_reasoning',
    }]);
  });

  test('canonicalizes tool.call and matching tool.result while retaining rawName', () => {
    const state = createClaudeMapperState();
    const call = mapClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tc1', name: 'TodoWrite' },
      },
    } as ClaudeRawEvent, state);
    const args = mapClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"todos":[]}' },
      },
    } as ClaudeRawEvent, state);
    const completed = mapClaudeEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    } as ClaudeRawEvent, state);
    const result = mapClaudeEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'ok' }],
      },
    } as ClaudeRawEvent, state);

    expect(call).toEqual([]);
    expect(args).toEqual([{
      type: 'tool-call-delta',
      callId: 'tc1',
      name: 'todo_write',
      rawName: 'TodoWrite',
      argumentsDelta: '{"todos":[]}',
    }]);
    expect(completed).toEqual([{
      type: 'tool-call',
      callId: 'tc1',
      name: 'todo_write',
      rawName: 'TodoWrite',
      args: { todos: [] },
    }]);
    expect(result).toEqual([{
      type: 'tool-result',
      callId: 'tc1',
      name: 'todo_write',
      rawName: 'TodoWrite',
      ok: true,
      result: 'ok',
    }]);
  });

  test('routes an fxt MCP delivery tool through the canonical kernel event name', () => {
    const state = createClaudeMapperState();
    mapClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'delivery-1', name: 'mcp__fxt__deliver_summary' },
      },
    } as ClaudeRawEvent, state);
    mapClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"outcome":"done","files":[]}' },
      },
    } as ClaudeRawEvent, state);
    const [completed] = mapClaudeEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    } as ClaudeRawEvent, state);

    expect([...chatEventToKernel(completed!)]).toEqual([{
      kind: 'tool.call',
      callId: 'delivery-1',
      name: 'deliver_summary',
      rawName: 'mcp__fxt__deliver_summary',
      args: { outcome: 'done', files: [] },
    }]);
  });
});
