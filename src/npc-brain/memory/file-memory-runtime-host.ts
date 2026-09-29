/**
 * Product-neutral lifecycle composition for the built-in File memory provider.
 *
 * This is deliberately not a general provider registry: F2 needs one proven
 * File reference path before F4 adds discovery/reference readers.  The product
 * must still own subject and recall-request adaptation, because the generic
 * Brain cannot infer game time, dialogue state, or authority identity.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import {
  NpcMemoryCommitCommandV1Schema,
  NpcMemorySettlementCommandV1Schema,
  canonicalJson,
  type NpcMemoryAuditEventV1,
  type NpcMemoryCommandWriterHostV1,
  type NpcMemoryCommandWriterV1,
  type NpcMemoryRecallRequestV1,
  type NpcMemoryReaderV1,
  type NpcMemorySubjectV1,
} from '@forgeax/types/npc-memory';
import type { NpcMemoryRuntimeBinding, NpcMemoryWritePolicy } from '../memory-host-seam';
import {
  createFileSoulMemoryReader,
  createFileSoulMemoryWriter,
} from './file-soul-memory-provider';
import {
  fileMemoryFactIdempotencyKey,
  fileMemorySettlementIdempotencyKey,
} from './file-memory-idempotency';
import {
  DurableMemoryOutbox,
  type DurableMemoryDispatchReceipt,
  type DurableMemoryOutboxCommand,
} from './durable-memory-outbox';

type FileMemoryCommand =
  | ReturnType<typeof NpcMemoryCommitCommandV1Schema.parse>
  | ReturnType<typeof NpcMemorySettlementCommandV1Schema.parse>;

export type FileMemoryRuntimeHostState = 'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface FileMemoryRuntimeProductAdapter {
  readonly subjectFor: NpcMemoryRuntimeBinding['subjectFor'];
  readonly recallRequestFor: NpcMemoryRuntimeBinding['recallRequestFor'];
  /** Brain-level, product-owned audit sink.  It is never required for gameplay. */
  readonly audit?: NpcMemoryRuntimeBinding['audit'];
}

export type FileMemoryProviderAuditEvent = NpcMemoryAuditEventV1
  | Parameters<NpcMemoryCommandWriterHostV1['audit']>[0];

export interface FileMemoryRuntimeHostOptions extends FileMemoryRuntimeProductAdapter {
  /** Provider recall mode. Defaults to active for the built-in File host. */
  readonly mode?: 'shadow' | 'active';
  /** Provider write capability. Missing is fail-closed (`deny`). */
  readonly writePolicy?: NpcMemoryWritePolicy;
  /** Absolute project root. File memories remain under `.forgeax/souls`. */
  readonly projectRoot: string;
  /** File transaction metadata; defaults outside all File memory roots. */
  readonly providerStateDir?: string;
  /** Append-only decision/command handoffs; defaults outside all File roots. */
  readonly outboxStateDir?: string;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly autoRun?: boolean;
  /** Optional low-level provider audit, separate from Brain-level audit. */
  readonly providerAudit?: (event: FileMemoryProviderAuditEvent) => void;
}

export interface FileMemoryRuntimeHost {
  readonly binding: NpcMemoryRuntimeBinding;
  readonly reader: NpcMemoryReaderV1;
  readonly writer: NpcMemoryCommandWriterV1;
  readonly outbox: DurableMemoryOutbox<unknown, FileMemoryCommand>;
  readonly state: FileMemoryRuntimeHostState;
  start(): Promise<void>;
  stop(options?: { readonly mode?: 'drain' | 'abort'; readonly signal?: AbortSignal }): Promise<void>;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function assertAbsoluteDirectory(value: string, name: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return resolve(value);
}

function overlaps(left: string, right: string): boolean {
  return left === right || relative(left, right) === '' || relative(right, left) === ''
    || (!relative(left, right).startsWith(`..${sep}`) && relative(left, right) !== '..')
    || (!relative(right, left).startsWith(`..${sep}`) && relative(right, left) !== '..');
}

function assertSeparateDirectories(projectRoot: string, providerStateDir: string, outboxStateDir: string): void {
  const memoryRoots = join(projectRoot, '.forgeax', 'souls');
  if (overlaps(providerStateDir, outboxStateDir)) {
    throw new TypeError('File memory providerStateDir and outboxStateDir must not overlap');
  }
  if (overlaps(providerStateDir, memoryRoots) || overlaps(outboxStateDir, memoryRoots)) {
    throw new TypeError('File memory state directories must not overlap File memory roots');
  }
}

function reject(commandId: string): DurableMemoryDispatchReceipt {
  return { commandId, status: 'rejected' };
}

class FileMemoryWritePolicyPausedError extends Error {
  readonly code = 'NPC_MEMORY_WRITE_POLICY_PAUSED';

