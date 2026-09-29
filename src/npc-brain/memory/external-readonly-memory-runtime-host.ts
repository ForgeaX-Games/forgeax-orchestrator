/**
 * Host-owned lifecycle composition for one product-selected read-only memory
 * provider.
 *
 * The host receives an opaque trusted source, its untrusted manifest/config
 * candidate, and a loader that can resolve only that source. Provider-specific
 * code and algorithms stay in the selected npm artifact; Orchestrator owns the
 * narrow registry, lifecycle, background refresh, and durable zero-command
 * receipts.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  NpcMemoryProviderScopeV1Schema,
  canonicalJson,
  type NpcMemoryAuditEventV1,
  type NpcMemoryProviderScopeV1,
  type NpcMemoryReaderHostV1,
  type NpcMemoryReaderV1,
  type NpcMemorySubjectV1,
} from '@forgeax/types/npc-memory';
import type { NpcMemoryRuntimeBinding } from '../memory-host-seam';
import {
  DurableMemoryOutbox,
  type DurableMemoryDispatchReceipt,
  type DurableMemoryOutboxCommand,
} from './durable-memory-outbox';
import {
  NpcMemoryProviderRegistry,
  type NpcMemoryProviderCandidateV1,
  type NpcMemoryProviderLoaderV1,
  type NpcMemoryProviderTrustedSourceV1,
} from './provider-registry';

export type ExternalReadOnlyMemoryRuntimeMode = 'shadow' | 'active';
export type ExternalReadOnlyMemoryRuntimeHostState =
  | 'new'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface ExternalReadOnlyMemoryProviderV1 {
  /** Product-selected immutable package provenance, not a filesystem path. */
  readonly source: NpcMemoryProviderTrustedSourceV1;
  /** Manifest/config pair independently validated by the provider registry. */
  readonly candidate: NpcMemoryProviderCandidateV1;
  /** Host loader bound to the product-selected trusted package root. */
  readonly loader: NpcMemoryProviderLoaderV1;
  /** Background refresh is explicit and never inferred from opaque config. */
  readonly refreshScopes: readonly NpcMemoryProviderScopeV1[];
}

export interface ExternalReadOnlyMemoryRuntimeHostOptions {
  readonly mode: ExternalReadOnlyMemoryRuntimeMode;
  /** Required in active mode; receipt state is never placed under File roots. */
  readonly projectRoot?: string;
  readonly receiptStateDir?: string;
  readonly provider: ExternalReadOnlyMemoryProviderV1;
  /** Background authority refresh cadence. Production default is 30 seconds. */
  readonly refreshIntervalMs?: number;
  readonly autoRun?: boolean;
  /** Authenticated source callback; it owns URL/token/grant handling. */
  readonly readSnapshot: NonNullable<NpcMemoryReaderHostV1['readSnapshot']>;
  readonly subjectFor: NpcMemoryRuntimeBinding['subjectFor'];
  readonly recallRequestFor: NpcMemoryRuntimeBinding['recallRequestFor'];
  readonly resolveIdentity: NpcMemoryReaderHostV1['resolveIdentity'];
  readonly identityResolverVersion: NpcMemoryReaderHostV1['identityResolverVersion'];
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly audit?: NpcMemoryRuntimeBinding['audit'];
  readonly providerAudit?: (event: NpcMemoryAuditEventV1) => void;
}

export interface ExternalReadOnlyMemoryRuntimeHost {
  readonly binding: NpcMemoryRuntimeBinding;
  readonly registry: NpcMemoryProviderRegistry;
  readonly reader: NpcMemoryReaderV1;
  readonly providerId: string;
  readonly mode: ExternalReadOnlyMemoryRuntimeMode;
  readonly state: ExternalReadOnlyMemoryRuntimeHostState;
  start(): Promise<void>;
  stop(options?: { readonly mode?: 'drain' | 'abort'; readonly signal?: AbortSignal }): Promise<void>;
}

function assertActiveStateDir(options: ExternalReadOnlyMemoryRuntimeHostOptions): string | undefined {
  if (options.mode !== 'active') return undefined;
  if (!options.projectRoot || !isAbsolute(options.projectRoot)) {
    throw new TypeError('active external memory runtime requires an absolute projectRoot');
  }
  const root = resolve(options.projectRoot);
  const rawStateDir = options.receiptStateDir
    ?? join(root, '.forgeax', 'npc-brain', 'external-readonly-receipts');
  if (!isAbsolute(rawStateDir)) throw new TypeError('external memory receiptStateDir must be absolute');
  const stateDir = resolve(rawStateDir);
  const memoryRoots = join(root, '.forgeax', 'souls');
  const fromMemoryRoots = relative(memoryRoots, stateDir);
  const fromStateDir = relative(stateDir, memoryRoots);
  const contained = (value: string) => value === '' || (value !== '..' && !value.startsWith(`..${sep}`));
  if (contained(fromMemoryRoots) || contained(fromStateDir)) {
    throw new TypeError('external memory receiptStateDir must not overlap File memory roots');
  }
  return stateDir;
}

