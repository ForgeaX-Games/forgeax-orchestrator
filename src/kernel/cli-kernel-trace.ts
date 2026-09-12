/**
 * CLI 内核一轮的 trace —— 全链路的第 2/3/4 层(`kernel.turn` → `agent.run` → `tool`)。
 *
 * forgeax-core 的三层由 sidecar 内部产;CLI 内核(codebuddy / claude-code / codex /
 * cursor)跑在 server 进程、本身**不出 span**。这里给它们补齐同名同形的三层:
 *   - `kernel.turn` —— 我们这一次派发(compose + 起内核 + MCP 物化 + 流式收敛)。
 *     provisional 立即落盘,内核卡住就在 trace 里留下一个永不收口的 kernel.turn
 *     (挂在浏览器 `ui.request` 下),配合浏览器侧 `ui.stall` 即可定位「卡在内核」。
 *   - `agent.run`  —— 内核自己那一轮 agent 循环。
 *   - `tool`       —— 循环里的**每一次**工具调用,attrs 带内核铸的 `callId`;若工具结果
 *     经 MCP 回带了 shim 自铸的 `toolExecutionId`,一并记上 —— 那是连到
 *     `kernel-tool-audit` / `ui-browse-metrics` 两份旁账的唯一键(codex 的 callId
 *     结构上不过 MCP,只能靠结果回传的自铸 id 反向绑)。
 * parent:浏览器 `ui.request` 的 W3C traceparent(无则自建 root,形成独立 trace)。
 *
 * **为什么三层逻辑全写在这一个模块里**:本工作流已经三次栽在「护栏/观测只装在一个
 * 执行口,产品实际走另一口」(B3 咽喉改道 / kernel.turn 漏 CLI 桥 / MAJOR-1 收口漏 CLI 桥)。
 * 状态机只存在一份,两个执行口(core/kernel-turn.ts 与 api/cli/chat.ts)各自只调方法,
 * 从结构上消除「两口不同步」这一类。
 */
import { randomUUID } from 'node:crypto';
import type { TelemetryRecord } from '@forgeax/types';
import { emitHostTelemetry } from './host-telemetry';

/** 8-byte span id(16 hex):randomUUID 去横线取前 16。 */
function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}
/** 16-byte trace id(32 hex):拼两个 randomUUID 取前 32。 */
function newTraceId(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 32);
}

/** Keep correlation values bounded and opaque; never put request content in telemetry. */
function safeOpaqueId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : fallback;
}

export type ChildTaskStatus = 'ok' | 'error' | 'unknown';

/** Classify only documented terminal reasons; all other provider reasons stay unknown. */
export function classifyChildTaskStatus(reason: unknown): ChildTaskStatus {
  if (reason === 'completed' || reason === 'done' || reason === 'stop') return 'ok';
  if (reason === 'error' || reason === 'failed' || reason === 'cancelled' || reason === 'timeout') return 'error';
  return 'unknown';
}

/** 解析 W3C traceparent(`00-<32hex>-<16hex>-<2hex>`)→ {traceId, spanId};非法/全零 → undefined。 */
function parseTraceparent(tp: string | undefined): { traceId: string; spanId: string } | undefined {
  if (!tp) return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(tp.trim());
  if (!m) return undefined;
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2] };
}

function emitSafely(sid: string | undefined, records: TelemetryRecord[]): void {
  try {
    emitHostTelemetry(sid, records);
  } catch {
    /* 可观测性永不反噬主流程 */
  }
}

/**
 * 从一条工具结果里读出 shim 自铸的 `toolExecutionId`。
 *
 * 只认一个位置:`result.structuredContent.toolExecutionId`。MCP 的
 * `structuredContent` 是内核逐字回传的(实证:本机 codex rollout 里 2811 次真实回传,
 * 其中 1873 次来自一个**根本没声明 outputSchema** 的 server → 不需要 outputSchema)。
 * 取不到就**返回 undefined、上游不带这个键** —— 消费方据「有没有这个键」判断能不能 join,
 * 写空串会让它以为能 join 然后连到错的地方。
 */
