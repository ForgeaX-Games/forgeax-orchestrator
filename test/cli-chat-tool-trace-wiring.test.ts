/** 接线钉子:CLI 桥这条路真的把工具事件交给了 tracer,并且**信封没流出去**。
 *
 *  单元测试只能证明 `readToolExecutionId` / `unwrapMcpResultEnvelope` 这两个函数
 *  自己是对的 —— 证明不了两个执行口真的调了它们。而本工作流反复栽的恰恰是这一层:
 *  护栏写好了、只装在一个执行口(B3 咽喉改道 / kernel.turn 漏 CLI 桥 / MAJOR-1 收口
 *  漏 CLI 桥,三次)。所以这里驱动**真实路由**,一次钉住两件事:
 *    ① 连接键从工具结果里被取出来,进了 tool span 的 attrs;
 *    ② 传输层信封在发给前端之前被剥掉 —— 前端 store 只认字符串 result
 *       (`typeof result === 'string' ? … : undefined`),信封流出去,工具卡正文就整段消失。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AgentKernel, KernelEvent, TurnRequest } from '@forgeax/agent-runtime';
import { registerKernel } from '@forgeax/agent-runtime';
import type { TelemetryRecord } from '@forgeax/types';
import { createCliRouter } from '../src/api/cli/chat';
import { setHostTelemetry } from '../src/kernel/host-telemetry';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';

const KERNEL_ID = 'fake-trace-kernel';
/** 工具真正说的那句话。剥完信封应当逐字等于它。 */
const TOOL_TEXT = '{"ok":true,"visible_change":true}';

/** 只实现路由用得到的那几个成员;其余按接口补最小面。 */
function fakeKernel(events: KernelEvent[]): AgentKernel {
  return {
    id: KERNEL_ID as AgentKernel['id'],
    capabilities: {} as AgentKernel['capabilities'],
    async *runTurn(_req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
      for (const e of events) {
        if (signal.aborted) return;
        yield e;
      }
    },
    openHandle: () => ({ cancel: async () => {} }) as ReturnType<AgentKernel['openHandle']>,
    probe: async () => ({ ok: true }) as Awaited<ReturnType<AgentKernel['probe']>>,
  };
}

let app: Hono;
let root: string;
let telemetry: TelemetryRecord[];
let savedKernelEnv: string | undefined;
let savedProjectRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fx-trace-wiring-'));
  savedKernelEnv = process.env.FORGEAX_KERNEL;
  savedProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_KERNEL = 'kernel';
  process.env.FORGEAX_PROJECT_ROOT = root;
  resetPathManager();
  initPathManager({ userRoot: root });
  telemetry = [];
  setHostTelemetry((_sid, records) => { telemetry.push(...records); });
  registerKernel(fakeKernel([
    { kind: 'tool.call', callId: 'call_real', name: 'mcp__fxt__editor_ui_browse', args: {} },
    {
      kind: 'tool.result',
      callId: 'call_real',
      ok: true,
      // 这就是 codex app-server 适配层规范化后的形状(extractMcpResult)。
      result: { text: TOOL_TEXT, structuredContent: { forgeax: { toolExecutionId: 'fxt-wired-1' } } },
    },
    { kind: 'turn.usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'turn.done', reason: 'stop' },
  ] as KernelEvent[]));
  app = new Hono().route('/api/cli', createCliRouter());
});

afterEach(() => {
  setHostTelemetry(null);
  resetPathManager();
  if (savedKernelEnv === undefined) delete process.env.FORGEAX_KERNEL; else process.env.FORGEAX_KERNEL = savedKernelEnv;
  if (savedProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT; else process.env.FORGEAX_PROJECT_ROOT = savedProjectRoot;
  rmSync(root, { recursive: true, force: true });
});

async function runTurn(): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const res = await app.request('/api/cli/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', agentId: 'forge', providerOverride: KERNEL_ID }),
  });
  const text = await res.text();
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  let event = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      try { out.push({ event, data: JSON.parse(line.slice(5).trim()) as Record<string, unknown> }); } catch { /* 非 JSON 帧忽略 */ }
    }
  }
  return out;
}

describe('CLI 桥:工具事件 → tracer,信封不出墙', () => {
  test('连接键进了 tool span 的 attrs', async () => {
    await runTurn();
    const toolSpans = telemetry.filter((r) => {
      const s = r as unknown as Record<string, unknown>;
      return s.kind === 'span' && s.name === 'tool' && s.endTs !== undefined;
    }) as unknown as Array<Record<string, unknown>>;
    expect(toolSpans).toHaveLength(1);
    const attrs = toolSpans[0]!.attrs as Record<string, unknown>;
    // 内核铸的 callId 与 shim 自铸的执行 id 并存,两个键都在、且互不冒充。
    expect(attrs.callId).toBe('call_real');
    expect(attrs.toolExecutionId).toBe('fxt-wired-1');
  });

  test('发给前端的 tool-result 是字符串正文,不是信封', async () => {
    const frames = await runTurn();
    const toolResult = frames.find((f) => f.event === 'tool-result');
    expect(toolResult).toBeDefined();
    // 前端只认字符串;这里若是对象,工具卡的正文会整段消失。
    expect(typeof toolResult!.data.result).toBe('string');
    expect(toolResult!.data.result).toBe(TOOL_TEXT);
    // 内部连接键不该出现在发往前端的载荷里。
    expect(JSON.stringify(toolResult!.data)).not.toContain('fxt-wired-1');
    expect(JSON.stringify(toolResult!.data)).not.toContain('structuredContent');
  });
});
