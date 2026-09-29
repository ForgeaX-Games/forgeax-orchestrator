import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sha256CanonicalJson,
  type NpcMemoryAuthoritySubjectV1,
  type NpcMemoryProviderDescriptorV1,
  type NpcMemoryProviderFactoryV1,
  type NpcMemoryProviderManifestV1,
  type NpcMemoryReaderHostV1,
  type NpcMemoryReaderV1,
} from '@forgeax/types/npc-memory';
import { createExternalReadOnlyMemoryRuntimeHost } from '../src/npc-brain/memory/external-readonly-memory-runtime-host';

const scope = {
  authority: 'asiw' as const,
  authorityScopeId: 'scope-external',
  game: 'game-external',
  worldInstanceId: 'world-external',
  saveBranchId: 'branch-external',
  playerPartition: 'global' as const,
  clockDomainId: 'clock-external',
};
const subject: NpcMemoryAuthoritySubjectV1 = {
  scope,
  ownerNpcId: 'npc-external',
  soulId: 'soul-external',
};
const descriptor = Object.freeze({
  id: 'test-external-memory',
  abiVersion: 1 as const,
  roles: ['reader'] as const,
  capabilities: ['snapshot-read', 'recall-raw-blocks'] as const,
  stateSchemaVersions: [1] as const,
  rawRecallVersions: [1] as const,
  integrityProfiles: ['authenticated-server'] as const,
}) as unknown as NpcMemoryProviderDescriptorV1;
const manifest: NpcMemoryProviderManifestV1 = {
  id: descriptor.id,
  abiVersion: 1,
  entry: './dist/index.js',
  exportName: 'testExternalMemoryFactory',
  descriptor,
  requestedPermissions: ['network:snapshot-read'],
};

function makeRuntimeFixture(input: {
  readonly mode?: 'shadow' | 'active';
  readonly projectRoot?: string;
  readonly refreshIntervalMs?: number;
} = {}) {
  const events: string[] = [];
  const reads: string[] = [];
  let refreshCount = 0;
  const factory: NpcMemoryProviderFactoryV1 = {
    descriptor,
    createReader(host: NpcMemoryReaderHostV1): NpcMemoryReaderV1 {
      return {
        descriptor,
        async start() { events.push('reader:start'); },
        async preload() { events.push('reader:preload'); return []; },
        async refresh(refreshScope, signal) {
          refreshCount += 1;
          events.push('reader:refresh');
          await host.readSnapshot!(subject, { signal });
          return { scope: refreshScope, status: 'not-applicable' };
        },
        async recall(request) {
          events.push('reader:recall');
          return {
            source: {
              kind: 'snapshot',
              revision: {
                epoch: 'epoch-external',
                seq: 1,
                grantId: 'grant-external',
                writerFence: 1,
                writerLeaseId: 'lease-external',
              },
            },
            rawRecallVersion: 1,
            rawBlocks: [],
            diagnostics: {
              stale: true,
              volatileStateUsed: false,
              projectionMode: 'settled-only',
              identityResolved: false,
            },
          };
        },
        async stop() { events.push('reader:stop'); },
      };
    },
  };
  const source = Object.freeze({
    sourceId: 'ide-selected:test-external-memory@0.1.0',
    providerId: descriptor.id,
    entry: manifest.entry,
    authority: 'asiw' as const,
  });
  let loadCount = 0;
  const runtime = createExternalReadOnlyMemoryRuntimeHost({
    mode: input.mode ?? 'shadow',
    ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
    ...(input.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: input.refreshIntervalMs }),
    provider: {
      source,
      candidate: {
        sourceId: source.sourceId,
        manifest,
        config: { enabled: true },
        validateConfig: (value) => {
          if ((value as { enabled?: unknown })?.enabled !== true) throw new Error('invalid config');
          return Object.freeze({ enabled: true });
        },
      },
      loader: {
        load: async (loadedSource) => {
          loadCount += 1;
          expect(loadedSource).toEqual(source);
          return { [manifest.exportName]: factory };
        },
      },
      refreshScopes: [scope, structuredClone(scope)],
    },
    readSnapshot: async (readSubject) => {
      reads.push(readSubject.ownerNpcId);
      return { status: 'missing' };
    },
    subjectFor: () => subject,
    recallRequestFor: ({ subject: requestSubject }) => ({
      subject: requestSubject,
      trigger: 'active_decision',
      at: { day: 0, hour: 0, minute: 0 },
      context: {
        mapId: 'map-external',
        sceneAreaId: null,
        visibleRefIds: [],
        focusEntityIds: [],
        conversationTurns: [],
      },
      budget: { mode: 'legacy-exact' },
    }),
    resolveIdentity: () => null,
    identityResolverVersion: () => null,
  });
  return {
    runtime,
    events,
    reads,
    get loadCount() { return loadCount; },
    get refreshCount() { return refreshCount; },
  };
}

