/**
 * Lifecycle composition for the built-in immutable reference fixture reader.
 *
 * It intentionally owns exactly one trusted registry source.  This proves the
 * executable Reader/registry/cache seam without granting a provider arbitrary
 * loading, transport, or local-root capabilities.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ReferenceSnapshotFixtureV1Schema,
  type NpcMemoryAuditEventV1,
  type NpcMemoryReaderHostV1,
  type NpcMemoryReaderV1,
  type NpcMemorySubjectV1,
  type ReferenceSnapshotFixtureV1,
} from '@forgeax/types/npc-memory';
import type { NpcMemoryRuntimeBinding } from '../memory-host-seam';
import {
  DurableMemoryOutbox,
  type DurableMemoryDispatchReceipt,
  type DurableMemoryOutboxCommand,
} from './durable-memory-outbox';
import {
  REFERENCE_SNAPSHOT_READER_ID,
  REFERENCE_SNAPSHOT_READER_MANIFEST,
  ReferenceSnapshotReaderConfigV1Schema,
  createReferenceFixtureStoreReader,
  referenceSnapshotReaderFactory,
  type ReferenceSnapshotReaderConfigV1,
} from './reference-snapshot-reader';
import { NpcMemoryProviderRegistry } from './provider-registry';

export type ReferenceMemoryRuntimeMode = 'shadow' | 'active';
export type ReferenceMemoryRuntimeHostState = 'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface ReferenceMemoryRuntimeHostOptions {
  readonly mode: ReferenceMemoryRuntimeMode;
  /** Required only for active, durable decision-receipt mode. */
  readonly projectRoot?: string;
  readonly receiptStateDir?: string;
  /** The input store is copied at construction and never exposed to the provider. */
  readonly fixtures: ReadonlyMap<string, ReferenceSnapshotFixtureV1>;
  readonly allowedSubjects: ReferenceSnapshotReaderConfigV1['allowedSubjects'];
  readonly subjectFor: NpcMemoryRuntimeBinding['subjectFor'];
  readonly recallRequestFor: NpcMemoryRuntimeBinding['recallRequestFor'];
  readonly resolveIdentity?: NpcMemoryReaderHostV1['resolveIdentity'];
  readonly identityResolverVersion?: NpcMemoryReaderHostV1['identityResolverVersion'];
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly autoRun?: boolean;
  readonly audit?: NpcMemoryRuntimeBinding['audit'];
  readonly providerAudit?: (event: NpcMemoryAuditEventV1) => void;
}

export interface ReferenceMemoryRuntimeHost {
  readonly binding: NpcMemoryRuntimeBinding;
  readonly registry: NpcMemoryProviderRegistry;
  readonly reader: NpcMemoryReaderV1;
  readonly mode: ReferenceMemoryRuntimeMode;
  readonly fixtureReadCount: number;
  readonly state: ReferenceMemoryRuntimeHostState;
  start(): Promise<void>;
  stop(options?: { readonly mode?: 'drain' | 'abort'; readonly signal?: AbortSignal }): Promise<void>;
}

const SOURCE_ID = 'builtin-reference-memory-v1';

function assertActiveStateDir(options: ReferenceMemoryRuntimeHostOptions): string | undefined {
  if (options.mode !== 'active') return undefined;
  if (!options.projectRoot || !isAbsolute(options.projectRoot)) {
    throw new TypeError('active reference memory runtime requires an absolute projectRoot');
  }
  const root = resolve(options.projectRoot);
  const rawStateDir = options.receiptStateDir ?? join(root, '.forgeax', 'npc-brain', 'reference-receipts');
  if (!isAbsolute(rawStateDir)) throw new TypeError('reference receiptStateDir must be absolute');
  const stateDir = resolve(rawStateDir);
  const memoryRoots = join(root, '.forgeax', 'souls');
  const fromMemoryRoots = relative(memoryRoots, stateDir);
  const fromStateDir = relative(stateDir, memoryRoots);
  const contained = (value: string) => value === '' || (value !== '..' && !value.startsWith(`..${sep}`));
  if (contained(fromMemoryRoots) || contained(fromStateDir)) {
    throw new TypeError('reference receiptStateDir must not overlap File memory roots');
  }
  return stateDir;
}

