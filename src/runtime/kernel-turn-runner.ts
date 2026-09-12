/**
 * runKernelTurn —— AgentInstance 的单次 Kernel turn 执行器。
 *
 * 关键洞见:`ws.ts` 把 `session.eventBus` 的每条事件原样广播,所有 hook→AG-UI
 * 翻译都在 UI 侧。⇒ 只要本函数往 bus 发**与 `runAgentLoop` 同款**的
 * `Hook.StreamLLM` / `Hook.AssistantMessage` / `Hook.ToolCall|ToolResult` 事件,
 * 整条 WS→UI 渲染管线(流式/思考/工具卡/spinner/历史)零改复用。
 *
 * 边界:只读 `composeTurnRequest`(编排层装配 charter+persona+R6 分层记忆+工具)
 * + `resolveKernel` + `runTurn`,再把 KernelEvent 映射成 bus 事件。**不持密钥、
 * 不碰内核内部**。`Hook.TurnStart/TurnEnd` 仍由调用方 `process()` 包。
 *
 * 历史连续性:RuntimeHost 从该 AgentInstance 的 EventStore 物化
 * `ContextSnapshot`,作为每轮完整的外部事实传入 Kernel。Kernel 可自行选择如何
 * 消费这份数据:无私有会话时直接用它引导首轮,有私有会话时则可通过稳定
 * `threadId = uuidv5(sid::instanceId)` 续接。因而私有 CLI 会话是可选的执行优化,
 * 不是宿主上下文连续性的唯一来源。
 */
import { publicCompactionStatus } from './compaction-status';
import { createHash } from 'node:crypto';
import type { KernelEvent, TurnContextSnapshot } from '@forgeax/agent-runtime';
import { Hook } from '../hooks/types';
import { normalizeContent } from '../message/modality';
import type { Event, EventBusAPI } from '../core/types';
import { composeTurnRequest, type ComposeInput } from '../kernel/compose-turn-request';
import { runWithHistoryResync } from '../kernel/history-resync';
import type { EventIdentity } from './turn-context';
import { resolveKernel } from '../kernel/resolve-kernel';
import { tt } from '../lib/turn-trace';
import { hostTelemetryEnabled } from '../kernel/host-telemetry';
import {
  classifyChildTaskStatus,
  startCliKernelTurn,
  type CliKernelTurnTrace,
} from '../kernel/cli-kernel-trace';
import type { SystemBlock } from '../llm/types';
import type { AgentManagementToolName } from '../kits/agent-management-visibility';

