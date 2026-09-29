import { describe, expect, test } from 'bun:test';
import type {
  NpcMemoryCommandWriterHostV1,
  NpcMemoryProviderDescriptorV1,
  NpcMemoryProviderManifestV1,
  NpcMemoryReaderHostV1,
} from '@forgeax/types/npc-memory';
import {
  NpcMemoryProviderRegistry,
  type NpcMemoryProviderCandidateV1,
  type NpcMemoryProviderTrustedSourceV1,
} from '../src/npc-brain/memory/provider-registry';

type Counters = {
  readerStart: number;
  readerStop: number;
  writerStart: number;
  writerStop: number;
  writerFactory: number;
};

const BASE_SOURCE: NpcMemoryProviderTrustedSourceV1 = {
  sourceId: 'memory-source',
  providerId: 'test-memory-provider',
  entry: 'artifact://memory-provider.js',
  authority: 'reference-fixture',
};

const REFERENCE_DESCRIPTOR: NpcMemoryProviderDescriptorV1 = {
  id: BASE_SOURCE.providerId,
  abiVersion: 1,
  roles: ['reader'],
  capabilities: ['reference-fixture-read', 'recall-raw-blocks'],
  stateSchemaVersions: [1],
  rawRecallVersions: [1],
  integrityProfiles: [],
};

const SNAPSHOT_DESCRIPTOR: NpcMemoryProviderDescriptorV1 = {
  id: BASE_SOURCE.providerId,
  abiVersion: 1,
  roles: ['reader'],
  capabilities: ['snapshot-read', 'recall-raw-blocks'],
  stateSchemaVersions: [1],
  rawRecallVersions: [1],
  integrityProfiles: ['authenticated-server'],
};

const FILE_DESCRIPTOR: NpcMemoryProviderDescriptorV1 = {
  id: BASE_SOURCE.providerId,
  abiVersion: 1,
  roles: ['reader', 'writer'],
  capabilities: ['recall-raw-blocks', 'external-commit', 'settle'],
  stateSchemaVersions: [1],
  rawRecallVersions: [1],
  integrityProfiles: [],
};

const ASIW_DESCRIPTOR: NpcMemoryProviderDescriptorV1 = {
  id: BASE_SOURCE.providerId,
  abiVersion: 1,
  roles: ['reader', 'writer'],
  capabilities: ['snapshot-read', 'snapshot-write', 'event-ingest', 'recall-raw-blocks'],
  stateSchemaVersions: [1],
  rawRecallVersions: [1],
  integrityProfiles: ['authenticated-server'],
};

function host(options: { snapshot?: boolean; reference?: boolean } = {}): NpcMemoryReaderHostV1 {
  return {
    now: () => 1,
    monotonicNow: () => 1,
    ...(options.snapshot ? { readSnapshot: async () => ({ status: 'missing' as const }) } : {}),
    ...(options.reference ? { readReferenceFixture: async () => ({ status: 'missing' as const }) } : {}),
    resolveIdentity: () => null,
    identityResolverVersion: () => null,
    audit: () => undefined,
  };
}

const writerHost: NpcMemoryCommandWriterHostV1 = {
  now: () => 1,
  audit: () => undefined,
};

function candidate(
  source: NpcMemoryProviderTrustedSourceV1,
  descriptor: NpcMemoryProviderDescriptorV1,
  factory: Record<string, unknown>,
  extra: Partial<NpcMemoryProviderCandidateV1> = {},
): NpcMemoryProviderCandidateV1 {
  const permissions: NpcMemoryProviderManifestV1['requestedPermissions'] = descriptor.capabilities.includes('snapshot-read')
    ? ['network:snapshot-read']
    : descriptor.capabilities.includes('reference-fixture-read')
      ? ['fixture:reference-read']
      : descriptor.capabilities.some((capability) => ['external-commit', 'settle', 'snapshot-write', 'event-ingest'].includes(capability))
        ? ['fs:provider-state']
        : [];
  return {
    sourceId: source.sourceId,
    manifest: {
      id: descriptor.id,
      abiVersion: 1,
      entry: source.entry,
      exportName: 'factory',
      descriptor,
      requestedPermissions: permissions,
    } satisfies NpcMemoryProviderManifestV1,
    config: { enabled: true },
    validateConfig: (value) => value,
    ...extra,
    // The loader is installed by each test via `moduleFor` below.
    __factory: factory,
  } as NpcMemoryProviderCandidateV1 & { __factory: Record<string, unknown> };
}

