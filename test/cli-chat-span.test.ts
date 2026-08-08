/** CLI 内核一轮的三层 span:kernel.turn → agent.run → tool。
 *
 *  2026-08-06 外审①:真实会话 0 个 span。调研结论 —— **能力与内核无关,与入口有关**:
 *  span 挂在 core/kernel-turn.ts 的 runKernelTurn 上,而模型选择器里显式选 CLI 内核
 *  (codex 等)时走 POST /api/cli/chat,那条路整条绕开。护栏/观测只装一个执行口、另一口
 *  绕开 —— 本工作流已犯过三次,所以这里钉的是"状态机只有一份、两个入口都得接"这条纪律。
 *
 *  2026-08-06 外审②:只有 kernel.turn 不够,拿不到逐调用的归属。补 agent.run + tool 两层,
 *  tool span 带内核铸的 callId,以及(经 MCP 结果回传的)shim 自铸 toolExecutionId ——
 *  后者是连到 kernel-tool-audit / ui-browse-metrics 两份旁账的唯一键。 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { TelemetryRecord } from '@forgeax/types';
import { setHostTelemetry, hostTelemetryEnabled } from '../src/kernel/host-telemetry';
import { startCliKernelTurn, readToolExecutionId, unwrapMcpResultEnvelope } from '../src/kernel/cli-kernel-trace';

afterEach(() => { setHostTelemetry(null); });

type SpanRow = Record<string, unknown>;
const spansOf = (records: TelemetryRecord[]): SpanRow[] =>
  records.filter((r) => (r as { kind?: string }).kind === 'span') as SpanRow[];
const named = (records: TelemetryRecord[], name: string): SpanRow[] =>
  spansOf(records).filter((s) => s.name === name);
/** 收口后的 final span(provisional 那条不带 endTs)。 */
const finals = (records: TelemetryRecord[], name: string): SpanRow[] =>
  named(records, name).filter((s) => s.endTs !== undefined);

describe('CLI 内核的 kernel.turn span', () => {
  it('挂在浏览器 traceparent 之下 —— parentSpanId 必须指向 ui.request', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });
    expect(hostTelemetryEnabled()).toBe(true);

    const traceId = 'a'.repeat(32);
    const parentSpanId = 'b'.repeat(16);
    const trace = startCliKernelTurn({
      kernelId: 'codex',
      agentId: 'forge',
      sid: 'sid-span',
      traceparent: `00-${traceId}-${parentSpanId}-01`,
    });
    trace.end({ ok: true, reason: 'end_turn' });

    const spans = spansOf(seen);
    expect(spans.length).toBeGreaterThan(0);
    // 同一条 trace —— 三层都在浏览器那棵树里。
    expect(spans.every((s) => s.traceId === traceId)).toBe(true);
    // kernel.turn 挂浏览器那一段之下,这就是审计要的那一跳。
    expect(named(seen, 'kernel.turn').every((s) => s.parentSpanId === parentSpanId)).toBe(true);
    // provisional 先落一条(内核卡死时留下永不收口的 span 供定位),收口再补 final。
    expect(named(seen, 'kernel.turn').some((s) => s.provisional === true)).toBe(true);
    expect(finals(seen, 'kernel.turn')).toHaveLength(1);
  });

  it('agent.run 挂在 kernel.turn 之下 —— 层级不能拍平', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' }).end({ ok: true });

    const kernelSpanId = named(seen, 'kernel.turn')[0]?.spanId;
    expect(typeof kernelSpanId).toBe('string');
    const runs = named(seen, 'agent.run');
    expect(runs.length).toBeGreaterThan(0);
    // 挂到 kernel.turn 而不是浏览器那段 —— 拍平就丢了"内核派发 vs 内核自己的循环"这层区分。
    expect(runs.every((s) => s.parentSpanId === kernelSpanId)).toBe(true);
    expect(finals(seen, 'agent.run')).toHaveLength(1);
  });

  it('没有 traceparent 时自建 root —— 绝不伪造父 id', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 'sid-root' }).end({ ok: true });

    const spans = spansOf(seen);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => typeof s.traceId === 'string' && (s.traceId as string).length === 32)).toBe(true);
    // 链少了浏览器那两段仍然成立;编一个不存在的父 id 才是错的。
    expect(named(seen, 'kernel.turn').every((s) => s.parentSpanId === undefined)).toBe(true);
  });

  it('未接 host-telemetry 出口时静默不产 —— 观测永不反噬主流程', () => {
    setHostTelemetry(null);
    expect(hostTelemetryEnabled()).toBe(false);
    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge' });
    expect(() => {
      trace.onToolCall('c1', 'editor_ui_browse');
      trace.onToolResult('c1', true, { structuredContent: { forgeax: { toolExecutionId: 'fxt-1' } } });
      trace.end({ ok: false });
    }).not.toThrow();
  });
});

