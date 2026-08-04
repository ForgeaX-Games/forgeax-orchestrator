import type { TurnMessage } from '@forgeax/agent-runtime';
import type { HistoryCursor, HistoryEntry, HistoryUnavailable, KernelLane, PreparedHistory } from './types';

export interface HistorySource {
  read(): Promise<HistoryEntry[]>;
}

export interface LaneStore {
  get(kernelId: string): Promise<KernelLane | undefined>;
  put(lane: KernelLane): Promise<void>;
}

export interface PrepareOptions {
  kernelId: string;
  intake: 'structured' | 'text-bridge';
  nativeResumeAvailable: boolean;
  maxMessages?: number;
  forceSnapshot?: boolean;
}

function cursorKey(cursor?: HistoryCursor): string {
  return cursor ? `${cursor.shard}:${cursor.line}:${cursor.eventId}` : 'start';
}

function stablePatchId(lane: KernelLane, mode: string, messages: TurnMessage[]): string {
  const body = JSON.stringify([lane.laneId, lane.epoch, mode, messages]);
  let hash = 2166136261;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 16777619);
  return `history-${(hash >>> 0).toString(16)}`;
}

function estimateTokens(messages: TurnMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export class HistoryCoordinator {
  constructor(private readonly source: HistorySource, private readonly lanes: LaneStore) {}

  async prepare(options: PrepareOptions): Promise<PreparedHistory | HistoryUnavailable> {
    const entries = await this.source.read();
    const current = await this.lanes.get(options.kernelId);
    const lane: KernelLane = current && !current.invalidated
      ? current
      : { laneId: `${options.kernelId}-${crypto.randomUUID()}`, kernelId: options.kernelId, epoch: (current?.epoch ?? 0) + 1 };

    if (options.intake === 'structured') {
      const messages = this.project(entries, options.maxMessages);
      return this.result('authoritative', messages, lane, entries.at(-1)?.cursor);
    }

    const messages = current && options.nativeResumeAvailable && !options.forceSnapshot
      ? this.projectAfter(entries, current.knownThrough, options.maxMessages)
      : this.project(entries, options.maxMessages);
    const mode = current && options.nativeResumeAvailable && !options.forceSnapshot
      ? (messages.length ? 'delta' : 'none')
      : 'snapshot';
    if (!options.nativeResumeAvailable && current && !messages.length) {
      return { code: 'history_unavailable', message: 'Kernel resume is unavailable; a new lane is required.', retryable: true };
    }
    return this.result(mode, messages, lane, entries.at(-1)?.cursor, current?.knownThrough);
  }

  async commit(prepared: PreparedHistory, through: HistoryCursor): Promise<void> {
    await this.lanes.put({ ...prepared.lane, knownThrough: through, invalidated: false });
  }

  async invalidate(kernelId: string): Promise<void> {
    const lane = await this.lanes.get(kernelId);
    if (lane) await this.lanes.put({ ...lane, invalidated: true });
  }

  private result(mode: PreparedHistory['mode'], messages: TurnMessage[], lane: KernelLane, through?: HistoryCursor, from?: HistoryCursor): PreparedHistory {
    return { mode, messages, lane, through, from, patchId: stablePatchId(lane, mode, messages), estimatedTokens: estimateTokens(messages), redactedParts: 0 };
  }

  private project(entries: HistoryEntry[], maxMessages?: number): TurnMessage[] {
    const messages = entries.map((entry) => entry.message);
    return maxMessages ? messages.slice(-maxMessages) : messages;
  }

  private projectAfter(entries: HistoryEntry[], cursor?: HistoryCursor, maxMessages?: number): TurnMessage[] {
    if (!cursor) return this.project(entries, maxMessages);
    const index = entries.findIndex((entry) => cursorKey(entry.cursor) === cursorKey(cursor));
    if (index < 0) {
      const newer = entries.filter((entry) => entry.cursor.shard > cursor.shard || (entry.cursor.shard === cursor.shard && entry.cursor.line > cursor.line));
      if (newer.some((entry) => entry.semanticBoundary)) return this.project(entries, maxMessages);
      return this.project(newer, maxMessages);
    }
    if (entries.slice(index + 1).some((entry) => entry.semanticBoundary)) return this.project(entries, maxMessages);
    return this.project(entries.slice(index + 1), maxMessages);
  }
}
