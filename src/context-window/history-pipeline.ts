/** history-pipeline —— StoredEvent[] → LLMMessage[]。
 *
 *  与 ref 1:1：拆 payload.llmMessage（可能是单条或数组），逐条 normalizeContent。
 *  把字符串 content 升格成 ContentPart[]，让下游 sanitizeMedia / microCompact /
 *  modalityFilter 都拿到统一形态。
 *
 *  hook:systemPrompt events → role:"system" carrier (dynamic-reminder)。 */

import type { LLMMessage } from "../llm/types";
import type { ContentPart } from "../core/types";
import type { StoredEvent } from "../ledger/types";
import { normalizeContent } from "../message/modality";
import { materializeSystemPromptEvent } from "./dynamic-reminder";
import { canonicalToolName } from "../kernel/canonical-tool-name";
import { projectToolCallMessage, projectToolResultMessage } from "../history/tool-result-projector";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMessage(raw: unknown): LLMMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "tool" && raw.role !== "system") {
    return undefined;
  }
  if (typeof raw.content === "string") {
    return { ...raw, content: normalizeContent(raw.content) } as LLMMessage;
  }
  if (!Array.isArray(raw.content)) return undefined;
  if (!raw.content.every((part) => isRecord(part) && typeof part.type === "string")) return undefined;
  return { ...raw, content: normalizeContent(raw.content as ContentPart[]) } as LLMMessage;
}

function appendMessage(messages: LLMMessage[], raw: unknown): void {
  const message = normalizeMessage(raw);
  if (!message) return;

  // Kernel streams may yield several tool.call events before their results.
  // Keep the event-per-call ledger/UI shape, but make ContextWindow see the
  // provider-like assistant(toolCalls[]) + contiguous tool-result timeline
  // expected by normalizeToolTimeline.
  const previous = messages[messages.length - 1];
  if (
    previous?.role === "assistant"
    && message.role === "assistant"
    && previous.content.length === 0
    && message.content.length === 0
    && previous.toolCalls?.length
    && message.toolCalls?.length
  ) {
    messages[messages.length - 1] = {
      ...previous,
      toolCalls: [...previous.toolCalls, ...message.toolCalls],
    };
    return;
  }
  messages.push(message);
}

export function eventsToMessages(events: readonly StoredEvent[]): LLMMessage[] {
  const msgs: LLMMessage[] = [];
  const callNames = new Map<string, string>();
  for (const rec of events) {
    if (rec.type === "hook:systemPrompt") {
      const reminder = materializeSystemPromptEvent(rec);
      if (reminder) msgs.push(reminder);
      continue;
    }

    const payload = rec.payload ?? {};
    if (rec.type === "hook:toolCall") {
      const toolCall = isRecord(payload.toolCall) ? payload.toolCall : undefined;
      const callId = payload.callId ?? toolCall?.id;
      const rawName = nonEmptyString(payload.name) ?? nonEmptyString(toolCall?.name);
      const name = rawName ? canonicalToolName(rawName) : undefined;
      if (typeof callId === "string" && callId && name) callNames.set(callId, name);
      appendMessage(
        msgs,
        payload.llmMessage ?? projectToolCallMessage({
          callId,
          toolName: name,
          args: payload.args ?? toolCall?.arguments,
          ts: rec.ts,
        }),
      );
      continue;
    }

    if (rec.type === "hook:toolResult") {
      const callId = nonEmptyString(payload.callId);
      const payloadName = nonEmptyString(payload.name);
      const name = payloadName ? canonicalToolName(payloadName) : (callId ? callNames.get(callId) : undefined);
      appendMessage(
        msgs,
        payload.llmMessage ?? projectToolResultMessage({
          callId,
          toolName: name,
          result: payload.result,
          ok: payload.ok !== false,
          error: payload.error,
          ts: rec.ts,
        }),
      );
      continue;
    }

    const llmMsg = payload.llmMessage as LLMMessage | LLMMessage[] | undefined;
    if (!llmMsg) continue;
    const arr = Array.isArray(llmMsg) ? llmMsg : [llmMsg];
    for (const rawMsg of arr) appendMessage(msgs, rawMsg);
  }
  return msgs;
}
