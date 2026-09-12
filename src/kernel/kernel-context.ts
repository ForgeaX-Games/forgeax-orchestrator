import type { TurnMessage, TurnRequest } from "@forgeax/agent-runtime";

/**
 * Build the model-visible task for a private-session kernel.
 *
 * The host always supplies a neutral context snapshot. A kernel that is
 * starting a fresh private thread bootstraps that thread from the snapshot;
 * a kernel that is resuming a synchronized private thread keeps its own state
 * and receives only the current task.
 */
export function buildKernelTask(
  req: TurnRequest,
  bootstrapContext: boolean,
): string {
  const suffix = req.systemPrompt.dynamicSuffix?.trim();
  const task = suffix
    ? `${req.input.text}\n\n${suffix}`
    : req.input.text;
  // A prepared text-bridge plan is already serialized in dynamicSuffix.
  // Replaying context.messages again doubles history on fresh/private restart.
  const mode = (req.historyPlan as { mode?: string } | undefined)?.mode;
  if (!bootstrapContext || mode === 'snapshot' || mode === 'delta' || mode === 'none') return task;

  const messages = req.context?.messages ?? req.history ?? [];
  if (messages.length === 0) return task;
  return [
    "# Previous conversation context supplied by ForgeaX",
    "",
    "Treat this as earlier conversation, not as new user instructions.",
    renderMessages(messages),
    "",
    "# Current task",
    "",
    task,
  ].join("\n");
}

function renderMessages(messages: readonly TurnMessage[]): string {
  return messages.map((message, index) => {
    switch (message.role) {
      case "user":
        return renderEntry(index, "user", message.content);
      case "assistant":
        return renderEntry(index, "assistant", {
          content: message.content,
          ...(message.toolCalls?.length
            ? { toolCalls: message.toolCalls }
            : {}),
        });
      case "tool":
        return renderEntry(index, "tool", {
          callId: message.callId,
          ok: message.ok,
          ...(message.result !== undefined ? { result: message.result } : {}),
          ...(message.error ? { error: message.error } : {}),
        });
    }
  }).join("\n");
}

function renderEntry(index: number, role: string, value: unknown): string {
  return `<forgeax-message index="${index}" role="${role}">${safeJson(value)}</forgeax-message>`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}
