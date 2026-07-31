/** LiveTurnTracker —— per-session 在途 turn 累积(多 tab 同步方案 §4.3)。
 *
 *  观察 eventBus 自累积每个 emitter 的在途流式内容;WsHub 在新连接 open 时取
 *  O(1) 快照(turn-snapshot 帧),中途加入的 tab 不用等 turn 结束才看到文本。
 *  kernel 无关:原生 runAgentLoop / runKernelTurn / CliEventBridge 三条流式
 *  路径只要往总线发 hook:turnStart / stream:llm / hook:turnEnd 就被覆盖 ——
 *  不复用 ResponseAccumulator(它是 assembleResponseWithCallback 的函数局部
 *  变量,且只覆盖原生路径)。
 *
 *  sealedTextLen / sealedThinkingLen:已被 hook:assistantMessage 封口的前缀
 *  长度(per-step seal,方案 D4)——一个 turn 内 assistantMessage 会发多条
 *  (tool-loop 每个 LLM step 一条),前端 reconcile 只修封口之后的尾部。 */

import type { EventBus } from "./event-bus";
import type { Event } from "./types";

export interface LiveToolCall {
  callId: string;
  name: string;
  args?: unknown;
  status: "running" | "done" | "error";
}

export interface TurnSnapshot {
  emitterId: string;
  turn: number;
  /** hook:turnStart 的 event.ts —— 前端流式消息身份锚 `live:<emitterId>:<ts>`。 */
  startedAt: number;
  text: string;
  thinking: string;
  sealedTextLen: number;
  sealedThinkingLen: number;
  toolCalls: LiveToolCall[];
}

interface LiveTurn {
  turn: number;
  startedAt: number;
  text: string;
  thinking: string;
  hasToolActivity: boolean;
  sealedTextLen: number;
  sealedThinkingLen: number;
  toolCalls: Map<string, LiveToolCall>;
}

interface StreamChunk {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: string;
  arguments_delta?: string;
}

