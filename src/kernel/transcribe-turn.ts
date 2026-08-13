/**
 * transcribeKernelTurn —— 把一轮内核 turn **转录**进编排层 host-owned 账本。
 *
 * 核心目标(多内核通用·host-owned 历史):内核每轮吐的是中立 `KernelEvent` 流;编排层
 * 在此把它转录成 per-agent 账本的 canonical 事件,**与具体内核无关**(claude-code /
 * codex / forgeax-core 同一形状),账本即上下文真相,不依赖任何内核的私有会话文件。
 *
 * 两条铁律:
 *  1. **key 到 UI 重放用的同一个 (sid, agentPath)** —— `agentPath` 必须 = 客户端发消息
 *     时传的 agentId(store.ts 发送 + 刷新后 fetch_session_events(sid, agentId) 重放,
 *     逐字一致)。caller 负责传对;本函数不再做 `display===agentId / depth===1` 那种会
 *     落到别的节点的启发式解析(那正是"claude-code 刷新历史消失"的根因)。
 *  2. **直接写账本、不经 EventBus** —— caller(如 /api/cli/chat)已把同轮 SSE 直送前端;
 *     再经 bus 广播会在 WS 上重复渲染。账本路径只由 (sid, agentPath) 计算、append 时自建
 *     目录,无需 agent 已 scaffold。
 *
 * 形状对齐 native /messages 路径(user_input / hook:turnStart / hook:toolCall|toolResult /
 * hook:assistantMessage(llmMessage) / hook:turnEnd) → replay 即可还原。
 */
import type { Event } from "../core/types";
import type { Session } from "../core/session";
import type { PreparedHistory } from "@forgeax/agent-runtime";
import { randomUUID } from "node:crypto";
import { canonicalToolName } from "./canonical-tool-name";

export interface KernelTurnRecord {
  /** 本轮用户输入文本(渲染 user 气泡)。 */
  message: string;
  /** Server-owned checkpoint identity for the inbound user message. */
  msgId?: string;
  /** Model-visible user context. Defaults to message; may include durable attachment path notes. */
  contextText?: string;
  /** Path-only attachments retained for UI refresh + model history (no base64). */
  attachments?: Array<Record<string, unknown>>;
  /** 驱动本轮的内核/驱动 id(claude-code / codex / forgeax-core)。写进账本,
   *  刷新后 loadSession 据此还原 ForgeCard 的来源 badge(否则历史消息丢标记)。 */
  providerId?: string;
  /** 累计的 assistant 文本。 */
  asstText: string;
  /** Wall-clock time captured before kernel execution begins. */
  startedAt?: number;
  /** 累计的 thinking 文本。 */
  thinkingText: string;
  /** Explicitly user-visible progress summary. Kept separate from private reasoning. */
  publicSummaryText?: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "cancelled";
  usage?: unknown;
  model?: string;
  historyPlan?: PreparedHistory;
  toolEvents: Array<
    | { kind: "call"; callId: string; name: string; args: unknown }
    | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
  >;
  /** Ordered public process stream. New callers use this to preserve the
   * model-emitted summary/tool sequence across refresh. */
  processEvents?: Array<
    | { kind: "assistant_text"; text: string }
    | { kind: "public_summary"; text: string }
    | { kind: "call"; callId: string; name: string; args: unknown }
    | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
  >;
}

/** 把一轮内核 turn 转录进 `session` 下 `agentPath` 的 per-agent 账本。
 *  空轮(无文本/思考/工具)直接跳过,不落噪声。 */