describe('tool span 与跨账本连接键', () => {
  it('同一轮里两次一模一样的调用各自成 span,靠 id 一对一 —— 不靠工具名/顺序/时间戳', () => {
    // 这条正是外审的验收判据:连续两个相同的 act 必须能一对一关联。
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' });
    trace.onToolCall('call_A', 'editor_ui_browse');
    trace.onToolCall('call_B', 'editor_ui_browse');
    // 结果**乱序**回来 —— 时间戳/顺序匹配在这里就已经错了,只有 id 匹配是对的。
    trace.onToolResult('call_B', true, { text: 'ok', structuredContent: { forgeax: { toolExecutionId: 'fxt-B' } } });
    trace.onToolResult('call_A', true, { text: 'ok', structuredContent: { forgeax: { toolExecutionId: 'fxt-A' } } });
    trace.end({ ok: true });

    const tools = finals(seen, 'tool');
    expect(tools).toHaveLength(2);
    const byCall = new Map(tools.map((s) => [(s.attrs as Record<string, unknown>).callId, s]));
    expect((byCall.get('call_A')!.attrs as Record<string, unknown>).toolExecutionId).toBe('fxt-A');
    expect((byCall.get('call_B')!.attrs as Record<string, unknown>).toolExecutionId).toBe('fxt-B');
    // 两条 span 各自独立(spanId 不同),否则"一对一"只是看起来成立。
    expect(byCall.get('call_A')!.spanId).not.toBe(byCall.get('call_B')!.spanId);
    // 都挂在 agent.run 下。
    const runSpanId = named(seen, 'agent.run')[0]?.spanId;
    expect(tools.every((s) => s.parentSpanId === runSpanId)).toBe(true);
  });

  it('工具结果没带 toolExecutionId 时省略该键 —— 缺席可观察,绝不伪造', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' });
    trace.onToolCall('c1', 'Bash');
    trace.onToolResult('c1', true, 'plain text output'); // 非 MCP 工具:结果是裸字符串
    trace.end({ ok: true });

    const attrs = finals(seen, 'tool')[0]!.attrs as Record<string, unknown>;
    expect(attrs.callId).toBe('c1');
    expect('toolExecutionId' in attrs).toBe(false);
  });

  it('内核提前结束时未收口的 tool span 被收掉并标 unclosed —— 开了不收比不开更坏', () => {
    // MAJOR-1 的教训:永不收口的 span 会被当成"卡死"信号,turn 都结束了还挂着就是误报源。
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' });
    trace.onToolCall('c1', 'editor_ui_browse');
    trace.end({ ok: false, reason: 'cancelled', error: 'aborted' }); // 结果永远没回来

    const tools = finals(seen, 'tool');
    expect(tools).toHaveLength(1);
    expect((tools[0]!.attrs as Record<string, unknown>).unclosed).toBe(true);
    expect((tools[0]!.status as { code: string }).code).toBe('error');
  });

  it('同 callId 撞车必须留痕 —— 归属不可判定时不许伪装成一条可信的账', () => {
    // codex 的两个 mapper 上游按 item.id 去重(同一次调用的重复 started),合并是对的;
    // 但 cursor / kimi 的 mapper 没有唯一性保证,真撞上时结果归谁无法判定。
    // 实测 4618 次真实调用 0 次重复 → 不为它重构 id,但绝不静默合并。
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'cursor', agentId: 'forge', sid: 's' });
    trace.onToolCall('dup', 'editor_ui_browse');
    trace.onToolCall('dup', 'editor_ui_browse'); // 尚未收口时又来一条 → 撞车
    trace.onToolResult('dup', true, { text: 'ok', structuredContent: { forgeax: { toolExecutionId: 'fxt-1' } } });
    trace.end({ ok: true });

    const tools = finals(seen, 'tool');
    expect(tools).toHaveLength(1);
    expect((tools[0]!.attrs as Record<string, unknown>).callIdCollision).toBe(true);
  });

  it('重复上报只算一次:同 callId 的第二次 call 不重开,第二次 result 不重收', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' });
    trace.onToolCall('c1', 'editor_ui_browse');
    trace.onToolCall('c1', 'editor_ui_browse'); // 内核对同一 item 发了两次 started
    trace.onToolResult('c1', true, 'x');
    trace.onToolResult('c1', true, 'x');
    trace.end({ ok: true });

    expect(named(seen, 'tool').filter((s) => s.provisional === true)).toHaveLength(1);
    expect(finals(seen, 'tool')).toHaveLength(1);
  });

  it('结果先于调用到达时静默忽略 —— 不补造 span 把内核异常藏起来', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' });
    trace.onToolResult('ghost', true, 'x');
    trace.end({ ok: true });

    expect(named(seen, 'tool')).toHaveLength(0);
  });

  it('end() 幂等 —— 第二次整体 no-op', () => {
    const seen: TelemetryRecord[] = [];
    setHostTelemetry((_sid, records) => { seen.push(...records); });

    const trace = startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', sid: 's' });
    trace.end({ ok: true });
    trace.end({ ok: false, error: '不该出现' });

    expect(finals(seen, 'kernel.turn')).toHaveLength(1);
    expect(finals(seen, 'agent.run')).toHaveLength(1);
  });
});