describe('external read-only memory runtime host', () => {
  it('loads only the product-selected source and owns reader lifecycle', async () => {
    const fixture = makeRuntimeFixture();
    expect(fixture.loadCount).toBe(0);
    await fixture.runtime.start();
    expect(fixture.loadCount).toBe(1);
    expect(fixture.runtime.providerId).toBe(descriptor.id);
    expect(fixture.runtime.registry.get(descriptor.id)?.writer).toBeUndefined();
    expect(fixture.runtime.registry.status(descriptor.id)?.writerPolicy).toBe('not-declared');
    await fixture.runtime.binding.preload?.([subject], new AbortController().signal);
    await expect(fixture.runtime.reader.recall({
      subject,
      trigger: 'active_decision',
      at: { day: 0, hour: 0, minute: 0 },
      context: { mapId: 'map', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    })).resolves.toMatchObject({ diagnostics: { projectionMode: 'settled-only' } });
    await fixture.runtime.stop({ mode: 'drain' });
    expect(fixture.events).toEqual(['reader:start', 'reader:preload', 'reader:recall', 'reader:stop']);
    expect(fixture.runtime.state).toBe('stopped');
  });

  it('deduplicates explicit refresh scopes and stops the cadence before reader teardown', async () => {
    const fixture = makeRuntimeFixture({ refreshIntervalMs: 5 });
    await fixture.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 22));
    expect(fixture.refreshCount).toBeGreaterThanOrEqual(2);
    expect(fixture.reads.length).toBe(fixture.refreshCount);
    const readsAtStop = fixture.reads.length;
    await fixture.runtime.stop({ mode: 'drain' });
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(fixture.reads).toHaveLength(readsAtStop);
    expect(fixture.events.at(-1)).toBe('reader:stop');
  });

  it('persists zero-command receipts while rejecting forged writes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-external-memory-'));
    try {
      const first = makeRuntimeFixture({ mode: 'active', projectRoot });
      await first.runtime.start();
      const decision = { inputFingerprint: 'external-fingerprint', wireDecision: { ok: true } };
      const decisionHash = await sha256CanonicalJson(decision);
      await expect(first.runtime.binding.enqueueHandoff!({
        handoffId: 'external-zero',
        eventId: 'external-event',
        decisionHash,
        decision,
        commands: [],
      })).resolves.toMatchObject({ status: 'enqueued' });
      await expect(first.runtime.binding.enqueueHandoff!({
        handoffId: 'external-forged',
        eventId: 'external-event-forged',
        decisionHash,
        decision,
        commands: [{
          commandId: 'forged',
          scopeKey: 'scope',
          idempotencyKey: '0'.repeat(32),
          commandHash: '0'.repeat(64),
          payload: {},
        }],
      })).rejects.toThrow('zero-command');
      await first.runtime.stop({ mode: 'drain' });

      const restarted = makeRuntimeFixture({ mode: 'active', projectRoot });
      await restarted.runtime.start();
      expect(restarted.runtime.binding.readHandoff?.('external-zero')).toMatchObject({
        eventId: 'external-event',
        decisionHash,
        decision,
        commands: [],
      });
      await restarted.runtime.stop({ mode: 'drain' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects mismatched source and candidate identities before loading code', () => {
    expect(() => createExternalReadOnlyMemoryRuntimeHost({
      mode: 'shadow',
      provider: {
        source: {
          sourceId: 'trusted', providerId: descriptor.id, entry: manifest.entry, authority: 'asiw',
        },
        candidate: {
          sourceId: 'other', manifest, config: {}, validateConfig: (value) => value,
        },
        loader: { load: async () => ({}) },
        refreshScopes: [scope],
      },
      readSnapshot: async () => ({ status: 'missing' }),
      subjectFor: () => subject,
      recallRequestFor: () => { throw new Error('unused'); },
      resolveIdentity: () => null,
      identityResolverVersion: () => null,
    })).toThrow('source ids must match');
  });
});
