/** Whitelist public occupancy fields; do not promote arbitrary kernel history. */
export function publicContextUsage(record: Record<string, unknown>) {
  if (record.type !== 'context.usage' || !record.payload || typeof record.payload !== 'object') return null;
  const p = record.payload as Record<string, unknown>;
  const { inputTokens, outputTokens, contextWindow } = p;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0 ||
      typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0 ||
      typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return { type: 'context.usage', ts: typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : Date.now(),
    payload: { inputTokens, outputTokens, contextWindow } };
}
