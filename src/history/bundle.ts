import { createHash } from 'node:crypto';
import type { HistoryEntry } from './types';
import { redactHistoryEntries } from './redactor';

export interface HistoryBundle {
  version: 1;
  sourceSid: string;
  sourceAgentId: string;
  createdAt: string;
  items: HistoryEntry[];
  digest: string;
  redactionPolicy: 'portable-v1';
  redactedParts: number;
}

function canonical(items: HistoryEntry[]): string {
  return JSON.stringify(items);
}

export function createHistoryBundle(sourceSid: string, sourceAgentId: string, items: HistoryEntry[]): HistoryBundle {
  const redacted = redactHistoryEntries(items);
  const digest = createHash('sha256').update(canonical(redacted.items)).digest('hex');
  return {
    version: 1,
    sourceSid,
    sourceAgentId,
    createdAt: new Date().toISOString(),
    items: redacted.items,
    digest,
    redactionPolicy: 'portable-v1',
    redactedParts: redacted.redactedParts,
  };
}

export function verifyHistoryBundle(bundle: unknown): asserts bundle is HistoryBundle {
  if (!bundle || typeof bundle !== 'object') throw new Error('history_bundle_invalid');
  const value = bundle as Partial<HistoryBundle>;
  if (value.version !== 1 || typeof value.sourceSid !== 'string' || typeof value.sourceAgentId !== 'string' || !Array.isArray(value.items) || typeof value.digest !== 'string' || value.redactionPolicy !== 'portable-v1' || !Number.isInteger(value.redactedParts)) {
    throw new Error('history_bundle_invalid');
  }
  const expected = createHash('sha256').update(canonical(value.items)).digest('hex');
  if (expected !== value.digest) throw new Error('history_bundle_digest_mismatch');
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || typeof item.turnId !== 'string' || !item.cursor || typeof item.cursor.eventId !== 'string') throw new Error('history_bundle_invalid');
  }
}

export function cloneHistoryBundle(bundle: unknown, newSid: string, agentId: string): HistoryEntry[] {
  verifyHistoryBundle(bundle);
  if (!newSid || newSid === bundle.sourceSid) throw new Error('history_clone_requires_new_session');
  if (!agentId || agentId.includes('..') || agentId.startsWith('/')) throw new Error('history_permission_denied');
  return bundle.items.map((item) => ({ ...item, cursor: { ...item.cursor, eventId: `import:${item.cursor.eventId}` } }));
}