function rejectReferenceCommand(command: DurableMemoryOutboxCommand<unknown>): Promise<DurableMemoryDispatchReceipt> {
  // A reference reader never has a writer facet.  Retaining a forged command in
  // the durable ledger is useful for audit/replay, but it must be terminal.
  return Promise.resolve({ commandId: command.commandId, status: 'rejected' });
}

/** Creates the reference reader binding. Product code owns subject/request
 * adapters; this host owns only cache/lifecycle and zero-command receipts. */
export function createReferenceMemoryRuntimeHost(options: ReferenceMemoryRuntimeHostOptions): ReferenceMemoryRuntimeHost {
  if (!options || typeof options !== 'object') throw new TypeError('reference memory runtime options are required');
  if ((options.mode !== 'shadow' && options.mode !== 'active')
    || typeof options.subjectFor !== 'function' || typeof options.recallRequestFor !== 'function') {
    throw new TypeError('reference memory runtime requires mode plus product-owned subjectFor and recallRequestFor adapters');
  }
  const receiptStateDir = assertActiveStateDir(options);
  const config = ReferenceSnapshotReaderConfigV1Schema.parse({ allowedSubjects: options.allowedSubjects });
  const fixtures = new Map<string, ReferenceSnapshotFixtureV1>();
  for (const [id, fixture] of options.fixtures) fixtures.set(id, ReferenceSnapshotFixtureV1Schema.parse(structuredClone(fixture)));
  const readFixture = createReferenceFixtureStoreReader(fixtures);
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? now;
  let fixtureReadCount = 0;
  const readerHost: NpcMemoryReaderHostV1 = {
    now,
    monotonicNow,
    readReferenceFixture: async (scope, input) => {
      fixtureReadCount += 1;
      return readFixture(scope, input);
    },
    resolveIdentity: options.resolveIdentity ?? (() => null),
    identityResolverVersion: options.identityResolverVersion ?? (() => null),
    audit: (event) => options.providerAudit?.(event),
  };
  const source = Object.freeze({
    sourceId: SOURCE_ID,
    providerId: REFERENCE_SNAPSHOT_READER_ID,
    entry: REFERENCE_SNAPSHOT_READER_MANIFEST.entry,
    authority: 'reference-fixture' as const,
  });
  const registry = new NpcMemoryProviderRegistry({
    sourceAllowlist: [source],
    loader: { load: async () => ({ [REFERENCE_SNAPSHOT_READER_MANIFEST.exportName]: referenceSnapshotReaderFactory }) },
    readerHost,
  });
  let reader: NpcMemoryReaderV1 | undefined;
  const outbox = receiptStateDir === undefined ? undefined : new DurableMemoryOutbox<unknown, unknown>({
    stateDir: receiptStateDir,
    now,
    autoRun: options.autoRun,
    dispatch: (command) => rejectReferenceCommand(command),
  });
  let state: ReferenceMemoryRuntimeHostState = 'new';
  let startTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;
  let outboxStarted = false;
  let registryStarted = false;

  const abortLiveFacets = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    if (outboxStarted && outbox) {
      try {
        await outbox.stop({ mode: 'abort' });
        outboxStarted = false;
      } catch (error) { failures.push(error); }
    }
    if (registryStarted) {
      const stopped = await registry.stop(REFERENCE_SNAPSHOT_READER_ID, 'abort');
      if (stopped.ok) {
        registryStarted = false;
        reader = undefined;
      } else failures.push(stopped.error);
    }
    return failures;
  };

  const hasLiveFacets = () => outboxStarted || registryStarted;

  const binding: NpcMemoryRuntimeBinding = Object.freeze({
    mode: options.mode,
    // Reference is a reader-only authority by construction.
    writePolicy: 'deny',
    get reader() { return reader; },
    subjectFor: options.subjectFor,
    recallRequestFor: options.recallRequestFor,
    preload: (subjects: readonly NpcMemorySubjectV1[], signal: AbortSignal) => {
      if (!reader) return Promise.reject(new Error('reference memory reader is not started'));
      return reader.preload(subjects, signal);
    },
    audit: options.audit,
    ...(outbox === undefined ? {} : {
      enqueueHandoff: (input: Parameters<NonNullable<NpcMemoryRuntimeBinding['enqueueHandoff']>>[0]) =>
        outbox.enqueueHandoff(input),
      readHandoff: (handoffId: string) => outbox.getHandoff(handoffId),
    }),
  });

  const host: ReferenceMemoryRuntimeHost = {
    binding,
    registry,
    get reader() {
      if (!reader) throw new Error('reference memory reader is not started');
      return reader;
    },
    mode: options.mode,
    get fixtureReadCount() { return fixtureReadCount; },
    get state() { return state; },
    start: async () => {
      if (state === 'running') return;
      if (state === 'starting') return startTask!;
      if (state !== 'new') throw new Error(`reference memory runtime cannot start from ${state}`);
      state = 'starting';
      startTask = (async () => {
        try {
          const result = await registry.activate({
            sourceId: source.sourceId,
            manifest: REFERENCE_SNAPSHOT_READER_MANIFEST,
            config,
            validateConfig: (value) => ReferenceSnapshotReaderConfigV1Schema.parse(value),
          });
          if (!result.ok) throw new Error(`reference memory provider activation failed: ${result.error.code}`);
          registryStarted = true;
          reader = registry.get(REFERENCE_SNAPSHOT_READER_ID)?.reader;
          if (!reader) throw new Error('reference memory provider did not expose a reader');
          if (outbox) {
            await outbox.start();
            outboxStarted = true;
          }
          state = 'running';
        } catch (error) {
          // `activate()` may fail after installing a failed record (for
          // example reader start plus cleanup-stop failure). Discover that
          // ownership from registry state instead of trusting only `ok`.
          if (!registryStarted && registry.get(REFERENCE_SNAPSHOT_READER_ID)) registryStarted = true;
          const cleanupFailures = hasLiveFacets() ? await abortLiveFacets() : [];
          state = 'failed';
          if (cleanupFailures.length) {
            throw new AggregateError([error, ...cleanupFailures], 'reference memory runtime start and cleanup failed');
          }
          throw error;
        }
      })().catch((error) => {
        if (state !== 'failed') state = 'failed';
        throw error;
      });
      return startTask;
    },
    stop: async (input = {}) => {
      if (state === 'stopped') return;
      if (state === 'stopping') return stopTask!;
      if (state === 'new') { state = 'stopped'; return; }
      if (state === 'starting') {
        try { await startTask; } catch { /* fall through to failed cleanup */ }
      }
      if (state === 'failed') {
        if ((input.mode ?? 'abort') !== 'abort') return;
        state = 'stopping';
        stopTask = (async () => {
          const failures = await abortLiveFacets();
          state = hasLiveFacets() ? 'failed' : 'stopped';
          if (failures.length) throw new AggregateError(failures, 'reference memory runtime abort cleanup failed');
        })();
        return stopTask;
      }
      if (state !== 'running') return;
      state = 'stopping';
      const mode = input.mode ?? 'drain';
      stopTask = (async () => {
        if (mode === 'drain' && outboxStarted && outbox) {
          try { await outbox.stop({ mode, signal: input.signal }); }
          catch (error) { state = 'running'; throw error; }
          outboxStarted = false;
        }
        const failures: unknown[] = [];
        if (mode === 'abort') {
          failures.push(...await abortLiveFacets());
        } else if (registryStarted) {
          const stopped = await registry.stop(REFERENCE_SNAPSHOT_READER_ID, mode);
          if (stopped.ok) {
            registryStarted = false;
            reader = undefined;
          } else failures.push(stopped.error);
        }
        state = failures.length === 0 && !hasLiveFacets() ? 'stopped' : 'failed';
        if (failures.length) throw new AggregateError(failures, 'reference memory runtime stop failed');
      })();
      return stopTask;
    },
  };
  return host;
}
