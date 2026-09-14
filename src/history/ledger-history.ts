import type { TurnMessage } from '@forgeax/agent-runtime';
import type { EventLedger, LedgerCursor } from '../ledger/event-ledger';
import type { StoredEvent } from '../ledger/types';
import type { HistoryEntry, KernelLane } from './types';
import type { HistorySource, LaneStore } from './coordinator';

export const REPLAY_TOOL_PREVIEW_CHARS = 8_000;
// Text-bridge history has no provider-side compaction before admission. Reserve
// a bounded excerpt budget across results, not 8 KB multiplied by every tool.
export const TEXT_BRIDGE_TOOL_PREVIEW_BUDGET_CHARS = 128_000;


function textFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return JSON.stringify(value ?? '') ?? '';
}

function messageOf(event: StoredEvent): TurnMessage | null {
  const payload = event.payload ?? {};
  if (event.type === 'user_input' || event.type === 'inbound_message') {
    const llm = payload.llmMessage as TurnMessage | undefined;
    if (llm?.role === 'user') return llm;
    return { role: 'user', content: textFrom(payload.content ?? payload.message) };
  }
  if (event.type === 'hook:assistantMessage' || event.type === 'assistant.message') {
    const llm = payload.llmMessage as TurnMessage | undefined;
    if (llm?.role === 'assistant') return llm;
    return { role: 'assistant', content: textFrom(payload.content) };
  }
  if (event.type === 'hook:toolResult' || event.type === 'tool.result') {
    const callId = typeof payload.callId === 'string' ? payload.callId : 'unknown-tool';
    return {
      role: 'tool', callId, ok: payload.ok !== false,
      ...(payload.result !== undefined ? { result: payload.result } : {}),
      ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
    };
  }
  return null;
}

export class LedgerHistorySource implements HistorySource {
  constructor(private readonly ledger: EventLedger, private readonly toolPreviewBudgetChars = Infinity) {}

  async read(): Promise<HistoryEntry[]> {
    const rows = await this.ledger.readAllWithCursors();
    const entries: HistoryEntry[] = [];
    const projectedInputs = new Set(rows.filter((row) => row.event.type === 'inbound_message')
      .map((row) => row.event.payload?.sourceEventId).filter((id): id is string => typeof id === 'string'));
    for (const row of rows) {
      if (row.event.type === 'user_input' && typeof row.event.eventId === 'string' && projectedInputs.has(row.event.eventId)) continue;
      const message = messageOf(row.event);
      if (!message) continue;
      const payload = row.event.payload ?? {};
      const history = row.event.history as { origin?: { kernelId?: string }; turnId?: string } | undefined;
      const kernelId = history?.origin?.kernelId
        ?? (typeof payload.providerId === 'string' ? payload.providerId : undefined);
      const turnId = history?.turnId
        ?? (typeof payload.turnId === 'string' ? payload.turnId : `${row.cursor.shard}:${row.cursor.line}`);
      const boundary = row.event.type === 'compaction.applied' || row.event.type === 'compaction.revoked'
        ? 'compaction'
        : row.event.type === 'rewind.applied' || row.event.type === 'rewind.revoked'
          ? 'rewind'
          : undefined;
      entries.push({ cursor: row.cursor, ts: row.event.ts, turnId, message, ...(kernelId ? { kernelId } : {}), ...(boundary ? { semanticBoundary: boundary } : {}) });
    }
    // Prefer recent evidence. Older outputs retain their status and a durable
    // cursor; this is an excerpt projection, never a semantic compaction.
    let remaining = this.toolPreviewBudgetChars;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      const message = entry.message;
      if (message.role !== 'tool') continue;
      const value = message.result ?? message.error ?? '';
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      const available = Math.max(0, Math.min(REPLAY_TOOL_PREVIEW_CHARS, remaining));
      remaining -= Math.min(serialized.length, available);
      if (serialized.length <= available) continue;
      const head = Math.ceil(available * 3 / 4);
      const tail = available - head;
      entry.message = {
        ...message,
        ...(message.error ? { error: 'Error details retained in the referenced session event.' } : {}),
        result: {
          preview: available > 0
            ? serialized.slice(0, head)
              + '\n[Middle omitted from replay; full output retained in session event history.]\n'
              + (tail > 0 ? serialized.slice(-tail) : '')
            : '[Output omitted from replay; full output retained in session event history.]',
          originalCharacters: serialized.length,
          historyReference: { ...entry.cursor, field: message.result !== undefined ? 'payload.result' : 'payload.error' },
        },
      };
    }
    return entries;
  }
}

const CONTROL_TYPES = new Set(['kernel_lane_bound', 'kernel_history_dispatching', 'kernel_history_applied', 'kernel_lane_invalidated']);

export class LedgerLaneStore implements LaneStore {
  constructor(private readonly ledger: EventLedger) {}

  async get(kernelId: string): Promise<KernelLane | undefined> {
    const rows = await this.ledger.readAllWithCursors();
    let lane: KernelLane | undefined;
    for (const row of rows) {
      if (!CONTROL_TYPES.has(row.event.type)) continue;
      const p = row.event.payload ?? {};
      if (p.kernelId !== kernelId) continue;
      if (row.event.type === 'kernel_lane_bound') {
        lane = {
          laneId: String(p.laneId), kernelId, epoch: Number(p.epoch ?? 1),
          ...(typeof p.nativeSessionRef === 'string' ? { nativeSessionRef: p.nativeSessionRef } : {}),
        };
      } else if (lane && p.laneId === lane.laneId && p.epoch === lane.epoch && row.event.type === 'kernel_history_applied') {
        const cursor = p.knownThrough as KernelLane['knownThrough'];
        lane = { ...lane, ...(cursor ? { knownThrough: cursor } : {}) };
      } else if (lane && p.laneId === lane.laneId && p.epoch === lane.epoch && row.event.type === 'kernel_lane_invalidated') {
        lane = { ...lane, invalidated: true };
      }
    }
    return lane;
  }

  async put(lane: KernelLane): Promise<void> {
    const event = (type: string, payload: Record<string, unknown>) => ({ type, ts: Date.now(), source: 'history-coordinator', payload } as never);
    if (lane.invalidated) {
      this.ledger.append(event('kernel_lane_invalidated', { laneId: lane.laneId, kernelId: lane.kernelId, epoch: lane.epoch, reason: 'resume_failed' }));
      return;
    }
    const existing = await this.get(lane.kernelId);
    if (!existing || existing.laneId !== lane.laneId || existing.epoch !== lane.epoch) {
      this.ledger.append(event('kernel_lane_bound', { laneId: lane.laneId, kernelId: lane.kernelId, epoch: lane.epoch }));
    }
    if (lane.knownThrough) {
      this.ledger.append(event('kernel_history_applied', {
        laneId: lane.laneId, kernelId: lane.kernelId, epoch: lane.epoch, knownThrough: lane.knownThrough,
      }));
    }
  }
}

export function cursorFromLedger(cursor: LedgerCursor): import('./types').HistoryCursor {
  return cursor;
}