function moduleFor(factory: Record<string, unknown>) {
  return { load: async () => ({ factory }) };
}

function readerFactory(
  descriptor: NpcMemoryProviderDescriptorV1,
  counters: Counters,
  options: { failStart?: boolean; failStop?: boolean; captureHost?: (host: NpcMemoryReaderHostV1) => void } = {},
) {
  return {
    descriptor,
    createReader: (readerHost: NpcMemoryReaderHostV1) => {
      options.captureHost?.(readerHost);
      return {
        descriptor,
        start: async () => {
          counters.readerStart++;
          if (options.failStart) throw new Error('reader start failed');
        },
        preload: async () => [],
        refresh: async () => ({ status: 'not-applicable' as const }),
        recall: async () => ({ status: 'unavailable' as const }),
        stop: async () => {
          counters.readerStop++;
          if (options.failStop) throw new Error('reader stop failed');
        },
      };
    },
  };
}

function writerFactory(
  descriptor: NpcMemoryProviderDescriptorV1,
  counters: Counters,
  options: { failStart?: boolean } = {},
) {
  return {
    descriptor,
    createReader: readerFactory(descriptor, counters).createReader,
    createCommandWriter: () => {
      counters.writerFactory++;
      return {
        descriptor,
        start: async () => {
          counters.writerStart++;
          if (options.failStart) throw new Error('writer start failed');
        },
        commit: async (command: { commandId: string }) => ({ commandId: command.commandId, status: 'written' as const }),
        settle: async (command: { commandId: string }) => ({ commandId: command.commandId, status: 'written' as const }),
        stop: async () => { counters.writerStop++; },
      };
    },
  };
}

function makeRegistry(
  sources: readonly NpcMemoryProviderTrustedSourceV1[],
  loader: { load: (source: NpcMemoryProviderTrustedSourceV1) => Promise<unknown> },
  options: Partial<ConstructorParameters<typeof NpcMemoryProviderRegistry>[0]> = {},
) {
  return new NpcMemoryProviderRegistry({
    sourceAllowlist: sources,
    loader,
    readerHost: host({ snapshot: true, reference: true }),
    writerHost,
    ...options,
  });
}