function rejectReadOnlyCommand(
  command: DurableMemoryOutboxCommand<unknown>,
): Promise<DurableMemoryDispatchReceipt> {
  return Promise.resolve({ commandId: command.commandId, status: 'rejected' });
}

function captureProvider(input: ExternalReadOnlyMemoryProviderV1): ExternalReadOnlyMemoryProviderV1 {
  if (!input || typeof input !== 'object'
    || !input.source || !input.candidate || !input.loader
    || typeof input.loader.load !== 'function'
    || !Array.isArray(input.refreshScopes)) {
    throw new TypeError('external memory runtime requires a complete product-selected provider');
  }
  if (input.candidate.sourceId !== input.source.sourceId) {
    throw new TypeError('external memory candidate and trusted source ids must match');
  }
  if (typeof input.candidate.validateConfig !== 'function') {
    throw new TypeError('external memory candidate requires an explicit config validator');
  }
  const source = Object.freeze({ ...input.source });
  const candidate = Object.freeze({
    sourceId: input.candidate.sourceId,
    manifest: structuredClone(input.candidate.manifest),
    config: structuredClone(input.candidate.config),
    validateConfig: input.candidate.validateConfig,
  });
  const refreshScopes = Object.freeze(input.refreshScopes.map((scope) =>
    Object.freeze(NpcMemoryProviderScopeV1Schema.parse(structuredClone(scope)))));
  if (refreshScopes.length === 0) {
    throw new TypeError('external memory runtime requires at least one refresh scope');
  }
  return Object.freeze({ source, candidate, loader: input.loader, refreshScopes });
}