  constructor() {
    super('File memory command dispatch is paused by write policy');
    this.name = 'FileMemoryWritePolicyPausedError';
  }
}

/** Validate both the durable envelope and its closed command schema before a
 * File writer sees it. A forged payload is terminally rejected, never coerced. */
async function dispatchFileCommand(
  writer: NpcMemoryCommandWriterV1,
  command: DurableMemoryOutboxCommand<FileMemoryCommand>,
  signal: AbortSignal,
  writePolicy: NpcMemoryWritePolicy,
): Promise<DurableMemoryDispatchReceipt> {
  // Policy gates new command admission, but an older process may already have
  // durably accepted this command. A read-only rollback must pause that work,
  // not convert it into a terminal dead letter. Throwing keeps it retryable;
  // the deny-mode host also disables automatic dispatch until write authority
  // is explicitly restored.
  if (writePolicy !== 'configured-writer') throw new FileMemoryWritePolicyPausedError();
  const commit = NpcMemoryCommitCommandV1Schema.safeParse(command.payload);
  const settlement = commit.success
    ? undefined
    : NpcMemorySettlementCommandV1Schema.safeParse(command.payload);
  if (!commit.success && !settlement?.success) return reject(command.commandId);
  const payload = (commit.success ? commit.data : settlement!.data) as FileMemoryCommand;
  if (payload.commandId !== command.commandId
    || payload.idempotencyKey !== command.idempotencyKey
    || command.commandHash !== canonicalHash(payload)
    || command.scopeKey !== canonicalHash(payload.subject.scope)) {
    return reject(command.commandId);
  }
  if (commit.success) {
    if (commit.data.subject.scope.authority !== 'forgeax-file' || commit.data.facts.length !== 1) {
      return reject(command.commandId);
    }
    const fact = commit.data.facts[0]!;
    if (commit.data.idempotencyKey !== fileMemoryFactIdempotencyKey(
      commit.data.subject.scope,
      commit.data.sourceEventId,
      fact.kind,
      fact.text,
    )) return reject(command.commandId);
    if (!writer.commit) return { commandId: command.commandId, status: 'unsupported' };
    return writer.commit(commit.data, signal);
  }
  if (!settlement?.success) return reject(command.commandId);
  const settlementCommand = settlement.data;
  if (settlementCommand.subject.scope.authority !== 'forgeax-file'
    || settlementCommand.idempotencyKey !== fileMemorySettlementIdempotencyKey(
      settlementCommand.subject.scope,
      settlementCommand.settlementId,
    )) return reject(command.commandId);
  if (!writer.settle) return { commandId: command.commandId, status: 'unsupported' };
  return writer.settle(settlementCommand, signal);
}

/**
 * Create, but do not start, the built-in File provider runtime.
 *
 * Start order is reader → writer → outbox, so journal replay can never invoke a
 * writer before it is ready. Stop reverses the durable dependency order:
 * outbox → writer → reader.
 */
export function createFileMemoryRuntimeHost(options: FileMemoryRuntimeHostOptions): FileMemoryRuntimeHost {
  if (!options || typeof options !== 'object') throw new TypeError('File memory runtime options are required');
  if (typeof options.subjectFor !== 'function' || typeof options.recallRequestFor !== 'function') {
    throw new TypeError('File memory runtime requires product-owned subjectFor and recallRequestFor adapters');
  }
  const projectRoot = assertAbsoluteDirectory(options.projectRoot, 'projectRoot');
  const providerStateDir = assertAbsoluteDirectory(
    options.providerStateDir ?? join(projectRoot, '.forgeax', 'npc-brain', 'memory-state'),
    'providerStateDir',
  );
  const outboxStateDir = assertAbsoluteDirectory(
    options.outboxStateDir ?? join(projectRoot, '.forgeax', 'npc-brain', 'memory-outbox'),
    'outboxStateDir',
  );
  assertSeparateDirectories(projectRoot, providerStateDir, outboxStateDir);
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? now;
  const mode = options.mode ?? 'active';
  const writePolicy = options.writePolicy ?? 'deny';
  if (mode !== 'shadow' && mode !== 'active') throw new TypeError('File memory runtime mode must be shadow or active');
  if (writePolicy !== 'deny' && writePolicy !== 'configured-writer') {
    throw new TypeError('File memory runtime writePolicy must be deny or configured-writer');
  }
  // Shadow is a read-only experiment regardless of the caller's requested
  // write policy. Expose the effective policy so the Brain cannot manufacture
  // provider commands for this host mode.
  const effectiveWritePolicy: NpcMemoryWritePolicy = mode === 'shadow' ? 'deny' : writePolicy;
  const reader = createFileSoulMemoryReader({
    now,
    monotonicNow,
    resolveIdentity: () => null,
    identityResolverVersion: () => null,
    audit: (event) => options.providerAudit?.(event),
  }, { projectRoot, stateDir: providerStateDir });
  const writer = createFileSoulMemoryWriter({
    now,
    audit: (event) => options.providerAudit?.(event),
  }, { projectRoot, stateDir: providerStateDir });
  const outbox = new DurableMemoryOutbox<unknown, FileMemoryCommand>({
    stateDir: outboxStateDir,
    autoRun: effectiveWritePolicy === 'configured-writer' ? options.autoRun : false,
    now,
    // File commands have already crossed the durable acceptance boundary.
    // Terminal schema/policy outcomes return receipts; thrown I/O failures
    // stay retryable until an operator drains or explicitly aborts the host.
    maxAttempts: Number.MAX_SAFE_INTEGER,
    dispatch: (command, context) => dispatchFileCommand(writer, command, context.signal, effectiveWritePolicy),
  });

  let state: FileMemoryRuntimeHostState = 'new';
  let startTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;
  let readerStarted = false;
  let writerStarted = false;
  let outboxStarted = false;

  const abortLiveFacets = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    if (outboxStarted) {
      try {
        await outbox.stop({ mode: 'abort' });
        outboxStarted = false;
      } catch (error) {
        // A timed-out outbox still has a provider call in flight. In
        // particular, do not stop its writer underneath that call or report a
        // clean host shutdown; retain every facet and let the supervisor exit
        // loudly or retry after the dispatch actually settles.
        failures.push(error);
        return failures;
      }
    }
    if (writerStarted) {
      try {
        await writer.stop({ mode: 'abort' });
        writerStarted = false;
      } catch (error) { failures.push(error); }
    }
    if (readerStarted) {
      try {
        await reader.stop({ mode: 'abort' });
        readerStarted = false;
      } catch (error) { failures.push(error); }
    }
    return failures;
  };

