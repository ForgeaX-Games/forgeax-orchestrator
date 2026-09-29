import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { AsyncLedgerWriter } from '../../session/async-ledger-writer';
import { canonicalJson } from '@forgeax/types/npc-memory';

const JOURNAL_VERSION = 1 as const;
const JOURNAL_FILE = 'memory-commands.v1.jsonl';
const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_ID_CHARS = 256;
const MAX_PAYLOAD_BYTES = 1 << 20;
const MAX_HANDOFF_BYTES = 8 << 20;
const MAX_HANDOFF_COMMANDS = 128;
const MAX_JSON_DEPTH = 12;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_STRING_CHARS = 65_536;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCK_FILE = 'memory-commands.v1.owner.lock';
const MAX_LOCK_BYTES = 4_096;
const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 5_000;

export interface DurableMemoryOutboxCommand<TCommand = unknown> {
  readonly commandId: string;
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly payload: TCommand;
}

export interface DurableMemoryHandoff<TDecision = unknown, TCommand = unknown> {
  readonly handoffId: string;
  readonly eventId: string;
  readonly decisionHash: string;
  readonly decision: TDecision;
  readonly commands: readonly DurableMemoryOutboxCommand<TCommand>[];
}

export interface DurableMemoryDispatchReceipt {
  readonly commandId: string;
  readonly status: 'written' | 'duplicate' | 'unsupported' | 'rejected';
  readonly providerReceiptId?: string;
  readonly contentHash?: string;
}

export interface DurableMemoryOutboxOptions<TCommand = unknown> {
  readonly stateDir: string;
  readonly dispatch: (
    command: DurableMemoryOutboxCommand<TCommand>,
    context: { readonly attempt: number; readonly signal: AbortSignal },
  ) => Promise<DurableMemoryDispatchReceipt>;
  readonly now?: () => number;
  readonly autoRun?: boolean;
  readonly maxPending?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly maxJournalBytes?: number;
  /** How long terminal commands remain replayable for duplicate/conflict checks. */
  readonly terminalRetentionMs?: number;
  readonly maxRetainedCommands?: number;
  /**
   * Maximum time an abort shutdown waits for provider calls that ignore their
   * AbortSignal. On expiry the outbox stays live/locked and stop rejects; it
   * must never claim a safe stop while a provider may still be writing.
   */
  readonly abortSettleTimeoutMs?: number;
  /** Test-only crash boundary. Production callers must leave this undefined. */
  readonly failpoint?: (point: 'after-provider-result') => void;
}

export type DurableMemoryEnqueueResult =
  | { readonly status: 'enqueued'; readonly handoffHash: string }
  | { readonly status: 'duplicate'; readonly handoffHash: string };

type StoredCommand = DurableMemoryOutboxCommand<unknown>;
type StoredHandoff = DurableMemoryHandoff<unknown, unknown> & { readonly handoffHash: string };

type JournalRecord =
  | {
      readonly version: 1;
      readonly seq: number;
      readonly type: 'handoff';
      readonly at: number;
      readonly handoff: StoredHandoff;
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly type: 'dispatch';
      readonly at: number;
      readonly commandId: string;
      readonly attempt: number;
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly type: 'retry';
      readonly at: number;
      readonly commandId: string;
      readonly attempt: number;
      readonly nextAttemptAt: number;
      readonly errorCode: string;
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly type: 'succeeded';
      readonly at: number;
      readonly commandId: string;
      readonly attempt: number;
      readonly receipt: DurableMemoryDispatchReceipt;
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly type: 'dead-letter';
      readonly at: number;
      readonly commandId: string;
      readonly attempt: number;
      readonly errorCode: string;
      readonly receipt?: DurableMemoryDispatchReceipt;
    };

type NewJournalRecord = JournalRecord extends infer RecordType
  ? RecordType extends JournalRecord
    ? Omit<RecordType, 'version' | 'seq'>
    : never
  : never;

interface CommandState {
  readonly command: StoredCommand;
  attempts: number;
  nextAttemptAt: number;
  status: 'pending' | 'succeeded' | 'dead-letter';
  receipt?: DurableMemoryDispatchReceipt;
  errorCode?: string;
  terminalAt?: number;
}

export class DurableMemoryOutboxConflictError extends Error {
  readonly code = 'MEMORY_OUTBOX_IDEMPOTENCY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'DurableMemoryOutboxConflictError';
  }
}

export class DurableMemoryOutboxCapacityError extends Error {
  readonly code = 'MEMORY_OUTBOX_CAPACITY';

  constructor(message: string) {
    super(message);
    this.name = 'DurableMemoryOutboxCapacityError';
  }
}

export class DurableMemoryOutboxCorruptError extends Error {
  readonly code = 'MEMORY_OUTBOX_CORRUPT';

  constructor(message: string) {
    super(message);
    this.name = 'DurableMemoryOutboxCorruptError';
  }
}

export class DurableMemoryOutboxDurabilityUnsupportedError extends Error {
  readonly code = 'MEMORY_OUTBOX_STRICT_DURABILITY_UNSUPPORTED';

  constructor() {
    super('strict durable memory outbox is unsupported on this platform');
    this.name = 'DurableMemoryOutboxDurabilityUnsupportedError';
  }
}

export class DurableMemoryOutboxAbortTimeoutError extends Error {
  readonly code = 'MEMORY_OUTBOX_ABORT_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`memory outbox abort did not settle in-flight provider calls within ${timeoutMs}ms`);
    this.name = 'DurableMemoryOutboxAbortTimeoutError';
  }
}

