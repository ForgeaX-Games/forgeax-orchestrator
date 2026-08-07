/**
 * codex-appserver 单测 —— 验证 `codex app-server` notification → 中立 KernelEvent
 * 的映射、审批 server-request 分类、push/pull 队列。app-server 子进程本身无法在 CI
 * 跑(需 codex 二进制),故锁住可纯函数验证的映射/分类/队列逻辑。
 */
import { describe, expect, test } from 'bun:test';
import {
  KernelEventQueue,
  classifyApproval,
  classifyElicitation,
  createCodexNotifState,
  mapCodexNotification,
} from '../src/kernel/codex-appserver';
import { readToolExecutionId } from '../src/kernel/cli-kernel-trace';

function drain(fn: (q: KernelEventQueue) => void) {
  const q = new KernelEventQueue();
  fn(q);
  q.end();
  return q;
}

async function collect(q: KernelEventQueue) {
  const out = [];
  for await (const ev of q) out.push(ev);
  return out;
}

describe('codex-appserver mapNotification', () => {
  test('agentMessage delta → message.delta', async () => {
    const st = createCodexNotifState();
    const q = drain((q) => mapCodexNotification('item/agentMessage/delta', { delta: 'hi' }, st, q));
    expect(await collect(q)).toEqual([{ kind: 'message.delta', role: 'assistant', text: 'hi' }]);
  });

  test('reasoning textDelta → thinking.delta', async () => {
    const st = createCodexNotifState();
    const q = drain((q) => mapCodexNotification('item/reasoning/textDelta', { delta: 'think' }, st, q));
    expect(await collect(q)).toEqual([{ kind: 'thinking.delta', text: 'think' }]);
  });

  test('commandExecution started → tool.call Bash; outputDelta + completed → tool.result', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'i1', type: 'commandExecution', command: 'ls', cwd: '/w' } }, st, q);
    mapCodexNotification('item/commandExecution/outputDelta', { itemId: 'i1', delta: 'a.txt\n' }, st, q);
    mapCodexNotification('item/completed', { item: { id: 'i1', type: 'commandExecution', status: 'completed' } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0]).toEqual({ kind: 'tool.call', callId: 'i1', name: 'Bash', args: { command: 'ls', cwd: '/w' } });
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'i1', ok: true, result: 'a.txt\n' });
  });

  test('fileChange completed failed → tool.result not ok', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'f1', type: 'fileChange', changes: [] } }, st, q);
    mapCodexNotification('item/completed', { item: { id: 'f1', type: 'fileChange', status: 'failed' } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0].kind).toBe('tool.call');
    expect((out[0] as any).name).toBe('Edit');
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'f1', ok: false, error: 'failed' });
  });

  test('tokenUsage uses current last usage, never cumulative thread total', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: {
          inputTokens: 1_316_946,
          outputTokens: 12_000,
          cachedInputTokens: 900_000,
        },
        last: {
          inputTokens: 70_000,
          outputTokens: 456,
          cachedInputTokens: 18_176,
        },
      },
    }, st, q);
    mapCodexNotification('turn/completed', {}, st, q);
    const out = await collect(q); // turn/completed calls q.end()
    expect(out[0]).toEqual({
      kind: 'turn.usage',
      inputTokens: 70_000,
      outputTokens: 456,
      cacheRead: 18_176,
    });
    expect(out[1]).toEqual({ kind: 'turn.done', reason: 'stop' });
    expect(st.ended).toBe(true);
  });

  test('cumulative-only token update is not misreported as current turn usage', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 99_999, outputTokens: 888 },
      },
    }, st, q);
    mapCodexNotification('turn/completed', {}, st, q);
    expect(await collect(q)).toEqual([
      { kind: 'turn.usage' },
      { kind: 'turn.done', reason: 'stop' },
    ]);
  });

  test('error notification → turn.usage, error, turn.done(error)', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('error', { message: 'boom' }, st, q);
    const out = await collect(q);
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect((out[1] as any).error.message).toBe('boom');
    expect((out[2] as any).reason).toBe('error');
  });

  test('new nested ErrorNotification shape preserves the real message', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('error', {
      error: { message: 'model gpt-test is not supported' },
    }, st, q);
    const out = await collect(q);
    expect((out[1] as any).error.message).toBe(
      'model gpt-test is not supported',
    );
  });

  test('unknown notification tolerated (no events)', async () => {
    const st = createCodexNotifState();
    const q = drain((q) => mapCodexNotification('some/experimental/event', { x: 1 }, st, q));
    expect(await collect(q)).toEqual([]);
  });

  test('mcpToolCall started → tool.call with mcp__server__tool name', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'm1', type: 'mcpToolCall', server: 'fxt', tool: 'echo', arguments: { text: 'hi' } } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0]).toEqual({ kind: 'tool.call', callId: 'm1', name: 'mcp__fxt__echo', args: { text: 'hi' } });
  });

  test('mcpToolCall completed → tool.result ok with extracted text result', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'm2', type: 'mcpToolCall', server: 'fxt', tool: 'echo', arguments: { text: 'x' } } }, st, q);
    mapCodexNotification('item/completed', { item: { id: 'm2', type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'text', text: '[forgeax_echo] x' }] } } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0].kind).toBe('tool.call');
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'm2', ok: true, result: '[forgeax_echo] x' });
  });

  test('mcpToolCall completed (no prior started) still emits a call then result', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/completed', { item: { id: 'm3', type: 'mcpToolCall', server: 'fxt', tool: 'list_games', status: 'completed', result: { content: [{ type: 'text', text: '{"count":0}' }] } } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out[0]).toEqual({ kind: 'tool.call', callId: 'm3', name: 'mcp__fxt__list_games', args: {} });
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'm3', ok: true, result: '{"count":0}' });
  });

  test('mcpToolCall 失败 → tool.result 不 ok,且**必须带 result**', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'm4', type: 'mcpToolCall', server: 'fxt', tool: 'boom' } }, st, q);
    mapCodexNotification('item/completed', { item: { id: 'm4', type: 'mcpToolCall', status: 'failed', error: { message: 'kaboom' } } }, st, q);
    q.end();
    const out = await collect(q);
    // 连接键就在结果里 —— 失败事件也得带 result。item 没给 result 时稳定产出空串,
    // 让下游"读不到键"是可观察的缺席,而不是根本没有这个字段可读。
    expect(out[1]).toEqual({ kind: 'tool.result', callId: 'm4', ok: false, error: 'kaboom', result: '' });
  });

  test('失败结果里的连接键必须跨过适配层 —— 失败行最有审计价值', async () => {
    // 2026-08-06 外审 MAJOR-2:宿主工具返回 error → MCP 结果 isError:true → codex 把 item
    // 标成失败。此前失败分支只 push error,于是真实 NOT_FOUND 路径永远跨不了账本。
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/completed', {
      item: {
        id: 'm9', type: 'mcpToolCall', server: 'fxt', tool: 'editor_ui_browse', status: 'failed',
        result: {
          content: [{ type: 'text', text: '{"ok":false,"error":{"code":"not_found"}}' }],
          structuredContent: { forgeax: { toolExecutionId: 'fxt-fail-1' } },
          isError: true,
        },
      },
    }, st, q);
    q.end();
    const out = await collect(q);
    const ev = out.find((c) => c.kind === 'tool.result');
    if (ev?.kind !== 'tool.result') throw new Error('缺少 tool.result 事件');
    expect(ev.ok).toBe(false);
    expect(readToolExecutionId(ev.result)).toBe('fxt-fail-1');
  });

  test('mcpToolCall preserves structuredContent alongside text', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/completed', { item: { id: 'm5', type: 'mcpToolCall', server: 'fxt', tool: 'q', status: 'completed', result: { content: [{ type: 'text', text: 't' }], structuredContent: { a: 1 } } } }, st, q);
    q.end();
    const out = await collect(q);
    const res = out.find((e) => e.kind === 'tool.result') as any;
    expect(res.result).toEqual({ text: 't', structuredContent: { a: 1 } });
  });

  test('duplicate item/started for same id emits only one tool.call', async () => {
    const st = createCodexNotifState();
    const q = new KernelEventQueue();
    mapCodexNotification('item/started', { item: { id: 'd1', type: 'mcpToolCall', server: 'fxt', tool: 'echo' } }, st, q);
    mapCodexNotification('item/started', { item: { id: 'd1', type: 'mcpToolCall', server: 'fxt', tool: 'echo' } }, st, q);
    q.end();
    const out = await collect(q);
    expect(out.filter((e) => e.kind === 'tool.call').length).toBe(1);
  });
});

