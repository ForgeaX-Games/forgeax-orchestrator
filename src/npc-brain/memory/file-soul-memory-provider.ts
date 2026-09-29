/**
 * Local FileSoul memory provider.
 *
 * The provider is deliberately an adapter around the existing layered-memory
 * runtime. It owns scope/path binding and the ABI lifecycle, while the runtime
 * remains the single source of truth for filenames, index rendering and
 * prompt-compatible memory text. All request-path filesystem access is async.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  FileSoulMemoryScopeV1Schema,
  NpcMemoryCommandWriterReceiptV1Schema,
  NpcMemoryCommitCommandV1Schema,
  NpcMemoryRecallRequestV1Schema,
  NpcMemoryRecallResultV1Schema,
  NpcMemoryRefreshReceiptV1Schema,
  NpcMemorySettlementCommandV1Schema,
  NpcMemorySubjectV1Schema,
  canonicalJson,
  type FileSoulMemoryScopeV1,
  type NpcMemoryCommandWriterV1,
  type NpcMemoryCommandWriterHostV1,
  type NpcMemoryCommitCommandV1,
  type NpcMemoryProviderDescriptorV1,
  type NpcMemoryProviderFactoryV1,
  type NpcMemoryProviderScopeV1,
  type NpcMemoryRecallRequestV1,
  type NpcMemoryRecallResultV1,
  type NpcMemoryReaderHostV1,
  type NpcMemoryReaderV1,
  type NpcMemoryRefreshReceiptV1,
  type NpcMemorySettlementCommandV1,
  type NpcMemorySubjectV1,
  type NpcMemoryWriteReceiptV1,
} from '@forgeax/types/npc-memory';
import {
  FileMemoryDurabilityUnsupportedError,
  FileMemoryTransactionConflictError,
  FileMemoryTransactionStore,
  type FileMemoryTransactionResult,
} from './file-memory-transaction-store';
import {
  composeEpisodicRecallAsync,
  composeReincarnationNoticeAsync,
  composeStableMemoryAsync,
  firstPastLifeMemoryAsync,
  searchMemoryAsync,
} from '../../soul/layered-memory';
import { isMemorySlug } from '../../soul/layered-memory-runtime.mjs';
import { npcPlayerMemoryRoot, npcSoulMemoryRoot, safeNpcId } from '../safe-id';
import {
  fileMemoryFactIdempotencyKey,
  fileMemorySettlementIdempotencyKey,
} from './file-memory-idempotency';

// Kept as a local alias to make the descriptor visibly ABI-only. The public
// type name is NpcMemoryProviderDescriptorV1 in @forgeax/types.
type ProviderDescriptor = NpcMemoryProviderDescriptorV1;

export const FILE_SOUL_MEMORY_PROVIDER_ID = 'file-soul-memory' as const;

// Presentation trust is an object-identity capability owned entirely by this
// built-in module. Provider descriptors and File-shaped subjects cannot forge
// membership, and no public marking function exists.
const builtInFileReaders = new WeakSet<object>();

export function isBuiltInFileSoulMemoryReader(reader: unknown): boolean {
  return typeof reader === 'object' && reader !== null && builtInFileReaders.has(reader);
}

export const FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR = Object.freeze({
  id: FILE_SOUL_MEMORY_PROVIDER_ID,
  abiVersion: 1 as const,
  roles: ['reader', 'writer'] as const,
  capabilities: ['recall-raw-blocks', 'external-commit', 'settle'] as const,
  stateSchemaVersions: [1] as const,
  rawRecallVersions: [1] as const,
  integrityProfiles: [] as const,
}) as unknown as ProviderDescriptor;

const ABSOLUTE_PATH = z.string().min(1).refine((value) => isAbsolute(value), 'path must be absolute')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'path contains control characters');

export const FileSoulMemoryProviderConfigV1Schema = z.object({
  /** Host project root; the scope, never caller text, chooses the memory root. */
  projectRoot: ABSOLUTE_PATH,
  /** Durable transaction state is intentionally outside each memory root. */
  stateDir: ABSOLUTE_PATH.optional(),
  maxStateRecordBytes: z.number().int().positive().optional(),
}).strict();
export type FileSoulMemoryProviderConfigV1 = z.infer<typeof FileSoulMemoryProviderConfigV1Schema>;