describe('readToolExecutionId', () => {
  it('只认 result.structuredContent.toolExecutionId 这一个位置', () => {
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: 'fxt-1' } } })).toBe('fxt-1');
    // codex app-server 侧规范化后的形状(text + structuredContent 并存)。
    expect(readToolExecutionId({ text: 'ok', structuredContent: { forgeax: { toolExecutionId: 'fxt-2' } } })).toBe('fxt-2');
  });

  it('取不到就是 undefined —— 空串/非串/别的位置一律不认', () => {
    expect(readToolExecutionId(undefined)).toBeUndefined();
    expect(readToolExecutionId(null)).toBeUndefined();
    expect(readToolExecutionId('plain')).toBeUndefined();
    expect(readToolExecutionId({ toolExecutionId: 'fxt-x' })).toBeUndefined();      // 不在 structuredContent 里
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: '' } } })).toBeUndefined();
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: 42 } } })).toBeUndefined();
    expect(readToolExecutionId({ structuredContent: null })).toBeUndefined();
  });

  it('只认我们自己铸得出来的形状 —— 宁可缺席,不要假阳', () => {
    // 空白串曾能通过长度检查,变成"看着能 join、实际连不上"的键。
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: '   ' } } })).toBeUndefined();
    // fxt 还代理第三方 project-MCP server;它们结果里同名字段不能被当成我们的连接键。
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: 'exec-abc' } } })).toBeUndefined();
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: 'fxt-' } } })).toBeUndefined();
    expect(readToolExecutionId({ structuredContent: { forgeax: { toolExecutionId: '  fxt-1234  ' } } })).toBe('fxt-1234');
  });
});

describe('MCP 结果信封只活在编排层内部', () => {
  it('取完连接键就把信封剥掉 —— 否则前端工具卡的正文整段消失', () => {
    // 前端 store 明确只认字符串 result(`typeof result === 'string' ? … : undefined`),
    // 账本 / 跨内核历史桥 / 事件格式化器也各有各的读法。信封若流出去,就得有四个地方
    // 分别认识它 —— 那正是本工作流犯过四次的"第二份事实源"。
    expect(unwrapMcpResultEnvelope({ text: 'panels: []', structuredContent: { forgeax: { toolExecutionId: 'fxt-9' } } })).toBe('panels: []');
  });

  it('第三方 structuredContent 一个字段都不许动', () => {
    // 2026-08-06 外审 MAJOR-1(已复现):上一版按形状剥,把经我们代理的第三方 project-MCP
    // 的业务结构化结果降成了纯文本。`{text, structuredContent}` 这个形状不是我们独有的 ——
    // 适配层对**任何**回 structuredContent 的 MCP server 都产出它。
    const thirdParty = { text: 'ok', structuredContent: { rows: 2, cursor: 'x' } };
    expect(unwrapMcpResultEnvelope(thirdParty)).toBe(thirdParty);
    expect(readToolExecutionId(thirdParty)).toBeUndefined();
  });

  it('混了业务字段的 structuredContent 也不算独占信封', () => {
    // 只要还有别的键,这份 structuredContent 就不是我们独自拼装的 —— 剥成文本会再次销毁
    // 别人的数据。判据落在"整份只有 forgeax 一个键",而不是"能不能取到 id"。
    const mixed = { text: 'ok', structuredContent: { forgeax: { toolExecutionId: 'fxt-1' }, rows: 2 } };
    expect(unwrapMcpResultEnvelope(mixed)).toBe(mixed);
  });

  it('不是那个信封就原样返回 —— 顺手归一化会悄悄吃掉字段', () => {
    expect(unwrapMcpResultEnvelope('plain string')).toBe('plain string');
    expect(unwrapMcpResultEnvelope(undefined)).toBeUndefined();
    // 只有 text、没有 structuredContent → 不是我们造的信封,别动。
    const notEnvelope = { text: 'x', rows: 2 };
    expect(unwrapMcpResultEnvelope(notEnvelope)).toBe(notEnvelope);
    // 第三方 MCP 的 content 数组形状也不动(那是既有形状,不归这次改动处理)。
    const contentShape = { content: [{ type: 'text', text: 'y' }] };
    expect(unwrapMcpResultEnvelope(contentShape)).toBe(contentShape);
  });
});
