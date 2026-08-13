import { describe, expect, test } from 'bun:test';
import type { PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import {
  createKimiAcpMapperState,
  kimiAcpStopReason,
  mapKimiAcpPromptResponse,
  mapKimiAcpUpdate,
  permissionCallFromAcp,
  selectKimiPermissionOption,
} from '../src/kernel/kimi-acp-mapper';

function map(update: SessionUpdate) {
  return mapKimiAcpUpdate(update, createKimiAcpMapperState());
}

describe('kimi-acp-mapper', () => {
  test('maps assistant and thought text chunks', () => {
    expect(map({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    })).toEqual([{ kind: 'message.delta', role: 'assistant', text: 'hello' }]);
    expect(map({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    })).toEqual([{ kind: 'thinking.delta', text: 'hmm' }]);
  });

  test('ignores non-text and unknown updates', () => {
    expect(map({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'x', mimeType: 'image/png' },
    })).toEqual([]);
    expect(map({
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    })).toEqual([]);
  });

  test('emits one tool.call and one successful tool.result', () => {
    const state = createKimiAcpMapperState();
    const started = mapKimiAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: '1:tc',
      title: 'Bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    }, state);
    const duplicate = mapKimiAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tc',
      title: 'Bash',
      status: 'in_progress',
    }, state);
    const done = mapKimiAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tc',
      status: 'completed',
      rawOutput: 'a.txt',
    }, state);
    expect(started).toEqual([
      { kind: 'tool.call', callId: '1:tc', name: 'bash', rawName: 'Bash', args: { command: 'ls' } },
    ]);
    expect(duplicate).toEqual([]);
    expect(done).toEqual([
      { kind: 'tool.result', callId: '1:tc', name: 'bash', rawName: 'Bash', ok: true, result: 'a.txt' },
    ]);
  });

  test('recovers tool args from ACP content when rawInput is omitted', () => {
    const state = createKimiAcpMapperState();
    expect(mapKimiAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: '1:bash',
      title: 'Run printf',
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: '{"command":"printf ok"}' } }],
    }, state)).toEqual([
      { kind: 'tool.call', callId: '1:bash', name: 'bash', rawName: 'Bash', args: { command: 'printf ok' } },
    ]);
  });

  test('preserves MCP capability names exposed through the ACP title', () => {
    const state = createKimiAcpMapperState();
    expect(mapKimiAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: '1:todo',
      title: 'mcp__fxt__todo_write',
      status: 'completed',
      rawInput: { todos: [] },
      rawOutput: { ok: true },
    }, state)).toEqual([
      { kind: 'tool.call', callId: '1:todo', name: 'todo_write', rawName: 'mcp__fxt__todo_write', args: { todos: [] } },
      { kind: 'tool.result', callId: '1:todo', name: 'todo_write', rawName: 'mcp__fxt__todo_write', ok: true, result: { ok: true } },
    ]);
  });

  test('terminal update before create degrades to a call then failed result', () => {
    const state = createKimiAcpMapperState();
    expect(mapKimiAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: '2:tc',
      title: 'Edit',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'denied' } }],
    }, state)).toEqual([
      { kind: 'tool.call', callId: '2:tc', name: 'edit_file', rawName: 'Edit', args: { input: 'denied' } },
      {
        kind: 'tool.result',
        callId: '2:tc',
        name: 'edit_file',
        rawName: 'Edit',
        ok: false,
        error: 'denied',
      },
    ]);
  });

  test('maps usage before terminal event and preserves cache fields', () => {
    const out = mapKimiAcpPromptResponse({
      stopReason: 'end_turn',
      usage: {
        totalTokens: 17,
        inputTokens: 10,
        outputTokens: 7,
        cachedReadTokens: 3,
        cachedWriteTokens: 2,
      },
    });
    expect(out).toEqual([
      { kind: 'turn.usage', inputTokens: 10, outputTokens: 7, cacheRead: 3, cacheCreation: 2 },
      { kind: 'turn.done', reason: 'stop' },
    ]);
  });

  test('maps all ACP stop reasons', () => {
    const cases: Array<[PromptResponse['stopReason'], string]> = [
      ['end_turn', 'stop'],
      ['max_tokens', 'max_tokens'],
      ['max_turn_requests', 'max_turns'],
      ['cancelled', 'cancelled'],
      ['refusal', 'error'],
    ];
    for (const [input, expected] of cases) {
      expect(String(kimiAcpStopReason(input))).toBe(expected);
    }
  });

  test('maps permission request and selects safe matching option', () => {
    const request = {
      sessionId: 's',
      toolCall: { toolCallId: 'tc', title: 'Bash', rawInput: { command: 'pwd' } },
      options: [
        { optionId: 'yes', name: 'Approve once', kind: 'allow_once' as const },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
      ],
    };
    expect(permissionCallFromAcp(request)).toEqual({ name: 'Bash', args: { command: 'pwd' } });
    expect(selectKimiPermissionOption(request.options, { behavior: 'allow' })).toBe('yes');
    expect(selectKimiPermissionOption(request.options, { behavior: 'deny', message: 'no' })).toBe('no');
    expect(selectKimiPermissionOption([], { behavior: 'allow' })).toBeNull();
  });
});
