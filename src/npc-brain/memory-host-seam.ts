import type {
  NpcMemoryReaderV1,
  NpcMemoryRecallRequestV1,
  NpcMemoryRecallResultV1,
  NpcMemorySubjectV1,
} from '@forgeax/types/npc-memory';
import { NpcMemoryRecallResultV1Schema } from '@forgeax/types/npc-memory';
import type { NpcDecisionWire, PerceptionSnapshot } from './protocol';

/** Runtime policy for the optional memory reader.  `off` is intentionally a
 * zero-call path; the Brain's legacy prompt remains the owner of that mode. */
export type NpcMemoryProviderMode = 'off' | 'shadow' | 'active';
/** Whether an injected memory authority may receive provider-owned writes. */
export type NpcMemoryWritePolicy = 'deny' | 'configured-writer';

/**
 * The only memory capability that the Brain receives.  Provider resolution,
 * scope construction and lifecycle ownership stay outside the decision loop;
 * this binding is intentionally small enough for tests and for a host to
 * replace File with a read-only ASIW/reference provider.
 */
export interface NpcMemoryRuntimeBinding {
  readonly mode: NpcMemoryProviderMode;
  /** Missing is fail-closed and is treated as `deny`. */
  readonly writePolicy?: NpcMemoryWritePolicy;
  readonly reader?: Pick<NpcMemoryReaderV1, 'recall'> & Partial<Pick<NpcMemoryReaderV1, 'preload'>>;
  readonly subjectFor: (input: {
    readonly game: string;
    readonly playerId: string;
    readonly npcId: string;
    readonly soulId: string;
  }) => NpcMemorySubjectV1;
  /** Product-owned typed adapter. The generic Brain must not guess game time,
   * dialogue state, partner identity, or canonical trigger semantics. */
  readonly recallRequestFor: (input: {
    readonly subject: NpcMemorySubjectV1;
    readonly snapshot: PerceptionSnapshot;
    readonly playerId: string;
    readonly soulId: string;
    readonly history: readonly {
      readonly snapshot: PerceptionSnapshot;
      readonly decision: NpcDecisionWire;
    }[];
  }) => NpcMemoryRecallRequestV1;
  readonly preload?: (subjects: readonly NpcMemorySubjectV1[], signal: AbortSignal) => Promise<unknown>;
  readonly audit?: (event: NpcMemoryRecallAuditEvent | {
    readonly operation: 'commit' | 'settle' | 'unsupported' | 'handoff' | 'shadow-diff';
    readonly ownerNpcId: string;
    readonly eventId?: string;
    readonly commandId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly error?: unknown;
  }) => void;
  /** Optional durable handoff. If supplied, the writer is invoked only by it. */
  readonly enqueueHandoff?: (input: {
    readonly handoffId: string;
    readonly eventId: string;
    readonly decisionHash: string;
    readonly decision: unknown;
    readonly commands: readonly {
      readonly commandId: string;
      readonly scopeKey: string;
      readonly idempotencyKey: string;
      readonly commandHash: string;
      readonly payload: unknown;
    }[];
  }) => Promise<unknown>;
  /** Optional crash-replay lookup owned by the durable outbox. */
  readonly readHandoff?: (handoffId: string) => {
    readonly eventId: string;
    readonly decisionHash: string;
    readonly decision: unknown;
    readonly commands: readonly unknown[];
  } | undefined;
}

export interface NpcMemoryRecallAuditEvent {
  readonly operation: 'recall';
  readonly mode: NpcMemoryProviderMode;
  readonly ownerNpcId: string;
  readonly eventId?: string;
  readonly status: 'skipped' | 'succeeded' | 'failed' | 'expired';
  readonly reason?: 'off' | 'missing-reader' | 'deadline' | 'aborted' | 'provider-error';
  readonly latencyMs?: number;
}

/** Narrow injection point for the Brain.  It deliberately contains no fetch,
 * refresh, writer, or File-root capability. */
export interface NpcMemoryReaderHostSeam {
  readonly mode: NpcMemoryProviderMode;
  readonly reader?: Pick<NpcMemoryReaderV1, 'recall'>;
  readonly now?: () => number;
  readonly audit?: (event: NpcMemoryRecallAuditEvent) => void;
}

export interface NpcMemoryRecallDeadline {
  /** Captured once by the caller at admission; never extended by this helper. */
  readonly decisionDeadlineAt: number;
  readonly memoryRecallBudgetMs?: number;
  readonly signal?: AbortSignal;
}

