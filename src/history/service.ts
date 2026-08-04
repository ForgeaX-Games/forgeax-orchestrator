import type { TurnMessage } from '@forgeax/agent-runtime';
import type { Session } from '../core/session';
import { LedgerHistorySource } from './ledger-history';
import type { HistoryEntry } from './types';
import { createHistoryBundle, type HistoryBundle } from './bundle';

export interface HistoryQuery {
  agentId: string;
  kernelId?: string;
  since?: number;
  until?: number;
  after?: string;
  limit?: number;
}

export interface HistoryPage {
  items: Array<HistoryEntry & { message: TurnMessage }>;
  next?: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): { shard: number; line: number; eventId: string } {
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { shard?: number; line?: number; eventId?: string };
  if (!Number.isInteger(parsed.shard) || !Number.isInteger(parsed.line) || typeof parsed.eventId !== 'string') throw new Error('invalid history cursor');
  return { shard: parsed.shard!, line: parsed.line!, eventId: parsed.eventId! };
}

export class HistoryService {
  constructor(private readonly session: Session) {}

  async query(input: HistoryQuery): Promise<HistoryPage> {
    if (!input.agentId || input.agentId.includes('..') || input.agentId.startsWith('/')) throw new Error('history_permission_denied');
    const ledger = this.session.ledgers.get(input.agentId);
    if (!ledger) return { items: [] };
    const after = input.after ? decode(input.after) : undefined;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const entries = await new LedgerHistorySource(ledger).read();
    const filtered = entries.filter((entry) => {
      if (input.kernelId && entry.kernelId !== input.kernelId) return false;
      if (input.since !== undefined && (entry.ts ?? 0) < input.since) return false;
      if (input.until !== undefined && (entry.ts ?? 0) > input.until) return false;
      if (after && (entry.cursor.shard < after.shard || (entry.cursor.shard === after.shard && entry.cursor.line <= after.line))) return false;
      return true;
    });
    const items = filtered.slice(0, limit);
    const last = items.at(-1);
    return { items, ...(filtered.length > limit && last ? { next: encode(last.cursor) } : {}) };
  }

  async export(input: { agentId: string; kernelId?: string }): Promise<HistoryBundle> {
    const page = await this.query({ ...input, limit: 500 });
    if (page.next) throw new Error('history_export_too_large');
    return createHistoryBundle(this.session.sid, input.agentId, page.items);
  }
}
