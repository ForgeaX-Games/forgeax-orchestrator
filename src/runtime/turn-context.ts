import type {
  TurnContextSnapshot,
  TurnMessage,
} from "@forgeax/agent-runtime";
import type { BlackboardAPI } from "../core/types";
import {
  ContextWindow,
  type LedgerReader,
} from "../context-window/context-window";
import { llmMessagesToTurnHistory } from "../kernel/llm-history";
import type { StoredEvent } from "../ledger/types";

export interface EventIdentity {
  readonly sgen: string;
  readonly seq: number;
}

export interface MaterializeTurnContextInput {
  readonly agentId: string;
  readonly ledger: LedgerReader;
  readonly blackboard?: BlackboardAPI;
  readonly excludeEvents?: readonly EventIdentity[];
}

/**
 * Select one model-visible context snapshot from an instance-bound EventStore.
 * It is deliberately kernel-neutral: every kernel receives the same data and
 * decides internally whether to replay, resume or reconcile private state.
 */
export async function materializeTurnContext(
  input: MaterializeTurnContextInput,
): Promise<TurnContextSnapshot | undefined> {
  const eventKey = (identity: EventIdentity) =>
    `${identity.sgen}:${identity.seq}`;
  const excluded = new Set((input.excludeEvents ?? []).map(eventKey));
  const allEvents = await input.ledger.readAllEvents();
  const keep = (event: StoredEvent): boolean => {
    if (event.type !== "inbound_message") return true;
    const sourceEvent = event.payload?.sourceEvent as EventIdentity | undefined;
    return !sourceEvent || !excluded.has(eventKey(sourceEvent));
  };
  const selectedEvents = excluded.size > 0
    ? allEvents.filter(keep)
    : allEvents;
  const reader: LedgerReader = {
    readAllEvents: async () => selectedEvents,
    readFromTail: async () => selectedEvents,
  };
  const messages: TurnMessage[] = llmMessagesToTurnHistory(
    await new ContextWindow(
      input.agentId,
      reader,
      input.blackboard,
    ).buildPrompt(),
  );
  if (messages.length === 0) return undefined;
  const lastTurnEnd = [...selectedEvents]
    .reverse()
    .find((event) => event.type === "hook:turnEnd");
  const throughTurnId =
    typeof lastTurnEnd?.payload?.turnId === "string"
      ? lastTurnEnd.payload.turnId
      : lastTurnEnd?.eventId;
  return Object.freeze({
    messages: Object.freeze(messages),
    ...(throughTurnId ? { throughTurnId } : {}),
  });
}