/** Creates a read-only runtime around one product-selected provider package. */
export function createExternalReadOnlyMemoryRuntimeHost(
  options: ExternalReadOnlyMemoryRuntimeHostOptions,
): ExternalReadOnlyMemoryRuntimeHost {
  if (!options || typeof options !== 'object') {
    throw new TypeError('external memory runtime options are required');
  }
  if ((options.mode !== 'shadow' && options.mode !== 'active')
    || typeof options.readSnapshot !== 'function'
    || typeof options.subjectFor !== 'function'
    || typeof options.recallRequestFor !== 'function'
    || typeof options.resolveIdentity !== 'function'
    || typeof options.identityResolverVersion !== 'function') {
    throw new TypeError('external memory runtime requires source and product adapters');
  }
  const provider = captureProvider(options.provider);
  const providerId = provider.source.providerId;
  const receiptStateDir = assertActiveStateDir(options);
  let reader: NpcMemoryReaderV1 | undefined;
  let state: ExternalReadOnlyMemoryRuntimeHostState = 'new';
  let startTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;
  let registryStarted = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshController: AbortController | undefined;
  let refreshCycle: Promise<void> | undefined;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? now;
  const providerHost: NpcMemoryReaderHostV1 = {
    now,
    monotonicNow,
    readSnapshot: options.readSnapshot,
    resolveIdentity: options.resolveIdentity,
    identityResolverVersion: options.identityResolverVersion,
    audit: (event) => {
      try { options.providerAudit?.(event); } catch { /* audit is non-authoritative */ }
    },
  };
  const registry = new NpcMemoryProviderRegistry({
    sourceAllowlist: [provider.source],
    loader: provider.loader,
    readerHost: providerHost,
    // This supervisor never exposes a command-writer host. Keep that explicit
    // even for non-ASIW authorities whose registry default is also deny.
    writerPolicy: () => false,
  });
  const outbox = receiptStateDir === undefined ? undefined : new DurableMemoryOutbox<unknown, unknown>({
    stateDir: receiptStateDir,
    now,
    autoRun: options.autoRun,
    dispatch: rejectReadOnlyCommand,
  });
  const refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs <= 0) {
    throw new TypeError('external memory refreshIntervalMs must be a positive safe integer');
  }
  const refreshScopes = [...new Map(
    provider.refreshScopes.map((scope) => [canonicalJson(scope), scope]),
  ).values()] as readonly NpcMemoryProviderScopeV1[];
  const runRefreshCycle = (signal: AbortSignal): Promise<void> => {
    if (refreshCycle) return refreshCycle;
    refreshCycle = Promise.allSettled(refreshScopes.map((scope) => reader!.refresh(scope, signal)))
      .then(() => undefined)
      .finally(() => { refreshCycle = undefined; });
    return refreshCycle;
  };
  const stopRefreshSupervisor = async (
    mode: 'drain' | 'abort',
    signal?: AbortSignal,
  ): Promise<void> => {
    if (refreshTimer !== undefined) { clearInterval(refreshTimer); refreshTimer = undefined; }
    const abort = () => refreshController?.abort(signal?.reason);
    if (mode === 'abort' || signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const pending = refreshCycle;
    try { if (pending) await pending; }
    finally {
      signal?.removeEventListener('abort', abort);
      refreshController = undefined;
    }
  };
  const startRefreshSupervisor = (): void => {
    if (refreshTimer !== undefined || refreshController !== undefined) return;
    refreshController = new AbortController();
    refreshTimer = setInterval(() => {
      if (reader && refreshController) void runRefreshCycle(refreshController.signal);
    }, refreshIntervalMs);
    refreshTimer.unref?.();
  };
  const binding: NpcMemoryRuntimeBinding = Object.freeze({
    mode: options.mode,
    writePolicy: 'deny',
    get reader() { return reader; },
    subjectFor: options.subjectFor,
    recallRequestFor: options.recallRequestFor,
    preload: (subjects: readonly NpcMemorySubjectV1[], signal: AbortSignal) => {
      if (!reader) return Promise.reject(new Error('external memory reader is not started'));
      return reader.preload(subjects, signal);
    },
    audit: options.audit,
    ...(outbox === undefined ? {} : {
      enqueueHandoff: async (input: Parameters<NonNullable<NpcMemoryRuntimeBinding['enqueueHandoff']>>[0]) => {
        if (!Array.isArray(input.commands) || input.commands.length !== 0) {
          throw new Error('external read-only memory runtime accepts zero-command receipts only');
        }
        return outbox.enqueueHandoff(input);
      },
      readHandoff: (handoffId: string) => outbox.getHandoff(handoffId),
    }),
  });
  let outboxStarted = false;
  const hasLiveFacets = () => outboxStarted || registryStarted;
  const abortReader = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    await stopRefreshSupervisor('abort');
    if (outboxStarted && outbox) {
      try { await outbox.stop({ mode: 'abort' }); outboxStarted = false; }
      catch (error) { failures.push(error); }
    }
    if (registryStarted) {
      const stopped = await registry.stop(providerId, 'abort');
      if (stopped.ok) { registryStarted = false; reader = undefined; }
      else failures.push(stopped.error);
    }
    return failures;
  };
  const host: ExternalReadOnlyMemoryRuntimeHost = {
    binding,
    registry,
    get reader() {
      if (!reader) throw new Error('external memory reader is not started');
      return reader;
    },
    providerId,
    mode: options.mode,
    get state() { return state; },
    start: async () => {
      if (state === 'running') return;
      if (state === 'starting') return startTask!;
      if (state !== 'new') throw new Error(`external memory runtime cannot start from ${state}`);
      state = 'starting';
      startTask = (async () => {
        try {
          const activated = await registry.activate(provider.candidate);
          if (!activated.ok) {
            throw new Error(`external memory provider activation failed: ${activated.error.code}`);
          }
          registryStarted = true;
          reader = registry.get(providerId)?.reader;
          if (!reader) throw new Error('external memory provider did not expose a reader');
          startRefreshSupervisor();
          if (outbox) { await outbox.start(); outboxStarted = true; }
          state = 'running';
        } catch (error) {
          if (!registryStarted && registry.get(providerId)) registryStarted = true;
          const failures = hasLiveFacets() ? await abortReader() : [];
          state = 'failed';
          if (failures.length) {
            throw new AggregateError([error, ...failures], 'external memory runtime start cleanup failed');
          }
          throw error;
        }
      })();
      return startTask;
    },
    stop: async (input = {}) => {
      if (state === 'stopped') return;
      if (state === 'stopping') return stopTask!;
      if (state === 'new') { state = 'stopped'; return; }
      if (state === 'starting') { try { await startTask; } catch { /* cleanup failed start below */ } }
      if (state === 'failed') {
        if ((input.mode ?? 'abort') !== 'abort') return;
        state = 'stopping';
        stopTask = (async () => {
          const failures = await abortReader();
          state = hasLiveFacets() ? 'failed' : 'stopped';
          if (failures.length) {
            throw new AggregateError(failures, 'external memory runtime abort cleanup failed');
          }
        })();
        return stopTask;
      }
      if (state !== 'running') return;
      state = 'stopping';
      stopTask = (async () => {
        const mode = input.mode ?? 'drain';
        await stopRefreshSupervisor(mode, input.signal);
        if (mode === 'drain' && outboxStarted && outbox) {
          try { await outbox.stop({ mode, signal: input.signal }); }
          catch (error) {
            startRefreshSupervisor();
            state = 'running';
            throw error;
          }
          outboxStarted = false;
        }
        if (mode === 'abort') {
          const failures = await abortReader();
          state = hasLiveFacets() ? 'failed' : 'stopped';
          if (failures.length) {
            throw new AggregateError(failures, 'external memory runtime abort cleanup failed');
          }
          return;
        }
        const result = await registry.stop(providerId, mode);
        if (!result.ok) {
          state = 'failed';
          throw new Error(`external memory provider stop failed: ${result.error.code}`);
        }
        registryStarted = false;
        reader = undefined;
        state = 'stopped';
      })();
      return stopTask;
    },
  };
  return host;
}