export const FILE_SOUL_MEMORY_PROVIDER_MANIFEST = Object.freeze({
  id: FILE_SOUL_MEMORY_PROVIDER_ID,
  abiVersion: 1 as const,
  entry: './src/npc-brain/memory/file-soul-memory-provider.ts',
  exportName: 'fileSoulMemoryProviderFactory',
  descriptor: FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR,
  requestedPermissions: ['fs:provider-state'] as const,
});

export type FileSoulMemoryProviderErrorCode =
  | 'not_started'
  | 'stopped'
  | 'scope_denied'
  | 'scope_mismatch'
  | 'invalid_input'
  | 'unsupported_operation'
  | 'io_error';

export class FileSoulMemoryProviderError extends Error {
  readonly code: FileSoulMemoryProviderErrorCode;

  constructor(code: FileSoulMemoryProviderErrorCode, message: string) {
    super(message);
    this.name = 'FileSoulMemoryProviderError';
    this.code = code;
  }
}

interface FileMemoryConfig {
  readonly projectRoot: string;
  readonly stateDir: string;
  readonly maxStateRecordBytes?: number;
}

interface FileReadCache {
  readonly contentHash: string;
  readonly blocks: readonly { name: string; text: string }[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function composeSignals(...parents: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners = parents.map((parent) => {
    const listener = () => controller.abort(parent.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    if (parent.aborted) listener();
    else parent.addEventListener('abort', listener, { once: true });
    return { parent, listener };
  });
  return {
    signal: controller.signal,
    dispose: () => listeners.forEach(({ parent, listener }) => parent.removeEventListener('abort', listener)),
  };
}

function parseConfig(value: unknown): FileMemoryConfig {
  const parsed = FileSoulMemoryProviderConfigV1Schema.parse(value);
  return {
    projectRoot: resolve(parsed.projectRoot),
    stateDir: resolve(parsed.stateDir ?? join(parsed.projectRoot, '.forgeax', 'npc-brain', 'memory-state')),
    ...(parsed.maxStateRecordBytes === undefined ? {} : { maxStateRecordBytes: parsed.maxStateRecordBytes }),
  };
}

function parseFileScope(value: unknown): FileSoulMemoryScopeV1 {
  let scope: FileSoulMemoryScopeV1;
  try {
    scope = FileSoulMemoryScopeV1Schema.parse(value);
  } catch (error) {
    throw new FileSoulMemoryProviderError('scope_mismatch', `invalid FileSoul memory scope: ${String(error)}`);
  }
  // memoryGame is a namespace used as a key by the host; only the current
  // game is interpolated by the layered runtime and must use its slug grammar.
  try {
    if (!isMemorySlug(scope.game)) throw new Error('game must be a lowercase slug');
    safeNpcId(scope.memoryGame);
    safeNpcId(scope.soulId);
    if (scope.storagePartition.kind === 'player-isolated') safeNpcId(scope.storagePartition.playerId);
  } catch (error) {
    throw new FileSoulMemoryProviderError('scope_denied', `unsafe FileSoul memory scope: ${String(error)}`);
  }
  return scope;
}

function parseFileSubject(value: unknown): NpcMemorySubjectV1 & { scope: FileSoulMemoryScopeV1 } {
  let subject: NpcMemorySubjectV1;
  try {
    subject = NpcMemorySubjectV1Schema.parse(value);
  } catch (error) {
    throw new FileSoulMemoryProviderError('invalid_input', `invalid NPC memory subject: ${String(error)}`);
  }
  if (subject.scope.authority !== 'forgeax-file') {
    throw new FileSoulMemoryProviderError('scope_mismatch', 'FileSoul provider accepts forgeax-file scopes only');
  }
  const scope = parseFileScope(subject.scope);
  if (subject.soulId !== scope.soulId) {
    throw new FileSoulMemoryProviderError('scope_mismatch', 'subject soulId does not match scope soulId');
  }
  try {
    safeNpcId(subject.ownerNpcId);
  } catch (error) {
    throw new FileSoulMemoryProviderError('scope_denied', `unsafe FileSoul memory owner: ${String(error)}`);
  }
  return { ...subject, scope };
}

function memoryRef(config: FileMemoryConfig, scope: FileSoulMemoryScopeV1): { root: string; game: string } {
  const root = scope.storagePartition.kind === 'player-isolated'
    ? npcPlayerMemoryRoot(config.projectRoot, scope.soulId, scope.storagePartition.playerId)
    : npcSoulMemoryRoot(config.projectRoot, scope.soulId);
  // `game` identifies the Forge product scope. `memoryGame` is the canonical
  // legacy layered-memory namespace and must be the value handed to its
  // current-world helpers; the two are intentionally allowed to differ.
  return { root, game: scope.memoryGame };
}

function scopeStateDir(config: FileMemoryConfig, scope: FileSoulMemoryScopeV1): string {
  return join(config.stateDir, sha256(canonicalJson(scope)));
}

function normalizeBlocks(blocks: readonly { name: string; text: string }[]): readonly { name: string; text: string }[] {
  return blocks.filter((block) => block.text.length > 0).map((block) => Object.freeze({ ...block }));
}

async function renderLegacyBlocks(
  ref: { root: string; game: string },
  request: NpcMemoryRecallRequestV1,
): Promise<readonly { name: string; text: string }[]> {
  const stable = await composeStableMemoryAsync(ref);
  const reincarnation = await composeReincarnationNoticeAsync(ref);
  let reincarnationContext = reincarnation;
  if (reincarnation) {
    const query = request.context.conversationTurns.at(-1)?.text || 'past life';
    const match = (await searchMemoryAsync(ref, query, 1)).matches[0];
    const pastLife = match ?? await firstPastLifeMemoryAsync(ref);
    if (pastLife) {
      reincarnationContext = `${reincarnation}\n\nOne bounded past-life memory you may reference explicitly as a past-life rumor, never as a current-world fact:\n${pastLife.text}`;
    }
  }
  const episodic = await composeEpisodicRecallAsync(ref);
  return normalizeBlocks([
    { name: 'stable-memory', text: stable },
    { name: 'reincarnation', text: reincarnationContext },
    { name: 'current-world-memory', text: episodic },
  ]);
}

function contentHash(scope: FileSoulMemoryScopeV1, blocks: readonly { name: string; text: string }[]): string {
  return sha256(canonicalJson({ scope, blocks }));
}

function makeRefreshReceipt(scope: FileSoulMemoryScopeV1, status: NpcMemoryRefreshReceiptV1['status']): NpcMemoryRefreshReceiptV1 {
  return NpcMemoryRefreshReceiptV1Schema.parse({ scope, status });
}

function makeWriteReceipt(commandId: string, status: NpcMemoryWriteReceiptV1['status'], fields: Partial<NpcMemoryWriteReceiptV1> = {}): NpcMemoryWriteReceiptV1 {
  const safeCommandId = typeof commandId === 'string' && commandId.trim().length > 0 ? commandId : 'invalid-command';
  return NpcMemoryCommandWriterReceiptV1Schema.parse({ commandId: safeCommandId, status, ...fields });
}

function terminalWriteErrorCode(error: unknown): 'scope_denied' | 'scope_mismatch' | 'invalid_input' | 'unsupported_operation' | undefined {
  if (error instanceof FileSoulMemoryProviderError
    && (error.code === 'scope_denied' || error.code === 'scope_mismatch' || error.code === 'invalid_input')) {
    return error.code;
  }
  if (error instanceof FileMemoryDurabilityUnsupportedError) return 'unsupported_operation';
  // Conflicts and host-bound input/path validation cannot be healed by an
  // identical retry. Filesystem/locking errors intentionally do not match
  // this branch: they must throw so the durable outbox retries them.
  if (error instanceof FileMemoryTransactionConflictError || error instanceof TypeError) return 'invalid_input';
  return undefined;
}

function auditErrorCode(error: unknown): 'unsupported_operation' | 'scope_denied' | 'scope_mismatch' | 'invalid_input' | 'io_error' | undefined {
  if (error instanceof FileSoulMemoryProviderError) {
    if (error.code === 'unsupported_operation' || error.code === 'scope_denied' || error.code === 'scope_mismatch'
      || error.code === 'invalid_input') return error.code;
  }
  return error === undefined ? undefined : 'io_error';
}

class FileSoulMemoryReader implements NpcMemoryReaderV1 {
  readonly descriptor = FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR;
  readonly #config: FileMemoryConfig;
  readonly #host: NpcMemoryReaderHostV1;
  readonly #cache = new Map<string, FileReadCache>();
  readonly #lifecycleAbort = new AbortController();
  readonly #inflight = new Set<Promise<unknown>>();
  #started = false;
  #stopping = false;
  #stopped = false;
  #requestCounter = 0;

  constructor(host: NpcMemoryReaderHostV1, config: unknown) {
    this.#host = host;
    this.#config = parseConfig(config);
    builtInFileReaders.add(this);
  }

  #audit(operation: 'start' | 'preload' | 'refresh' | 'recall' | 'stop', startedAt: number, fields: Record<string, unknown> = {}): void {
    try {
      this.#host.audit({
        requestId: `${FILE_SOUL_MEMORY_PROVIDER_ID}:${operation}:${++this.#requestCounter}`,
        providerId: FILE_SOUL_MEMORY_PROVIDER_ID,
        operation,
        latencyMs: Math.max(0, Math.floor(this.#host.monotonicNow() - startedAt)),
        ...fields,
      } as Parameters<NpcMemoryReaderHostV1['audit']>[0]);
    } catch { /* audit is best-effort on the game path */ }
  }

  #requireStarted(): void {
    if (!this.#started) throw new FileSoulMemoryProviderError('not_started', 'FileSoul memory reader is not started');
    if (this.#stopping || this.#stopped) throw new FileSoulMemoryProviderError('stopped', 'FileSoul memory reader is stopped');
  }

  #track<T>(parentSignals: readonly AbortSignal[], work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#requireStarted();
    const operation = composeSignals(this.#lifecycleAbort.signal, ...parentSignals);
    let tracked!: Promise<T>;
    const run = Promise.resolve().then(() => work(operation.signal));
    tracked = run.finally(() => {
      operation.dispose();
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
    return tracked;
  }

  async start(): Promise<void> {
    if (this.#stopped) throw new FileSoulMemoryProviderError('stopped', 'cannot restart a stopped FileSoul reader');
    const startedAt = this.#host.monotonicNow();
    this.#started = true;
    this.#audit('start', startedAt);
  }

  async preload(subjects: readonly NpcMemorySubjectV1[], signal: AbortSignal): Promise<readonly NpcMemoryRefreshReceiptV1[]> {
    return this.#track([signal], async (operationSignal) => {
      throwIfAborted(operationSignal);
      const startedAt = this.#host.monotonicNow();
      const unique = new Map<string, FileSoulMemoryScopeV1>();
      for (const value of subjects) {
        // A mixed preload may contain other providers' valid subjects. Only
        // those are skipped; a malformed File-owned binding must remain visible.
        const authority = value && typeof value === 'object'
          && 'scope' in value && value.scope && typeof value.scope === 'object'
          && 'authority' in value.scope ? value.scope.authority : undefined;
        if (authority === 'asiw' || authority === 'reference-fixture') continue;
        const subject = parseFileSubject(value);
        unique.set(canonicalJson(subject.scope), subject.scope);
      }
      // Stay within the already-admitted preload operation. Calling the
      // public refresh admission gate here would make a concurrent drain stop
      // reject work that preload had already accepted.
      const receipts = await Promise.all([...unique.values()].map((scope) => this.#refresh(scope, operationSignal)));
      throwIfAborted(operationSignal);
      this.#audit('preload', startedAt);
      return receipts;
    });
  }

  async refresh(scopeValue: NpcMemoryProviderScopeV1, signal: AbortSignal): Promise<NpcMemoryRefreshReceiptV1> {
    return this.#track([signal], (operationSignal) => this.#refresh(scopeValue, operationSignal));
  }

  async #refresh(
    scopeValue: NpcMemoryProviderScopeV1,
    operationSignal: AbortSignal,
  ): Promise<NpcMemoryRefreshReceiptV1> {
    const startedAt = this.#host.monotonicNow();
    throwIfAborted(operationSignal);
    let scope: FileSoulMemoryScopeV1;
    try {
      scope = parseFileScope(scopeValue);
    } catch (error) {
      // A shared host may fan a refresh call out to several provider facets.
      // Valid scopes owned by another facet are a typed no-op, while malformed
      // file scopes remain a hard error for the caller to see.
      if (scopeValue && typeof scopeValue === 'object' && 'authority' in scopeValue && scopeValue.authority !== 'forgeax-file') {
        this.#audit('refresh', startedAt, { errorCode: 'scope_mismatch' });
        return NpcMemoryRefreshReceiptV1Schema.parse({ scope: scopeValue, status: 'not-applicable' });
      }
      this.#audit('refresh', startedAt, { errorCode: auditErrorCode(error) ?? 'scope_mismatch' });
      throw error;
    }
    const ref = memoryRef(this.#config, scope);
    try {
      const blocks = await renderLegacyBlocks(ref, {
        subject: { scope, ownerNpcId: scope.soulId, soulId: scope.soulId },
        trigger: 'active_decision',
        at: { day: 0, hour: 0, minute: 0 },
        context: { mapId: '', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
        budget: { mode: 'legacy-exact' },
      });
      throwIfAborted(operationSignal);
      const hash = contentHash(scope, blocks);
      const key = canonicalJson(scope);
      const prior = this.#cache.get(key);
      this.#cache.set(key, { contentHash: hash, blocks });
      this.#audit('refresh', startedAt);
      return makeRefreshReceipt(scope, prior?.contentHash === hash ? 'not-modified' : 'loaded');
    } catch (error) {
      const code = auditErrorCode(error);
      this.#audit('refresh', startedAt, code ? { errorCode: code } : {});
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof FileSoulMemoryProviderError) throw error;
      throw new FileSoulMemoryProviderError('io_error', `FileSoul memory refresh failed: ${String(error)}`);
    }
  }

  async recall(requestValue: NpcMemoryRecallRequestV1): Promise<NpcMemoryRecallResultV1> {
    const parentSignals = requestValue?.signal ? [requestValue.signal] : [];
    return this.#track(parentSignals, async (operationSignal) => {
      const startedAt = this.#host.monotonicNow();
      let request: NpcMemoryRecallRequestV1;
      try {
      request = NpcMemoryRecallRequestV1Schema.parse(requestValue);
      const subject = parseFileSubject(request.subject);
      if (request.budget.mode !== 'legacy-exact') {
        throw new FileSoulMemoryProviderError('unsupported_operation', 'FileSoul memory v1 supports legacy-exact budget only');
      }
      throwIfAborted(operationSignal);
      const blocks = await renderLegacyBlocks(memoryRef(this.#config, subject.scope), request);
      throwIfAborted(operationSignal);
      const result = NpcMemoryRecallResultV1Schema.parse({
        source: { kind: 'live-file', contentHash: contentHash(subject.scope, blocks) },
        rawRecallVersion: 1,
        rawBlocks: blocks,
        diagnostics: {
          stale: false,
          volatileStateUsed: false,
          projectionMode: 'full',
          identityResolved: true,
        },
      });
      this.#audit('recall', startedAt, { subject: request.subject });
      return structuredClone(result);
      } catch (error) {
        const code = auditErrorCode(error);
        this.#audit('recall', startedAt, { subject: requestValue?.subject, ...(code ? { errorCode: code } : {}) });
        throw error;
      }
    });
  }

  async stop(options: { mode: 'drain' | 'abort'; signal?: AbortSignal }): Promise<void> {
    const startedAt = this.#host.monotonicNow();
    if (this.#stopped) return;
    if (options.signal) throwIfAborted(options.signal);
    this.#stopping = true;
    if (options.mode === 'abort') {
      this.#lifecycleAbort.abort(new DOMException('FileSoul reader stopped', 'AbortError'));
    }
    // Abort cannot cancel an already-issued filesystem read, but every tracked
    // operation observes the lifecycle signal before producing/cacheing output.
    await Promise.allSettled([...this.#inflight]);
    this.#cache.clear();
    this.#stopped = true;
    this.#audit('stop', startedAt);
  }
}

class FileSoulMemoryWriter implements NpcMemoryCommandWriterV1 {
  readonly descriptor = FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR;
  readonly #config: FileMemoryConfig;
  readonly #host: NpcMemoryCommandWriterHostV1;
  readonly #store: FileMemoryTransactionStore;
  readonly #scopeTails = new Map<string, Promise<void>>();
  readonly #lifecycleAbort = new AbortController();
  #started = false;
  #stopping = false;
  #stopped = false;

  constructor(host: NpcMemoryCommandWriterHostV1, config: unknown) {
    this.#host = host;
    this.#config = parseConfig(config);
    this.#store = new FileMemoryTransactionStore({ maxStateRecordBytes: this.#config.maxStateRecordBytes });
  }

  #audit(commandId: string, operation: 'commit' | 'settle' | 'stop', errorCode?: Parameters<NpcMemoryCommandWriterHostV1['audit']>[0]['errorCode']): void {
    try {
      this.#host.audit({ commandId, providerId: FILE_SOUL_MEMORY_PROVIDER_ID, operation, ...(errorCode ? { errorCode } : {}) });
    } catch { /* audit must not change receipt semantics */ }
  }

  #rejected(commandId: string, operation: 'commit' | 'settle', errorCode: 'unsupported_operation' | 'scope_denied' | 'scope_mismatch' | 'invalid_input' | 'timeout' | 'io_error'): NpcMemoryWriteReceiptV1 {
    this.#audit(commandId, operation, errorCode);
    return makeWriteReceipt(commandId, 'rejected');
  }

  async start(): Promise<void> {
    if (this.#stopped) throw new FileSoulMemoryProviderError('stopped', 'cannot restart a stopped FileSoul writer');
    this.#started = true;
  }

  #enqueue<T>(scopeKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#scopeTails.get(scopeKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.#scopeTails.set(scopeKey, tail);
    void tail.finally(() => {
      if (this.#scopeTails.get(scopeKey) === tail) this.#scopeTails.delete(scopeKey);
    });
    return run;
  }

  async #commitValidated(
    command: NpcMemoryCommitCommandV1,
    signal: AbortSignal,
    operation: 'commit' | 'settle',
    canonicalBinding: unknown = command,
  ): Promise<NpcMemoryWriteReceiptV1> {
    throwIfAborted(signal);
    if (!this.#started || this.#stopping || this.#stopped) return this.#rejected(command.commandId, operation, 'unsupported_operation');
    const subject = parseFileSubject(command.subject);
    const ref = memoryRef(this.#config, subject.scope);
    const stateDir = scopeStateDir(this.#config, subject.scope);
    // File v1 binds one command-level idempotency key to exactly one fact.
    // Batching facts would make the public key ambiguous and split ownership
    // between the outbox and provider ledger.
    if (command.facts.length !== 1) {
      throw new FileSoulMemoryProviderError('invalid_input', 'FileSoul commit requires exactly one fact');
    }
    const fact = command.facts[0]!;
    // Preserve the legacy trust-tier guard even if a buggy host constructs an
    // imported trait command. Imported episodes remain allowed.
    if (fact.kind === 'trait' && command.trustTier !== 'own') {
      throw new FileSoulMemoryProviderError('scope_denied', 'imported memory cannot write traits');
    }
    const idempotencyKey = operation === 'settle'
      ? fileMemorySettlementIdempotencyKey(subject.scope, command.sourceEventId)
      : fileMemoryFactIdempotencyKey(subject.scope, command.sourceEventId, fact.kind, fact.text);
    if (command.idempotencyKey !== idempotencyKey) {
      throw new FileSoulMemoryProviderError('invalid_input', 'FileSoul command idempotency key mismatch');
    }
    throwIfAborted(signal);
    const canonicalCommandHash = sha256(canonicalJson({ command: canonicalBinding, fact }));
    const results: FileMemoryTransactionResult[] = [await this.#store.commit({
      ref,
      stateDir,
      idempotencyKey,
      canonicalCommandHash,
      facts: [{ kind: fact.kind === 'trait' ? 'general' : 'game', text: fact.text }],
    })];
    const status = results.length > 0 && results.every((result) => result.status === 'duplicate') ? 'duplicate' : 'written';
    const stable = results.map((result) => ({
      status: result.status,
      idempotencyKey: result.idempotencyKey,
      canonicalCommandHash: result.canonicalCommandHash,
      written: result.written,
    }));
    const digest = sha256(canonicalJson({ scope: subject.scope, commandId: command.commandId, receipts: stable }));
    this.#audit(command.commandId, operation);
    return makeWriteReceipt(command.commandId, status, { providerReceiptId: digest, contentHash: digest });
  }

  async commit(commandValue: NpcMemoryCommitCommandV1, signal: AbortSignal): Promise<NpcMemoryWriteReceiptV1> {
    if (!this.#started || this.#stopping || this.#stopped) return this.#rejected(String(commandValue?.commandId ?? ''), 'commit', 'unsupported_operation');
    let command: NpcMemoryCommitCommandV1;
    try { command = NpcMemoryCommitCommandV1Schema.parse(commandValue); }
    catch { return this.#rejected(String(commandValue?.commandId ?? ''), 'commit', 'invalid_input'); }
    let scopeKey: string;
    try { scopeKey = memoryRef(this.#config, parseFileSubject(command.subject).scope).root; }
    catch (error) {
      const code = error instanceof FileSoulMemoryProviderError
        && (error.code === 'scope_denied' || error.code === 'scope_mismatch' || error.code === 'invalid_input')
        ? error.code
        : 'invalid_input' as const;
      return this.#rejected(command.commandId, 'commit', code);
    }
    const operation = composeSignals(signal, this.#lifecycleAbort.signal);
    return this.#enqueue(scopeKey, async () => {
      try {
        return await this.#commitValidated(command, operation.signal, 'commit');
      } catch (error) {
        if (operation.signal.aborted) throw error;
        const code = terminalWriteErrorCode(error);
        if (code) return this.#rejected(command.commandId, 'commit', code);
        throw error;
      } finally {
        operation.dispose();
      }
    });
  }

  async settle(commandValue: NpcMemorySettlementCommandV1, signal: AbortSignal): Promise<NpcMemoryWriteReceiptV1> {
    if (!this.#started || this.#stopping || this.#stopped) return this.#rejected(String(commandValue?.commandId ?? ''), 'settle', 'unsupported_operation');
    let command: NpcMemorySettlementCommandV1;
    try { command = NpcMemorySettlementCommandV1Schema.parse(commandValue); }
    catch { return this.#rejected(String(commandValue?.commandId ?? ''), 'settle', 'invalid_input'); }
    if (!/^[0-9a-f]{64}$/u.test(command.workingLogHash)) return this.#rejected(command.commandId, 'settle', 'invalid_input');
    const commit: NpcMemoryCommitCommandV1 = {
      commandId: command.commandId,
      subject: command.subject,
      sourceEventId: command.settlementId,
      idempotencyKey: command.idempotencyKey,
      trustTier: 'own',
      facts: [{ kind: 'episode', text: command.episodeText }],
    };
    let scopeKey: string;
    try { scopeKey = memoryRef(this.#config, parseFileSubject(command.subject).scope).root; }
    catch (error) {
      const code = error instanceof FileSoulMemoryProviderError
        && (error.code === 'scope_denied' || error.code === 'scope_mismatch' || error.code === 'invalid_input')
        ? error.code
        : 'invalid_input' as const;
      return this.#rejected(command.commandId, 'settle', code);
    }
    const operation = composeSignals(signal, this.#lifecycleAbort.signal);
    return this.#enqueue(scopeKey, async () => {
      try {
        // The deadline bounded Brain work before durable append. Accepted
        // commands use durable-until-terminal and therefore remain replayable
        // after this wall-clock instant or a process restart.
        return await this.#commitValidated(commit, operation.signal, 'settle', command);
      } catch (error) {
        if (operation.signal.aborted) throw error;
        const code = terminalWriteErrorCode(error);
        if (code) return this.#rejected(command.commandId, 'settle', code);
        throw error;
      } finally {
        operation.dispose();
      }
    });
  }

  async stop(options: { mode: 'drain' | 'abort'; signal?: AbortSignal }): Promise<void> {
    if (this.#stopped) return;
    this.#stopping = true;
    if (options.signal) throwIfAborted(options.signal);
    if (options.mode === 'abort') this.#lifecycleAbort.abort(new DOMException('FileSoul writer stopped', 'AbortError'));
    // Even abort waits for the currently atomic File transaction to quiesce;
    // queued work observes the lifecycle signal and cannot start materializing.
    await Promise.allSettled([...this.#scopeTails.values()]);
    if (options.signal) throwIfAborted(options.signal);
    this.#stopped = true;
    this.#audit('lifecycle', 'stop');
  }
}

export const fileSoulMemoryProviderFactory: NpcMemoryProviderFactoryV1 = Object.freeze({
  descriptor: FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR,
  createReader(host: NpcMemoryReaderHostV1, config: unknown) { return new FileSoulMemoryReader(host, config); },
  createCommandWriter(host: NpcMemoryCommandWriterHostV1, config: unknown) { return new FileSoulMemoryWriter(host, config); },
});

export const createFileSoulMemoryReader = (host: NpcMemoryReaderHostV1, config: unknown): NpcMemoryReaderV1 =>
  fileSoulMemoryProviderFactory.createReader(host, config);
export const createFileSoulMemoryWriter = (host: NpcMemoryCommandWriterHostV1, config: unknown): NpcMemoryCommandWriterV1 =>
  fileSoulMemoryProviderFactory.createCommandWriter!(host, config);
