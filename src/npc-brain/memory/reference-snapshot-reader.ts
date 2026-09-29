/**
 * Forge-only reference snapshot Reader.
 *
 * The source boundary is intentionally tiny: the provider can ask the host
 * for an allowlisted fixture, but it cannot fetch, open paths, or write.
 * Reference fixtures exercise the provider seam and are never ASIW parity
 * evidence.  See digital-life-foundation §4.3.
 */
import { z } from 'zod';
import {
  NpcMemoryRecallRequestV1Schema,
  NpcMemoryRecallResultV1Schema,
  ReferenceFixtureReadResultV1Schema,
  ReferenceMemoryScopeV1Schema,
  ReferenceSnapshotFixtureV1Schema,
  canonicalJson,
  computeReferenceFixtureContentHashV1,
  sha256CanonicalJson,
  parseNpcMemoryRecallRequestV1,
  parseReferenceSnapshotFixtureV1,
  verifyReferenceFixtureContentHashV1,
  type NpcMemoryProviderFactoryV1,
  type NpcMemoryProviderDescriptorV1,
  type NpcMemoryProviderScopeV1,
  type NpcMemoryReaderHostV1,
  type NpcMemoryReaderV1,
  type NpcMemoryRecallRequestV1,
  type NpcMemoryRecallResultV1,
  type NpcMemoryRefreshReceiptV1,
  type NpcMemorySubjectV1,
  type ReferenceFixtureReadResultV1,
  type ReferenceMemoryScopeV1,
  type ReferenceSnapshotFixtureV1,
} from '@forgeax/types/npc-memory';
import type { ReferenceFixtureEntryV1 } from './reference-snapshot-fixture';

export const REFERENCE_SNAPSHOT_READER_ID = 'reference-snapshot-reader' as const;

export const REFERENCE_SNAPSHOT_READER_DESCRIPTOR = Object.freeze({
  id: REFERENCE_SNAPSHOT_READER_ID,
  abiVersion: 1 as const,
  roles: ['reader'] as const,
  capabilities: ['reference-fixture-read', 'recall-raw-blocks'] as const,
  stateSchemaVersions: [1] as const,
  rawRecallVersions: [1] as const,
  integrityProfiles: [] as const,
}) as unknown as NpcMemoryProviderDescriptorV1;

/** Config is intentionally a closed allowlist.  It has no path, URL, fetch,
 * credential, or arbitrary source selector. */
const ReferenceReaderAllowedSubjectSchema = z.object({
  fixtureId: z.string().min(1).max(256).refine((value) => value.trim() === value && !value.includes('\u0000')),
  clockDomainId: z.string().min(1).max(256).refine((value) => value.trim() === value && !value.includes('\u0000')),
  ownerNpcId: z.string().min(1).max(256).refine((value) => value.trim() === value && !value.includes('\u0000')),
  soulId: z.string().min(1).max(256).refine((value) => value.trim() === value && !value.includes('\u0000')),
}).strict();

export const ReferenceSnapshotReaderConfigV1Schema = z.object({
  allowedSubjects: z.array(ReferenceReaderAllowedSubjectSchema).min(1).max(128),
  /** Optional fixture freshness bound.  Infinity is the fixture-test default. */
  maxAgeMs: z.number().finite().nonnegative().optional(),
}).strict().superRefine((config, ctx) => {
  const seenFixtures = new Map<string, string>();
  const seenSubjects = new Set<string>();
  for (const [index, allowed] of config.allowedSubjects.entries()) {
    const fixtureKey = `${allowed.fixtureId}\u0000${allowed.clockDomainId}`;
    const subjectKey = `${fixtureKey}\u0000${allowed.ownerNpcId}\u0000${allowed.soulId}`;
    if (seenSubjects.has(subjectKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedSubjects', index], message: 'duplicate allowed subject' });
    }
    seenSubjects.add(subjectKey);
    const priorSubject = seenFixtures.get(fixtureKey);
    const currentSubject = `${allowed.ownerNpcId}\u0000${allowed.soulId}`;
    if (priorSubject !== undefined && priorSubject !== currentSubject) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedSubjects', index], message: 'one fixture scope may bind only one owner subject' });
    }
    seenFixtures.set(fixtureKey, currentSubject);
  }
});
export type ReferenceSnapshotReaderConfigV1 = z.infer<typeof ReferenceSnapshotReaderConfigV1Schema>;

