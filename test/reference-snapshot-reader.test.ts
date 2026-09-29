import { describe, expect, it } from 'bun:test';
import {
  REFERENCE_FIXTURE,
  REFERENCE_FIXTURE_CLOCK_DOMAIN,
  REFERENCE_FIXTURE_ID,
  REFERENCE_FIXTURE_OWNER,
  REFERENCE_FIXTURE_STORE,
} from '../src/npc-brain/memory/reference-snapshot-fixture';
import {
  REFERENCE_SNAPSHOT_READER_DESCRIPTOR,
  REFERENCE_SNAPSHOT_READER_MANIFEST,
  ReferenceSnapshotReaderConfigV1Schema,
  ReferenceSnapshotReaderError,
  createReferenceFixtureStoreReader,
  referenceSnapshotReaderFactory,
} from '../src/npc-brain/memory/reference-snapshot-reader';
import { NpcMemoryProviderRegistry } from '../src/npc-brain/memory/provider-registry';
import type {
  NpcMemoryReaderHostV1,
  NpcMemoryRecallRequestV1,
  NpcMemorySubjectV1,
} from '@forgeax/types/npc-memory';

const NOW = REFERENCE_FIXTURE.generatedAtWallMs;

function subject(
  ownerNpcId: string = REFERENCE_FIXTURE_OWNER.ownerNpcId,
  soulId: string = REFERENCE_FIXTURE_OWNER.soulId,
): NpcMemorySubjectV1 {
  return {
    scope: {
      authority: 'reference-fixture',
      fixtureId: REFERENCE_FIXTURE_ID,
      clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
    },
    ownerNpcId,
    soulId,
  };
}

function request(overrides: Partial<NpcMemoryRecallRequestV1> = {}): NpcMemoryRecallRequestV1 {
  return {
    subject: subject(),
    trigger: 'active_decision',
    at: { day: 1, hour: 9, minute: 0 },
    context: {
      mapId: 'reference-map',
      sceneAreaId: null,
      visibleRefIds: [],
      focusEntityIds: [],
      conversationTurns: [],
    },
    budget: { mode: 'legacy-exact' },
    ...overrides,
  };
}

function makeHost(options: {
  now?: number;
  read?: NpcMemoryReaderHostV1['readReferenceFixture'];
  resolveIdentity?: NpcMemoryReaderHostV1['resolveIdentity'];
} = {}): { host: NpcMemoryReaderHostV1; reads: string[]; audits: Array<Record<string, unknown>> } {
  let now = options.now ?? NOW;
  const reads: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const storeReader = createReferenceFixtureStoreReader(REFERENCE_FIXTURE_STORE);
  const host: NpcMemoryReaderHostV1 = {
    now: () => now,
    monotonicNow: () => now,
    readReferenceFixture: async (scope, input) => {
      reads.push(`${scope.fixtureId}:${input.ifNoneMatch ?? 'none'}`);
      return (options.read ?? storeReader)(scope, input);
    },
    resolveIdentity: options.resolveIdentity ?? (() => ({
      canonicalDisplayName: 'The visiting player',
      isPlayer: true,
      resolverVersion: 'asiw-npc-id/v1',
    })),
    identityResolverVersion: () => 'asiw-npc-id/v1',
    audit: (event) => audits.push(event as unknown as Record<string, unknown>),
  };
  return {
    host,
    reads,
    audits,
  };
}

function makeReader(host: NpcMemoryReaderHostV1, extra: Record<string, unknown> = {}) {
  return referenceSnapshotReaderFactory.createReader(host, {
    allowedSubjects: [{
      fixtureId: REFERENCE_FIXTURE_ID,
      clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
      ...REFERENCE_FIXTURE_OWNER,
    }],
    ...extra,
  });
}