describe('codex-appserver classifyElicitation', () => {
  test('mcpServer/elicitation/request → decline reply', () => {
    expect(classifyElicitation('mcpServer/elicitation/request')).toEqual({ reply: { action: 'decline' } });
  });
  test('elicitation/create → decline reply', () => {
    expect(classifyElicitation('elicitation/create')).toEqual({ reply: { action: 'decline' } });
  });
  test('non-elicitation method → null', () => {
    expect(classifyElicitation('item/started')).toBeNull();
    expect(classifyElicitation('item/commandExecution/requestApproval')).toBeNull();
  });
});

describe('codex-appserver classifyApproval', () => {
  test('v2 exec approval', () => {
    expect(classifyApproval('item/commandExecution/requestApproval')).toEqual({ tool: 'Bash', v1: false });
  });
  test('v1 exec approval', () => {
    expect(classifyApproval('execCommandApproval')).toEqual({ tool: 'Bash', v1: true });
  });
  test('v2 patch approval', () => {
    expect(classifyApproval('item/fileChange/requestApproval')).toEqual({ tool: 'Edit', v1: false });
  });
  test('v1 patch approval', () => {
    expect(classifyApproval('applyPatchApproval')).toEqual({ tool: 'Edit', v1: true });
  });
  test('non-approval → null', () => {
    expect(classifyApproval('item/started')).toBeNull();
  });
});