interface OwnerLock {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: number;
}

/**
 * Append-only, fsync-backed memory command handoff.
 *
 * The journal is the crash authority; the in-memory scheduler is only a
 * projection. A dispatch record is persisted before invoking a provider. If a
 * process dies after the provider side effect but before the succeeded record,
 * replay retries the same typed command/idempotency key and relies on the
 * provider's durable idempotency ledger to return duplicate.
 */
export class DurableMemoryOutbox<TDecision = unknown, TCommand = unknown> {
  readonly #stateDir: string;
  readonly #journalPath: string;
  readonly #dispatch: DurableMemoryOutboxOptions<TCommand>['dispatch'];
  readonly #now: () => number;
  readonly #autoRun: boolean;
  readonly #maxPending: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #maxJournalBytes: number;
  readonly #terminalRetentionMs: number;
  readonly #maxRetainedCommands: number;
  readonly #abortSettleTimeoutMs: number;
  readonly #failpoint?: DurableMemoryOutboxOptions<TCommand>['failpoint'];
  readonly #writer: AsyncLedgerWriter;
  readonly #handoffs = new Map<string, StoredHandoff>();
  readonly #commands = new Map<string, CommandState>();
  readonly #idempotencyOwners = new Map<string, string>();
  readonly #commandOrder: string[] = [];
  readonly #commandHandoffs = new Map<string, string>();
  readonly #handoffAt = new Map<string, number>();
  readonly #running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly #ownerLockPath: string;
  #nextSeq = 1;
  #started = false;
  #stopping = false;
  #stopNeedsRetry = false;
  #degradedError: Error | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ownerToken: string | undefined;