/** 确定性 UUIDv5(RFC 4122,sha1)——稳定 key → 稳定 UUID(CC resume 要求 UUID)。 */
function uuidv5(name: string): string {
  const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // 标准 DNS 命名空间
  const nsBytes = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 确定性 UUIDv5(RFC 4122,sha1)——稳定 key → 稳定 UUID(CC resume 要求 UUID)。 */
export function kernelThreadId(sessionId: string | undefined, instanceIdOrAgentId: string): string {
  return uuidv5(`${sessionId ?? 'nosid'}::${instanceIdOrAgentId}`);
}

/** `turn.done.reason === 'error'` 但上游没发过显式 error 事件时,合成可读错误——
 *  否则 error 保持 undefined,UI 会把失败渲染成「空响应」占位而非错误卡
 *  (bug-empty-response-2026-07-13)。显式 error / 非-error reason 原样透传。 */
export function inferKernelTurnError(
  reason: string | undefined,
  existingError: string | undefined,
  model?: string,
): string | undefined {
  if (existingError) return existingError;
  if (reason !== 'error') return undefined;
  return `kernel turn ended with reason=error but produced no error payload${model ? ` (model: ${model})` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface CanonicalCompactionBoundary {
  readonly summary: string;
  readonly replacement: Record<string, unknown>;
  readonly keepCount: number;
  readonly coveredFrom: number;
  readonly coveredTo: number;
}

type CanonicalCompactionValidation =
  | { readonly ok: true; readonly boundary: CanonicalCompactionBoundary }
  | { readonly ok: false; readonly reason: string };

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validate the complete destructive-boundary contract atomically. A partial
 * or malformed stored event must never be repaired with lossy defaults. */
function validateCanonicalCompactionApplied(
  payload: Record<string, unknown>,
): CanonicalCompactionValidation {
  const replacement = payload.replacement;
  if (!isRecord(replacement) || replacement.role !== 'user') {
    return { ok: false, reason: 'replacement must be a canonical user message' };
  }

  let summary: string | undefined;
  if (typeof replacement.content === 'string') {
    summary = replacement.content.trim() || undefined;
  } else if (
    Array.isArray(replacement.content) &&
    replacement.content.length > 0 &&
    replacement.content.every(
      (part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
  ) {
    summary = replacement.content
      .map((part) => (part as Record<string, unknown>).text as string)
      .join('\n')
      .trim() || undefined;
  }
  if (!summary) {
    return { ok: false, reason: 'replacement content must be non-empty canonical text' };
  }

  if (!nonNegativeSafeInteger(payload.keepCount)) {
    return { ok: false, reason: 'keepCount must be a non-negative safe integer' };
  }
  if (
    !nonNegativeSafeInteger(payload.coveredFrom) ||
    !nonNegativeSafeInteger(payload.coveredTo)
  ) {
    return { ok: false, reason: 'covered range must contain non-negative safe integers' };
  }
  if (payload.coveredFrom !== 0 || payload.coveredFrom > payload.coveredTo) {
    return { ok: false, reason: 'covered range must be a coherent compacted prefix' };
  }
  if (!Number.isSafeInteger(payload.coveredTo + payload.keepCount + 1)) {
    return { ok: false, reason: 'covered range and keepCount exceed safe history bounds' };
  }

  return {
    ok: true,
    boundary: {
      summary,
      replacement,
      keepCount: payload.keepCount,
      coveredFrom: payload.coveredFrom,
      coveredTo: payload.coveredTo,
    },
  };
}

/** Project only neutral failure/post diagnostics emitted by forgeax-core. The
 * payload cannot carry llmMessage, so persistence cannot change host history. */
export function projectKernelCompactionDiagnostic(
  ev: Extract<KernelEvent, { kind: 'stored-event' }>,
  agentId: string,
  now = Date.now(),
  providerId?: string,
): Event | undefined {
  const type = ev.payload.type;
  if (type !== 'compaction.failed' && type !== 'compaction.post') return undefined;
  const rawPayload = ev.payload.payload;
  if (!isRecord(rawPayload)) return undefined;
  const { llmMessage: _ignoredHistory, ...diagnostic } = rawPayload;
  return {
    type,
    ts: now,
    source: providerId ? `kernel:${providerId}` : `agent:${agentId}`,
    payload: {
      ...diagnostic,
      kernelEventKind: ev.kind,
      ...(providerId ? { providerId, kernelId: providerId } : {}),
    },
  };
}

export interface KernelTurnOpts {
  /** = agentPath;既是 compose 的 agentId,也是 threadId key 的一部分。 */
  agentId: string;
  /** session id(threadId 续接 + host-tool 桥定位活 agent)。 */
  sessionId?: string;
  /** Opaque runtime identity; never derive Kernel isolation from a template id. */
  instanceId?: string;
  runtimeEpochId?: string;
  templateRef?: string;
  /** Kernel implementation selected by the frozen Agent definition. */
  kernelId?: string;
  context?: TurnContextSnapshot;
  /** 本轮用户输入(合并 events 的 content)。 */
  userText: string;
  /** Stable identities of this turn's already-persisted inbound messages. */
  historyExcludeEvents?: readonly EventIdentity[];
  /** = this.boundEventBus(emitterId 自动带 agentPath)。 */
  eventBus: EventBusAPI;
  signal: AbortSignal;
  turn: number;
  model?: string;
  callId?: string;
  /** 该 agent 的 host-tools(ToolSpec)→ 经 MCP 桥下发内核(T-A)。 */
  tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  /** Canonical agent_manage visibility resolved from the host's agent config. */
  visibleAgentManagementTools?: readonly AgentManagementToolName[];
  /** Kit slots resolved by RuntimeAgentHost for this pinned turn revision. */
  kitSystemBlocks?: readonly SystemBlock[];
  /** 多模态附件(图片);透传进 composeTurnRequest → 原生内核 facade 组 image block。 */
  attachments?: Array<Record<string, unknown>>;
  /** 全链路 trace:浏览器 ui.request 的 W3C traceparent(经 /:sid/messages event payload 传到这);
   *  透传进 composeTurnRequest → TurnRequest.traceparent → 内核把 kernel.turn 挂成其 child。 */
  traceparent?: string;
  /** 本轮回复语言(UI 结算),透传进 composeTurnRequest → dynamicSuffix 指令。 */
  replyLanguage?: 'en' | 'zh';
}

export interface KernelTurnResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly aborted: boolean;
  readonly error?: string;
  readonly output?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly costUsd?: number;
    readonly durationMs?: number;
  };
}

/** 跑一轮内核 turn,把流式/工具/终态映射成 bus 事件。 */
export async function runKernelTurn(
  opts: KernelTurnOpts,
): Promise<KernelTurnResult> {
  const { agentId, eventBus, signal, turn } = opts;
  // Stable per (session, instance): residents keep CLI/--resume continuity
  // across reloadRuntime (epoch rotates every register, instanceId does not).
  // Ephemeral instanceIds are unique per spawn, so they need no epoch either.
  const threadId = kernelThreadId(opts.sessionId, opts.instanceId ?? agentId);

  let finalText = '';
  let thinkingText = '';
  let usage: KernelTurnResult["usage"];
  let error: string | undefined;
  let reason: string | undefined; // turn.done.reason(全链路 trace:kernel.turn 结束原因)
  let providerId: string | undefined;
  let cliTrace: CliKernelTurnTrace | null = null; // 第 2 层:非-forgeax-core 内核的 kernel.turn span
  const toolName = new Map<string, string>(); // callId → name(供 tool.result 命名)

  try {
    const kernel = resolveKernel(agentId, opts.kernelId);
    providerId = kernel.id;
    const turnId = opts.callId ?? `${opts.runtimeEpochId ?? 'legacy'}:${turn}`;

    // The generic execution layer owns phase telemetry. Start it before request
    // composition so preparation latency includes history/tool materialization;
    // product-specific policy remains outside this module.
    if (kernel.id !== 'forgeax-core' && hostTelemetryEnabled()) {
      cliTrace = startCliKernelTurn({
        kernelId: kernel.id,
        agentId,
        ...(opts.sessionId ? { sid: opts.sessionId } : {}),
        ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
        requestId: opts.callId ?? turnId,
        turnId,
      });
    }

    const composeInput: ComposeInput = {
      message: opts.userText,
      agentId,
      kernel,
      threadId,
      turnId,
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.callId ? { callId: opts.callId } : {}),
      ...(opts.historyExcludeEvents?.length
        ? { historyExcludeEvents: opts.historyExcludeEvents }
        : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.tools ? { extraTools: opts.tools } : {}),
      ...(opts.visibleAgentManagementTools !== undefined
        ? { visibleAgentManagementTools: opts.visibleAgentManagementTools }
        : {}),
      ...(opts.kitSystemBlocks ? { kitSystemBlocks: opts.kitSystemBlocks } : {}),
      ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}),
      ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
      ...(opts.replyLanguage ? { replyLanguage: opts.replyLanguage } : {}),
    };
    let req = await composeTurnRequest(composeInput);
    // This path does not currently expose reasoning-effort capability in the
    // neutral TurnRequest contract. Record that as unknown rather than
    // inferring support or changing the user's selected model/effort.
    cliTrace?.onRequestReady({
      ...(req.model ? { model: req.model } : {}),
      reasoningEffort: 'unknown',
      reasoningSupport: 'unknown',
    });

    tt('kt.start', { agent: agentId, turn, sid: opts.sessionId, threadId, tools: req.tools?.length });
    let deltas = 0;
    let lastKind = '';
    for await (const ev of runWithHistoryResync({
      initial: req,
      retrySnapshot: async () => {
        req = await composeTurnRequest({ ...composeInput, forceSnapshot: true });
        return req;
      },
      run: (request) => kernel.runTurn(request, signal),
    })) {
      lastKind = ev.kind;
      if (ev.kind === 'message.delta' || ev.kind === 'thinking.delta') {
        deltas++;
        if (deltas === 1) tt('kt.first-delta', { agent: agentId, turn, kind: ev.kind });
      } else {
        const evName = (ev as { name?: string; callId?: string }).name;
        const evCall = (ev as { name?: string; callId?: string }).callId;
        tt('kt.event', { agent: agentId, turn, kind: ev.kind, deltas, ...(evName ? { name: evName } : {}), ...(evCall ? { callId: evCall } : {}) });
      }
      switch (ev.kind) {
        case 'message.delta':
          if (ev.text.length > 0) cliTrace?.onFirstToken('text');
          finalText += ev.text;
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'text', text: ev.text },
            turn,
            providerId,
          });
          break;
        case 'thinking.delta':
          if (ev.text.length > 0) cliTrace?.onFirstToken('thinking');
          thinkingText += ev.text;
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'thinking', text: ev.text },
            turn,
            providerId,
          });
          break;
        case 'tool.call': {
          cliTrace?.onToolCall(ev.callId, ev.name);
          toolName.set(ev.callId, ev.name);
          const args = (ev.args ?? {}) as Record<string, unknown>;
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'tool_call', id: ev.callId, name: ev.name, arguments: JSON.stringify(args) },
            turn,
            providerId,
          });
          eventBus.hook(Hook.ToolCall, {
            name: ev.name,
            args,
            toolCall: { id: ev.callId, name: ev.name, arguments: args },
            providerId,
          });
          break;
        }
        case 'tool.call.delta':
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'tool_call_delta', id: ev.callId, name: ev.name, arguments_delta: ev.argsDelta },
            turn,
            providerId,
          });
          break;
        case 'tool.result':
          cliTrace?.onToolResult(ev.callId, ev.ok, ev.result, ev.error);
          // P0(历史归属):把工具结果**内容**也带进 bus → 落 per-agent 账本,让 forgeax
          // 拥有可回放的完整一轮(此前只记 name+durationMs,丢了 result)。kernel-neutral:
          // claude-code / codex / forgeax-core 的 tool.result 都带 {callId,ok,result}。
          eventBus.hook(Hook.ToolResult, {
            name: toolName.get(ev.callId) ?? '',
            callId: ev.callId,
            durationMs: 0,
            ok: ev.ok,
            ...(ev.result !== undefined ? { result: ev.result } : {}),
            ...(ev.ok ? {} : { error: ev.error ?? 'tool failed' }),
            providerId,
          });
          break;
        case 'turn.usage':
          usage = {
            inputTokens: ev.inputTokens ?? 0,
            outputTokens: ev.outputTokens ?? 0,
            ...(typeof ev.cacheRead === "number"
              ? { cacheReadTokens: ev.cacheRead }
              : {}),
            ...(typeof ev.cacheCreation === "number"
              ? { cacheWriteTokens: ev.cacheCreation }
              : {}),
            ...(typeof ev.costUsd === "number" ? { costUsd: ev.costUsd } : {}),
            ...(typeof ev.durationMs === "number"
              ? { durationMs: ev.durationMs }
              : {}),
          };
          eventBus.hook(Hook.StreamLLM, {
            chunk: { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(opts.model ? { model: opts.model } : {}) },
            turn,
            providerId,
          });
          break;
        case 'error':
          error = `${ev.error.code}: ${ev.error.message}`;
          break;
        case 'turn.done':
          reason = (ev as { reason?: string }).reason; // kernel.turn 结束原因(stop/max_turns/cancelled…)
          break;
        case 'compact_boundary':
          // The legacy neutral event contains only observational range/token data.
          // It must not become the host's semantic truncation boundary: doing so
          // would discard all earlier history without a replacement summary.
          eventBus.publish({
            type: 'compaction.observed',
            ts: Date.now(),
            source: `kernel:${providerId ?? 'unknown'}`,
            payload: {
              coveredFrom: ev.coveredFrom,
              coveredTo: ev.coveredTo,
              ...(ev.trigger !== undefined ? { trigger: ev.trigger } : {}),
              ...(ev.preTokens !== undefined ? { preTokens: ev.preTokens } : {}),
              ...(ev.postTokens !== undefined ? { postTokens: ev.postTokens } : {}),
              ...(providerId ? { providerId, kernelId: providerId } : {}),
            },
          });
          break;
        case 'stored-event': {
          const status = publicCompactionStatus(ev.payload);
          if (status) {
            eventBus.publish({ ...status, source: `kernel:${providerId}` }, agentId);
            break;
          }
          const envelope = ev.payload;
          const canonicalType = typeof envelope.type === 'string' ? envelope.type : undefined;
          const canonicalPayload = isRecord(envelope.payload) ? envelope.payload : {};
          if (canonicalType === 'compaction.applied') {
            const validation = validateCanonicalCompactionApplied(canonicalPayload);
            if (validation.ok) {
              const { boundary } = validation;
              eventBus.publish({
                type: 'compact_boundary',
                ts: Date.now(),
                source: `kernel:${providerId ?? 'unknown'}`,
                payload: {
                  ...boundary,
                  ...(typeof canonicalPayload.trigger === 'string'
                    ? { trigger: canonicalPayload.trigger }
                    : {}),
                  ...(typeof canonicalPayload.preTokens === 'number'
                    ? { preTokens: canonicalPayload.preTokens }
                    : {}),
                  ...(typeof canonicalPayload.postTokens === 'number'
                    ? { postTokens: canonicalPayload.postTokens }
                    : {}),
                  ...(providerId ? { providerId, kernelId: providerId } : {}),
                },
              });
            } else {
              // Malformed applied events remain durable and auditable but cannot
              // authorize destructive ContextWindow truncation.
              const { llmMessage: _ignoredHistory, ...auditablePayload } = canonicalPayload;
              eventBus.publish({
                type: 'compaction.applied',
                ts: Date.now(),
                source: `kernel:${providerId ?? 'unknown'}`,
                payload: {
                  ...auditablePayload,
                  reconstruction: {
                    status: 'unavailable',
                    reason: validation.reason,
                  },
                  ...(providerId ? { providerId, kernelId: providerId } : {}),
                },
              });
            }
          } else {
            const diagnostic = projectKernelCompactionDiagnostic(
              ev,
              agentId,
              Date.now(),
              providerId,
            );
            if (diagnostic) eventBus.publish(diagnostic, agentId);
          }
          break;
        }
        default:
          // x.* 扩展事件(x.subagent.* / x.perception / x.ui.* …):publish 进 session
          // EventBus → ws.ts 原样广播给前端(照 perception:query 的做法;不动 wire
          // ChatEvent 类型,绕开稳定接口区)。UI 侧按需消费(轨迹图/ghost 高亮),
          // 无人订阅时零成本。非 x.* 的未知 kind 维持忽略。
          if (typeof (ev as { kind?: unknown }).kind === 'string' && (ev as { kind: string }).kind.startsWith('x.')) {
            const extension = ev as Extract<KernelEvent, { kind: `x.${string}` }>;
            if (extension.kind === 'x.subagent.start') {
              cliTrace?.onChildTaskStart(extension.agentId);
            } else if (extension.kind === 'x.subagent.done') {
              cliTrace?.onChildTaskEnd(
                extension.agentId,
                classifyChildTaskStatus(extension.reason),
                extension.reason,
              );
            }
            try {
              eventBus.publish(
                {
                  type: (ev as { kind: string }).kind,
                  ts: Date.now(),
                  source: `agent:${agentId}`,
                  payload: ev as unknown as Record<string, unknown>,
                },
                agentId,
              );
            } catch {
              /* 观测通道绝不影响主流程 */
            }
          }
          break;
      }
    }
    tt('kt.loop-exit', { agent: agentId, turn, deltas, lastKind, finalLen: finalText.length, error });
  } catch (err) {
    if (!signal.aborted) error = (err as Error).message;
    tt('kt.catch', { agent: agentId, turn, aborted: signal.aborted, error: (err as Error).message });
  } finally {
    // abort 短路对齐 catch 分支的 !signal.aborted:取消的 turn 即便内核发 reason=error 也不合成错误卡。
    if (!signal.aborted) error = inferKernelTurnError(reason, error, opts.model);
    // 第 2 层:收尾 CLI 内核 kernel.turn span(status/reason/usage/model 落 trace+log)。
    //   即便上面 throw / abort 也保证收口,避免假性「永不收口」误报。
    const doneReason = reason ?? (signal.aborted ? 'cancelled' : error ? 'error' : undefined);
    cliTrace?.end({
      ok: !error,
      ...(doneReason ? { reason: doneReason } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
    });
  }

  const usageId = usage
    ? `usage_${createHash("sha256").update(JSON.stringify({
        sid: opts.sessionId ?? "nosid",
        instanceId: opts.instanceId ?? agentId,
        runtimeEpochId: opts.runtimeEpochId ?? "legacy",
        callId: opts.callId ?? null,
        turn,
      })).digest("hex").slice(0, 32)}`
    : undefined;
  if (usage && usageId) {
    eventBus.publish({
      type: "turn.usage",
      ts: Date.now(),
      source: `agent:${agentId}`,
      payload: {
        usageId,
        usage,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        turn,
        ...(opts.model ? { model: opts.model } : {}),
        ...(providerId ? { providerId, kernelId: providerId } : {}),
        ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
        ...(opts.runtimeEpochId ? { runtimeEpochId: opts.runtimeEpochId } : {}),
        ...(opts.templateRef ? { templateRef: opts.templateRef } : {}),
      },
    });
  }

  // 终态:累计文本作为 assistant 消息发出(落 ledger + 渲染提交)。
  // Failures travel in the structured turn result. Do not impersonate model
  // output with a diagnostic: clients would render it twice and replay it as
  // assistant prose on the next turn.
  if (finalText.trim() || thinkingText.trim()) {
    const llmMessage = {
      role: 'assistant' as const,
      content: normalizeContent(finalText),
      ...(thinkingText.trim() ? { thinking: thinkingText } : {}),
      ts: Date.now(),
      ...(signal.aborted ? { truncated: true } : {}),
    };
    eventBus.hook(Hook.AssistantMessage, {
      llmMessage,
      turn,
      ...(providerId ? { providerId, kernelId: providerId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(usage ? { usage } : {}),
      ...(usageId ? { usageId } : {}),
    });
  }

  tt('kt.return', { agent: agentId, turn, aborted: signal.aborted, error });
  return {
    status: signal.aborted ? 'cancelled' : error ? 'failed' : 'completed',
    aborted: signal.aborted,
    ...(error ? { error } : {}),
    ...(finalText ? { output: finalText } : {}),
    ...(usage ? { usage } : {}),
  };
}
