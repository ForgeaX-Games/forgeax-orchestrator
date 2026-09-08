/**
 * Seal histories of ephemeral instances that were live when the process died.
 * This is history repair only: no RuntimeTree node or Controller is restored.
 */

import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import { EventStore } from "./event-store";
import {
  listPersistedInstanceEventStores,
} from "./session-event-reader";
import type { InstanceEventBinding, StoredEvent } from "./types";

const TERMINAL_TYPES = new Set([
  "agent.completed",
  "agent.cancelled",
  "agent.failed",
  "agent.disposed",
  "agent.aborted_by_restart",
  "agent.registration_failed",
]);

export async function recoverAbandonedEphemeralHistories(
  sid: string,
  sessionRoot: string,
): Promise<readonly string[]> {
  const recovered: string[] = [];
  for (const persisted of listPersistedInstanceEventStores(sessionRoot)) {
    if (persisted.kind !== "ephemeral") continue;
    const binding: InstanceEventBinding = {
      ownerInstanceId: persisted.ownerId,
      runtimeEpochId: "unknown",
      storeId: `recovery:${sid}:${persisted.ownerId}`,
      locator: {
        relativeDir: relative(sessionRoot, persisted.eventsDir).split(sep).join("/"),
      },
    };
    const store = new EventStore(binding, {
      eventsDir: persisted.eventsDir,
      blobsDir: persisted.blobsDir,
    });
    try {
      const events = await store.readAllEvents();
      if (!needsRecovery(events)) continue;
      const runtimeEpochId = findRuntimeEpoch(events) ?? "unknown";
      const event: StoredEvent = {
        eventId: randomUUID(),
        type: "agent.aborted_by_restart",
        ts: Date.now(),
        source: "runtime",
        owner: {
          kind: "agent",
          instanceId: persisted.ownerId,
          runtimeEpochId,
        },
        agentInstanceId: persisted.ownerId,
        runtimeEpochId,
        payload: {
          sid,
          instanceId: persisted.ownerId,
          runtimeEpochId,
          reason: "process restarted before a terminal event was persisted",
        },
      };
      await store.append(event, "required");
      await store.flush();
      recovered.push(persisted.ownerId);
    } finally {
      store.dispose();
    }
  }
  return Object.freeze(recovered);
}

function needsRecovery(events: readonly StoredEvent[]): boolean {
  if (!events.some((event) => event.type === "agent.registered")) return false;
  return !events.some((event) => TERMINAL_TYPES.has(event.type));
}

function findRuntimeEpoch(events: readonly StoredEvent[]): string | undefined {
  for (const event of events) {
    if (typeof event.runtimeEpochId === "string") return event.runtimeEpochId;
    if (
      event.owner?.kind === "agent" &&
      typeof event.owner.runtimeEpochId === "string"
    ) {
      return event.owner.runtimeEpochId;
    }
  }
  return undefined;
}