  constructor(options: DurableMemoryOutboxOptions<TCommand>) {
    assertStrictDurability();
    if (!options || typeof options !== 'object') throw new TypeError('memory outbox options are required');
    if (typeof options.stateDir !== 'string' || options.stateDir.length === 0
      || hasControlCharacters(options.stateDir) || !isAbsolute(options.stateDir)) {
      throw new TypeError('memory outbox stateDir must be an absolute path');
    }
    if (typeof options.dispatch !== 'function') throw new TypeError('memory outbox dispatch is required');
    this.#stateDir = resolve(options.stateDir);
    this.#journalPath = join(this.#stateDir, JOURNAL_FILE);
    this.#dispatch = options.dispatch;
    this.#now = options.now ?? Date.now;
    this.#autoRun = options.autoRun ?? true;
    this.#maxPending = positiveInteger(options.maxPending ?? 10_000, 'maxPending');
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? 8, 'maxAttempts');
    this.#retryBaseMs = positiveInteger(options.retryBaseMs ?? 250, 'retryBaseMs');
    this.#retryMaxMs = positiveInteger(options.retryMaxMs ?? 30_000, 'retryMaxMs');
    this.#maxJournalBytes = positiveInteger(options.maxJournalBytes ?? 64 << 20, 'maxJournalBytes');
    this.#terminalRetentionMs = nonNegativeInteger(options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS, 'terminalRetentionMs');
    this.#maxRetainedCommands = positiveInteger(options.maxRetainedCommands ?? Math.max(10_000, this.#maxPending * 2), 'maxRetainedCommands');
    this.#abortSettleTimeoutMs = positiveInteger(options.abortSettleTimeoutMs ?? DEFAULT_ABORT_SETTLE_TIMEOUT_MS, 'abortSettleTimeoutMs');
    this.#failpoint = options.failpoint;
    this.#ownerLockPath = join(this.#stateDir, LOCK_FILE);
    this.#writer = new AsyncLedgerWriter(`npc-memory-outbox:${createHash('sha256').update(this.#stateDir).digest('hex').slice(0, 12)}`);
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('memory outbox already started');
    try {
      await mkdir(this.#stateDir, { recursive: true });
      await assertNoSymlinkComponents(this.#stateDir, 'memory outbox stateDir');
      this.#ownerToken = await acquireOwnerLock(this.#ownerLockPath, this.#now);
      await this.#replay();
      if (this.#pruneTerminalStates(this.#now())) await this.#compact();
    } catch (error) {
      await releaseOwnerLock(this.#ownerLockPath, this.#ownerToken);
      this.#ownerToken = undefined;
      this.#writer.dispose();
      throw error;
    }
    this.#started = true;
    if (this.#autoRun) this.#schedule();
  }

  async enqueueHandoff(
    input: DurableMemoryHandoff<TDecision, TCommand>,
  ): Promise<DurableMemoryEnqueueResult> {
    this.#assertRunning();
    const handoff = normalizeHandoff(input) as StoredHandoff;
    let result: DurableMemoryEnqueueResult | undefined;
    await this.#writer.enqueueTask(async () => {
      const existing = this.#handoffs.get(handoff.handoffId);
      if (existing) {
        if (existing.handoffHash !== handoff.handoffHash) {
          throw new DurableMemoryOutboxConflictError(`handoff ${handoff.handoffId} was reused with different content`);
        }
        result = { status: 'duplicate', handoffHash: existing.handoffHash };
        return;
      }
      for (const command of handoff.commands) {
        const existingCommand = this.#commands.get(command.commandId);
        if (existingCommand) {
          throw new DurableMemoryOutboxConflictError(`command id already belongs to another handoff: ${command.commandId}`);
        }
        const owner = this.#idempotencyOwners.get(commandLedgerKey(command));
        if (owner !== undefined) {
          throw new DurableMemoryOutboxConflictError(
            `scope/idempotency key already belongs to command ${owner}`,
          );
        }
      }
      if (this.pendingCount + handoff.commands.length > this.#maxPending) {
        throw new DurableMemoryOutboxCapacityError('memory outbox pending capacity exceeded');
      }
      if (this.#commands.size + handoff.commands.length > this.#maxRetainedCommands) {
        await this.#compact();
        if (this.#commands.size + handoff.commands.length > this.#maxRetainedCommands) {
          throw new DurableMemoryOutboxCapacityError('memory outbox retained command capacity exceeded');
        }
      }
      const record = this.#record({ type: 'handoff', at: this.#now(), handoff });
      const persisted = await this.#appendRecord(record);
      this.#nextSeq = persisted.seq + 1;
      this.#apply(persisted, false);
      result = { status: 'enqueued', handoffHash: handoff.handoffHash };
    }, 'required');
    if (!result) throw new Error('memory outbox enqueue did not produce a result');
    if (this.#autoRun && result.status === 'enqueued') this.#schedule();
    return result;
  }

  getHandoff(handoffId: string): DurableMemoryHandoff<TDecision, TCommand> | undefined {
    const stored = this.#handoffs.get(handoffId);
    if (!stored) return undefined;
    const { handoffHash: _hash, ...handoff } = stored;
    return cloneJson(handoff) as unknown as DurableMemoryHandoff<TDecision, TCommand>;
  }

  async runReady(): Promise<number> {
    this.#assertRunning();
    return this.#runReadyInternal();
  }

  async #runReadyInternal(): Promise<number> {
    const now = this.#now();
    const firstByScope = new Map<string, CommandState>();
    for (const commandId of this.#commandOrder) {
      const state = this.#commands.get(commandId);
      if (!state || state.status !== 'pending' || firstByScope.has(state.command.scopeKey)) continue;
      firstByScope.set(state.command.scopeKey, state);
    }
    const selected = [...firstByScope.values()].filter((state) =>
      state.nextAttemptAt <= now && !this.#running.has(state.command.commandId));
    for (const state of selected) {
      const controller = new AbortController();
      const promise = this.#dispatchOne(state, controller.signal)
        .finally(() => this.#running.delete(state.command.commandId));
      this.#running.set(state.command.commandId, { controller, promise });
    }
    await Promise.all([...selected].map((state) => this.#running.get(state.command.commandId)?.promise));
    if (this.#autoRun) this.#schedule();
    return selected.length;
  }

  async drain(signal?: AbortSignal): Promise<void> {
    this.#assertStarted();
    if (this.#stopping) throw new Error('memory outbox is stopping');
    await this.#drainInternal(signal);
  }

  async #drainInternal(signal?: AbortSignal): Promise<void> {
    while (this.pendingCount > 0) {
      if (signal?.aborted) throw abortReason(signal);
      const ran = await this.#runReadyInternal();
      if (ran > 0) continue;
      const next = this.#nextAttemptAt();
      if (next === undefined) break;
      await delayWithSignal(Math.max(1, Math.min(250, next - this.#now())), signal);
    }
  }

  async stop(options: { readonly mode: 'drain' | 'abort'; readonly signal?: AbortSignal }): Promise<void> {
    this.#assertStarted();
    if (this.#stopping) {
      // A previous abort timed out after signalling all provider calls. Once
      // they have independently settled, a supervisor may retry stop to flush
      // the terminal journal records and release ownership. Until then the
      // lock intentionally remains held.
      if (!this.#stopNeedsRetry || this.#running.size > 0) {
        throw new Error('memory outbox stop already in progress');
      }
      await this.#finishStop();
      return;
    }
    // Close admission before checking pending work. Otherwise an enqueue that
    // races the first drain observation can be accepted after drain saw zero.
    this.#stopping = true;
    try {
      if (options.mode === 'drain') await this.#drainInternal(options.signal);
    } catch (error) {
      // A caller may cancel the drain rather than request an abort. Restore
      // normal admission so this instance remains usable for a later stop.
      this.#stopping = false;
      if (this.#autoRun) this.#schedule();
      throw error;
    }
    if (this.#timer) clearTimeout(this.#timer);
    for (const { controller } of this.#running.values()) controller.abort(new Error('memory outbox stopped'));
    if (options.mode === 'abort') {
      try {
        await waitForRunningSettled(this.#running, options.signal, this.#abortSettleTimeoutMs);
      } catch (error) {
        // Do not flush/dispose/release: an uncooperative dispatch may still be
        // in its provider write after this function returns. The caller gets a
        // loud failure and may retry only after it has actually settled.
        this.#stopNeedsRetry = true;
        throw error;
      }
    } else {
      await Promise.allSettled([...this.#running.values()].map(({ promise }) => promise));
    }
    await this.#finishStop();
  }

  async #finishStop(): Promise<void> {
    await this.#writer.flush();
    this.#writer.dispose();
    await releaseOwnerLock(this.#ownerLockPath, this.#ownerToken);
    this.#ownerToken = undefined;
    this.#stopNeedsRetry = false;
  }

  get pendingCount(): number {
    let count = 0;
    for (const state of this.#commands.values()) if (state.status === 'pending') count += 1;
    return count;
  }

  get deadLetterCount(): number {
    let count = 0;
    for (const state of this.#commands.values()) if (state.status === 'dead-letter') count += 1;
    return count;
  }

  get succeededCount(): number {
    let count = 0;
    for (const state of this.#commands.values()) if (state.status === 'succeeded') count += 1;
    return count;
  }

  async #dispatchOne(state: CommandState, signal: AbortSignal): Promise<void> {
    const attempt = state.attempts + 1;
    await this.#appendAndApply({
      type: 'dispatch', at: this.#now(), commandId: state.command.commandId, attempt,
    });
    let receipt: DurableMemoryDispatchReceipt;
    try {
      receipt = normalizeReceipt(await this.#dispatch(
        state.command as DurableMemoryOutboxCommand<TCommand>,
        { attempt, signal },
      ));
      if (receipt.commandId !== state.command.commandId) {
        throw new TypeError('provider returned a receipt for a different memory command');
      }
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (attempt >= this.#maxAttempts) {
        await this.#appendAndApply({
          type: 'dead-letter', at: this.#now(), commandId: state.command.commandId, attempt, errorCode,
        });
      } else {
        await this.#appendAndApply({
          type: 'retry', at: this.#now(), commandId: state.command.commandId, attempt,
          nextAttemptAt: this.#now() + this.#backoff(attempt), errorCode,
        });
      }
      return;
    }
    if (receipt.status === 'unsupported' || receipt.status === 'rejected') {
      await this.#appendAndApply({
        type: 'dead-letter', at: this.#now(), commandId: state.command.commandId, attempt,
        errorCode: receipt.status === 'unsupported' ? 'provider_unsupported' : 'provider_rejected',
        receipt,
      });
      return;
    }
    this.#failpoint?.('after-provider-result');
    await this.#appendAndApply({
      type: 'succeeded', at: this.#now(), commandId: state.command.commandId, attempt, receipt,
    });
  }

  async #appendAndApply(
    value: Exclude<NewJournalRecord, { type: 'handoff' }>,
  ): Promise<void> {
    await this.#writer.enqueueTask(async () => {
      const record = this.#record(value);
      const persisted = await this.#appendRecord(record);
      this.#nextSeq = persisted.seq + 1;
      this.#apply(persisted, false);
    }, 'required');
  }

  async #appendRecord(record: JournalRecord): Promise<JournalRecord> {
    await assertNoSymlinkComponents(this.#journalPath, 'memory outbox journal');
    const currentBytes = await fileSize(this.#journalPath);
    let persisted = record;
    if (currentBytes + journalRecordBytes(record) > this.#maxJournalBytes) {
      await this.#compact();
      // Compaction rewrites the journal with contiguous sequence numbers. The
      // record was prepared before that rewrite, so bind it to the new tail.
      persisted = { ...record, seq: this.#nextSeq };
      const compactedBytes = await fileSize(this.#journalPath);
      if (compactedBytes + journalRecordBytes(persisted) > this.#maxJournalBytes) {
        throw new DurableMemoryOutboxCapacityError('memory outbox journal capacity exceeded');
      }
    }
    await this.#writeRecord(persisted);
    return persisted;
  }

  #record(value: NewJournalRecord): JournalRecord {
    return { version: JOURNAL_VERSION, seq: this.#nextSeq, ...value } as JournalRecord;
  }

  async #writeRecord(record: JournalRecord): Promise<void> {
    if (this.#degradedError) throw this.#degradedError;
    try {
      await appendJournalRecord(this.#stateDir, this.#journalPath, record);
    } catch (error) {
      this.#degradedError = new Error(
        `memory outbox journal became unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      throw this.#degradedError;
    }
  }

  #apply(record: JournalRecord, replay: boolean): void {
    if (record.type === 'handoff') {
      if (this.#handoffs.has(record.handoff.handoffId)) {
        throw new DurableMemoryOutboxCorruptError(`duplicate handoff record at seq ${record.seq}`);
      }
      this.#handoffs.set(record.handoff.handoffId, record.handoff);
      this.#handoffAt.set(record.handoff.handoffId, record.at);
      for (const command of record.handoff.commands) {
        if (this.#commands.has(command.commandId)) {
          throw new DurableMemoryOutboxCorruptError(`duplicate command id at seq ${record.seq}`);
        }
        this.#commands.set(command.commandId, {
          command,
          attempts: 0,
          nextAttemptAt: 0,
          status: 'pending',
        });
        const key = commandLedgerKey(command);
        if (this.#idempotencyOwners.has(key)) {
          throw new DurableMemoryOutboxCorruptError(`duplicate scope/idempotency key at seq ${record.seq}`);
        }
        this.#idempotencyOwners.set(key, command.commandId);
        this.#commandHandoffs.set(command.commandId, record.handoff.handoffId);
        this.#commandOrder.push(command.commandId);
      }
      return;
    }
    const state = this.#commands.get(record.commandId);
    if (!state || state.status !== 'pending') {
      throw new DurableMemoryOutboxCorruptError(`invalid ${record.type} transition at seq ${record.seq}`);
    }
    if (record.type === 'dispatch') {
      if (record.attempt !== state.attempts + 1) {
        throw new DurableMemoryOutboxCorruptError(`invalid dispatch attempt at seq ${record.seq}`);
      }
      state.attempts = record.attempt;
      // A replayed dispatch without a terminal record has unknown provider
      // outcome and is deliberately retried with the same idempotency key.
      state.nextAttemptAt = replay ? 0 : state.nextAttemptAt;
      return;
    }
    if (record.attempt !== state.attempts) {
      throw new DurableMemoryOutboxCorruptError(`terminal attempt mismatch at seq ${record.seq}`);
    }
    if (record.type === 'retry') {
      state.nextAttemptAt = record.nextAttemptAt;
      state.errorCode = record.errorCode;
    } else if (record.type === 'succeeded') {
      if (record.receipt.commandId !== record.commandId) {
        throw new DurableMemoryOutboxCorruptError(`receipt command mismatch at seq ${record.seq}`);
      }
      state.status = 'succeeded';
      state.receipt = record.receipt;
      state.terminalAt = record.at;
    } else {
      state.status = 'dead-letter';
      state.errorCode = record.errorCode;
      if (record.receipt !== undefined) {
        if (record.receipt.commandId !== record.commandId) {
          throw new DurableMemoryOutboxCorruptError(`receipt command mismatch at seq ${record.seq}`);
        }
        state.receipt = record.receipt;
      }
      state.terminalAt = record.at;
    }
  }

  async #replay(): Promise<void> {
    if (!(await pathExists(this.#journalPath))) return;
    await assertNoSymlinkComponents(this.#journalPath, 'memory outbox journal');
    const size = await fileSize(this.#journalPath);
    if (size > this.#maxJournalBytes) {
      throw new DurableMemoryOutboxCapacityError('memory outbox journal exceeds configured replay capacity');
    }
    const bytes = await readBoundedFile(this.#journalPath, this.#maxJournalBytes, 'memory outbox journal');
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeBytes = bytes.length === 0 || bytes.at(-1) === 0x0a
      ? bytes.length
      : lastNewline + 1;
    if (completeBytes !== bytes.length) await truncateJournalTail(this.#stateDir, this.#journalPath, completeBytes);
    const complete = bytes.subarray(0, completeBytes).toString('utf8');
    if (complete === '') return;
    let expectedSeq = 1;
    for (const line of complete.split('\n')) {
      if (!line) continue;
      // Replay can contain a large handoff and canonical validation is CPU
      // work. Yield once per record so startup/recovery cannot monopolize the
      // Bun event loop even when the async read itself resolves immediately.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const tab = line.indexOf('\t');
      if (tab !== 64 || !HEX_64.test(line.slice(0, tab))) {
        throw new DurableMemoryOutboxCorruptError(`invalid journal checksum prefix at seq ${expectedSeq}`);
      }
      const json = line.slice(tab + 1);
      const checksum = createHash('sha256').update(json, 'utf8').digest('hex');
      if (checksum !== line.slice(0, tab)) {
        throw new DurableMemoryOutboxCorruptError(`journal checksum mismatch at seq ${expectedSeq}`);
      }
      let record: JournalRecord;
      try {
        record = normalizeJournalRecord(JSON.parse(json), expectedSeq);
      } catch (error) {
        if (error instanceof DurableMemoryOutboxCorruptError) throw error;
        throw new DurableMemoryOutboxCorruptError(`invalid journal record at seq ${expectedSeq}: ${String(error)}`);
      }
      if (record.seq !== expectedSeq) {
        throw new DurableMemoryOutboxCorruptError(`journal sequence gap: got ${record.seq}, want ${expectedSeq}`);
      }
      this.#apply(record, true);
      expectedSeq += 1;
    }
    this.#nextSeq = expectedSeq;
    if (this.#commands.size > this.#maxRetainedCommands) {
      throw new DurableMemoryOutboxCapacityError('memory outbox retained command capacity exceeded');
    }
  }

  #pruneTerminalStates(now: number): boolean {
    const cutoff = now - this.#terminalRetentionMs;
    const removeHandoffs: string[] = [];
    for (const [handoffId, handoff] of this.#handoffs) {
      const removable = handoff.commands.every((command) => {
        const state = this.#commands.get(command.commandId);
        return state !== undefined && state.status !== 'pending' && state.terminalAt !== undefined && state.terminalAt <= cutoff;
      }) && (handoff.commands.length > 0 || (this.#handoffAt.get(handoffId) ?? now) <= cutoff);
      if (removable) removeHandoffs.push(handoffId);
    }
    if (removeHandoffs.length === 0) return false;
    const removeCommands = new Set<string>();
    for (const handoffId of removeHandoffs) {
      const handoff = this.#handoffs.get(handoffId);
      if (!handoff) continue;
      this.#handoffs.delete(handoffId);
      this.#handoffAt.delete(handoffId);
      for (const command of handoff.commands) {
        removeCommands.add(command.commandId);
        this.#commands.delete(command.commandId);
        this.#commandHandoffs.delete(command.commandId);
        this.#idempotencyOwners.delete(commandLedgerKey(command));
      }
    }
    if (removeCommands.size > 0) {
      for (let index = this.#commandOrder.length - 1; index >= 0; index -= 1) {
        if (removeCommands.has(this.#commandOrder[index])) this.#commandOrder.splice(index, 1);
      }
    }
    return true;
  }

  async #compact(): Promise<void> {
    this.#pruneTerminalStates(this.#now());
    const records: JournalRecord[] = [];
    let seq = 1;
    for (const handoff of this.#handoffs.values()) {
      const handoffRecord = { version: 1 as const, seq, type: 'handoff' as const, at: this.#handoffAt.get(handoff.handoffId) ?? this.#now(), handoff };
      records.push(handoffRecord);
      seq += 1;
      for (const command of handoff.commands) {
        const state = this.#commands.get(command.commandId);
        if (!state) continue;
        if (state.attempts > 0) {
          records.push({ version: 1, seq, type: 'dispatch', at: this.#now(), commandId: command.commandId, attempt: state.attempts });
          seq += 1;
        }
        if (state.status === 'pending') {
          if (state.attempts > 0 && (state.nextAttemptAt > 0 || state.errorCode !== undefined)) {
            records.push({ version: 1, seq, type: 'retry', at: this.#now(), commandId: command.commandId, attempt: state.attempts, nextAttemptAt: state.nextAttemptAt, errorCode: state.errorCode ?? 'provider_unavailable' });
            seq += 1;
          }
        } else if (state.status === 'succeeded') {
          if (!state.receipt) throw new DurableMemoryOutboxCorruptError(`succeeded command has no receipt: ${command.commandId}`);
          records.push({ version: 1, seq, type: 'succeeded', at: state.terminalAt ?? this.#now(), commandId: command.commandId, attempt: state.attempts, receipt: state.receipt });
          seq += 1;
        } else {
          records.push({ version: 1, seq, type: 'dead-letter', at: state.terminalAt ?? this.#now(), commandId: command.commandId, attempt: state.attempts, errorCode: state.errorCode ?? 'provider_unavailable', ...(state.receipt ? { receipt: state.receipt } : {}) });
          seq += 1;
        }
      }
    }
    const temp = join(this.#stateDir, `.memory-commands.compact-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, 'wx', 0o600);
      let totalBytes = 0;
      // Serialize/write one record at a time. Building one joined Buffer at the
      // 64 MiB journal ceiling would turn async filesystem work into a large
      // synchronous event-loop and memory spike.
      for (const record of records) {
        const bytes = Buffer.from(journalLine(record), 'utf8');
        totalBytes += bytes.length;
        if (totalBytes > this.#maxJournalBytes) {
          throw new DurableMemoryOutboxCapacityError('memory outbox journal cannot be compacted below capacity');
        }
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes.subarray(offset));
          if (result.bytesWritten <= 0) throw new Error('memory outbox compaction write made no progress');
          offset += result.bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, this.#journalPath);
      await fsyncDirectory(this.#stateDir);
      this.#nextSeq = seq;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  #backoff(attempt: number): number {
    return Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** Math.max(0, attempt - 1));
  }

  #nextAttemptAt(): number | undefined {
    const seenScopes = new Set<string>();
    let next: number | undefined;
    for (const commandId of this.#commandOrder) {
      const state = this.#commands.get(commandId);
      if (!state || seenScopes.has(state.command.scopeKey)) continue;
      if (state.status !== 'pending') continue;
      seenScopes.add(state.command.scopeKey);
      if (next === undefined || state.nextAttemptAt < next) next = state.nextAttemptAt;
    }
    return next;
  }

  #schedule(): void {
    if (!this.#started || this.#stopping || this.pendingCount === 0) return;
    if (this.#timer) clearTimeout(this.#timer);
    const next = this.#nextAttemptAt() ?? this.#now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runReady().catch((error) => {
        try { process.stderr.write(`[npc-memory-outbox] scheduler failed: ${String(error)}\n`); } catch {}
      });
    }, Math.max(0, next - this.#now()));
    this.#timer.unref?.();
  }

  #assertStarted(): void {
    if (!this.#started) throw new Error('memory outbox is not started');
  }

  #assertRunning(): void {
    this.#assertStarted();
    if (this.#stopping) throw new Error('memory outbox is stopping');
    if (this.#degradedError) throw this.#degradedError;
  }
}

async function appendJournalRecord(stateDir: string, path: string, record: JournalRecord): Promise<void> {
  await assertNoSymlinkComponents(path, 'memory outbox journal');
  const existed = await pathExists(path);
  await mkdir(stateDir, { recursive: true });
  const bytes = Buffer.from(journalLine(record), 'utf8');
  const handle = await open(path, 'a', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      // An append-open handle owns the append offset. Supplying a numeric
      // position is not portable across Bun/Node and can overwrite the
      // beginning of the journal when the same handle is reused.
      const result = await handle.write(bytes.subarray(offset));
      if (result.bytesWritten <= 0) throw new Error('memory outbox append made no progress');
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existed) await fsyncDirectory(stateDir);
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateJournalTail(stateDir: string, path: string, length: number): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(stateDir);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function writeHandleFully(handle: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const result = await handle.write(data.subarray(offset));
    if (result.bytesWritten <= 0) throw new Error('durable memory write made no progress');
    offset += result.bytesWritten;
  }
}

function journalRecordBytes(record: JournalRecord): number {
  return Buffer.byteLength(journalLine(record), 'utf8');
}

function journalLine(record: JournalRecord): string {
  // This unkeyed checksum detects torn/accidentally changed storage. It is not
  // an authenticity mechanism for an attacker who can rewrite the journal.
  const json = JSON.stringify(record);
  const checksum = createHash('sha256').update(json, 'utf8').digest('hex');
  return `${checksum}\t${json}\n`;
}

function normalizeHandoff(input: DurableMemoryHandoff<unknown, unknown>): StoredHandoff {
  if (!input || typeof input !== 'object') throw new TypeError('memory handoff is required');
  const handoffId = boundedId(input.handoffId, 'handoffId');
  const eventId = boundedId(input.eventId, 'eventId');
  if (!HEX_64.test(input.decisionHash)) throw new TypeError('decisionHash must be lower-case SHA-256 hex');
  if (input.decisionHash !== canonicalHash(input.decision)) {
    throw new DurableMemoryOutboxConflictError('decisionHash does not match canonical decision payload');
  }
  const decision = cloneJson(input.decision);
  if (!Array.isArray(input.commands) || input.commands.length > MAX_HANDOFF_COMMANDS) {
    throw new TypeError('memory handoff commands must be a bounded array');
  }
  const seen = new Set<string>();
  const seenIdempotency = new Set<string>();
  const commands = input.commands.map((command): StoredCommand => {
    if (!command || typeof command !== 'object') throw new TypeError('memory outbox command is required');
    const commandId = boundedId(command.commandId, 'commandId');
    if (seen.has(commandId)) throw new DurableMemoryOutboxConflictError(`duplicate command id in handoff: ${commandId}`);
    seen.add(commandId);
    if (!HEX_32.test(command.idempotencyKey)) throw new TypeError('idempotencyKey must be 32 lower-case hex characters');
    if (!HEX_64.test(command.commandHash)) throw new TypeError('commandHash must be lower-case SHA-256 hex');
    if (command.commandHash !== canonicalHash(command.payload)) {
      throw new DurableMemoryOutboxConflictError(`commandHash does not match canonical payload: ${commandId}`);
    }
    const normalized = {
      commandId,
      scopeKey: boundedId(command.scopeKey, 'scopeKey'),
      idempotencyKey: command.idempotencyKey,
      commandHash: command.commandHash,
      payload: cloneJson(command.payload),
    };
    const ledgerKey = commandLedgerKey(normalized);
    if (seenIdempotency.has(ledgerKey)) {
      throw new DurableMemoryOutboxConflictError(`duplicate scope/idempotency key in handoff: ${commandId}`);
    }
    seenIdempotency.add(ledgerKey);
    return normalized;
  });
  const handoffHash = createHash('sha256').update([
    eventId,
    input.decisionHash,
    ...commands.map((command) => `${command.commandId}:${command.scopeKey}:${command.idempotencyKey}:${command.commandHash}`),
  ].join('\n'), 'utf8').digest('hex');
  const stored = { handoffId, eventId, decisionHash: input.decisionHash, decision, commands, handoffHash };
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > MAX_HANDOFF_BYTES) {
    throw new TypeError('memory handoff exceeds 8 MiB');
  }
  return deepFreezeJson(stored);
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function normalizeReceipt(value: DurableMemoryDispatchReceipt): DurableMemoryDispatchReceipt {
  if (!value || typeof value !== 'object') throw new TypeError('provider returned an invalid memory receipt');
  const receipt = {
    commandId: boundedId(value.commandId, 'commandId'),
    status: value.status,
    ...(value.providerReceiptId === undefined
      ? {}
      : { providerReceiptId: boundedId(value.providerReceiptId, 'providerReceiptId') }),
    ...(value.contentHash === undefined ? {} : { contentHash: value.contentHash }),
  };
  if (!['written', 'duplicate', 'unsupported', 'rejected'].includes(receipt.status)) {
    throw new TypeError('provider returned an invalid memory receipt status');
  }
  if (receipt.contentHash !== undefined && !HEX_64.test(receipt.contentHash)) {
    throw new TypeError('provider returned an invalid memory content hash');
  }
  return receipt;
}

function commandLedgerKey(command: Pick<StoredCommand, 'scopeKey' | 'idempotencyKey'>): string {
  return `${command.scopeKey}\0${command.idempotencyKey}`;
}

function normalizeJournalRecord(value: unknown, expectedSeq: number): JournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableMemoryOutboxCorruptError(`journal record ${expectedSeq} is not an object`);
  }
  const row = value as Record<string, unknown>;
  if (row.version !== JOURNAL_VERSION || row.seq !== expectedSeq || !Number.isSafeInteger(row.at) || (row.at as number) < 0) {
    throw new DurableMemoryOutboxCorruptError(`journal record ${expectedSeq} has an invalid header`);
  }
  if (row.type === 'handoff') {
    const handoff = normalizeHandoff(row.handoff as DurableMemoryHandoff<unknown, unknown>);
    if ((row.handoff as { handoffHash?: unknown }).handoffHash !== handoff.handoffHash) {
      throw new DurableMemoryOutboxCorruptError(`journal handoff hash mismatch at seq ${expectedSeq}`);
    }
    return { version: 1, seq: expectedSeq, type: 'handoff', at: row.at as number, handoff };
  }
  const commandId = boundedId(row.commandId, 'commandId');
  const attempt = positiveInteger(row.attempt as number, 'attempt');
  if (row.type === 'dispatch') {
    return { version: 1, seq: expectedSeq, type: 'dispatch', at: row.at as number, commandId, attempt };
  }
  if (row.type === 'retry') {
    if (!Number.isSafeInteger(row.nextAttemptAt) || (row.nextAttemptAt as number) < 0) {
      throw new DurableMemoryOutboxCorruptError(`invalid retry time at seq ${expectedSeq}`);
    }
    return {
      version: 1, seq: expectedSeq, type: 'retry', at: row.at as number, commandId, attempt,
      nextAttemptAt: row.nextAttemptAt as number, errorCode: boundedId(row.errorCode, 'errorCode'),
    };
  }
  if (row.type === 'succeeded') {
    return {
      version: 1, seq: expectedSeq, type: 'succeeded', at: row.at as number, commandId, attempt,
      receipt: normalizeReceipt(row.receipt as DurableMemoryDispatchReceipt),
    };
  }
  if (row.type === 'dead-letter') {
    return {
      version: 1, seq: expectedSeq, type: 'dead-letter', at: row.at as number, commandId, attempt,
      errorCode: boundedId(row.errorCode, 'errorCode'),
      ...(row.receipt === undefined ? {} : { receipt: normalizeReceipt(row.receipt as DurableMemoryDispatchReceipt) }),
    };
  }
  throw new DurableMemoryOutboxCorruptError(`unknown journal record type at seq ${expectedSeq}`);
}

function boundedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS
    || value.trim() !== value || hasControlCharacters(value)) {
    throw new TypeError(`${name} must be a bounded non-empty identifier`);
  }
  return value;
}

function assertStrictDurability(): void {
  if (process.platform === 'win32') throw new DurableMemoryOutboxDurabilityUnsupportedError();
}

async function assertNoSymlinkComponents(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || hasControlCharacters(path)) throw new TypeError(`${label} contains an unsafe path`);
  const absolute = resolve(path);
  const parsed = absolute.split(sep);
  let current = parsed[0] === '' ? sep : parsed[0];
  for (const component of parsed.slice(parsed[0] === '' ? 1 : 0)) {
    if (!component) continue;
    current = current === sep ? join(current, component) : join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() && !isSystemPathAlias(current)) throw new TypeError(`${label} cannot contain symlink or junction: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function isSystemPathAlias(path: string): boolean {
  return process.platform === 'darwin' && (path === '/var' || path === '/tmp');
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const size = (await stat(path)).size;
  if (size > maxBytes) throw new DurableMemoryOutboxCapacityError(`${label} exceeds read capacity`);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new DurableMemoryOutboxCapacityError(`${label} exceeds read capacity`);
  return bytes;
}

async function acquireOwnerLock(path: string, now: () => number): Promise<string> {
  const token = randomUUID();
  const body = Buffer.from(JSON.stringify({ pid: process.pid, token, startedAt: now() } satisfies OwnerLock) + '\n', 'utf8');
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlinkComponents(dirname(path), 'memory outbox owner directory');
  for (;;) {
    // Do not expose an empty O_EXCL lock before its owner record is durable.
    // `link` publishes the fully fsynced temp file without replacing a live
    // owner. A crash before link leaves only an ignorable prepare artifact.
    const prepare = `${path}.prepare-${randomUUID()}`;
    let published = false;
    try {
      const handle = await open(prepare, 'wx', 0o600);
      try {
        await writeHandleFully(handle, body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(prepare, path);
        published = true;
        await fsyncDirectory(dirname(path));
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } catch (error) {
      if (published) await releaseOwnerLock(path, token);
      throw error;
    } finally {
      await unlink(prepare).catch(() => {});
    }
    const owner = await readOwnerLock(path);
    if (owner === undefined) {
      if (!(await pathExists(path))) continue;
      throw new Error('memory outbox owner lock is malformed; refusing takeover');
    }
    if (isProcessAlive(owner.pid)) throw new Error(`memory outbox is already owned by process ${owner.pid}`);
    const quarantine = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, quarantine);
      await unlink(quarantine);
      await fsyncDirectory(dirname(path));
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
    }
  }
}

async function releaseOwnerLock(path: string, token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    if (!(await pathExists(path))) return;
    const owner = await readOwnerLock(path);
    if (owner?.token !== token) return;
    await unlink(path);
    await fsyncDirectory(dirname(path));
  } catch {
    // Never remove a lock whose owner cannot be proven; the next opener can
    // only recover it when its recorded pid is demonstrably dead.
  }
}

async function readOwnerLock(path: string): Promise<OwnerLock | undefined> {
  await assertNoSymlinkComponents(path, 'memory outbox owner lock');
  if (!(await pathExists(path))) return undefined;
  const bytes = await readBoundedFile(path, MAX_LOCK_BYTES, 'memory outbox owner lock');
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Partial<OwnerLock>;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.token) || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return undefined;
    return value as OwnerLock;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function cloneJson<T>(value: T): T {
  validateJson(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) throw new TypeError('memory outbox payload exceeds 1 MiB');
  return JSON.parse(json) as T;
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

function validateJson(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth > MAX_JSON_DEPTH) throw new TypeError('memory outbox payload is too deep');
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) throw new TypeError('memory outbox payload contains a non-finite number');
      continue;
    }
    if (typeof item.value === 'string') {
      if (Array.from(item.value).length > MAX_STRING_CHARS) throw new TypeError('memory outbox string is too large');
      continue;
    }
    if (typeof item.value !== 'object') throw new TypeError('memory outbox payload is not JSON-safe');
    if (seen.has(item.value)) throw new TypeError('memory outbox payload contains a cycle');
    seen.add(item.value);
    if (Array.isArray(item.value)) {
      if (item.value.length > MAX_ARRAY_ITEMS) throw new TypeError('memory outbox array is too large');
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        if (!Object.prototype.hasOwnProperty.call(item.value, index)) throw new TypeError('memory outbox array is sparse');
        stack.push({ value: item.value[index], depth: item.depth + 1 });
      }
      continue;
    }
    if (Object.getPrototypeOf(item.value) !== Object.prototype && Object.getPrototypeOf(item.value) !== null) {
      throw new TypeError('memory outbox payload must use plain JSON objects');
    }
    for (const child of Object.values(item.value as Record<string, unknown>)) {
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function safeErrorCode(error: unknown): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : 'provider_unavailable';
  return /^[a-z0-9_:-]{1,128}$/u.test(candidate) ? candidate : 'provider_unavailable';
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('memory outbox drain aborted');
}

async function waitForRunningSettled(
  running: ReadonlyMap<string, { readonly promise: Promise<void> }>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const pending = [...running.values()].map(({ promise }) => promise);
  if (pending.length === 0) return;
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DurableMemoryOutboxAbortTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    const abort = () => {
      cleanup();
      reject(abortReason(signal!));
    };
    const settled = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.allSettled(pending).then(settled);
  });
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', abort, { once: true });
    timer.unref?.();
  });
}