describe('reference-snapshot-reader', () => {
  it('is a reader-only formal factory with a closed source config', () => {
    expect(REFERENCE_SNAPSHOT_READER_DESCRIPTOR.roles).toEqual(['reader']);
    expect(REFERENCE_SNAPSHOT_READER_DESCRIPTOR.capabilities).toEqual(['reference-fixture-read', 'recall-raw-blocks']);
    expect('createCommandWriter' in referenceSnapshotReaderFactory).toBe(false);
    expect(() => ReferenceSnapshotReaderConfigV1Schema.parse({
      allowedSubjects: [{ fixtureId: REFERENCE_FIXTURE_ID, clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN, ...REFERENCE_FIXTURE_OWNER }],
      path: '/tmp/escape',
    })).toThrow();
  });

  it('activates the real class-based factory through the trusted registry', async () => {
    const { host } = makeHost();
    const source = {
      sourceId: 'builtin-reference-memory',
      providerId: REFERENCE_SNAPSHOT_READER_DESCRIPTOR.id,
      entry: REFERENCE_SNAPSHOT_READER_MANIFEST.entry,
      authority: 'reference-fixture' as const,
    };
    const registry = new NpcMemoryProviderRegistry({
      sourceAllowlist: [source],
      loader: {
        load: async () => ({
          [REFERENCE_SNAPSHOT_READER_MANIFEST.exportName]: referenceSnapshotReaderFactory,
        }),
      },
      readerHost: host,
    });
    const activated = await registry.activate({
      sourceId: source.sourceId,
      manifest: REFERENCE_SNAPSHOT_READER_MANIFEST,
      config: {
        allowedSubjects: [{
          fixtureId: REFERENCE_FIXTURE_ID,
          clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
          ...REFERENCE_FIXTURE_OWNER,
        }],
      },
      validateConfig: (value) => ReferenceSnapshotReaderConfigV1Schema.parse(value),
    });
    if (!activated.ok) throw new Error(JSON.stringify(activated.error));
    const reader = registry.get(source.providerId)?.reader;
    expect(reader).toBeDefined();
    await expect(reader!.preload([subject()], new AbortController().signal))
      .resolves.toEqual([expect.objectContaining({ status: 'loaded' })]);
    await expect(reader!.recall(request())).resolves.toMatchObject({
      source: { kind: 'reference-fixture', fixtureId: REFERENCE_FIXTURE_ID },
    });
    expect((await registry.stop(source.providerId, 'drain')).ok).toBe(true);
  });

  it('preloads scopes in parallel while coalescing same-scope reads', async () => {
    const { host, reads } = makeHost();
    const reader = makeReader(host);
    await reader.start();
    const [first, second] = await Promise.all([
      reader.preload([subject()], new AbortController().signal),
      reader.preload([subject()], new AbortController().signal),
    ]);
    expect(first[0]?.status).toBe('loaded');
    expect(second[0]?.status).toBe('loaded');
    expect(reads).toHaveLength(1);
  });

  it('isolates caller cancellation while a coalesced refresh still has a waiter', async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const storeReader = createReferenceFixtureStoreReader(REFERENCE_FIXTURE_STORE);
    const fixture = makeHost({
      read: async (scope, input) => {
        await gate;
        return storeReader(scope, input);
      },
    });
    const reader = makeReader(fixture.host);
    await reader.start();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = reader.refresh(REFERENCE_FIXTURE.scope, firstController.signal);
    const second = reader.refresh(REFERENCE_FIXTURE.scope, secondController.signal);
    firstController.abort(new DOMException('first cancelled', 'AbortError'));
    releaseRead();
    await expect(first).rejects.toBeDefined();
    await expect(second).resolves.toMatchObject({ status: 'loaded' });
    expect(fixture.reads).toHaveLength(1);
  });

  it('builds owner-selected raw blocks and never reads source during decision recall', async () => {
    const { host, reads } = makeHost();
    const reader = makeReader(host);
    await reader.start();
    await reader.preload([subject()], new AbortController().signal);
    const beforeRecall = reads.length;
    const result = await reader.recall(request());
    expect(reads).toHaveLength(beforeRecall);
    expect(result.source.kind).toBe('reference-fixture');
    expect(result.rawBlocks.map((block) => block.text).join('\n')).not.toContain('Bob');
    expect(result.diagnostics.identityResolved).toBe(true);
    const firstBlock = result.rawBlocks[0];
    if (firstBlock !== undefined) firstBlock.text = 'tampered';
    const again = await reader.recall(request());
    expect(again.rawBlocks.map((block) => block.text).join('\n')).not.toContain('tampered');
  });

  it('gates partner-dependent blocks on the host identity resolver and fails soft', async () => {
    const { host, audits } = makeHost({ resolveIdentity: () => null });
    const reader = makeReader(host);
    await reader.start();
    await reader.preload([subject()], new AbortController().signal);
    const result = await reader.recall(request({
      trigger: 'dialogue_turn',
      at: { day: 1, hour: 9, minute: 1 },
      partnerEntityId: 'reference-player-1',
    }));
    expect(result.diagnostics.identityResolved).toBe(false);
    expect(result.rawBlocks.map((block) => block.text).join('\n')).not.toContain('visiting player');
    expect(audits.some((event) => event.errorCode === 'identity_unresolved')).toBe(true);
  });

  it('rejects wrong owner subjects without exposing another owner', async () => {
    const { host, audits } = makeHost();
    const reader = makeReader(host);
    await reader.start();
    const receipts = await reader.preload([subject('reference-npc-bob', 'reference-soul-bob')], new AbortController().signal);
    expect(receipts[0]?.status).toBe('not-applicable');
    await expect(reader.recall(request({ subject: subject('reference-npc-bob', 'reference-soul-bob') }))).rejects.toMatchObject({ code: 'scope_denied' });
    expect(audits.some((event) => event.errorCode === 'scope_denied')).toBe(true);
  });

  it('rejects tampered hash and wrong fixture scope before caching', async () => {
    const tampered = structuredClone(REFERENCE_FIXTURE);
    tampered.integrity.contentHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { host } = makeHost({
      read: async () => ({ status: 'loaded', fixture: tampered, etag: tampered.integrity.contentHash }),
    });
    const reader = makeReader(host);
    await reader.start();
    const receipt = await reader.refresh(REFERENCE_FIXTURE.scope, new AbortController().signal);
    expect(receipt.status).toBe('not-applicable');
    await expect(reader.recall(request())).rejects.toMatchObject({ code: 'missing_snapshot' });

    const wrongScope = structuredClone(REFERENCE_FIXTURE);
    wrongScope.scope.clockDomainId = 'other-clock';
    const secondHost = makeHost({
      read: async () => ({ status: 'loaded', fixture: wrongScope, etag: wrongScope.integrity.contentHash }),
    });
    const secondReader = makeReader(secondHost.host);
    await secondReader.start();
    const secondReceipt = await secondReader.refresh(REFERENCE_FIXTURE.scope, new AbortController().signal);
    expect(secondReceipt.status).toBe('not-applicable');
  });

  it('handles not-modified and stale explicitly', async () => {
    const { host, reads } = makeHost();
    const reader = makeReader(host);
    await reader.start();
    expect((await reader.refresh(REFERENCE_FIXTURE.scope, new AbortController().signal)).status).toBe('loaded');
    expect((await reader.refresh(REFERENCE_FIXTURE.scope, new AbortController().signal)).status).toBe('not-modified');
    expect(reads[1]).toContain(REFERENCE_FIXTURE.integrity.contentHash);

    const stale = makeHost({ now: NOW + 101 });
    const staleReader = makeReader(stale.host, { maxAgeMs: 100 });
    await staleReader.start();
    expect((await staleReader.refresh(REFERENCE_FIXTURE.scope, new AbortController().signal)).status).toBe('not-applicable');
    await expect(staleReader.recall(request())).rejects.toMatchObject({ code: 'missing_snapshot' });
    expect(stale.audits.some((event) => event.errorCode === 'stale_snapshot')).toBe(true);
  });

  it('aborts an in-flight source read and requires a new instance after stop', async () => {
    let resolveRead: (() => void) | undefined;
    const read = async (_scope: NonNullable<NpcMemoryReaderHostV1['readReferenceFixture']> extends (scope: infer S, input: infer _I) => Promise<infer R> ? S : never, input: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => { resolveRead = resolve; });
      if (input.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { status: 'missing' as const };
    };
    const { host } = makeHost({ read: read as NpcMemoryReaderHostV1['readReferenceFixture'] });
    const reader = makeReader(host);
    await reader.start();
    const pending = reader.refresh(REFERENCE_FIXTURE.scope, new AbortController().signal);
    await Promise.resolve();
    const stopped = reader.stop({ mode: 'abort' });
    resolveRead?.();
    await stopped;
    await expect(pending).rejects.toBeDefined();
    await expect(reader.recall(request())).rejects.toMatchObject({ code: 'stopped' });

    const cached = makeHost();
    const recalling = makeReader(cached.host);
    await recalling.start();
    await recalling.preload([subject()], new AbortController().signal);
    const pendingRecall = recalling.recall(request());
    const recallStop = recalling.stop({ mode: 'abort' });
    await expect(pendingRecall).rejects.toMatchObject({ name: 'AbortError' });
    await recallStop;
  });
});
