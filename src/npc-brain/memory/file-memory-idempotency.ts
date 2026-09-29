import { createHash } from 'node:crypto';
import { canonicalJson, type FileSoulMemoryScopeV1 } from '@forgeax/types/npc-memory';

export function normalizeFileMemoryFactText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/** Frozen §5.4 identity shared by the Brain outbox and File writer ledger. */
export function fileMemoryFactIdempotencyKey(
  scope: FileSoulMemoryScopeV1,
  sourceEventId: string,
  kind: 'episode' | 'trait',
  text: string,
): string {
  const canonicalScope = canonicalJson(scope);
  const normalized = normalizeFileMemoryFactText(text);
  return createHash('sha256')
    .update(`${canonicalScope}\n${sourceEventId}\n${kind}\n${normalized}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** Settlement is one durable episode command, keyed independently from the
 * fact formula so retries bind to the frozen working-log settlement id. */
export function fileMemorySettlementIdempotencyKey(
  scope: FileSoulMemoryScopeV1,
  settlementId: string,
): string {
  return createHash('sha256')
    .update(`${canonicalJson(scope)}\nsettlement\n${settlementId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}