function extractAssistantContent(payload: Record<string, unknown>): {
  text: string;
  thinking: string;
  hasToolCalls: boolean;
} {
  const raw = (payload.llmMessage ?? payload.msg) as {
    content?: unknown;
    thinking?: unknown;
    toolCalls?: unknown;
  } | undefined;
  const content = raw?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((block): block is { type: string; text: string } =>
          !!block && typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string")
        .map((block) => block.text)
        .join("")
      : "";
  return {
    text,
    thinking: typeof raw?.thinking === "string" ? raw.thinking : "",
    hasToolCalls: Array.isArray(raw?.toolCalls) && raw.toolCalls.length > 0,
  };
}

/** 可见 assistant 正文:流式 text 非空,或本轮已封口过正文(sealedTextLen>0)。
 *  仅 thinking / TTFT 不算 —— 刷新后可不续展示,但应 abort 请求。 */
export function hasAssistantOutput(t: {
  text: string;
  sealedTextLen: number;
}): boolean {
  return t.text.trim().length > 0 || t.sealedTextLen > 0;
}

export class LiveTurnTracker {
  private readonly turns = new Map<string, LiveTurn>();

  constructor(bus: EventBus) {
    this.disposeFn = bus.observe((event, emitterId) => this.onEvent(event, emitterId));
  }

  private readonly disposeFn: () => void;

  dispose(): void {
    this.disposeFn();
    this.turns.clear();
  }

  /** 每个在途 turn 一份快照;没有 running turn 则空数组。 */
  snapshots(): TurnSnapshot[] {
    return [...this.turns.entries()].map(([emitterId, t]) => ({
      emitterId,
      turn: t.turn,
      startedAt: t.startedAt,
      text: t.text,
      thinking: t.thinking,
      sealedTextLen: t.sealedTextLen,
      sealedThinkingLen: t.sealedThinkingLen,
      toolCalls: [...t.toolCalls.values()],
    }));
  }

  /** `emitterId` 当前是否有未封口的在途 turn(已收到 turnStart,还没收到匹配的
   *  turnEnd)。供 caller 判断「target 被强制终止时,是否需要补一条合成
   *  turnEnd」——若这里已经是 false,说明真实 turnEnd 已经跑过,不必再补,
   *  避免重复广播。 */
  has(agentPath: string): boolean {
    return this.turns.has(agentPath);
  }

  /** 仅 thinking / 等首 token 的 emitter。正文或工具活动都可恢复,不得 abort。 */
  thinkingOnlyEmitterIds(): string[] {
    const out: string[] = [];
    for (const [emitterId, t] of this.turns) {
      if (!hasAssistantOutput(t) && !t.hasToolActivity) out.push(emitterId);
    }
    return out;
  }

  private onEvent(event: Event, emitterId?: string): void {
    if (!emitterId) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === "hook:turnStart") {
      this.turns.set(emitterId, {
        turn: typeof payload.turn === "number" ? payload.turn : 0,
        startedAt: event.ts,
        text: "",
        thinking: "",
        hasToolActivity: false,
        sealedTextLen: 0,
        sealedThinkingLen: 0,
        toolCalls: new Map(),
      });
      return;
    }

    const t = this.turns.get(emitterId);
    if (!t) return;

    switch (event.type) {
      case "stream:llm": {
        const chunk = payload.chunk as StreamChunk | undefined;
        if (!chunk) return;
        if (chunk.type === "text" && chunk.text) t.text += chunk.text;
        else if (chunk.type === "thinking" && chunk.text) t.thinking += chunk.text;
        else if (chunk.type === "tool_call" && chunk.id) {
          t.hasToolActivity = true;
          const prev = t.toolCalls.get(chunk.id);
          t.toolCalls.set(chunk.id, {
            callId: chunk.id,
            name: chunk.name ?? prev?.name ?? "tool",
            args: chunk.arguments ?? prev?.args,
            status: prev?.status ?? "running",
          });
        } else if (chunk.type === "tool_call_delta" && chunk.id) {
          t.hasToolActivity = true;
          const prev = t.toolCalls.get(chunk.id);
          const prevArgs = typeof prev?.args === "string" ? prev.args : "";
          t.toolCalls.set(chunk.id, {
            callId: chunk.id,
            name: chunk.name ?? prev?.name ?? "tool",
            args: prevArgs + (chunk.arguments_delta ?? ""),
            status: prev?.status ?? "running",
          });
        }
        return;
      }
      case "stream:tool_use": {
        const callId = payload.toolUseId as string | undefined;
        if (!callId) return;
        t.hasToolActivity = true;
        t.toolCalls.set(callId, {
          callId,
          name: typeof payload.name === "string" ? payload.name : "tool",
          args: payload.input,
          status: "running",
        });
        return;
      }
      case "stream:tool_result": {
        const callId = payload.toolUseId as string | undefined;
        if (!callId) return;
        t.hasToolActivity = true;
        const prev = t.toolCalls.get(callId);
        if (prev) prev.status = payload.isError ? "error" : "done";
        return;
      }
      case "hook:toolCall": {
        const tc = payload.toolCall as { id?: string; name?: string } | undefined;
        const callId = tc?.id;
        if (!callId) return;
        t.hasToolActivity = true;
        t.toolCalls.set(callId, {
          callId,
          name: (payload.name as string) ?? tc?.name ?? "tool",
          args: payload.args,
          status: "running",
        });
        return;
      }
      case "hook:toolResult": {
        const callId = payload.callId as string | undefined;
        if (!callId) return;
        const prev = t.toolCalls.get(callId);
        if (prev) prev.status = payload.error ? "error" : "done";
        return;
      }
      case "hook:assistantMessage": {
        // CLI / bridge paths can emit only the sealed assistantMessage without
        // preceding stream:llm text. Keep the snapshot and abort policy correct
        // in that regime instead of misclassifying visible output as thinking-only.
        const sealed = extractAssistantContent(payload);
        if (sealed.hasToolCalls) t.hasToolActivity = true;
        if (sealed.text && t.text.slice(t.sealedTextLen) !== sealed.text) {
          t.text = t.text.slice(0, t.sealedTextLen) + sealed.text;
        }
        if (sealed.thinking && t.thinking.slice(t.sealedThinkingLen) !== sealed.thinking) {
          t.thinking = t.thinking.slice(0, t.sealedThinkingLen) + sealed.thinking;
        }
        t.sealedTextLen = t.text.length;
        t.sealedThinkingLen = t.thinking.length;
        return;
      }
      case "hook:turnEnd": {
        this.turns.delete(emitterId);
        return;
      }
    }
  }
}