  const hasLiveFacets = () => outboxStarted || writerStarted || readerStarted;

  const binding: NpcMemoryRuntimeBinding = Object.freeze({
    mode,
    writePolicy: effectiveWritePolicy,
    reader,
    subjectFor: options.subjectFor,
    recallRequestFor: options.recallRequestFor,
    preload: (subjects: readonly NpcMemorySubjectV1[], signal: AbortSignal) => reader.preload(subjects, signal),
    audit: options.audit,
    enqueueHandoff: async (input: Parameters<NonNullable<NpcMemoryRuntimeBinding['enqueueHandoff']>>[0]) => {
      // The Brain respects writePolicy, but the binding is also a public seam.
      // Reject forged/new command handoffs before they cross the durable
      // acceptance boundary. Zero-command decision receipts remain supported.
      if (effectiveWritePolicy !== 'configured-writer'
        && Array.isArray(input.commands)
        && input.commands.length > 0) {
        throw new Error('File memory runtime write policy denies command handoffs');
      }
      return outbox.enqueueHandoff(input as Parameters<typeof outbox.enqueueHandoff>[0]);
    },
    readHandoff: (handoffId: string) => outbox.getHandoff(handoffId),
  });

  const host: FileMemoryRuntimeHost = {
    binding,
    reader,
    writer,
    outbox,
    get state() { return state; },
    start: async () => {
      if (state === 'running') return;
      if (state === 'starting') return startTask!;
      if (state !== 'new') throw new Error(`File memory runtime cannot start from ${state}`);
      state = 'starting';
      startTask = (async () => {
        try {
          await reader.start();
          readerStarted = true;
          if (effectiveWritePolicy === 'configured-writer') {
            await writer.start();
            writerStarted = true;
          }
          await outbox.start();
          outboxStarted = true;
          state = 'running';
        } catch (error) {
          // Startup must leave no live writer/reader when replay cannot begin.
          // Preserve ownership flags for any cleanup that itself fails so a
          // supervisor can retry `stop({ mode: 'abort' })` from failed state.
          const cleanupFailures = await abortLiveFacets();
          state = 'failed';
          if (cleanupFailures.length) {
            throw new AggregateError([error, ...cleanupFailures], 'File memory runtime start and cleanup failed');
          }
          throw error;
        }
      })();
      return startTask;
    },
    stop: async (input = {}) => {
      if (state === 'stopped') return;
      if (state === 'stopping') return stopTask!;
      if (state === 'new') {
        state = 'stopped';
        return;
      }
      if (state === 'starting') {
        try { await startTask; } catch { /* fall through to failed cleanup */ }
      }
      if (state === 'failed') {
        // Failed cleanup does not prove facets are gone. Permit the supervisor
        // to retry unconditional abort cleanup until every successful child
        // stop has cleared its own flag.
        if ((input.mode ?? 'abort') !== 'abort') return;
        state = 'stopping';
        stopTask = (async () => {
          const failures = await abortLiveFacets();
          state = hasLiveFacets() ? 'failed' : 'stopped';
          if (failures.length) throw new AggregateError(failures, 'File memory runtime abort cleanup failed');
        })();
        return stopTask;
      }
      if (state !== 'running') return;
      state = 'stopping';
      const mode = input.mode ?? 'drain';
      stopTask = (async () => {
        // A cancelled/failed drain leaves the outbox live by contract.  Do not
        // continue and strand it behind a stopped writer; restore a retryable
        // running state so the supervisor can drain or abort later.
        if (mode === 'drain') {
          try {
            if (outboxStarted) {
              // A deny-mode host intentionally cannot dispatch any commands
              // replayed from an earlier writable run. Release the journal
              // lock without pretending those durable commands were drained.
              await outbox.stop({
                mode: effectiveWritePolicy === 'configured-writer' ? mode : 'abort',
                signal: input.signal,
              });
            }
          } catch (error) {
            state = 'running';
            throw error;
          }
          outboxStarted = false;
          try {
            if (writerStarted) await writer.stop({ mode, signal: input.signal });
            writerStarted = false;
            if (readerStarted) await reader.stop({ mode, signal: input.signal });
            readerStarted = false;
            state = 'stopped';
            return;
          } catch (error) {
            // The durable outbox has already stopped. A failed drain must not
            // strand a child facet behind an unreachable failed host. Cleanup
            // is unconditional: an aborted caller signal cannot veto it.
            const cleanupFailures = await abortLiveFacets();
            state = 'failed';
            if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'File memory runtime drain and cleanup failed');
            throw error;
          }
        }
        // Abort is unconditional cleanup. Supervisors commonly pass an
        // already-aborted request signal; forwarding it would let a child
        // reject before it observes its own lifecycle abort.
        const failures = await abortLiveFacets();
        state = hasLiveFacets() ? 'failed' : 'stopped';
        if (failures.length > 0) throw new AggregateError(failures, 'File memory runtime stop failed');
      })();
      return stopTask;
    },
  };
  return host;
}
