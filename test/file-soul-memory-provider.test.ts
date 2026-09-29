import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR,
  FILE_SOUL_MEMORY_PROVIDER_MANIFEST,
  FileSoulMemoryProviderError,
  FileSoulMemoryProviderConfigV1Schema,
  createFileSoulMemoryReader,
  createFileSoulMemoryWriter,
  fileSoulMemoryProviderFactory,
} from '../src/npc-brain/memory/file-soul-memory-provider';
import {
  fileMemoryFactIdempotencyKey,
  fileMemorySettlementIdempotencyKey,
} from '../src/npc-brain/memory/file-memory-idempotency';
import { NpcMemoryProviderRegistry } from '../src/npc-brain/memory/provider-registry';
import {
  composeEpisodicRecall,
  composeEpisodicRecallAsync,
  composeReincarnationNotice,
  composeReincarnationNoticeAsync,
  composeStableMemory,
  composeStableMemoryAsync,
  firstPastLifeMemoryAsync,
  readMemoryIndex,
  searchMemory,
  searchMemoryAsync,
} from '../src/soul/layered-memory';
import { writeMemoryEntry } from '../src/soul/layered-memory';

const TMP = mkdtempSync(join(tmpdir(), 'fx-file-soul-provider-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function scope(
  game = 'paopaotang',
  partition: { kind: 'soul-shared' } | { kind: 'player-isolated'; playerId: string } = { kind: 'soul-shared' },
  memoryGame = game,
) {
  return { authority: 'forgeax-file' as const, game, memoryGame, soulId: 'npc.alice', storagePartition: partition };
}
function subject(currentScope = scope()) { return { scope: currentScope, ownerNpcId: 'alice', soulId: currentScope.soulId }; }
function factKey(
  currentScope: ReturnType<typeof scope>,
  sourceEventId: string,
  kind: 'episode' | 'trait',
  text: string,
) {
  return fileMemoryFactIdempotencyKey(currentScope, sourceEventId, kind, text);
}
function request(currentScope = scope(), extra: Record<string, unknown> = {}) {
  return {
    subject: subject(currentScope), trigger: 'active_decision' as const,
    at: { day: 1, hour: 2, minute: 3 },
    context: { mapId: 'map', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
    budget: { mode: 'legacy-exact' as const }, ...extra,
  };
}
function host() {
  const events: unknown[] = [];
  return {
    now: () => 1_700_000_000_000,
    monotonicNow: () => 10,
    resolveIdentity: () => null,
    identityResolverVersion: () => null,
    audit: (event: unknown) => events.push(event),
    events,
  };
}
function writerHost() {
  const events: unknown[] = [];
  return { now: () => 1_700_000_000_000, audit: (event: unknown) => events.push(event), events };
}
function config(name: string) {
  const projectRoot = join(TMP, name);
  mkdirSync(projectRoot, { recursive: true });
  return { projectRoot, stateDir: join(projectRoot, 'provider-state') };
}

describe('FileSoulMemoryProvider', () => {
  test('descriptor and config are closed, local-only capabilities', () => {
    expect(FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR.capabilities).toEqual(['recall-raw-blocks', 'external-commit', 'settle']);
    expect(FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR.integrityProfiles).toEqual([]);
    expect(() => FileSoulMemoryProviderConfigV1Schema.parse({ projectRoot: '/tmp/x', url: 'https://bad' })).toThrow();
    expect(fileMemoryFactIdempotencyKey(
      scope('paopaotang', { kind: 'player-isolated', playerId: 'p1' }, 'tenant-canonical'),
      'event-1',
      'episode',
      '  hello\t world  ',
    )).toBe('90978ce9a2b12f3f2859601c5944c707');
    expect(fileMemorySettlementIdempotencyKey(
      scope('paopaotang', { kind: 'player-isolated', playerId: 'p1' }, 'tenant-canonical'),
      'episode-end-1',
    )).toBe('b76af7ecf7dcc46bd80abb2b39948c83');
  });

  test('loads the real File factory through the trusted registry and starts both facets', async () => {
    const c = config('registry');
    const source = {
      sourceId: 'builtin-file-memory',
      providerId: FILE_SOUL_MEMORY_PROVIDER_DESCRIPTOR.id,
      entry: FILE_SOUL_MEMORY_PROVIDER_MANIFEST.entry,
      authority: 'forgeax-file' as const,
    };
    const registry = new NpcMemoryProviderRegistry({
      sourceAllowlist: [source],
      loader: { load: async () => ({ [FILE_SOUL_MEMORY_PROVIDER_MANIFEST.exportName]: fileSoulMemoryProviderFactory }) },
      readerHost: host(),
      writerHost: writerHost(),
      writerPolicy: () => true,
    });
    const activated = await registry.activate({
      sourceId: source.sourceId,
      manifest: FILE_SOUL_MEMORY_PROVIDER_MANIFEST,
      config: c,
      validateConfig: (value) => FileSoulMemoryProviderConfigV1Schema.parse(value),
    });
    if (!activated.ok) throw new Error(JSON.stringify(activated.error));
    expect(activated.ok).toBe(true);
    expect(registry.status(source.providerId)).toMatchObject({ state: 'running', writerPolicy: 'enabled' });
    expect((await registry.stop(source.providerId, 'drain')).ok).toBe(true);
  });

  test('reader preserves stable/current-world/reincarnation legacy text and order', async () => {
    const c = config('parity');
    const root = join(c.projectRoot, '.forgeax', 'souls', 'npc.alice', 'memory');
    writeMemoryEntry({ root }, { tier: 'identity', title: 'Name', text: 'Alice identity.' });
    writeMemoryEntry({ root }, { tier: 'traits', title: 'Trait', text: 'Alice trait.' });
    writeMemoryEntry({ root, game: 'old-world' }, { tier: 'episodes', title: 'Past', text: 'A past life fact.' });
    writeMemoryEntry({ root, game: 'second-world' }, { tier: 'episodes', title: 'Blue Key', text: 'The blue key opens the tower.' });
    const h = host();
    const reader = createFileSoulMemoryReader(h, c);
    await reader.start();
    const result = await reader.recall(request());
    expect(result.rawBlocks.map((block) => block.name)).toEqual(['stable-memory', 'reincarnation']);
    expect(result.rawBlocks.map((block) => block.text)).toEqual([
      await composeStableMemoryAsync({ root, game: 'paopaotang' }),
      `${await composeReincarnationNoticeAsync({ root, game: 'paopaotang' })}\n\nOne bounded past-life memory you may reference explicitly as a past-life rumor, never as a current-world fact:\n# Past\n\nA past life fact.`,
    ]);
    expect(await composeStableMemoryAsync({ root, game: 'paopaotang' })).toBe(composeStableMemory({ root, game: 'paopaotang' }));
    expect(await composeReincarnationNoticeAsync({ root, game: 'paopaotang' })).toBe(composeReincarnationNotice({ root, game: 'paopaotang' }));
    expect(await composeEpisodicRecallAsync({ root, game: 'paopaotang' })).toBe(composeEpisodicRecall({ root, game: 'paopaotang' }));
    expect(await searchMemoryAsync({ root, game: 'paopaotang' }, 'past life', 5))
      .toEqual(searchMemory({ root, game: 'paopaotang' }, 'past life', 5));
    expect(await firstPastLifeMemoryAsync({ root, game: 'paopaotang' })).toEqual({ text: '# Past\n\nA past life fact.\n' });
    const blueRequest = request(scope(), {
      context: {
        mapId: 'map', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [],
        conversationTurns: [{ speakerEntityId: 'player', listenerEntityId: 'alice', text: 'blue key', at: 1 }],
      },
    });
    const blueRecall = await reader.recall(blueRequest);
    expect(blueRecall.rawBlocks.find((block) => block.name === 'reincarnation')?.text).toContain('blue key opens the tower');
    expect(result.source.kind).toBe('live-file');
    expect(result.diagnostics.projectionMode).toBe('full');
    await reader.stop({ mode: 'drain' });
  });

  test('legacy-exact keeps an oversized current-world episode untrimmed', async () => {
    const c = config('large');
    const h = host();
    const writer = createFileSoulMemoryWriter(writerHost(), c)!;
    await writer.start();
    const text = 'x'.repeat(60_000);
    const result = await writer.commit!({
      commandId: 'command-large', sourceEventId: 'event-large',
      idempotencyKey: factKey(scope(), 'event-large', 'episode', text), trustTier: 'own',
      subject: subject(), facts: [{ kind: 'episode', text }],
    }, new AbortController().signal);
    expect(result.status).toBe('written');
    const reader = createFileSoulMemoryReader(h, c);
    await reader.start();
    const recall = await reader.recall(request());
    expect(recall.rawBlocks.find((block) => block.name === 'current-world-memory')?.text).toContain(text);
  });

  test('storagePartition is the root source of truth and isolates player writes', async () => {
    const c = config('partitions');
    const h = writerHost();
    const writer = createFileSoulMemoryWriter(h, c)!;
    await writer.start();
    const p1 = scope('paopaotang', { kind: 'player-isolated', playerId: 'p1' }, 'tenant-canonical');
    const p2 = scope('paopaotang', { kind: 'player-isolated', playerId: 'p2' });
    const base = (s: ReturnType<typeof scope>, id: string) => ({
      commandId: id,
      sourceEventId: id,
      idempotencyKey: factKey(s, id, 'trait', id),
      trustTier: 'own' as const,
      subject: subject(s),
      facts: [{ kind: 'trait' as const, text: id }],
    });
    await writer.commit!(base(p1, 'one'), new AbortController().signal);
    await writer.commit!(base(p2, 'two'), new AbortController().signal);
    const reader = createFileSoulMemoryReader(host(), c);
    await reader.start();
    const p1Text = (await reader.recall(request(p1))).rawBlocks.map((block) => block.text).join('\n');
    const p2Text = (await reader.recall(request(p2))).rawBlocks.map((block) => block.text).join('\n');
    expect(p1Text).toContain('one');
    expect(existsSync(join(c.projectRoot, '.forgeax', 'souls', 'npc.alice', 'players', 'p1', 'memory', 'traits', 'one.md'))).toBe(true);
    expect(p2Text).not.toContain('traits/one.md');
    expect(p2Text).toContain('two');
  });

  test('uses memoryGame, not logical game, for the legacy current-world namespace', async () => {
    const c = config('memory-game-namespace');
    const currentScope = scope('forge-logical-game', { kind: 'soul-shared' }, 'legacy-world');
    const writer = createFileSoulMemoryWriter(writerHost(), c)!;
    await writer.start();
    const text = 'This episode belongs only to the legacy-world namespace.';
    await expect(writer.commit!({
      commandId: 'memory-game-command',
      sourceEventId: 'memory-game-event',
      idempotencyKey: factKey(currentScope, 'memory-game-event', 'episode', text),
      trustTier: 'own',
      subject: subject(currentScope),
      facts: [{ kind: 'episode', text }],
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'written' });

    const root = join(c.projectRoot, '.forgeax', 'souls', 'npc.alice', 'memory');
    expect(existsSync(join(root, 'episodes', 'legacy-world'))).toBe(true);
    expect(existsSync(join(root, 'episodes', 'forge-logical-game'))).toBe(false);
    const reader = createFileSoulMemoryReader(host(), c);
    await reader.start();
    const recall = await reader.recall(request(currentScope));
    expect(recall.rawBlocks.find((block) => block.name === 'current-world-memory')?.text).toContain(text);
    await reader.stop({ mode: 'drain' });
    await writer.stop({ mode: 'drain' });
  });

  test('commit is durable/idempotent and settle is an explicit command', async () => {
    const c = config('writes');
    const h = writerHost();
    const writer = createFileSoulMemoryWriter(h, c)!;
    await writer.start();
    const command = {
      commandId: 'command-1', sourceEventId: 'event-1',
      idempotencyKey: factKey(scope(), 'event-1', 'trait', 'Remember this.'),
      trustTier: 'own' as const, subject: subject(),
      facts: [{ kind: 'trait' as const, text: 'Remember this.' }],
    };
    expect((await writer.commit!(command, new AbortController().signal)).status).toBe('written');
    expect((await writer.commit!(command, new AbortController().signal)).status).toBe('duplicate');
    const settlementKey = fileMemorySettlementIdempotencyKey(scope(), 'episode-end-1');
    const settlement = await writer.settle!({ commandId: 'settle-1', subject: subject(), settlementId: 'episode-end-1', idempotencyKey: settlementKey, workingLogHash: sha256('working-log'), episodeText: 'Settled episode.', deadlineAtWallMs: 1_700_000_000_001, retryPolicy: 'durable-until-terminal' }, new AbortController().signal);
    expect(settlement.status).toBe('written');
    expect((await writer.settle!({ commandId: 'settle-1', subject: subject(), settlementId: 'episode-end-1', idempotencyKey: settlementKey, workingLogHash: sha256('working-log'), episodeText: 'Settled episode.', deadlineAtWallMs: 1_700_000_000_001, retryPolicy: 'durable-until-terminal' }, new AbortController().signal)).status).toBe('duplicate');
    expect((await writer.settle!({ commandId: 'settle-1', subject: subject(), settlementId: 'episode-end-1', idempotencyKey: settlementKey, workingLogHash: sha256('working-log'), episodeText: 'Changed settlement.', deadlineAtWallMs: 1_700_000_000_001, retryPolicy: 'durable-until-terminal' }, new AbortController().signal)).status).toBe('rejected');
    expect((await writer.commit!({ commandId: 'wrong-key', sourceEventId: 'event-1', idempotencyKey: 'caller-key', trustTier: 'own', subject: subject(), facts: [{ kind: 'trait', text: 'Remember this.' }] }, new AbortController().signal)).status).toBe('rejected');
    expect((await writer.commit!({ commandId: 'multi-fact', sourceEventId: 'event-multi', idempotencyKey: 'caller-key', trustTier: 'own', subject: subject(), facts: [{ kind: 'episode', text: 'one' }, { kind: 'episode', text: 'two' }] }, new AbortController().signal)).status).toBe('rejected');
    const importedText = 'Imported trait must not persist.';
    expect((await writer.commit!({ commandId: 'imported-trait', sourceEventId: 'imported-event', idempotencyKey: factKey(scope(), 'imported-event', 'trait', importedText), trustTier: 'imported', subject: subject(), facts: [{ kind: 'trait', text: importedText }] }, new AbortController().signal)).status).toBe('rejected');
    const root = join(c.projectRoot, '.forgeax', 'souls', 'npc.alice', 'memory');
    expect(readMemoryIndex(root)).toContain('remember-this.md');
    expect(readMemoryIndex(root)).not.toContain('imported-trait-must-not-persist.md');
    await writer.stop({ mode: 'drain' });
    await expect(writer.commit!(command, new AbortController().signal)).resolves.toMatchObject({ status: 'rejected' });
  });

  test('throws transient filesystem failures so the durable host can retry them', async () => {
    const c = config('transient-io-retry');
    // A file temporarily occupies the provider-state directory. This produces
    // a real path I/O failure without changing command validity.
    writeFileSync(c.stateDir, 'temporarily blocked');
    const writer = createFileSoulMemoryWriter(writerHost(), c)!;
    await writer.start();
    const currentScope = scope('transient-world');
    const text = 'Retry this accepted fact after storage recovers.';
    const command = {
      commandId: 'transient-command',
      sourceEventId: 'transient-event',
      idempotencyKey: factKey(currentScope, 'transient-event', 'episode', text),
      trustTier: 'own' as const,
      subject: subject(currentScope),
      facts: [{ kind: 'episode' as const, text }],
    };
    await expect(writer.commit!(command, new AbortController().signal)).rejects.toThrow();
    rmSync(c.stateDir, { force: true });
    expect((await writer.commit!(command, new AbortController().signal)).status).toBe('written');
    await writer.stop({ mode: 'abort' });
  });

  test('rejects unsupported scope, bounded budget, malformed hash and abort without writing', async () => {
    const c = config('negative');
    const h = host();
    const reader = createFileSoulMemoryReader(h, c);
    await reader.start();
    await expect(reader.preload([subject(scope('Bad Game'))], new AbortController().signal)).rejects.toBeInstanceOf(FileSoulMemoryProviderError);
    await expect(reader.recall(request(scope('Bad Game')))).rejects.toBeInstanceOf(FileSoulMemoryProviderError);
    await expect(reader.recall(request(scope(), { budget: { mode: 'bounded', maxChars: 10, maxBlocks: 1 } }))).rejects.toMatchObject({ code: 'unsupported_operation' });
    const writer = createFileSoulMemoryWriter(writerHost(), c)!;
    await writer.start();
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(writer.commit!({ commandId: 'aborted', sourceEventId: 'event-aborted', idempotencyKey: 'key', trustTier: 'own', subject: subject(), facts: [{ kind: 'trait', text: 'must not write' }] }, signal)).rejects.toThrow('cancelled');
    expect(existsSync(join(c.projectRoot, '.forgeax', 'souls', 'npc.alice', 'memory', 'traits'))).toBe(false);
  });

  test('reader drain waits for admitted refreshes and abort cancels admitted recall', async () => {
    const c = config('reader-stop');
    const draining = createFileSoulMemoryReader(host(), c);
    await draining.start();
    const refresh = draining.refresh(scope(), new AbortController().signal);
    const drainStop = draining.stop({ mode: 'drain' });
    await expect(refresh).resolves.toMatchObject({ status: 'loaded' });
    await drainStop;
    await expect(draining.recall(request())).rejects.toBeInstanceOf(FileSoulMemoryProviderError);

    const preloading = createFileSoulMemoryReader(host(), c);
    await preloading.start();
    const preload = preloading.preload([subject()], new AbortController().signal);
    const preloadDrain = preloading.stop({ mode: 'drain' });
    await expect(preload).resolves.toHaveLength(1);
    await preloadDrain;

    const aborting = createFileSoulMemoryReader(host(), c);
    await aborting.start();
    const recall = aborting.recall(request());
    const abortStop = aborting.stop({ mode: 'abort' });
    await expect(recall).rejects.toMatchObject({ name: 'AbortError' });
    await abortStop;
    await expect(aborting.refresh(scope(), new AbortController().signal)).rejects.toBeInstanceOf(FileSoulMemoryProviderError);
  });

  test('abort stop cancels queued writes and waits for the writer to quiesce', async () => {
    const c = config('abort-stop');
    const writer = createFileSoulMemoryWriter(writerHost(), c)!;
    await writer.start();
    const pending = writer.commit!({
      commandId: 'queued-before-stop',
      sourceEventId: 'queued-event',
      idempotencyKey: factKey(scope(), 'queued-event', 'trait', 'must not materialize after abort stop'),
      trustTier: 'own',
      subject: subject(),
      facts: [{ kind: 'trait', text: 'must not materialize after abort stop' }],
    }, new AbortController().signal);
    await writer.stop({ mode: 'abort' });
    await expect(pending).rejects.toThrow();
    expect(existsSync(join(c.projectRoot, '.forgeax', 'souls', 'npc.alice', 'memory', 'traits'))).toBe(false);
  });
});
