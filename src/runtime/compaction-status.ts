/** Promote only the public lifecycle contract; arbitrary stored-event payloads
 * remain private. Neither diagnostics nor compaction replacements cross here. */
export function publicCompactionStatus(record: Record<string, unknown>): {
  type: 'compaction.status'; ts: number; payload: Record<string, unknown>;
} | null {
  if (record.type !== 'compaction.status') return null;
  const p = record.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const data = p as Record<string, unknown>;
  if (data.visibility === 'private_reasoning') return null;
  if (data.phase !== 'started' && data.phase !== 'completed' && data.phase !== 'failed' && data.phase !== 'cancelled') return null;
  if (typeof data.id !== 'string' || !data.id || data.id.length > 200) return null;
  if (!Number.isSafeInteger(data.count) || (data.count as number) < 1) return null;
  const duration = data.durationMs;
  return {
    type: 'compaction.status',
    ts: typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : Date.now(),
    payload: {
      id: data.id, phase: data.phase, count: data.count,
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    },
  };
}