export function transcribeKernelTurn(
  session: Session,
  agentPath: string,
  rec: KernelTurnRecord,
): { turnId: string; startedAt: number; settledAt: number } | undefined {
  if (!agentPath) return;
  if (!(
    rec.asstText.trim()
    || rec.publicSummaryText?.trim()
    || rec.toolEvents.length
    || rec.processEvents?.some((event) =>
      event.kind === "assistant_text" ? event.text.trim() : true)
  )) return;

  const led = session.getOrCreateLedger(agentPath);
  const ap = agentPath;
  const t0 = typeof rec.startedAt === "number" && Number.isFinite(rec.startedAt)
    ? rec.startedAt
    : Date.now();
  const ev = (o: Record<string, unknown>) => o as unknown as Event;

  const pid = rec.providerId;
  const turnId = randomUUID();
  const historyMeta = pid && rec.historyPlan?.laneId && typeof rec.historyPlan.epoch === 'number'
    ? { turnId, origin: { kernelId: pid, laneId: rec.historyPlan.laneId, epoch: rec.historyPlan.epoch } }
    : { turnId };
  const append = (event: Event, emitterId?: string) => led.append(event, emitterId, historyMeta);
  // `content` is the UI projection; `llmMessage` is canonical model context.
  // Attachment base64 is never persisted: compose has replaced it with durable paths.
  // Keep path-only `attachments` so refresh can re-render image chips.
  let durableAtts = Array.isArray(rec.attachments)
    ? rec.attachments
      .map((att) => {
        const kind = typeof att.kind === 'string' ? att.kind : 'file';
        const path = typeof att.path === 'string' ? att.path : '';
        if (!path) return null;
        const mediaType = typeof att.mediaType === 'string' ? att.mediaType : undefined;
        return { kind, path, ...(mediaType ? { mediaType } : {}) };
      })
      .filter((att): att is { kind: string; path: string; mediaType?: string } => !!att)
    : [];
  // Rented kernels leave only path notes in contextText — recover attachments[]
  // for UI refresh the same way the chat formatter does for legacy WAL rows.
  if (durableAtts.length === 0 && typeof rec.contextText === 'string') {
    const re = /\[Attached (image|document|file): (.+?) \(([^,]+), [^)]+\)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rec.contextText)) !== null) {
      const kind = m[1];
      const path = m[2].trim();
      const mediaType = m[3].trim();
      if (!path) continue;
      durableAtts.push({
        kind,
        path,
        ...(mediaType && mediaType !== 'unknown type' ? { mediaType } : {}),
      });
    }
  }
  append(ev({
    type: "user_input",
    ts: t0,
    source: "user",
    to: ap,
    handoff: "turn",
    payload: {
      content: rec.message,
      ...(rec.msgId ? { msgId: rec.msgId } : {}),
      llmMessage: { role: "user", content: [{ type: "text", text: rec.contextText ?? rec.message }] },
      ...(durableAtts.length ? { attachments: durableAtts } : {}),
    },
  }));
  append(ev({
    type: "hook:turnStart",
    ts: t0,
    source: `agent:${ap}`,
    payload: {
      turn: 1,
      turnId,
      artifactResolutionExpected: true,
      schemaVersion: 2,
      ...(rec.msgId ? { msgId: rec.msgId } : {}),
      ...(pid ? { providerId: pid } : {}),
    },
  }), ap);

  const callNames = new Map<string, string>();
  const orderedProcess = rec.processEvents ?? [
    ...rec.toolEvents,
    ...(rec.publicSummaryText?.trim()
      ? [{ kind: "public_summary" as const, text: rec.publicSummaryText }]
      : []),
  ];
  for (const t of orderedProcess) {
    if (t.kind === "assistant_text") {
      if (!t.text.trim()) continue;
      append(
        ev({
          type: "hook:assistantMessage",
          ts: Date.now(),
          source: `agent:${ap}`,
          payload: {
            llmMessage: { role: "assistant", content: [{ type: "text", text: t.text }] },
            turn: 1,
            ...(pid ? { providerId: pid } : {}),
          },
        }),
        ap,
      );
      continue;
    }
    if (t.kind === "public_summary") {
      if (!t.text.trim()) continue;
      append(
        ev({
          type: "agent_log",
          ts: Date.now(),
          source: `agent:${ap}`,
          payload: {
            visibility: "public_summary",
            summary: t.text,
            ...(pid ? { providerId: pid } : {}),
          },
        }),
        ap,
      );
      continue;
    }
    if (t.kind === "call") {
      const name = canonicalToolName(t.name);
      callNames.set(t.callId, name);
      append(
        ev({
          type: "hook:toolCall",
          ts: Date.now(),
          source: `agent:${ap}`,
          payload: { name, ...(name !== t.name ? { rawName: t.name } : {}), args: t.args, callId: t.callId, toolCall: { id: t.callId, name, arguments: t.args } },
        }),
        ap,
      );
    } else {
      append(
        ev({
          type: "hook:toolResult",
          ts: Date.now(),
          source: `agent:${ap}`,
          payload: {
            // Preserve the call name for replay consumers (notably the
            // host-owned artifact semantic projection). Older transcriptions
            // left this blank, which made a valid deliver_summary result
            // disappear after refresh.
            name: callNames.get(t.callId) ?? "",
            callId: t.callId,
            ok: t.ok,
            durationMs: 0,
            ...(t.result !== undefined ? { result: t.result } : {}),
            ...(t.ok ? {} : { error: t.error ?? "tool failed" }),
          },
        }),
        ap,
      );
    }
  }

  if (rec.asstText.trim()) {
    append(
      ev({
        type: "hook:assistantMessage",
        ts: Date.now(),
        source: `agent:${ap}`,
        payload: {
          llmMessage: {
            role: "assistant",
            content: [{ type: "text", text: rec.asstText }],
          },
          turn: 1,
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.usage ? { usage: rec.usage } : {}),
          ...(pid ? { providerId: pid } : {}),
        },
      }),
      ap,
    );
  }

  const settledAt = Date.now();
  const endCursor = append(ev({
    type: "hook:turnEnd",
    ts: settledAt,
    source: `agent:${ap}`,
    payload: {
      turn: 1,
      turnId,
      reason: rec.stopReason,
      artifactResolutionExpected: true,
      schemaVersion: 2,
      ...(rec.msgId ? { msgId: rec.msgId } : {}),
      ...(rec.stopReason === "cancelled" ? { aborted: true } : {}),
    },
  }), ap);
  if (rec.historyPlan?.laneId && rec.providerId && typeof rec.historyPlan.epoch === 'number') {
    led.append(ev({
      type: 'kernel_history_applied', ts: Date.now(), source: 'history-coordinator',
      payload: {
        laneId: rec.historyPlan.laneId, kernelId: rec.providerId, epoch: rec.historyPlan.epoch,
        knownThrough: endCursor, patchId: rec.historyPlan.patchId,
      },
    }));
  }
  return { turnId, startedAt: t0, settledAt };
}
