import type { StoredEvent } from "./types";
import { walkAndReinflate, LedgerBlobMissingError } from "./event-blob";

export { LedgerBlobMissingError };

export function parseEvents(raw: string, blobsDir?: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as StoredEvent);
    } catch {
      // A partial final line is recoverable; subsequent valid lines still load.
    }
  }
  if (blobsDir) {
    for (const event of events) {
      if (event.payload && typeof event.payload === "object") {
        walkAndReinflate(event.payload, blobsDir);
      }
    }
  }
  return events;
}