export function readToolExecutionId(result: unknown): string | undefined {
  try {
    if (typeof result !== 'object' || result === null) return undefined;
    const structured = (result as Record<string, unknown>).structuredContent;
    if (typeof structured !== 'object' || structured === null) return undefined;
    // 自铸内容住在我们独占的 `forgeax` 命名空间里 —— 认协议,不猜形状。
    const forgeax = (structured as Record<string, unknown>).forgeax;
    if (typeof forgeax !== 'object' || forgeax === null) return undefined;
    const value = (forgeax as Record<string, unknown>).toolExecutionId;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    // 必须是**我们自己铸得出来**的形状。空白串曾能通过长度检查,变成一个"看着能 join、
    // 实际连不上"的键 —— 假阳比缺席更危险。
    return trimmed.startsWith('fxt-') && trimmed.length > 4 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 剥掉 MCP 结果信封,还原成工具真正说的那句话。
 *
 * `extractMcpResult` 在内核适配层把带 structuredContent 的 MCP 结果规范化成
 * `{text, structuredContent}`。structuredContent 装的是**传输层元数据**(连接键),
 * 不该继续往下走:下游有四处消费工具结果 —— SSE 工具卡、账本、跨内核历史桥、事件
 * 格式化器,其中 `store.ts` 明确只认字符串(`typeof result === 'string' ? … : undefined`),
 * 信封一进去,工具卡的正文就整段消失。
 *
 * 所以信封只在「适配层 → 本模块」这一小段存在:`readToolExecutionId` 取走连接键
 * (它的归宿是 span attrs),这里把正文还回去。**只此一份** —— 让四个下游各自去认
 * 信封,就是这个工作流已经犯过四次的「第二份事实源」。
 */
export function unwrapMcpResultEnvelope(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const r = result as Record<string, unknown>;
  if (typeof r.text !== 'string') return result;
  const structured = r.structuredContent;
  if (typeof structured !== 'object' || structured === null) return result;
  // `{text, structuredContent}` 这个形状**不是我们独有的** —— 适配层对任何回了
  // structuredContent 的 MCP server 都产出它,包括经 fxt 代理的第三方 project-MCP
  // (它们的 structuredContent 装的是**真业务数据**)。上一版按形状剥,把第三方的业务
  // 结果剥成了纯文本(2026-08-06 外审 MAJOR-1,已复现)。
  // 判据落在我们独占的命名空间上:整份 structuredContent **只有 `forgeax` 一个键**
  // (还有别的键 = 第三方的结果,一个字段都不许动),且里面确有可连接的 id。
  const keys = Object.keys(structured as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'forgeax') return result;
  if (!readToolExecutionId(result)) return result;
  return r.text;
}

interface ToolSpanState {
  spanId: string;
  startTs: number;
  name: string;
  closed: boolean;
  /** 同一个 callId 被当作**两次不同调用**上报过。见 onToolCall 的注释。 */
  collided: boolean;
}

type PhaseName =
  | 'request.prepare'
  | 'model.first_token'
  | 'model.generation'
  | 'authorization.wait'
  | 'child.wait';

interface PhaseSpanState {
  spanId: string;
  parentSpanId: string;
  name: PhaseName;
  startTs: number;
  attrs: Record<string, unknown>;
  closed: boolean;
  /** A child lifecycle can outlive the tool call that announced it. */
  childId?: string;
}

function phaseStartRecord(
  context: Record<string, unknown>,
  state: PhaseSpanState,
): TelemetryRecord {
  return {
    kind: 'span',
    ...context,
    spanId: state.spanId,
    parentSpanId: state.parentSpanId,
    name: state.name,
    startTs: state.startTs,
    provisional: true,
    attrs: {
      ...state.attrs,
      phase: state.name,
      availability: 'pending',
    },
  } as unknown as TelemetryRecord;
}

function phaseFinalRecord(
  context: Record<string, unknown>,
  state: PhaseSpanState,
  endTs: number,
  availability: 'measured' | 'unknown',
  extraAttrs: Record<string, unknown> = {},
  status?: { code: 'ok' | 'error'; message?: string },
): TelemetryRecord {
  const attrs = {
    ...state.attrs,
    ...extraAttrs,
    phase: state.name,
    availability,
    ...(availability === 'measured'
      ? { durationMs: Math.max(0, endTs - state.startTs) }
      : {}),
  };
  return {
    kind: 'span',
    ...context,
    spanId: state.spanId,
    parentSpanId: state.parentSpanId,
    name: state.name,
    startTs: state.startTs,
    endTs,
    ...(status ? { status } : {}),
    attrs,
  } as unknown as TelemetryRecord;
}

function phaseState(
  name: PhaseName,
  parentSpanId: string,
  startTs: number,
  attrs: Record<string, unknown>,
  childId?: string,
): PhaseSpanState {
  return {
    spanId: newSpanId(),
    parentSpanId,
    name,
    startTs,
    attrs,
    closed: false,
    ...(childId ? { childId } : {}),
  };
}

export interface CliKernelTurnTrace {
  /** Composition/history/tool materialization finished and the request is ready to send. */
  onRequestReady(request?: {
    model?: unknown;
    reasoningEffort?: unknown;
    reasoningSupport?: unknown;
  }): void;
  /** First provider text/reasoning token. Tool calls do not count as a token. */
  onFirstToken(kind: 'text' | 'thinking'): void;
  /** 内核报了一次工具调用 → 开一条 `tool` span(挂 agent.run 下),provisional 立即落盘。
   *  `callId` 是**内核自己铸**的调用 id(codex 上形如 `call_…` 或 `exec-…`,视执行面而定;
   *  不要对前缀做任何假设)。同一 callId 重复上报只开一次。 */
  onToolCall(callId: string, name: string): void;
  /** 该调用的结果 → 收口对应 `tool` span,并把结果里带回的 toolExecutionId 记进 attrs。 */
  onToolResult(callId: string, ok: boolean, result?: unknown, error?: string): void;
  /** Runtime child lifecycle. These events are optional; no child duration is guessed when absent. */
  onChildTaskStart(childId: string): void;
  onChildTaskEnd(childId: string, status: ChildTaskStatus, reason?: string): void;
  /** 收尾:先收未收口的 tool span,再收 agent.run,最后收 kernel.turn。 */
  end(o: {
    ok: boolean;
    reason?: string;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
    error?: string;
  }): void;
}

/** 起一轮 CLI 内核的 trace(kernel.turn + agent.run 的 provisional **立即落盘**)。 */
export function startCliKernelTurn(o: {
  kernelId: string;
  agentId: string;
  sid?: string;
  traceparent?: string;
  /** Stable opaque request identity; generated when the caller has none. */
  requestId?: string;
  /** Stable opaque turn identity; generated from requestId when omitted. */
  turnId?: string;
}): CliKernelTurnTrace {
  const parent = parseTraceparent(o.traceparent);
  const traceId = parent?.traceId ?? newTraceId();
  const kernelSpanId = newSpanId();
  const agentSpanId = newSpanId();
  const startTs = Date.now();
  const context = { traceId, ...(o.sid ? { sid: o.sid } : {}), agentId: o.agentId };
  const requestId = safeOpaqueId(o.requestId, `req-${randomUUID()}`);
  const turnId = safeOpaqueId(o.turnId, requestId);
  const correlation = { requestId, turnId, sessionId: o.sid ?? 'unknown' };
  const kernelBase = {
    ...context,
    spanId: kernelSpanId,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name: 'kernel.turn',
  };
  const agentBase = { ...context, spanId: agentSpanId, parentSpanId: kernelSpanId, name: 'agent.run' };
  const tools = new Map<string, ToolSpanState>();
  const childWaits = new Map<string, PhaseSpanState>();
  const requestPreparation = phaseState('request.prepare', kernelSpanId, startTs, correlation);
  let requestReadyAt: number | undefined;
  let firstToken: PhaseSpanState | undefined;
  let firstTokenObserved = false;
  let generation: PhaseSpanState | undefined;
  let generationObserved = false;
  let lastOutputAt: number | undefined;
  let requestModel = 'unknown';
  let requestReasoningEffort = 'unknown';
  let requestReasoningSupport = 'unknown';
  let ended = false;

  const emitPhaseStart = (state: PhaseSpanState): void => {
    emitSafely(o.sid, [phaseStartRecord(context, state)]);
  };

  const closePhase = (
    state: PhaseSpanState | undefined,
    endTs: number,
    availability: 'measured' | 'unknown',
    extraAttrs: Record<string, unknown> = {},
    status?: { code: 'ok' | 'error'; message?: string },
  ): void => {
    if (!state || state.closed) return;
    state.closed = true;
    emitSafely(o.sid, [phaseFinalRecord(context, state, endTs, availability, extraAttrs, status)]);
  };

  const unknownPhase = (
    name: PhaseName,
    parentSpanId: string,
    start: number,
    unknownReason: string,
  ): void => {
    const state = phaseState(name, parentSpanId, start, correlation);
    emitPhaseStart(state);
    closePhase(state, Date.now(), 'unknown', { unknownReason });
  };

  const ensureRequestReady = (): void => {
    if (requestReadyAt !== undefined) return;
    const now = Date.now();
    closePhase(requestPreparation, now, 'unknown', {
      unknownReason: 'request_ready_not_observed',
      readiness: 'inferred_from_provider_event',
      requestModel,
      reasoningEffort: requestReasoningEffort,
      reasoningSupport: requestReasoningSupport,
    });
    requestReadyAt = now;
    firstToken = phaseState('model.first_token', agentSpanId, now, {
      ...correlation,
      requestModel,
      reasoningEffort: requestReasoningEffort,
      reasoningSupport: requestReasoningSupport,
    });
    emitPhaseStart(firstToken);
  };

  const noteModelEvent = (kind: 'text' | 'thinking' | 'tool_call'): void => {
    if (ended) return;
    ensureRequestReady();
    const now = Date.now();
    if (kind !== 'tool_call') lastOutputAt = now;
    if ((kind === 'text' || kind === 'thinking') && !firstTokenObserved) {
      firstTokenObserved = true;
      closePhase(firstToken, now, requestPreparation.attrs.explicitReady === true ? 'measured' : 'unknown', { firstTokenKind: kind });
    }
    if (!generation && kind !== 'tool_call') {
      generationObserved = true;
      generation = phaseState('model.generation', agentSpanId, now, {
        ...correlation,
        outputKind: kind,
      });
      emitPhaseStart(generation);
    }
    // A tool call is the end of this model-output burst. The next model burst
    // starts only after the tool result, so tool execution is never hidden
    // inside a long generation bar.
    if (kind === 'tool_call') {
      closePhase(generation, lastOutputAt ?? now, 'measured', { observation: 'first_to_last_output_event' });
      generation = undefined;
    }
  };

  emitSafely(o.sid, [phaseStartRecord(context, requestPreparation)]);

  emitSafely(o.sid, [
    {
      kind: 'span',
      ...kernelBase,
      startTs,
      provisional: true,
      attrs: { kernel: o.kernelId, ...correlation },
    } as TelemetryRecord,
    {
      kind: 'log',
      ts: startTs,
      level: 'info',
      msg: 'kernel.turn start',
      fields: { kernel: o.kernelId, ...correlation },
      ...context,
      spanId: kernelSpanId,
    } as TelemetryRecord,
    {
      kind: 'span',
      ...agentBase,
      startTs,
      provisional: true,
      attrs: { agentType: o.agentId, kernel: o.kernelId, ...correlation },
    } as TelemetryRecord,
  ]);

  return {
    onRequestReady(request): void {
      try {
        if (ended || requestReadyAt !== undefined) return;
        if (typeof request?.model === 'string' && request.model.trim()) {
          requestModel = request.model.trim().slice(0, 256);
        }
        if (request && Object.prototype.hasOwnProperty.call(request, 'reasoningEffort')) {
          requestReasoningEffort = typeof request.reasoningEffort === 'string'
            ? request.reasoningEffort.trim().slice(0, 32) || 'unknown'
            : request.reasoningEffort == null ? 'disabled' : 'unknown';
        }
        if (request && Object.prototype.hasOwnProperty.call(request, 'reasoningSupport')) {
          requestReasoningSupport = typeof request.reasoningSupport === 'string'
            ? request.reasoningSupport.trim().slice(0, 32) || 'unknown'
            : typeof request.reasoningSupport === 'boolean'
              ? request.reasoningSupport ? 'supported' : 'unsupported'
              : 'unknown';
        }
        const now = Date.now();
        requestPreparation.attrs.explicitReady = true;
        closePhase(requestPreparation, now, 'measured', {
          readiness: 'request_ready',
          requestModel,
          reasoningEffort: requestReasoningEffort,
          reasoningSupport: requestReasoningSupport,
        });
        requestReadyAt = now;
        firstToken = phaseState('model.first_token', agentSpanId, now, {
          ...correlation,
          requestModel,
          reasoningEffort: requestReasoningEffort,
          reasoningSupport: requestReasoningSupport,
        });
        emitPhaseStart(firstToken);
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },

    onFirstToken(kind): void {
      try {
        if (ended) return;
        noteModelEvent(kind);
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },

    onToolCall(callId, name): void {
      try {
        // 收口之后来的调用不再开新 span —— 那条 span 永远等不到 end() 去收它。
        if (ended) return;
        noteModelEvent('tool_call');
        const existing = tools.get(callId);
        if (existing) {
          // 同 callId 重复上报。**正常情况**是内核对同一 item 发了多次 started(codex 的两个
          // mapper 上游就按 item.id 去重),那就是同一次调用,合并是对的。
          // **异常情况**是两次不同的执行撞了同一个 callId(cursor / kimi 的 mapper 没有唯一性
          // 保证)—— 那时结果归谁**根本无法判定**,合并会把 B 的 toolExecutionId 挂到 A 上。
          // 实测 4618 次真实调用 0 次重复,所以不为它重构 id(那会引入第三个 id,还违反
          // 「span 必须带内核真实 callId」);但**绝不静默合并** —— 标记出来,让不可判定
          // 变成可观察,而不是变成一条看着可信的错账。
          if (!existing.closed) existing.collided = true;
          return;
        }
        const state: ToolSpanState = {
          spanId: newSpanId(),
          startTs: Date.now(),
          name,
          closed: false,
          collided: false,
        };
        // Tool names do not prove authorization waits. The permission
        // side-channel is not observed by this tracer yet.
        tools.set(callId, state);
        const records: TelemetryRecord[] = [
          {
            kind: 'span',
            ...context,
            spanId: state.spanId,
            parentSpanId: agentSpanId,
            name: 'tool',
            startTs: state.startTs,
            provisional: true,
            attrs: {
              ...correlation,
              tool: name,
              callId,
              phase: 'tool.execution',
              availability: 'pending',
            },
          } as TelemetryRecord,
        ];
        emitSafely(o.sid, records);
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },

    onToolResult(callId, ok, result, error): void {
      try {
        if (ended) return;
        const state = tools.get(callId);
        // 结果没有对应的调用 —— **不补造** span。凭空补一条会把「内核发了个我们没见过的
        // 结果」这件事藏起来;留成可观察的缺席,才查得出来。
        if (!state || state.closed) return;
        state.closed = true;
        const endTs = Date.now();
        const toolExecutionId = readToolExecutionId(result);
        emitSafely(o.sid, [
          {
            kind: 'span',
            ...context,
            spanId: state.spanId,
            parentSpanId: agentSpanId,
            name: 'tool',
            startTs: state.startTs,
            endTs,
            status: ok ? { code: 'ok' } : { code: 'error', ...(error ? { message: error } : {}) },
            attrs: {
              ...correlation,
              tool: state.name,
              callId,
              phase: 'tool.execution',
              availability: 'measured',
              durationMs: Math.max(0, endTs - state.startTs),
              observation: 'tool_call_to_result_including_unobserved_waits',
              ...(toolExecutionId ? { toolExecutionId } : {}),
              // 撞过 callId → 这一行的归属不可判定,别把它当可信证据用。
              ...(state.collided ? { callIdCollision: true } : {}),
            },
          } as TelemetryRecord,
        ]);
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },

    onChildTaskStart(childId): void {
      try {
        if (ended) return;
        const id = safeOpaqueId(childId, `child-${childWaits.size + 1}`);
        if (childWaits.has(id)) return;
        const state = phaseState('child.wait', agentSpanId, Date.now(), {
          ...correlation,
          childId: id,
        }, id);
        childWaits.set(id, state);
        emitPhaseStart(state);
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },

    onChildTaskEnd(childId, status, reason): void {
      try {
        if (ended) return;
        const id = safeOpaqueId(childId, '');
        const state = childWaits.get(id);
        if (!state) return;
        closePhase(
          state,
          Date.now(),
          'unknown',
          { unknownReason: 'child_lifecycle_does_not_prove_parent_wait', outcome: status },
          status === 'ok' ? { code: 'ok' } : status === 'error' ? { code: 'error' } : undefined,
        );
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },

    end(e): void {
      try {
        if (ended) return;
        ended = true;
        const endTs = Date.now();

        unknownPhase('authorization.wait', agentSpanId, startTs, 'authorization_lifecycle_not_observed');
        if (childWaits.size === 0) {
          unknownPhase('child.wait', agentSpanId, startTs, 'parent_wait_not_observed');
        }
        if (!requestPreparation.closed) {
          closePhase(requestPreparation, endTs, 'unknown', {
            unknownReason: 'request_not_ready',
            requestModel,
            reasoningEffort: requestReasoningEffort,
            reasoningSupport: requestReasoningSupport,
          });
        }
        if (!firstToken) {
          unknownPhase(
            'model.first_token',
            agentSpanId,
            requestReadyAt ?? startTs,
            requestReadyAt === undefined ? 'request_not_ready' : 'first_token_not_observed',
          );
        } else if (!firstTokenObserved) {
          closePhase(firstToken, endTs, 'unknown', { unknownReason: 'first_token_not_observed' });
        }
        if (generation) {
          closePhase(generation, lastOutputAt ?? endTs, 'measured', { observation: 'first_to_last_output_event' });
        } else if (!generationObserved) {
          unknownPhase(
            'model.generation',
            agentSpanId,
            requestReadyAt ?? startTs,
            requestReadyAt === undefined ? 'request_not_ready' : 'model_output_not_observed',
          );
        }
        for (const state of childWaits.values()) {
          closePhase(
            state,
            endTs,
            'unknown',
            { unknownReason: 'child_completion_not_observed', outcome: 'unknown' },
          );
        }

        // 未收口的 tool span 先收掉:turn 都结束了还挂着的 span 会被当成「卡死」信号,
        // 那就是纯误报源 —— 上一轮 MAJOR-1 的教训正是「开了链不收口比不开更坏」。
        for (const [callId, state] of tools) {
          if (state.closed) continue;
          state.closed = true;
          emitSafely(o.sid, [
            {
              kind: 'span',
              ...context,
              spanId: state.spanId,
              parentSpanId: agentSpanId,
              name: 'tool',
              startTs: state.startTs,
              endTs,
              status: { code: 'error', message: '工具调用未收到结果(内核提前结束或被取消)' },
              attrs: {
                ...correlation,
                tool: state.name,
                callId,
                phase: 'tool.execution',
                availability: 'unknown',
                unclosed: true,
                ...(state.collided ? { callIdCollision: true } : {}),
              },
            } as TelemetryRecord,
          ]);
        }

        emitSafely(o.sid, [
          {
            kind: 'span',
            ...agentBase,
            startTs,
            endTs,
            status: e.ok ? { code: 'ok' } : { code: 'error', ...(e.error ? { message: e.error } : {}) },
            attrs: { agentType: o.agentId, kernel: o.kernelId, tools: tools.size, ...correlation },
          } as TelemetryRecord,
        ]);

        const attrs: Record<string, unknown> = {
          kernel: o.kernelId,
          ...correlation,
          'request.model': requestModel,
          'request.reasoningEffort': requestReasoningEffort,
          'request.reasoningSupport': requestReasoningSupport,
        };
        if (e.model) attrs.model = e.model;
        if (e.reason) attrs.reason = e.reason;
        if (e.usage) {
          attrs['usage.input'] = e.usage.inputTokens;
          attrs['usage.output'] = e.usage.outputTokens;
        }
        emitSafely(o.sid, [
          {
            kind: 'span',
            ...kernelBase,
            startTs,
            endTs,
            status: e.ok ? { code: 'ok' } : { code: 'error', ...(e.error ? { message: e.error } : {}) },
            attrs,
          } as TelemetryRecord,
          {
            kind: 'log',
            ts: endTs,
            level: e.ok ? 'info' : 'error',
            msg: 'kernel.turn done',
            fields: {
              kernel: o.kernelId,
              ...correlation,
              status: e.ok ? 'ok' : 'error',
              ...(e.reason ? { reason: e.reason } : {}),
              ...(e.model ? { model: e.model } : {}),
              ...(e.usage ? { usage: e.usage } : {}),
              ...(e.error ? { error: e.error } : {}),
            },
            ...context,
            spanId: kernelSpanId,
          } as TelemetryRecord,
        ]);
      } catch {
        /* 可观测性永不反噬主流程 */
      }
    },
  };
}
