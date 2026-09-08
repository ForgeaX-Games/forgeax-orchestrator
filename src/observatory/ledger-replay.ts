/**
 * Offline Session history replay across resident, ephemeral and global stores.
 * History files prove past facts only; this reader never reconstructs a live
 * RuntimeTree.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { PathManagerAPI } from "../fs/types";
import { parseEvents } from "../ledger/event-store";
import {
  listEventShards,
  listPersistedInstanceEventStores,
  listSessionGlobalEventFiles,
} from "../ledger/session-event-reader";
import type { StoredEvent } from "../ledger/types";

interface ReplayRow {
  readonly event: StoredEvent;
  readonly storeId: string;
  readonly shardIndex: number;
  readonly lineIndex: number;
}

export async function replaySessionEvents(
  sid: string,
  paths: PathManagerAPI,
): Promise<StoredEvent[]> {
  const sessionRoot = paths.session(sid).root();
  if (!existsSync(sessionRoot)) return [];
  const rows: ReplayRow[] = [];

  for (const store of listPersistedInstanceEventStores(sessionRoot)) {
    const shards = listEventShards(store.eventsDir);
    for (let shardIndex = 0; shardIndex < shards.length; shardIndex++) {
      try {
        const raw = await readFile(shards[shardIndex]!, "utf8");
        const events = parseEvents(raw, store.blobsDir);
        events.forEach((event, lineIndex) => rows.push({
          event,
          storeId: store.storeId,
          shardIndex,
          lineIndex,
        }));
      } catch (error) {
        process.stderr.write(
          `[observatory:replay] ${sid}/${store.storeId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
  }

  const globals = listSessionGlobalEventFiles(sessionRoot);
  for (let fileIndex = 0; fileIndex < globals.length; fileIndex++) {
    try {
      const raw = await readFile(globals[fileIndex]!, "utf8");
      parseEvents(raw).forEach((event, lineIndex) => rows.push({
        event,
        storeId: fileIndex === 0 ? "global:runtime" : "global:legacy",
        shardIndex: 0,
        lineIndex,
      }));
    } catch {
      // A corrupt legacy global log must not hide valid instance history.
    }
  }

  rows.sort(compareReplayRows);
  const seenEventIds = new Set<string>();
  const result: StoredEvent[] = [];
  for (const row of rows) {
    const eventId = typeof row.event.eventId === "string"
      ? row.event.eventId
      : undefined;
    if (eventId && seenEventIds.has(eventId)) continue;
    if (eventId) seenEventIds.add(eventId);
    result.push(row.event);
  }
  return result;
}

function compareReplayRows(a: ReplayRow, b: ReplayRow): number {
  if (
    a.event.sgen &&
    a.event.sgen === b.event.sgen &&
    typeof a.event.seq === "number" &&
    typeof b.event.seq === "number" &&
    a.event.seq !== b.event.seq
  ) {
    return a.event.seq - b.event.seq;
  }
  return a.event.ts - b.event.ts
    || a.storeId.localeCompare(b.storeId)
    || a.shardIndex - b.shardIndex
    || a.lineIndex - b.lineIndex;
}