describe('NpcMemoryProviderRegistry', () => {
  test('rejects an untrusted source before the host loader is called', async () => {
    let loads = 0;
    const registry = makeRegistry([], { load: async () => { loads++; return {}; } });
    const result = await registry.register({
      sourceId: 'not-allowlisted',
      manifest: {},
      config: {},
      validateConfig: (value) => value,
    });
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('source_not_trusted');
    expect(loads).toBe(0);
  });

  test('requires exact trusted provider id and entry and never executes a mismatched artifact', async () => {
    let loads = 0;
    const source = { ...BASE_SOURCE };
    const registry = makeRegistry([source], { load: async () => { loads++; return {}; } });
    const result = await registry.register({
      sourceId: source.sourceId,
      manifest: {
        id: source.providerId,
        abiVersion: 1,
        entry: 'artifact://other.js',
        exportName: 'factory',
        descriptor: REFERENCE_DESCRIPTOR,
        requestedPermissions: ['fixture:reference-read'],
      },
      config: {},
      validateConfig: (value) => value,
    });
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('source_not_trusted');
    expect(loads).toBe(0);
  });

  test('validates config explicitly before module loading', async () => {
    let loads = 0;
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const factory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    const registry = makeRegistry([BASE_SOURCE], { load: async () => { loads++; return { factory }; } });
    const result = await registry.register(candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, factory, {
      validateConfig: () => { throw new Error('bad config'); },
    }));
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('config_invalid');
    expect(loads).toBe(0);
  });

  test('rejects invalid ABI/export and descriptor forgery', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const wrongExport = makeRegistry([BASE_SOURCE], { load: async () => ({ other: readerFactory(REFERENCE_DESCRIPTOR, counters) }) });
    const missing = await wrongExport.register(candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, readerFactory(REFERENCE_DESCRIPTOR, counters)));
    expect(missing.ok).toBe(false);
    expect(missing.ok || missing.error.code).toBe('export_missing');

    const forgedFactory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    const forged = makeRegistry([BASE_SOURCE], moduleFor({ factory: { ...forgedFactory, descriptor: { ...REFERENCE_DESCRIPTOR, id: 'forged' } } }));
    const rejected = await forged.register(candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, forgedFactory));
    expect(rejected.ok).toBe(false);
    expect(rejected.ok || rejected.error.code).toBe('factory_invalid');
  });

  test('rejects permission mismatch and missing source host method before module load', async () => {
    let loads = 0;
    const factory = readerFactory(REFERENCE_DESCRIPTOR, {
      readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0,
    });
    const permissionRegistry = makeRegistry([BASE_SOURCE], { load: async () => { loads++; return { factory }; } });
    const invalidManifestCandidate = {
      ...candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, factory),
      manifest: {
        id: REFERENCE_DESCRIPTOR.id,
        abiVersion: 1,
        entry: BASE_SOURCE.entry,
        exportName: 'factory',
        descriptor: REFERENCE_DESCRIPTOR,
        requestedPermissions: ['network:snapshot-read'],
      },
    } as NpcMemoryProviderCandidateV1;
    const permissionResult = await permissionRegistry.register(invalidManifestCandidate);
    expect(permissionResult.ok).toBe(false);
    expect(permissionResult.ok || permissionResult.error.code).toBe('manifest_invalid');
    expect(loads).toBe(0);

    const snapshotFactory = readerFactory(SNAPSHOT_DESCRIPTOR, {
      readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0,
    });
    const snapshotSource = { ...BASE_SOURCE, authority: 'asiw' as const };
    const hostMissingSource = makeRegistry([snapshotSource], moduleFor(snapshotFactory), { readerHost: host() });
    const missingHostResult = await hostMissingSource.register(candidate(snapshotSource, SNAPSHOT_DESCRIPTOR, snapshotFactory));
    expect(missingHostResult.ok).toBe(false);
    expect(missingHostResult.ok || missingHostResult.error.code).toBe('capability_mismatch');
  });

  test('scopes source methods: fixture reader cannot reach network and snapshot reader cannot reach fixture', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    let fixtureHost: NpcMemoryReaderHostV1 | undefined;
    const fixtureFactory = readerFactory(REFERENCE_DESCRIPTOR, counters, { captureHost: (value) => { fixtureHost = value; } });
    const fixtureRegistry = makeRegistry([BASE_SOURCE], moduleFor(fixtureFactory));
    expect((await fixtureRegistry.register(candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, fixtureFactory))).ok).toBe(true);
    expect(fixtureHost?.readReferenceFixture).toBeFunction();
    expect(fixtureHost?.readSnapshot).toBeUndefined();

    let snapshotHost: NpcMemoryReaderHostV1 | undefined;
    let forwardedSubject: Parameters<NonNullable<NpcMemoryReaderHostV1['readSnapshot']>>[0] | undefined;
    const snapshotFactory = readerFactory(SNAPSHOT_DESCRIPTOR, counters, { captureHost: (value) => { snapshotHost = value; } });
    const snapshotSource = { ...BASE_SOURCE, authority: 'asiw' as const };
    const snapshotRegistry = makeRegistry([snapshotSource], moduleFor(snapshotFactory), {
      readerHost: {
        ...host(),
        readSnapshot: async (subject) => {
          forwardedSubject = subject;
          return { status: 'missing' };
        },
      },
    });
    expect((await snapshotRegistry.register(candidate(snapshotSource, SNAPSHOT_DESCRIPTOR, snapshotFactory))).ok).toBe(true);
    expect(snapshotHost?.readSnapshot).toBeFunction();
    expect(snapshotHost?.readReferenceFixture).toBeUndefined();

    const authoritySubject = {
      scope: {
        authority: 'asiw' as const,
        authorityScopeId: 'scope-1',
        game: 'game-1',
        worldInstanceId: 'world-1',
        saveBranchId: 'branch-1',
        playerPartition: 'player:player-1',
        clockDomainId: 'clock-1',
      },
      ownerNpcId: 'npc-1',
      soulId: 'soul-1',
    };
    await expect(snapshotHost!.readSnapshot!(authoritySubject, {
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'missing' });
    expect(forwardedSubject).toEqual(authoritySubject);
  });

  test('keeps Reader usable while the ASIW writer policy forcibly denies a forged writer', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const factory = writerFactory(FILE_DESCRIPTOR, counters);
    const source = { ...BASE_SOURCE, authority: 'asiw' as const };
    const registry = makeRegistry([source], moduleFor(factory), { writerPolicy: () => true });
    const result = await registry.register(candidate(source, FILE_DESCRIPTOR, factory));
    expect(result.ok).toBe(true);
    expect(registry.get(FILE_DESCRIPTOR.id)?.writer).toBeUndefined();
    expect(registry.get(FILE_DESCRIPTOR.id)?.writerPolicy).toBe('denied');
    expect(counters.writerFactory).toBe(0);
    expect(registry.status(FILE_DESCRIPTOR.id)?.warnings.some((warning) => warning.code === 'writer_policy_denied')).toBe(true);
  });

  test('loads the real ASIW reader shape while denying its non-command writer lifecycle', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const source = { ...BASE_SOURCE, authority: 'asiw' as const };
    const factory = readerFactory(ASIW_DESCRIPTOR, counters);
    const registry = makeRegistry([source], moduleFor(factory), { writerPolicy: () => true });
    const result = await registry.register(candidate(source, ASIW_DESCRIPTOR, factory));
    expect(result.ok).toBe(true);
    expect(registry.get(ASIW_DESCRIPTOR.id)?.authority).toBe('asiw');
    expect(registry.get(ASIW_DESCRIPTOR.id)?.writer).toBeUndefined();
    expect(registry.get(ASIW_DESCRIPTOR.id)?.writerPolicy).toBe('denied');
  });

  test('binds authority to the trusted source and rejects conflicting source provenance', () => {
    expect(() => makeRegistry([
      { ...BASE_SOURCE, sourceId: 'asiw-source', authority: 'asiw' },
      { ...BASE_SOURCE, sourceId: 'file-source', authority: 'forgeax-file' },
    ], { load: async () => ({}) })).toThrow(/authority collision/);
  });

  test('allows a configured File writer independently of the Reader policy', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const factory = writerFactory(FILE_DESCRIPTOR, counters);
    const source = { ...BASE_SOURCE, authority: 'forgeax-file' as const };
    const registry = makeRegistry([source], moduleFor(factory), { writerPolicy: () => true });
    const result = await registry.register(candidate(source, FILE_DESCRIPTOR, factory));
    expect(result.ok).toBe(true);
    expect(registry.get(FILE_DESCRIPTOR.id)?.writer).toBeDefined();
    expect(registry.get(FILE_DESCRIPTOR.id)?.writerPolicy).toBe('enabled');
  });

  test('rolls back a partial start and never calls a facet stop twice', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const factory = writerFactory(FILE_DESCRIPTOR, counters, { failStart: true });
    const source = { ...BASE_SOURCE, authority: 'forgeax-file' as const };
    const registry = makeRegistry([source], moduleFor(factory), { writerPolicy: () => true });
    const activated = await registry.activate(candidate(source, FILE_DESCRIPTOR, factory));
    expect(activated.ok).toBe(false);
    expect(counters.readerStart).toBe(1);
    expect(counters.writerStart).toBe(1);
    expect(counters.writerStop).toBe(1);
    expect(counters.readerStop).toBe(1);
    expect(registry.status(FILE_DESCRIPTOR.id)?.state).toBe('failed');
    await registry.stop(FILE_DESCRIPTOR.id);
    expect(counters.writerStop).toBe(1);
    expect(counters.readerStop).toBe(1);
  });

  test('start and stop are idempotent for a running provider', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const factory = writerFactory(FILE_DESCRIPTOR, counters);
    const source = { ...BASE_SOURCE, authority: 'forgeax-file' as const };
    const registry = makeRegistry([source], moduleFor(factory), { writerPolicy: () => true });
    expect((await registry.activate(candidate(source, FILE_DESCRIPTOR, factory))).ok).toBe(true);
    expect((await registry.start(FILE_DESCRIPTOR.id)).ok).toBe(true);
    expect(counters.readerStart).toBe(1);
    expect(counters.writerStart).toBe(1);
    expect((await registry.stop(FILE_DESCRIPTOR.id)).ok).toBe(true);
    expect((await registry.stop(FILE_DESCRIPTOR.id)).ok).toBe(true);
    expect(counters.readerStop).toBe(1);
    expect(counters.writerStop).toBe(1);
  });

  test('serializes concurrent registration and stop for one provider id', async () => {
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const factory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    let loads = 0;
    const registry = makeRegistry([BASE_SOURCE], { load: async () => { loads += 1; return { factory }; } });
    const [first, second] = await Promise.all([
      registry.register(candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, factory)),
      registry.register(candidate(BASE_SOURCE, REFERENCE_DESCRIPTOR, factory)),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(loads).toBe(1);
    expect((await registry.start(REFERENCE_DESCRIPTOR.id)).ok).toBe(true);
    const stops = await Promise.all([
      registry.stop(REFERENCE_DESCRIPTOR.id),
      registry.stop(REFERENCE_DESCRIPTOR.id),
    ]);
    expect(stops.every((result) => result.ok)).toBe(true);
    expect(counters.readerStop).toBe(1);
  });

  test('safe boot reports bad candidates while loading valid candidates', async () => {
    const goodSource = { ...BASE_SOURCE };
    const badSource = { sourceId: 'bad', providerId: 'bad-provider', entry: 'artifact://bad.js', authority: 'reference-fixture' as const };
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const goodFactory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    const registry = makeRegistry([goodSource, badSource], {
      load: async (source) => source.sourceId === goodSource.sourceId ? { factory: goodFactory } : { wrong: true },
    });
    const report = await registry.boot([
      candidate(goodSource, REFERENCE_DESCRIPTOR, goodFactory),
      { sourceId: 'not-allowlisted', manifest: {}, config: {}, validateConfig: (value) => value },
    ]);
    expect(report.loadedProviderIds).toEqual([REFERENCE_DESCRIPTOR.id]);
    expect(report.results.some((result) => !result.ok)).toBe(true);
    expect(registry.status(REFERENCE_DESCRIPTOR.id)?.state).toBe('running');
  });

  test('reload starts a fresh old-version instance after replacement start failure', async () => {
    const firstSource = { ...BASE_SOURCE, sourceId: 'source-one', entry: 'artifact://one.js' };
    const secondSource = { ...BASE_SOURCE, sourceId: 'source-two', entry: 'artifact://two.js' };
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const oldFactory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    const newFactory = readerFactory(REFERENCE_DESCRIPTOR, counters, { failStart: true });
    const registry = makeRegistry([firstSource, secondSource], {
      load: async (source) => ({ factory: source.sourceId === firstSource.sourceId ? oldFactory : newFactory }),
    });
    expect((await registry.activate(candidate(firstSource, REFERENCE_DESCRIPTOR, oldFactory))).ok).toBe(true);
    const originalReader = registry.get(REFERENCE_DESCRIPTOR.id)!.reader;
    const replacement = await registry.reload(REFERENCE_DESCRIPTOR.id, candidate(secondSource, REFERENCE_DESCRIPTOR, newFactory));
    expect(replacement.ok).toBe(false);
    expect(registry.get(REFERENCE_DESCRIPTOR.id)?.reader).not.toBe(originalReader);
    expect(registry.status(REFERENCE_DESCRIPTOR.id)?.state).toBe('running');
    expect(counters.readerStart).toBe(3);
    expect(counters.readerStop).toBe(2);
  });

  test('reload never starts a replacement when old shutdown fails', async () => {
    const firstSource = { ...BASE_SOURCE, sourceId: 'stop-fail-one', entry: 'artifact://stop-fail-one.js' };
    const secondSource = { ...BASE_SOURCE, sourceId: 'stop-fail-two', entry: 'artifact://stop-fail-two.js' };
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    let failOldStop = true;
    const oldFactory = {
      ...readerFactory(REFERENCE_DESCRIPTOR, counters),
      createReader: () => ({
        descriptor: REFERENCE_DESCRIPTOR,
        start: async () => { counters.readerStart += 1; },
        preload: async () => [],
        refresh: async () => ({ status: 'not-applicable' as const }),
        recall: async () => ({ status: 'unavailable' as const }),
        stop: async () => {
          counters.readerStop += 1;
          if (failOldStop) throw new Error('reader stop failed');
        },
      }),
    };
    const replacementFactory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    const registry = makeRegistry([firstSource, secondSource], {
      load: async (source) => ({ factory: source.sourceId === firstSource.sourceId ? oldFactory : replacementFactory }),
    });
    await registry.activate(candidate(firstSource, REFERENCE_DESCRIPTOR, oldFactory));
    const oldReader = registry.get(REFERENCE_DESCRIPTOR.id)!.reader;
    const result = await registry.reload(REFERENCE_DESCRIPTOR.id, candidate(secondSource, REFERENCE_DESCRIPTOR, replacementFactory));
    expect(result).toMatchObject({ ok: false });
    expect(registry.get(REFERENCE_DESCRIPTOR.id)?.reader).toBe(oldReader);
    expect(registry.status(REFERENCE_DESCRIPTOR.id)?.state).toBe('failed');
    expect(counters.readerStart).toBe(1);
    expect(counters.readerStop).toBe(1);
    failOldStop = false;
    expect((await registry.stop(REFERENCE_DESCRIPTOR.id, 'abort')).ok).toBe(true);
    expect(registry.status(REFERENCE_DESCRIPTOR.id)?.state).toBe('stopped');
    expect(counters.readerStop).toBe(2);
  });

  test('reload exposes a failed replacement even when its cleanup stop fails', async () => {
    const firstSource = { ...BASE_SOURCE, sourceId: 'atomic-one', entry: 'artifact://atomic-one.js' };
    const secondSource = { ...BASE_SOURCE, sourceId: 'atomic-two', entry: 'artifact://atomic-two.js' };
    const counters: Counters = { readerStart: 0, readerStop: 0, writerStart: 0, writerStop: 0, writerFactory: 0 };
    const oldFactory = readerFactory(REFERENCE_DESCRIPTOR, counters);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const newFactory = {
      ...readerFactory(REFERENCE_DESCRIPTOR, counters),
      createReader: () => ({
        descriptor: REFERENCE_DESCRIPTOR,
        start: async () => { counters.readerStart += 1; await startGate; throw new Error('replacement start failed'); },
        preload: async () => [],
        refresh: async () => ({ status: 'not-applicable' as const }),
        recall: async () => ({ status: 'unavailable' as const }),
        stop: async () => { counters.readerStop += 1; throw new Error('replacement stop failed'); },
      }),
    };
    const registry = makeRegistry([firstSource, secondSource], {
      load: async (source) => ({ factory: source.sourceId === firstSource.sourceId ? oldFactory : newFactory }),
    });
    await registry.activate(candidate(firstSource, REFERENCE_DESCRIPTOR, oldFactory));
    const oldReader = registry.get(REFERENCE_DESCRIPTOR.id)!.reader;
    const replacing = registry.reload(REFERENCE_DESCRIPTOR.id, candidate(secondSource, REFERENCE_DESCRIPTOR, newFactory));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get(REFERENCE_DESCRIPTOR.id)!.reader).toBe(oldReader);
    expect(counters.readerStop).toBe(1);
    releaseStart();
    await expect(replacing).resolves.toMatchObject({ ok: false });
    expect(registry.get(REFERENCE_DESCRIPTOR.id)!.reader).not.toBe(oldReader);
    expect(registry.status(REFERENCE_DESCRIPTOR.id)?.state).toBe('failed');
    expect(counters.readerStop).toBe(2);
    expect(counters.readerStart).toBe(2);
  });
});
