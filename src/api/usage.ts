/**
 * /api/usage — aggregates canonical per-instance usage facts.
 *
 * Resident and ephemeral EventStores are scanned through the same offline
 * enumerator. Session-global events are excluded. `turn.usage` wins over an
 * assistant display copy carrying the same usageId; legacy assistant-only
 * ledgers remain countable.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { getPathManager } from "../fs/path-manager";
import { parseEvents } from "../ledger/event-store";
import {
  listEventShards,
  listPersistedInstanceEventStores,
} from "../ledger/session-event-reader";
import type { StoredEvent } from "../ledger/types";
import { stableHash } from "../runtime/freeze";

interface UsageRow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface UsageReport {
  totals: UsageRow;
  byModel: Array<UsageRow & { model: string }>;
  bySession: Array<UsageRow & { sid: string }>;
  byDay: Array<UsageRow & { day: string }>;
  sourcedFrom: { sessionsScanned: number; eventsScanned: number };
}

interface UsageFact {
  readonly usageId: string;
  readonly sid: string;
  readonly ts: number;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly canonical: boolean;
}

export async function aggregateUsage(opts: {
  sessionIds: string[];
  sessionRoot: (sid: string) => string;
  sid?: string;
  since?: number;
}): Promise<UsageReport> {
  const totals = emptyRow();
  const byModel = new Map<string, UsageRow>();
  const bySession = new Map<string, UsageRow>();
  const byDay = new Map<string, UsageRow>();
  let sessionsScanned = 0;
  let eventsScanned = 0;
  const facts = new Map<string, UsageFact>();

  for (const sid of opts.sid ? [opts.sid] : opts.sessionIds) {
    const sessionRoot = opts.sessionRoot(sid);
    if (!existsSync(sessionRoot)) continue;
    sessionsScanned++;
    for (const store of listPersistedInstanceEventStores(sessionRoot)) {
      const shards = listEventShards(store.eventsDir);
      for (let shardIndex = 0; shardIndex < shards.length; shardIndex++) {
        let events: StoredEvent[];
        try {
          events = parseEvents(await readFile(shards[shardIndex]!, "utf8"));
        } catch {
          continue;
        }
        eventsScanned += events.length;
        for (let lineIndex = 0; lineIndex < events.length; lineIndex++) {
          const event = events[lineIndex]!;
          const fact = toUsageFact(
            event,
            sid,
            store.storeId,
            shardIndex,
            lineIndex,
          );
          if (!fact) continue;
          if (typeof opts.since === "number" && fact.ts < opts.since) continue;
          const existing = facts.get(fact.usageId);
          if (!existing || (!existing.canonical && fact.canonical)) {
            facts.set(fact.usageId, fact);
          }
        }
      }
    }
  }

  for (const fact of facts.values()) {
    bump(totals, fact.inputTokens, fact.outputTokens);
    bump(mapRow(byModel, fact.model), fact.inputTokens, fact.outputTokens);
    bump(mapRow(bySession, fact.sid), fact.inputTokens, fact.outputTokens);
    bump(mapRow(byDay, dayKey(fact.ts)), fact.inputTokens, fact.outputTokens);
  }

  return {
    totals,
    byModel: [...byModel].map(([model, row]) => ({ model, ...row }))
      .sort((a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
      ),
    bySession: [...bySession].map(([sid, row]) => ({ sid, ...row }))
      .sort((a, b) => b.calls - a.calls),
    byDay: [...byDay].map(([day, row]) => ({ day, ...row }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    sourcedFrom: { sessionsScanned, eventsScanned },
  };
}

function toUsageFact(
  event: StoredEvent,
  sid: string,
  storeId: string,
  shardIndex: number,
  lineIndex: number,
): UsageFact | null {
  const canonical = event.type === "turn.usage";
  if (!canonical && event.type !== "hook:assistantMessage") return null;
  const payload = event.payload ?? {};
  const usage = (
    payload.usage && typeof payload.usage === "object"
      ? payload.usage
      : payload
  ) as Record<string, unknown>;
  const inputTokens = numberField(usage.inputTokens, usage.input_tokens);
  const outputTokens = numberField(usage.outputTokens, usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const explicitUsageId =
    stringField(payload.usageId) ??
    stringField(usage.usageId) ??
    stringField(event.eventId);
  const usageId = explicitUsageId ?? `legacy_${stableHash({
    sid,
    storeId,
    shardIndex,
    lineIndex,
    ts: event.ts,
    type: event.type,
  })}`;
  return {
    usageId,
    sid,
    ts: event.ts,
    model: stringField(payload.model) ?? stringField(usage.model) ?? "unknown",
    inputTokens,
    outputTokens,
    canonical,
  };
}

function numberField(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function emptyRow(): UsageRow {
  return { calls: 0, inputTokens: 0, outputTokens: 0 };
}

function mapRow(map: Map<string, UsageRow>, key: string): UsageRow {
  let row = map.get(key);
  if (!row) {
    row = emptyRow();
    map.set(key, row);
  }
  return row;
}

function bump(row: UsageRow, input: number, output: number): void {
  row.calls++;
  row.inputTokens += input;
  row.outputTokens += output;
}

function dayKey(ts: number): string {
  const date = new Date(ts);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function createUsageRouter() {
  const router = new Hono();
  router.get("/", async (context) => {
    const sid = context.req.query("sid") || undefined;
    const sinceRaw = context.req.query("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const paths = getPathManager();
    return context.json(await aggregateUsage({
      sessionIds: paths.listSessionIds(),
      sessionRoot: (sessionId) => paths.session(sessionId).root(),
      ...(sid ? { sid } : {}),
      ...(Number.isFinite(since) ? { since } : {}),
    }));
  });
  return router;
}
