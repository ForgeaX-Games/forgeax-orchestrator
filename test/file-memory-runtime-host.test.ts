import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type NpcMemorySubjectV1 } from '@forgeax/types/npc-memory';
import { NpcBrainService } from '../src/npc-brain/service';
import { NpcRuntime } from '../src/npc-brain/runtime';
import {
  createFileMemoryRuntimeHost,
  type FileMemoryProviderAuditEvent,
} from '../src/npc-brain/memory/file-memory-runtime-host';
import {
  fileMemoryFactIdempotencyKey,
  fileMemorySettlementIdempotencyKey,
} from '../src/npc-brain/memory/file-memory-idempotency';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'file-memory-runtime-host-'));
  roots.push(value);
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function subjectFor({ game, npcId, soulId }: { game: string; npcId: string; soulId: string }): NpcMemorySubjectV1 {
  return {
    ownerNpcId: npcId,
    soulId,
    scope: {
      authority: 'forgeax-file',
      game,
      memoryGame: game,
      soulId,
      storagePartition: { kind: 'soul-shared' },
    },
  };
}

function makeHost(
  projectRoot: string,
  autoRun = false,
  now?: () => number,
  providerAudit?: (event: FileMemoryProviderAuditEvent) => void,
) {
  return createFileMemoryRuntimeHost({
    projectRoot,
    autoRun,
    mode: 'active',
    writePolicy: 'configured-writer',
    ...(now ? { now, monotonicNow: now } : {}),
    ...(providerAudit ? { providerAudit } : {}),
    subjectFor: ({ game, npcId, soulId }) => subjectFor({ game, npcId, soulId }),
    recallRequestFor: ({ subject, snapshot }) => ({
      subject,
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: {
        mapId: snapshot.game,
        sceneAreaId: null,
        visibleRefIds: snapshot.nearby.map((item) => item.id),
        focusEntityIds: [],
        conversationTurns: [],
      },
      budget: { mode: 'legacy-exact' },
    }),
  });
}

function makeShadowHost(projectRoot: string) {
  return createFileMemoryRuntimeHost({
    projectRoot,
    mode: 'shadow',
    // Even a mistakenly requested writer is downgraded by shadow mode.
    writePolicy: 'configured-writer',
    autoRun: false,
    subjectFor: ({ game, npcId, soulId }) => subjectFor({ game, npcId, soulId }),
    recallRequestFor: ({ subject, snapshot: current }) => ({
      subject,
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: current.game, sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    }),
  });
}

function snapshot(eventId = 'evt-1') {
  return {
    v: 1,
    eventId,
    game: 'demo',
    npcId: 'guide',
    t: 1,
    trigger: 'player_message',
    text: 'remember this',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [],
    events: [],
    affordances: [{ action: 'idle' }],
  };
}

function modelResponse(memoryOps: unknown[] = []) {
  return async (request: { model: string }) => ({
    text: JSON.stringify({ utterance: { lines: ['ok'] }, memoryOps }),
    model: request.model,
    transport: 'mock' as const,
    latencyMs: 1,
  });
}