export const REFERENCE_SNAPSHOT_READER_MANIFEST = Object.freeze({
  id: REFERENCE_SNAPSHOT_READER_ID,
  abiVersion: 1 as const,
  entry: './src/npc-brain/memory/reference-snapshot-reader.ts',
  exportName: 'referenceSnapshotReaderFactory',
  descriptor: REFERENCE_SNAPSHOT_READER_DESCRIPTOR,
  requestedPermissions: ['fixture:reference-read'] as const,
});

export type ReferenceSnapshotReaderErrorCode =
  | 'not_started'
  | 'stopped'
  | 'scope_denied'
  | 'schema_incompatible'
  | 'integrity_failed'
  | 'scope_mismatch'
  | 'stale_snapshot'
  | 'missing_snapshot'
  | 'identity_unresolved'
  | 'source_failed';

export class ReferenceSnapshotReaderError extends Error {
  readonly code: ReferenceSnapshotReaderErrorCode;

  constructor(code: ReferenceSnapshotReaderErrorCode, message: string) {
    super(message);
    this.name = 'ReferenceSnapshotReaderError';
    this.code = code;
  }
}

interface CachedFixture {
  readonly scopeKey: string;
  readonly fixture: ReferenceSnapshotFixtureV1;
  readonly etag: string;
  readonly loadedAtWallMs: number;
}

interface AllowedSubject {
  readonly fixtureId: string;
  readonly clockDomainId: string;
  readonly ownerNpcId: string;
  readonly soulId: string;
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}

async function waitForWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child) => freezeDeep(child, seen));
  } else {
    Object.values(value as Record<string, unknown>).forEach((child) => freezeDeep(child, seen));
  }
  return Object.freeze(value);
}

function keyForScope(scope: ReferenceMemoryScopeV1): string {
  return canonicalJson(scope);
}

function keyForSubject(subject: NpcMemorySubjectV1): string {
  return canonicalJson({
    scope: subject.scope,
    ownerNpcId: subject.ownerNpcId,
    soulId: subject.soulId,
  });
}

function subjectFromAllowed(allowed: AllowedSubject): NpcMemorySubjectV1 {
  return {
    scope: {
      authority: 'reference-fixture',
      fixtureId: allowed.fixtureId,
      clockDomainId: allowed.clockDomainId,
    },
    ownerNpcId: allowed.ownerNpcId,
    soulId: allowed.soulId,
  };
}

function sameScope(left: ReferenceMemoryScopeV1, right: ReferenceMemoryScopeV1): boolean {
  return left.fixtureId === right.fixtureId
    && left.clockDomainId === right.clockDomainId
    && left.authority === right.authority;
}

function sameOwner(left: { ownerNpcId: string; soulId: string }, right: { ownerNpcId: string; soulId: string }): boolean {
  return left.ownerNpcId === right.ownerNpcId && left.soulId === right.soulId;
}

function fixtureEntry(value: unknown): ReferenceFixtureEntryV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string'
    || typeof candidate.ownerNpcId !== 'string'
    || typeof candidate.soulId !== 'string'
    || (candidate.kind !== 'trait' && candidate.kind !== 'episode')
    || typeof candidate.text !== 'string') return null;
  if (candidate.partnerEntityId !== undefined && typeof candidate.partnerEntityId !== 'string') return null;
  if (candidate.observedAt !== undefined && typeof candidate.observedAt !== 'number') return null;
  return candidate as unknown as ReferenceFixtureEntryV1;
}

/**
 * The fixture's deterministic moving part.  The state has already passed the
 * shared state schema; this function owns only the fixture's opaque entry
 * shape and selects by the requested owner before sorting by stable id.
 */
