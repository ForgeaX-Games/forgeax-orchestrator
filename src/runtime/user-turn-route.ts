import type { StoredEvent } from "../ledger/types";

/** Selected execution inputs, scoped to one recipient's processed user or delegated turn. */
export interface UserTurnRoute {
  kernelId?: string;
  model?: string;
}

/** Recover from the existing WAL, not a second preferences store. Only an
 * inbound projection proves a selected turn was processed; newer queued inputs
 * and teammate kernel metadata must not change the recipient's route. */
export function recoverUserTurnRoute(events: readonly Pick<StoredEvent, "type" | "source" | "payload" | "eventId">[]): UserTurnRoute | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "inbound_message") continue;
    const payload = event.payload ?? {};
    if (payload.originalType === "agent_command") continue;
    const source = typeof payload.sourceEventId === "string"
      ? events.slice(0, index).find((candidate) => candidate.eventId === payload.sourceEventId)
      : undefined;
    const input = source?.payload as Record<string, unknown> | undefined;
    if (event.source !== "user" && !(event.source === "agent" && typeof input?.delegationId === "string")) continue;
    return {
      kernelId: typeof payload.kernelId === "string" ? payload.kernelId.trim() || undefined : undefined,
      model: typeof input?.model === "string" ? input.model.trim() || undefined : undefined,
    };
  }
  return undefined;
}