describe('File memory runtime host', () => {
  test('shadow mode rejects new provider commands before durable acceptance', async () => {
    const projectRoot = root();
    const host = makeShadowHost(projectRoot);
    await host.start();
    expect(host.binding.writePolicy).toBe('deny');
    const subject = subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' });
    if (subject.scope.authority !== 'forgeax-file') throw new Error('expected File scope');
    const payload = {
      commandId: 'shadow-command', subject, sourceEventId: 'shadow-event',
      idempotencyKey: fileMemoryFactIdempotencyKey(subject.scope, 'shadow-event', 'episode', 'must not write'),
      trustTier: 'own' as const,
      facts: [{ kind: 'episode' as const, text: 'must not write' }],
    };
    await expect(host.binding.enqueueHandoff!({
      handoffId: 'shadow-handoff', eventId: 'shadow-event', decisionHash: hash({ shadow: true }),
      decision: { shadow: true }, commands: [{
        commandId: payload.commandId, scopeKey: hash(subject.scope), idempotencyKey: payload.idempotencyKey,
        commandHash: hash(payload), payload,
      }],
    })).rejects.toThrow(/write policy denies command handoffs/);
    expect(host.outbox.pendingCount).toBe(0);
    expect(host.outbox.succeededCount).toBe(0);
    expect(host.outbox.deadLetterCount).toBe(0);
    await host.stop();
  });

  test('read-only rollback preserves accepted commands until write authority is restored', async () => {
    const projectRoot = root();
    let now = 1_700_000_000_000;
    const clock = () => now;
    const writable = makeHost(projectRoot, false, clock);
    await writable.start();
    const subject = subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' });
    if (subject.scope.authority !== 'forgeax-file') throw new Error('expected File scope');
    const payload = {
      commandId: 'rollback-command', subject, sourceEventId: 'rollback-event',
      idempotencyKey: fileMemoryFactIdempotencyKey(subject.scope, 'rollback-event', 'episode', 'survive rollback'),
      trustTier: 'own' as const,
      facts: [{ kind: 'episode' as const, text: 'survive rollback' }],
    };
    await writable.binding.enqueueHandoff!({
      handoffId: 'rollback-handoff', eventId: payload.sourceEventId,
      decisionHash: hash({ rollback: true }), decision: { rollback: true },
      commands: [{
        commandId: payload.commandId, scopeKey: hash(subject.scope),
        idempotencyKey: payload.idempotencyKey, commandHash: hash(payload), payload,
      }],
    });
    await writable.stop({ mode: 'abort' });

    const readOnly = createFileMemoryRuntimeHost({
      projectRoot,
      mode: 'active',
      writePolicy: 'deny',
      autoRun: true,
      now: clock,
      monotonicNow: clock,
      subjectFor: ({ game, npcId, soulId }) => subjectFor({ game, npcId, soulId }),
      recallRequestFor: ({ subject: currentSubject, snapshot: current }) => ({
        subject: currentSubject, trigger: 'active_decision', at: { day: 1, hour: 9, minute: 0 },
        context: { mapId: current.game, sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
        budget: { mode: 'legacy-exact' },
      }),
    });
    let writerStarts = 0;
    const readOnlyWriter = readOnly.writer as { start: () => Promise<void> };
    const originalWriterStart = readOnlyWriter.start.bind(readOnlyWriter);
    readOnlyWriter.start = async () => {
      writerStarts += 1;
      await originalWriterStart();
    };
    await readOnly.start();
    expect(writerStarts).toBe(0);
    expect(readOnly.outbox.pendingCount).toBe(1);
    await readOnly.outbox.runReady();
    expect(readOnly.outbox.pendingCount).toBe(1);
    expect(readOnly.outbox.deadLetterCount).toBe(0);
    await readOnly.stop();

    now += 1_000;
    const restored = makeHost(projectRoot, false, clock);
    await restored.start();
    expect(restored.outbox.pendingCount).toBe(1);
    await restored.outbox.runReady();
    expect(restored.outbox.pendingCount).toBe(0);
    expect(restored.outbox.succeededCount).toBe(1);
    const recall = await restored.reader.recall({
      subject,
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: 'demo', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    });
    expect(recall.rawBlocks.map((block) => block.text).join('\n')).toContain('survive rollback');
    await restored.stop();
  });

  test('requires product adapters and keeps durable state outside File memory roots', () => {
    const projectRoot = root();
    const adapters = {
      subjectFor: ({ game, npcId, soulId }: { game: string; npcId: string; soulId: string }) =>
        subjectFor({ game, npcId, soulId }),
      recallRequestFor: ({ subject, snapshot }: Parameters<ReturnType<typeof makeHost>['binding']['recallRequestFor']>[0]) => ({
        subject,
        trigger: 'active_decision' as const,
        at: { day: 1, hour: 9, minute: 0 },
        context: { mapId: snapshot.game, sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
        budget: { mode: 'legacy-exact' as const },
      }),
    };
    expect(() => createFileMemoryRuntimeHost({
      projectRoot,
      ...adapters,
      providerStateDir: join(projectRoot, '.forgeax', 'souls', 'state'),
    })).toThrow(/must not overlap File memory roots/);
    const sameStateDir = join(projectRoot, '.forgeax', 'npc-brain', 'same-state');
    expect(() => createFileMemoryRuntimeHost({
      projectRoot,
      ...adapters,
      providerStateDir: sameStateDir,
      outboxStateDir: sameStateDir,
    })).toThrow(/must not overlap/);
  });

  test('shares one active binding with NpcRuntime and materializes decision memoryOps through the durable outbox', async () => {
    const projectRoot = root();
    const providerAudit: FileMemoryProviderAuditEvent[] = [];
    const host = makeHost(projectRoot, false, undefined, (event) => providerAudit.push(event));
    await host.start();
    const runtime = new NpcRuntime({
      projectRoot,
      brain: new NpcBrainService({
        projectRoot,
        memory: host.binding,
        complete: modelResponse([{ kind: 'episode', text: 'The player found the blue key.', sourceEventId: 'evt-1' }]),
      }),
    });
    const grant = runtime.createSession({ game: 'demo', npcIds: ['guide'] });
    const session = runtime.authorize(grant.sessionId, grant.token)!;
    await runtime.preloadSession(session);
    expect((await runtime.decide(session, snapshot()))?.utterance?.lines).toEqual(['ok']);
    expect(host.outbox.pendingCount).toBe(1);
    await host.outbox.runReady();
    expect(host.outbox.succeededCount).toBe(1);
    expect(providerAudit).toContainEqual(expect.objectContaining({
      providerId: 'file-soul-memory',
      operation: 'commit',
      commandId: expect.any(String),
    }));
    const recall = await host.reader.recall({
      subject: subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' }),
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: 'demo', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    });
    expect(recall.rawBlocks.map((block) => block.text).join('\n')).toContain('The player found the blue key.');
    await host.stop();
  });

  test('retries a transient File I/O failure after host restart instead of dead-lettering it', async () => {
    const projectRoot = root();
    const providerStateDir = join(projectRoot, '.forgeax', 'npc-brain', 'memory-state');
    mkdirSync(join(projectRoot, '.forgeax', 'npc-brain'), { recursive: true });
    writeFileSync(providerStateDir, 'temporarily blocked');
    let now = 1_700_000_000_000;
    const clock = () => now;
    const first = makeHost(projectRoot, false, clock);
    await first.start();
    const runtime = new NpcRuntime({
      projectRoot,
      brain: new NpcBrainService({
        projectRoot,
        memory: first.binding,
        complete: modelResponse([{ kind: 'episode', text: 'Persist after storage recovery.', sourceEventId: 'evt-io' }]),
      }),
    });
    const grant = runtime.createSession({ game: 'demo', npcIds: ['guide'] });
    const session = runtime.authorize(grant.sessionId, grant.token)!;
    await runtime.preloadSession(session);
    await runtime.decide(session, snapshot('evt-io'));
    await first.outbox.runReady();
    expect(first.outbox.pendingCount).toBe(1);
    expect(first.outbox.deadLetterCount).toBe(0);
    await first.stop({ mode: 'abort' });

    rmSync(providerStateDir, { force: true });
    now += 1_000;
    const second = makeHost(projectRoot, false, clock);
    await second.start();
    await second.outbox.runReady();
    expect(second.outbox.pendingCount).toBe(0);
    expect(second.outbox.succeededCount).toBe(1);
    const recall = await second.reader.recall({
      subject: subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' }),
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: 'demo', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    });
    expect(recall.rawBlocks.map((block) => block.text).join('\n')).toContain('Persist after storage recovery.');
    await second.stop({ mode: 'abort' });
  });

  test('replays a zero-command decision receipt after restart without manufacturing a File write', async () => {
    const projectRoot = root();
    const first = makeHost(projectRoot);
    await first.start();
    const receipt = {
      version: 1,
      inputFingerprint: 'input-fingerprint',
      internalDecision: { utterance: { lines: ['ok'] } },
      wireDecision: { v: 1, npcId: 'guide', seq: 1, utterance: { lines: ['ok'] } },
    };
    const receiptHandoffId = `handoff-${randomUUID()}`;
    await first.binding.enqueueHandoff!({
      handoffId: receiptHandoffId,
      eventId: 'evt-receipt',
      decisionHash: hash(receipt),
      decision: receipt,
      commands: [],
    });
    await first.stop({ mode: 'abort' });

    const second = makeHost(projectRoot);
    await second.start();
    // The journal is the source of truth; no command was queued or dispatched.
    expect(second.binding.readHandoff!(receiptHandoffId)).toMatchObject({ eventId: 'evt-receipt', decision: receipt, commands: [] });
    expect(second.outbox.pendingCount).toBe(0);
    expect(second.outbox.succeededCount).toBe(0);
    await second.stop({ mode: 'abort' });
  });

  test('replays a settlement command after restart and routes it only to writer.settle', async () => {
    const projectRoot = root();
    let now = 1_700_000_000_000;
    const clock = () => now;
    const first = makeHost(projectRoot, false, clock);
    await first.start();
    const subject = subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' });
    if (subject.scope.authority !== 'forgeax-file') throw new Error('expected File subject');
    const payload = {
      commandId: 'settle-command',
      subject,
      settlementId: 'settlement-1',
      idempotencyKey: fileMemorySettlementIdempotencyKey(subject.scope, 'settlement-1'),
      workingLogHash: 'a'.repeat(64),
      episodeText: 'The guide and player opened the gate together.',
      deadlineAtWallMs: now + 10_000,
      retryPolicy: 'durable-until-terminal' as const,
    };
    await first.binding.enqueueHandoff!({
      handoffId: 'settlement-handoff',
      eventId: 'settlement-1',
      decisionHash: hash({ settlement: true }),
      decision: { settlement: true },
      commands: [{
        commandId: payload.commandId,
        scopeKey: hash(subject.scope),
        idempotencyKey: payload.idempotencyKey,
        commandHash: hash(payload),
        payload,
      }],
    });
    await first.stop({ mode: 'abort' });

    // The command was durably accepted before the deadline, then the process
    // stayed down past it. Dispatch must still replay under its retry policy.
    now += 60_000;
    expect(now).toBeGreaterThan(payload.deadlineAtWallMs);
    const second = makeHost(projectRoot, false, clock);
    await second.start();
    expect(second.outbox.pendingCount).toBe(1);
    await second.outbox.runReady();
    expect(second.outbox.deadLetterCount).toBe(0);
    expect(second.outbox.succeededCount).toBe(1);
    const recall = await second.reader.recall({
      subject,
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: 'demo', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    });
    expect(recall.rawBlocks.map((block) => block.text).join('\n')).toContain('opened the gate together');
    await second.stop();
  });

  test('rolls back reader/writer on outbox start failure and makes repeated stop controlled', async () => {
    const projectRoot = root();
    const outboxStateDir = join(projectRoot, '.forgeax', 'npc-brain', 'bad-outbox');
    // A malformed published owner lock makes the strict outbox fail before replay.
    mkdirSync(outboxStateDir, { recursive: true });
    writeFileSync(join(projectRoot, '.forgeax', 'npc-brain', 'bad-outbox', 'memory-commands.v1.owner.lock'), 'not-json\n', { flag: 'w' });
    const broken = createFileMemoryRuntimeHost({
      projectRoot,
      outboxStateDir,
      subjectFor: ({ game, npcId, soulId }) => subjectFor({ game, npcId, soulId }),
      recallRequestFor: ({ subject, snapshot }) => ({
        subject, trigger: 'active_decision', at: { day: 1, hour: 9, minute: 0 },
        context: { mapId: snapshot.game, sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
        budget: { mode: 'legacy-exact' },
      }),
    });
    const brokenReader = broken.reader as { stop: (options: { mode: 'drain' | 'abort'; signal?: AbortSignal }) => Promise<void> };
    const originalReaderStop = brokenReader.stop.bind(brokenReader);
    let readerAbortAttempts = 0;
    brokenReader.stop = async (options) => {
      readerAbortAttempts += 1;
      if (readerAbortAttempts === 1) throw new Error('injected startup cleanup failure');
      await originalReaderStop(options);
    };
    await expect(broken.start()).rejects.toThrow('File memory runtime start and cleanup failed');
    expect(broken.state).toBe('failed');
    await broken.stop({ mode: 'abort' });
    expect(readerAbortAttempts).toBe(2);
    expect(broken.state).toBe('stopped');

    const healthy = makeHost(root());
    await healthy.start();
    await Promise.all([healthy.stop(), healthy.stop()]);
    expect(healthy.state).toBe('stopped');
    await healthy.stop();
  });

  test('keeps writer and reader running when a caller cancels a drain, then permits abort stop', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot);
    await host.start();
    const subject = subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' });
    if (subject.scope.authority !== 'forgeax-file') throw new Error('expected File subject');
    const payload = {
      commandId: 'cancelled-drain-command',
      subject,
      sourceEventId: 'cancelled-drain-event',
      idempotencyKey: fileMemoryFactIdempotencyKey(subject.scope, 'cancelled-drain-event', 'episode', 'queued fact'),
      trustTier: 'own' as const,
      facts: [{ kind: 'episode' as const, text: 'queued fact' }],
    };
    await host.binding.enqueueHandoff!({
      handoffId: 'cancelled-drain-handoff',
      eventId: payload.sourceEventId,
      decisionHash: hash({ queued: true }),
      decision: { queued: true },
      commands: [{
        commandId: payload.commandId,
        scopeKey: hash(subject.scope),
        idempotencyKey: payload.idempotencyKey,
        commandHash: hash(payload),
        payload,
      }],
    });
    await expect(host.stop({ mode: 'drain', signal: AbortSignal.abort(new Error('operator cancelled')) })).rejects.toThrow('operator cancelled');
    expect(host.state).toBe('running');
    expect(host.outbox.pendingCount).toBe(1);
    await host.stop({ mode: 'abort' });
    expect(host.state).toBe('stopped');
  });

  test('abort stop remains unconditional when the caller signal is already cancelled', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot);
    await host.start();
    await host.stop({ mode: 'abort', signal: AbortSignal.abort(new Error('supervisor already cancelled')) });
    expect(host.state).toBe('stopped');
    await expect(host.reader.recall({
      subject: subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' }),
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: 'demo', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    })).rejects.toThrow(/stopped/);
  });

  test('a child drain-stop failure abort-cleans remaining File facets before failing the host', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot);
    await host.start();
    const writer = host.writer as { stop: (options: { mode: 'drain' | 'abort'; signal?: AbortSignal }) => Promise<void> };
    const originalStop = writer.stop.bind(writer);
    let abortStops = 0;
    writer.stop = async (options) => {
      if (options.mode === 'drain') throw new Error('injected writer drain failure');
      abortStops += 1;
      await originalStop(options);
    };
    await expect(host.stop({ mode: 'drain' })).rejects.toThrow('injected writer drain failure');
    expect(host.state).toBe('failed');
    expect(abortStops).toBe(1);
    await expect(host.reader.recall({
      subject: subjectFor({ game: 'demo', npcId: 'guide', soulId: 'demo.guide' }),
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: { mapId: 'demo', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] },
      budget: { mode: 'legacy-exact' },
    })).rejects.toThrow(/stopped/);
  });

  test('a failed abort cleanup retains ownership for a later abort retry', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot);
    await host.start();
    const writer = host.writer as { stop: (options: { mode: 'drain' | 'abort'; signal?: AbortSignal }) => Promise<void> };
    const originalStop = writer.stop.bind(writer);
    let abortAttempts = 0;
    writer.stop = async (options) => {
      if (options.mode === 'drain') throw new Error('injected writer drain failure');
      abortAttempts += 1;
      if (abortAttempts === 1) throw new Error('injected writer abort cleanup failure');
      await originalStop(options);
    };
    await expect(host.stop({ mode: 'drain' })).rejects.toThrow('File memory runtime drain and cleanup failed');
    expect(host.state).toBe('failed');
    await expect(host.stop({ mode: 'abort', signal: AbortSignal.abort(new Error('ignored during cleanup')) })).resolves.toBeUndefined();
    expect(abortAttempts).toBe(2);
    expect(host.state).toBe('stopped');
  });
});
