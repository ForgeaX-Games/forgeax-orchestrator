import type { StoredEvent } from "../ledger/types";

/** User-selected execution inputs, scoped to one recipient's processed turn. */
export interface UserTurnRoute {
  kernelId?: string;
  model?: string;
}

/** Recover from the existing WAL, not a second preferences store. Only an
 * inbound projection proves a user input was processed; newer queued inputs
 * and teammate kernel metadata must not change the recipient's route. */
export function recoverUserTurnRoute(events: readonly Pick<StoredEvent, "type" | "source" | "payload" | "eventId">[]): UserTurnRoute | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "inbound_message" || event.source !== "user") continue;
    const payload = event.payload ?? {};
    if (payload.originalType === "agent_command") continue;
    const source = typeof payload.sourceEventId === "string"
      ? events.slice(0, index).find((candidate) => candidate.eventId === payload.sourceEventId)
      : undefined;
    const input = source?.payload as Record<string, unknown> | undefined;
    return {
      kernelId: typeof payload.kernelId === "string" ? payload.kernelId.trim() || undefined : undefined,
      model: typeof input?.model === "string" ? input.model.trim() || undefined : undefined,
    };
  }
  return undefined;
}