export function buildReferenceRawBlocksV1(
  fixture: ReferenceSnapshotFixtureV1,
  subject: NpcMemorySubjectV1,
  request: NpcMemoryRecallRequestV1,
  resolvePartner: (entityId: string) => boolean,
): readonly { name: string; text: string }[] {
  const entries = fixture.state.entries
    .map(fixtureEntry)
    .filter((entry): entry is ReferenceFixtureEntryV1 => entry !== null)
    .filter((entry) => entry.ownerNpcId === subject.ownerNpcId && entry.soulId === subject.soulId)
    .filter((entry) => {
      if (entry.partnerEntityId === undefined) return true;
      return request.partnerEntityId === entry.partnerEntityId && resolvePartner(entry.partnerEntityId);
    })
    // Code-unit ordering is deterministic across hosts; localeCompare is not.
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  const byKind = new Map<'trait' | 'episode', string[]>();
  byKind.set('trait', []);
  byKind.set('episode', []);
  for (const entry of entries) byKind.get(entry.kind)?.push(entry.text);

  return (['trait', 'episode'] as const)
    .map((kind) => ({ name: `${kind}s`, text: byKind.get(kind)?.join('\n') ?? '' }))
    .filter((block) => block.text.length > 0);
}

function applyBudget(
  blocks: readonly { name: string; text: string }[],
  request: NpcMemoryRecallRequestV1,
): readonly { name: string; text: string }[] {
  const limited = request.budget.mode === 'legacy-exact'
    ? blocks
    : blocks.slice(0, request.budget.maxBlocks);
  if (request.budget.mode === 'legacy-exact') return limited;
  let remaining = request.budget.maxChars;
  return limited.flatMap((block) => {
    if (remaining <= 0) return [];
    const chars = Array.from(block.text).slice(0, remaining).join('');
    remaining -= Array.from(chars).length;
    return chars.length > 0 ? [{ name: block.name, text: chars }] : [];
  });
}

function makeReceipt(scope: NpcMemoryProviderScopeV1, status: NpcMemoryRefreshReceiptV1['status']): NpcMemoryRefreshReceiptV1 {
  return { scope, status };
}