export interface NpcMemoryRecallInput extends NpcMemoryRecallDeadline {
  readonly request: NpcMemoryRecallRequestV1;
  readonly ownerNpcId: string;
  /** Product event correlation. Omitted when the caller has no real event id. */
  readonly eventId?: string;
}

export interface NpcMemoryRecallOutcome {
  readonly result?: NpcMemoryRecallResultV1;
  readonly deadlineAt: number;
  readonly status: 'skipped' | 'succeeded' | 'failed' | 'expired';
}

function emit(host: NpcMemoryReaderHostSeam, event: NpcMemoryRecallAuditEvent): void {
  try { host.audit?.(event); } catch { /* observability must not alter decision flow */ }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('NPC memory recall aborted');
}

/**
 * Runs one cache-only recall under the already-admitted absolute deadline.
 * Provider errors are intentionally converted to an empty outcome so the
 * caller can continue with a no-memory model prompt.  The reader receives a
 * child signal and cannot extend the parent deadline.
 */
export async function recallNpcMemory(
  host: NpcMemoryReaderHostSeam,
  input: NpcMemoryRecallInput,
): Promise<NpcMemoryRecallOutcome> {
  const now = host.now ?? Date.now;
  const audit = (event: NpcMemoryRecallAuditEvent): void => emit(host, {
    ...event,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
  });
  const startedAt = now();
  const deadlineAt = Math.min(
    input.decisionDeadlineAt,
    input.memoryRecallBudgetMs === undefined
      ? input.decisionDeadlineAt
      : startedAt + Math.max(0, input.memoryRecallBudgetMs),
  );
  if (host.mode === 'off') {
    // Off is the exact legacy path: no provider call and no new audit/log
    // dependency. Callers may still inspect the returned skipped status.
    return { deadlineAt, status: 'skipped' };
  }
  if (!host.reader) {
    audit({ operation: 'recall', mode: host.mode, ownerNpcId: input.ownerNpcId, status: 'skipped', reason: 'missing-reader' });
    return { deadlineAt, status: 'skipped' };
  }
  const remaining = deadlineAt - startedAt;
  if (remaining <= 0) {
    audit({ operation: 'recall', mode: host.mode, ownerNpcId: input.ownerNpcId, status: 'expired', reason: 'deadline', latencyMs: 0 });
    return { deadlineAt, status: 'expired' };
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason ?? new Error('NPC memory recall aborted'));
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (controller.signal.aborted) {
    audit({ operation: 'recall', mode: host.mode, ownerNpcId: input.ownerNpcId, status: 'failed', reason: 'aborted', latencyMs: 0 });
    input.signal?.removeEventListener('abort', abortFromParent);
    return { deadlineAt, status: 'failed' };
  }
  const timeout = setTimeout(() => controller.abort(new Error('NPC memory recall timed out')), remaining);
  try {
    const result = await Promise.race([
      host.reader.recall({ ...input.request, signal: controller.signal }),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(abortError(controller.signal)), { once: true })),
    ]);
    const latencyMs = Math.max(0, now() - startedAt);
    if (now() >= deadlineAt) {
      audit({ operation: 'recall', mode: host.mode, ownerNpcId: input.ownerNpcId, status: 'expired', reason: 'deadline', latencyMs });
      return { deadlineAt, status: 'expired' };
    }
    const parsed = NpcMemoryRecallResultV1Schema.parse(result);
    audit({ operation: 'recall', mode: host.mode, ownerNpcId: input.ownerNpcId, status: 'succeeded', latencyMs });
    return { deadlineAt, status: 'succeeded', result: parsed };
  } catch (error) {
    const latencyMs = Math.max(0, now() - startedAt);
    const aborted = controller.signal.aborted;
    const expired = now() >= deadlineAt;
    const status = expired ? 'expired' : 'failed';
    audit({
      operation: 'recall', mode: host.mode, ownerNpcId: input.ownerNpcId, status,
      reason: expired ? 'deadline' : aborted ? 'aborted' : 'provider-error', latencyMs,
    });
    return { deadlineAt, status };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

export interface NpcMemoryBatchRecallInput extends NpcMemoryRecallInput {
  readonly npcId: string;
}

/** Each member owns an independent child signal and deadline.  A slow or
 * failed member never rejects the batch and never delays other members. */
export async function recallNpcMemoryBatch(
  host: NpcMemoryReaderHostSeam,
  inputs: readonly NpcMemoryBatchRecallInput[],
): Promise<readonly (NpcMemoryBatchRecallInput & { readonly outcome: NpcMemoryRecallOutcome })[]> {
  return Promise.all(inputs.map(async (input) => ({
    ...input,
    outcome: await recallNpcMemory(host, input),
  })));
}