class ReferenceSnapshotReader implements NpcMemoryReaderV1 {
  readonly descriptor = REFERENCE_SNAPSHOT_READER_DESCRIPTOR;
  readonly #host: NpcMemoryReaderHostV1;
  readonly #allowedByScope = new Map<string, AllowedSubject>();
  readonly #allowedBySubject = new Map<string, AllowedSubject>();
  readonly #cache = new Map<string, CachedFixture>();
  readonly #inflight = new Map<string, {
    readonly promise: Promise<NpcMemoryRefreshReceiptV1>;
    readonly controller: AbortController;
    waiters: number;
  }>();
  readonly #activeRecalls = new Set<Promise<unknown>>();
  readonly #stopController = new AbortController();
  readonly #maxAgeMs: number;
  #started = false;
  #stopping = false;
  #stopped = false;
  #requestCounter = 0;

  constructor(host: NpcMemoryReaderHostV1, configValue: unknown) {
    this.#host = host;
    const parsed = ReferenceSnapshotReaderConfigV1Schema.parse(configValue);
    this.#maxAgeMs = parsed.maxAgeMs ?? Number.POSITIVE_INFINITY;
    for (const allowed of parsed.allowedSubjects) {
      const value = Object.freeze({ ...allowed });
      const scope = {
        authority: 'reference-fixture' as const,
        fixtureId: value.fixtureId,
        clockDomainId: value.clockDomainId,
      };
      this.#allowedByScope.set(keyForScope(scope), value);
      this.#allowedBySubject.set(keyForSubject(subjectFromAllowed(value)), value);
    }
  }

  #requestId(operation: string): string {
    this.#requestCounter += 1;
    return `${REFERENCE_SNAPSHOT_READER_ID}:${operation}:${String(this.#requestCounter)}`;
  }

  #audit(
    operation: 'start' | 'preload' | 'refresh' | 'recall' | 'stop',
    startedAt: number,
    fields: { subject?: NpcMemorySubjectV1; errorCode?: Parameters<NpcMemoryReaderHostV1['audit']>[0]['errorCode'] } = {},
  ): void {
    try {
      this.#host.audit({
        requestId: this.#requestId(operation),
        providerId: REFERENCE_SNAPSHOT_READER_ID,
        operation,
        latencyMs: Math.max(0, Math.floor(this.#host.monotonicNow() - startedAt)),
        ...fields,
      });
    } catch {
      // Audit must not turn a fail-soft reader result into a game-path failure.
    }
  }

  #requireStarted(): void {
    if (!this.#started) throw new ReferenceSnapshotReaderError('not_started', 'reference snapshot reader is not started');
    if (this.#stopping || this.#stopped) throw new ReferenceSnapshotReaderError('stopped', 'reference snapshot reader is stopping or stopped');
  }

  #allowedForScope(scope: ReferenceMemoryScopeV1): AllowedSubject | undefined {
    return this.#allowedByScope.get(keyForScope(scope));
  }

  #allowedForSubject(subject: NpcMemorySubjectV1): AllowedSubject | undefined {
    return this.#allowedBySubject.get(keyForSubject(subject));
  }

  #combinedSignal(signal: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason ?? this.#stopController.signal.reason);
    if (signal.aborted || this.#stopController.signal.aborted) abort();
    const onSignalAbort = (): void => abort();
    const onStopAbort = (): void => abort();
    signal.addEventListener('abort', onSignalAbort, { once: true });
    this.#stopController.signal.addEventListener('abort', onStopAbort, { once: true });
    return {
      signal: controller.signal,
      dispose: () => {
        signal.removeEventListener('abort', onSignalAbort);
        this.#stopController.signal.removeEventListener('abort', onStopAbort);
      },
    };
  }

  async start(): Promise<void> {
    const startedAt = this.#host.monotonicNow();
    if (this.#stopped) throw new ReferenceSnapshotReaderError('stopped', 'cannot restart a stopped reader; create a new instance');
    if (!this.#started) this.#started = true;
    this.#audit('start', startedAt);
  }

  async preload(subjects: readonly NpcMemorySubjectV1[], signal: AbortSignal): Promise<readonly NpcMemoryRefreshReceiptV1[]> {
    this.#requireStarted();
    const startedAt = this.#host.monotonicNow();
    throwIfAborted(signal);
    const unique = new Map<string, NpcMemorySubjectV1>();
    for (const subject of subjects) {
      const parsed = (() => {
        try { return NpcMemoryRecallRequestV1Schema.shape.subject.parse(subject); } catch { return null; }
      })();
      if (parsed?.scope.authority === 'reference-fixture') unique.set(keyForSubject(parsed), parsed);
    }
    const receipts = await Promise.all([...unique.values()].map(async (subject) => {
      const allowed = this.#allowedForSubject(subject);
      if (allowed === undefined) {
        this.#audit('preload', startedAt, { subject, errorCode: 'scope_denied' });
        return makeReceipt(subject.scope, 'not-applicable');
      }
      return this.refresh(subject.scope, signal);
    }));
    this.#audit('preload', startedAt);
    return receipts;
  }

  async refresh(scopeValue: NpcMemoryProviderScopeV1, signal: AbortSignal): Promise<NpcMemoryRefreshReceiptV1> {
    this.#requireStarted();
    const startedAt = this.#host.monotonicNow();
    throwIfAborted(signal);
    let scope: ReferenceMemoryScopeV1;
    try {
      scope = ReferenceMemoryScopeV1Schema.parse(scopeValue);
    } catch {
      this.#audit('refresh', startedAt, { errorCode: 'scope_mismatch' });
      return makeReceipt(scopeValue, 'not-applicable');
    }
    const allowed = this.#allowedForScope(scope);
    if (allowed === undefined) {
      this.#audit('refresh', startedAt, { errorCode: 'scope_denied' });
      return makeReceipt(scope, 'not-applicable');
    }
    const cacheKey = keyForScope(scope);
    const existing = this.#inflight.get(cacheKey);
    if (existing !== undefined) return this.#awaitRefresh(existing, signal);
    const controller = new AbortController();
    const entry = {
      controller,
      waiters: 0,
      promise: Promise.resolve(makeReceipt(scope, 'not-applicable')),
    };
    entry.promise = this.#refreshOne(scope, allowed, controller.signal, startedAt).finally(() => {
      if (this.#inflight.get(cacheKey) === entry) this.#inflight.delete(cacheKey);
    });
    this.#inflight.set(cacheKey, entry);
    return this.#awaitRefresh(entry, signal);
  }

  async #awaitRefresh(
    entry: { readonly promise: Promise<NpcMemoryRefreshReceiptV1>; readonly controller: AbortController; waiters: number },
    signal: AbortSignal,
  ): Promise<NpcMemoryRefreshReceiptV1> {
    entry.waiters += 1;
    try {
      return await waitForWithSignal(entry.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0) entry.controller.abort(signal.reason);
    }
  }

  async #refreshOne(
    scope: ReferenceMemoryScopeV1,
    allowed: AllowedSubject,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<NpcMemoryRefreshReceiptV1> {
    const cacheKey = keyForScope(scope);
    const existing = this.#cache.get(cacheKey);
    const combined = this.#combinedSignal(signal);
    try {
      throwIfAborted(combined.signal);
      if (typeof this.#host.readReferenceFixture !== 'function') {
        this.#audit('refresh', startedAt, { errorCode: 'unsupported_operation' });
        return makeReceipt(scope, 'not-applicable');
      }
      let rawResult: unknown;
      try {
        rawResult = await this.#host.readReferenceFixture(scope, {
          ...(existing ? { ifNoneMatch: existing.etag } : {}),
          signal: combined.signal,
        });
      } catch (error) {
        if (isAbortError(error) || combined.signal.aborted) throw error;
        this.#audit('refresh', startedAt, { errorCode: 'provider_unavailable' });
        return makeReceipt(scope, 'not-applicable');
      }
      let result: ReferenceFixtureReadResultV1;
      try {
        result = ReferenceFixtureReadResultV1Schema.parse(rawResult);
      } catch {
        this.#audit('refresh', startedAt, { errorCode: 'schema_incompatible' });
        return makeReceipt(scope, 'not-applicable');
      }

      throwIfAborted(combined.signal);
      if (result.status === 'missing') {
        this.#cache.delete(cacheKey);
        this.#audit('refresh', startedAt);
        return makeReceipt(scope, 'missing');
      }
      if (result.status === 'not-modified') {
        if (existing === undefined || result.etag !== existing.etag) {
          this.#audit('refresh', startedAt, { errorCode: 'integrity_failed' });
          return makeReceipt(scope, 'not-applicable');
        }
        if (this.#isStale(existing.fixture, this.#host.now())) {
          this.#cache.delete(cacheKey);
          this.#audit('refresh', startedAt, { errorCode: 'stale_snapshot' });
          return makeReceipt(scope, 'not-applicable');
        }
        this.#audit('refresh', startedAt);
        return makeReceipt(scope, 'not-modified');
      }

      const fixture = parseReferenceSnapshotFixtureV1(result.fixture);
      if (!sameScope(fixture.scope, scope)
        || fixture.fixtureId !== allowed.fixtureId
        || !sameOwner(fixture.subject, allowed)) {
        this.#audit('refresh', startedAt, { errorCode: 'scope_mismatch' });
        return makeReceipt(scope, 'not-applicable');
      }
      if (!(await verifyReferenceFixtureContentHashV1(fixture)) || result.etag !== fixture.integrity.contentHash) {
        this.#audit('refresh', startedAt, { errorCode: 'integrity_failed' });
        return makeReceipt(scope, 'not-applicable');
      }
      if (this.#isStale(fixture, this.#host.now())) {
        this.#audit('refresh', startedAt, { errorCode: 'stale_snapshot' });
        return makeReceipt(scope, 'not-applicable');
      }
      const detached = freezeDeep(clone(fixture));
      this.#cache.set(cacheKey, Object.freeze({
        scopeKey: cacheKey,
        fixture: detached,
        etag: detached.integrity.contentHash,
        loadedAtWallMs: this.#host.now(),
      }));
      this.#audit('refresh', startedAt);
      return makeReceipt(scope, 'loaded');
    } catch (error) {
      if (isAbortError(error) || combined.signal.aborted) throw error;
      this.#audit('refresh', startedAt, { errorCode: 'provider_unavailable' });
      return makeReceipt(scope, 'not-applicable');
    } finally {
      combined.dispose();
    }
  }

  #isStale(fixture: ReferenceSnapshotFixtureV1, now: number): boolean {
    return Number.isFinite(this.#maxAgeMs) && now >= fixture.generatedAtWallMs
      && now - fixture.generatedAtWallMs > this.#maxAgeMs;
  }

  async recall(requestValue: NpcMemoryRecallRequestV1): Promise<NpcMemoryRecallResultV1> {
    this.#requireStarted();
    let tracked!: Promise<NpcMemoryRecallResultV1>;
    tracked = this.#recall(requestValue).finally(() => this.#activeRecalls.delete(tracked));
    this.#activeRecalls.add(tracked);
    return tracked;
  }

  async #recall(requestValue: NpcMemoryRecallRequestV1): Promise<NpcMemoryRecallResultV1> {
    const startedAt = this.#host.monotonicNow();
    let request: NpcMemoryRecallRequestV1;
    try {
      request = parseNpcMemoryRecallRequestV1(requestValue);
    } catch {
      this.#audit('recall', startedAt, { errorCode: 'invalid_input' });
      throw new ReferenceSnapshotReaderError('scope_mismatch', 'invalid NPC memory recall request');
    }
    const callerSignal = request.signal ?? new AbortController().signal;
    const combined = this.#combinedSignal(callerSignal);
    try {
      throwIfAborted(combined.signal);
      if (request.subject.scope.authority !== 'reference-fixture') {
        this.#audit('recall', startedAt, { subject: request.subject, errorCode: 'scope_mismatch' });
        throw new ReferenceSnapshotReaderError('scope_mismatch', 'reference reader accepts reference-fixture subjects only');
      }
      const allowed = this.#allowedForSubject(request.subject);
      const cacheKey = keyForScope(request.subject.scope);
      const cached = this.#cache.get(cacheKey);
      if (allowed === undefined || cached === undefined || !sameOwner(cached.fixture.subject, request.subject)) {
        this.#audit('recall', startedAt, { subject: request.subject, errorCode: allowed === undefined ? 'scope_denied' : 'stale_snapshot' });
        throw new ReferenceSnapshotReaderError(
          allowed === undefined ? 'scope_denied' : cached === undefined ? 'missing_snapshot' : 'scope_denied',
          'no validated reference fixture is cached for the requested subject',
        );
      }
      if (this.#isStale(cached.fixture, this.#host.now())) {
        this.#audit('recall', startedAt, { subject: request.subject, errorCode: 'stale_snapshot' });
        throw new ReferenceSnapshotReaderError('stale_snapshot', 'cached reference fixture is stale');
      }

      let identityResolved = true;
      const resolvePartner = (entityId: string): boolean => {
        try {
          const identity = this.#host.resolveIdentity({ subject: request.subject, entityId });
          const resolverVersion = this.#host.identityResolverVersion(request.subject.scope);
          if (identity === null || resolverVersion === null || identity.resolverVersion !== resolverVersion) {
            identityResolved = false;
            return false;
          }
          return true;
        } catch {
          identityResolved = false;
          return false;
        }
      };
      const fullRawBlocks = buildReferenceRawBlocksV1(cached.fixture, request.subject, request, resolvePartner);
      if (identityResolved) {
        const expectedCase = cached.fixture.cases.find((candidate) => candidate.trigger === request.trigger
          && candidate.partnerEntityId === request.partnerEntityId);
        if (expectedCase !== undefined && await sha256CanonicalJson(fullRawBlocks) !== expectedCase.expectedRawBlocksHash) {
          this.#audit('recall', startedAt, { subject: request.subject, errorCode: 'integrity_failed' });
          throw new ReferenceSnapshotReaderError('integrity_failed', `reference fixture case ${expectedCase.caseId} does not match its deterministic builder`);
        }
      }
      throwIfAborted(combined.signal);
      const rawBlocks = applyBudget(fullRawBlocks, request);
      if (!identityResolved) this.#audit('recall', startedAt, { subject: request.subject, errorCode: 'identity_unresolved' });
      const result = {
        source: { kind: 'reference-fixture' as const, fixtureId: cached.fixture.fixtureId, contentHash: cached.etag },
        rawRecallVersion: 1 as const,
        rawBlocks,
        diagnostics: {
          authoritySnapshotAgeMs: Math.max(0, this.#host.now() - cached.fixture.generatedAtWallMs),
          gameMinuteLag: 0,
          stale: false,
          volatileStateUsed: false,
          projectionMode: 'full' as const,
          identityResolved,
        },
      };
      const parsed = NpcMemoryRecallResultV1Schema.parse(result);
      throwIfAborted(combined.signal);
      this.#audit('recall', startedAt, { subject: request.subject });
      return clone(parsed);
    } finally {
      combined.dispose();
    }
  }

  async stop(options: { mode: 'drain' | 'abort'; signal?: AbortSignal }): Promise<void> {
    const startedAt = this.#host.monotonicNow();
    if (this.#stopped) return;
    if (this.#stopping) {
      await Promise.allSettled([
        ...[...this.#inflight.values()].map((entry) => entry.promise),
        ...this.#activeRecalls,
      ]);
      return;
    }
    if (options.signal?.aborted) throwIfAborted(options.signal);
    this.#stopping = true;
    if (options.mode === 'abort') this.#stopController.abort(options.signal?.reason);
    const onStopSignal = (): void => this.#stopController.abort(options.signal?.reason);
    if (options.signal !== undefined && options.mode === 'drain') {
      options.signal.addEventListener('abort', onStopSignal, { once: true });
    }
    await Promise.allSettled([
      ...[...this.#inflight.values()].map((entry) => entry.promise),
      ...this.#activeRecalls,
    ]);
    options.signal?.removeEventListener('abort', onStopSignal);
    this.#cache.clear();
    this.#stopped = true;
    this.#audit('stop', startedAt);
  }
}

export const referenceSnapshotReaderFactory: NpcMemoryProviderFactoryV1 = Object.freeze({
  descriptor: REFERENCE_SNAPSHOT_READER_DESCRIPTOR,
  createReader(host: NpcMemoryReaderHostV1, config: unknown) {
    return new ReferenceSnapshotReader(host, config);
  },
});

/** Alias used by direct unit tests and host adapters. */
export const createReferenceSnapshotReader = referenceSnapshotReaderFactory.createReader;

/** Ensures fixture source wiring never needs a provider-owned path/fetch API. */
export function createReferenceFixtureStoreReader(
  fixtures: ReadonlyMap<string, ReferenceSnapshotFixtureV1>,
): (scope: ReferenceMemoryScopeV1, input: { ifNoneMatch?: string; signal: AbortSignal }) => Promise<ReferenceFixtureReadResultV1> {
  return async (scope, input) => {
    throwIfAborted(input.signal);
    const fixture = fixtures.get(scope.fixtureId);
    if (fixture === undefined) return { status: 'missing' };
    const parsed = ReferenceSnapshotFixtureV1Schema.parse(clone(fixture));
    const hash = await computeReferenceFixtureContentHashV1(parsed);
    if (hash !== parsed.integrity.contentHash) throw new ReferenceSnapshotReaderError('integrity_failed', 'fixture store contains an invalid hash');
    if (input.ifNoneMatch !== undefined && input.ifNoneMatch === parsed.integrity.contentHash) {
      return { status: 'not-modified', etag: parsed.integrity.contentHash };
    }
    return { status: 'loaded', fixture: parsed, etag: parsed.integrity.contentHash };
  };
}
