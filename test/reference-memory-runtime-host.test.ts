import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpcBrainService } from '../src/npc-brain/service';
import { NpcRuntime, createNpcWebSocketHandler } from '../src/npc-brain/runtime';
import { createNpcRouter } from '../src/api/npc';
import {
  REFERENCE_FIXTURE_CLOCK_DOMAIN,
  REFERENCE_FIXTURE_ID,
  REFERENCE_FIXTURE_OWNER,
  REFERENCE_FIXTURE_STORE,
} from '../src/npc-brain/memory/reference-snapshot-fixture';
import { createReferenceMemoryRuntimeHost } from '../src/npc-brain/memory/reference-memory-runtime-host';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'reference-memory-runtime-host-'));
  roots.push(value);
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function snapshot(eventId = 'reference-event') {
  return {
    v: 1,
    eventId,
    game: 'reference-game',
    npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
    t: 1,
    trigger: 'player_message',
    text: 'What do you remember?',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [],
    events: [],
    affordances: [{ action: 'idle' }],
  };
}

function makeHost(projectRoot: string, mode: 'shadow' | 'active', wrongOwner = false, autoRun?: boolean) {
  return createReferenceMemoryRuntimeHost({
    mode,
    ...(mode === 'active' ? { projectRoot } : {}),
    ...(autoRun === undefined ? {} : { autoRun }),
    fixtures: REFERENCE_FIXTURE_STORE,
    allowedSubjects: [{
      fixtureId: REFERENCE_FIXTURE_ID,
      clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
      ...REFERENCE_FIXTURE_OWNER,
    }],
    subjectFor: ({ npcId, soulId }) => ({
      ownerNpcId: wrongOwner ? 'not-the-fixture-owner' : npcId,
      soulId,
      scope: {
        authority: 'reference-fixture',
        fixtureId: REFERENCE_FIXTURE_ID,
        clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
      },
    }),
    recallRequestFor: ({ subject, snapshot: current }) => ({
      subject,
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      context: {
        mapId: current.game,
        sceneAreaId: null,
        visibleRefIds: [],
        focusEntityIds: [],
        conversationTurns: [],
      },
      budget: { mode: 'legacy-exact' },
    }),
  });
}

function runtime(projectRoot: string, memory: ReturnType<typeof makeHost>['binding'], complete: (request: any) => Promise<any>) {
  return new NpcRuntime({
    projectRoot,
    brain: new NpcBrainService({
      projectRoot,
      memory,
      loadAgentRecord: async (agentId) => ({
        agentId,
        source: 'builtin' as const,
        trustTier: 'own' as const,
        persona: 'Reference persona',
        skills: [],
        tools: [],
        memory: { root: join(projectRoot, 'unused') },
        warnings: [],
      }),
      complete,
    }),
  });
}

async function open(runtimeValue: NpcRuntime) {
  const grant = runtimeValue.createSession({
    game: 'reference-game',
    npcs: [{ npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId, soulId: REFERENCE_FIXTURE_OWNER.soulId }],
  });
  const session = runtimeValue.authorize(grant.sessionId, grant.token)!;
  await runtimeValue.preloadSession(session);
  return session;
}

describe('Reference memory runtime host', () => {
  test('activates the formal registry reader, preloads immutable fixtures, and never reads the source during a decision', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'active', false, false);
    await host.start();
    let prompt = '';
    const value = runtime(projectRoot, host.binding, async (request) => {
      prompt = request.messages.map((message: { content: string }) => message.content).join('\n');
      return { text: JSON.stringify({ utterance: { lines: ['I remember the gate.'] } }), model: request.model, transport: 'mock', latencyMs: 1 };
    });
    const session = await open(value);
    expect(host.fixtureReadCount).toBe(1);
    expect((await value.decide(session, snapshot()))?.utterance?.lines).toEqual(['I remember the gate.']);
    expect(prompt).toContain('Alice keeps a careful ledger of promises.');
    expect(host.fixtureReadCount).toBe(1);
    await host.stop();
    expect(host.state).toBe('stopped');
  });

  test('persists an active zero-command decision receipt and reuses it after restart without another model call', async () => {
    const projectRoot = root();
    const first = makeHost(projectRoot, 'active');
    await first.start();
    let calls = 0;
    const firstRuntime = runtime(projectRoot, first.binding, async (request) => {
      calls += 1;
      return { text: JSON.stringify({ utterance: { lines: ['cached answer'] } }), model: request.model, transport: 'mock', latencyMs: 1 };
    });
    const firstSession = await open(firstRuntime);
    const firstDecision = await firstRuntime.decide(firstSession, snapshot());
    await first.stop({ mode: 'abort' });

    const second = makeHost(projectRoot, 'active');
    await second.start();
    const secondRuntime = runtime(projectRoot, second.binding, async () => {
      throw new Error('model must not run during durable receipt replay');
    });
    const secondSession = await open(secondRuntime);
    expect(await secondRuntime.decide(secondSession, snapshot())).toEqual(firstDecision);
    expect(calls).toBe(1);
    await Promise.all([second.stop(), second.stop()]);
    await expect(second.start()).rejects.toThrow('cannot start from stopped');
  });

  test('ends an active read-only session without summarizing or creating a settlement command', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'active');
    await host.start();
    let decisionCalls = 0;
    let settlementCalls = 0;
    const value = runtime(projectRoot, host.binding, async (request) => {
      if (request.messages[0]?.content.startsWith('Extract one concise')) {
        settlementCalls += 1;
        return { text: 'must not be used', model: request.model, transport: 'mock', latencyMs: 1 };
      }
      decisionCalls += 1;
      return { text: JSON.stringify({ utterance: { lines: ['read-only memory'] } }), model: request.model, transport: 'mock', latencyMs: 1 };
    });
    const grant = value.createSession({
      game: 'reference-game',
      npcs: [{ npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId, soulId: REFERENCE_FIXTURE_OWNER.soulId }],
    });
    const session = value.authorize(grant.sessionId, grant.token)!;
    await value.preloadSession(session);
    await value.decide(session, snapshot('read-only-settlement'));
    await expect(value.end(session)).resolves.toBe(0);
    expect(settlementCalls).toBe(0);
    expect(decisionCalls).toBe(1);
    expect(value.authorize(grant.sessionId, grant.token)).toBeUndefined();
    await host.stop({ mode: 'abort' });
  });

  test('drives the same preloaded reference binding through HTTP and WebSocket batch paths', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'active', false, false);
    await host.start();
    let modelCalls = 0;
    const value = runtime(projectRoot, host.binding, async (request) => {
      modelCalls += 1;
      const decision = { utterance: { lines: ['shared reference path'] } };
      const text = request.responseFormat?.name === 'npc_decisions'
        ? JSON.stringify({
            decisions: request.messages[1].content.trim().split('\n').map((line: string) => ({
              npcId: JSON.parse(line).npcId,
              decision,
            })),
          })
        : JSON.stringify(decision);
      return { text, model: request.model, transport: 'mock', latencyMs: 1 };
    });
    const app = createNpcRouter({ projectRoot, runtime: value });
    const opened = await app.request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'reference-game',
        npcs: [{ npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId, soulId: REFERENCE_FIXTURE_OWNER.soulId }],
      }),
    });
    expect(opened.status).toBe(200);
    const session = await opened.json() as any;
    expect(host.fixtureReadCount).toBe(1);
    const chat = await app.request('/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        'x-npc-session': session.sessionId,
      },
      body: JSON.stringify(snapshot('http-reference-event')),
    });
    expect(await chat.json()).toMatchObject({
      ok: true,
      decision: { utterance: { lines: ['shared reference path'] } },
    });

    const sent: any[] = [];
    const ws = {
      data: { id: 'reference-ws', npc: { sessionId: session.sessionId, token: session.token } },
      send: (value: string) => { sent.push(JSON.parse(value)); },
      close: () => undefined,
    } as any;
    const handler = createNpcWebSocketHandler(value);
    handler.open?.(ws);
    await handler.message?.(ws, JSON.stringify({
      v: 1,
      eventId: 'reference-ws-frame',
      epoch: session.epoch,
      seq: 1,
      type: 'snapshots',
      snapshots: [snapshot('ws-reference-event')],
    }));
    expect(sent.find((frame) => frame.type === 'decisions')).toMatchObject({
      decisions: [{ utterance: { lines: ['shared reference path'] } }],
    });
    handler.close?.(ws, 1000, 'done');
    expect(host.fixtureReadCount).toBe(1);
    expect(modelCalls).toBe(2);
    await host.stop();
  });

  test('fails soft for a wrong fixture owner in shadow mode without reading an unapproved subject', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'shadow', true);
    await host.start();
    let prompt = '';
    const value = runtime(projectRoot, host.binding, async (request) => {
      prompt = request.messages.map((message: { content: string }) => message.content).join('\n');
      return { text: JSON.stringify({ utterance: { lines: ['no fixture leak'] } }), model: request.model, transport: 'mock', latencyMs: 1 };
    });
    const session = await open(value);
    expect((await value.decide(session, snapshot('wrong-owner-event')))?.utterance?.lines).toEqual(['no fixture leak']);
    expect(prompt).not.toContain('Alice keeps a careful ledger of promises.');
    expect(host.fixtureReadCount).toBe(0);
    await host.stop({ mode: 'abort' });
  });

  test('retains failed lifecycle ownership so abort cleanup can be retried', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'active');
    await host.start();
    const registry = host.registry;
    const originalStop = registry.stop.bind(registry);
    let stopAttempts = 0;
    registry.stop = async (...args: Parameters<typeof originalStop>) => {
      stopAttempts += 1;
      if (stopAttempts === 1) {
        return {
          ok: false as const,
          error: {
            code: 'lifecycle_failed' as const,
            message: 'injected transient registry stop failure',
            providerId: 'reference-snapshot-reader',
          },
        };
      }
      return originalStop(...args);
    };
    await expect(host.stop({ mode: 'abort' })).rejects.toThrow('reference memory runtime stop failed');
    expect(host.state).toBe('failed');
    await expect(host.stop({ mode: 'abort' })).resolves.toBeUndefined();
    expect(stopAttempts).toBe(2);
    expect(host.state).toBe('stopped');
  });

  test('claims and cleans a registry record left failed by activation cleanup', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'shadow');
    const registry = host.registry;
    registry.activate = async (candidate) => {
      const registered = await registry.register(candidate);
      if (!registered.ok) return registered;
      const instance = registry.get(registered.value.providerId)!;
      const reader = instance.reader as typeof instance.reader & {
        start: () => Promise<void>;
        stop: typeof instance.reader.stop;
      };
      const originalStop = reader.stop.bind(reader);
      let stopAttempts = 0;
      reader.start = async () => { throw new Error('injected reader start failure'); };
      reader.stop = async (options) => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error('injected reader cleanup failure');
        await originalStop(options);
      };
      const started = await registry.start(registered.value.providerId);
      expect(stopAttempts).toBe(1);
      return started;
    };
    await expect(host.start()).rejects.toThrow('reference memory provider activation failed');
    expect(host.registry.status('reference-snapshot-reader')?.state).toBe('stopped');
    expect(host.state).toBe('failed');
    await host.stop({ mode: 'abort' });
    expect(host.state).toBe('stopped');
  });

  test('rejects invalid activation config before a reader can run', () => {
    const projectRoot = root();
    expect(() => createReferenceMemoryRuntimeHost({
      mode: 'shadow',
      fixtures: REFERENCE_FIXTURE_STORE,
      allowedSubjects: [],
      subjectFor: () => { throw new Error('not used'); },
      recallRequestFor: () => { throw new Error('not used'); },
    })).toThrow();
    void projectRoot;
  });

  test('rejects relative receipt state and any receipt state under File memory roots', () => {
    const projectRoot = root();
    const base = {
      mode: 'active' as const,
      projectRoot,
      fixtures: REFERENCE_FIXTURE_STORE,
      allowedSubjects: [{ fixtureId: REFERENCE_FIXTURE_ID, clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN, ...REFERENCE_FIXTURE_OWNER }],
      subjectFor: ({ npcId, soulId }: { npcId: string; soulId: string }) => ({
        ownerNpcId: npcId,
        soulId,
        scope: { authority: 'reference-fixture' as const, fixtureId: REFERENCE_FIXTURE_ID, clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN },
      }),
      recallRequestFor: () => { throw new Error('not used'); },
    };
    expect(() => createReferenceMemoryRuntimeHost({ ...base, receiptStateDir: 'relative-receipts' })).toThrow('absolute');
    expect(() => createReferenceMemoryRuntimeHost({ ...base, receiptStateDir: projectRoot })).toThrow('must not overlap');
    expect(() => createReferenceMemoryRuntimeHost({ ...base, receiptStateDir: join(projectRoot, '.forgeax', 'souls', 'not-allowed') })).toThrow('must not overlap');
  });

  test('keeps any forged durable command terminal and never gives the reader a writer facet', async () => {
    const projectRoot = root();
    const host = makeHost(projectRoot, 'active', false, false);
    await host.start();
    const payload = { forged: true };
    await host.binding.enqueueHandoff!({
      handoffId: 'reference-forged-command-handoff',
      eventId: 'reference-forged-command-event',
      decisionHash: hash({ receipt: true }),
      decision: { receipt: true },
      commands: [{
        commandId: 'reference-forged-command',
        scopeKey: hash({ scope: 'forged' }),
        idempotencyKey: 'c'.repeat(32),
        commandHash: hash(payload),
        payload,
      }],
    });
    await host.stop({ mode: 'drain' });
    const journal = readFileSync(join(projectRoot, '.forgeax', 'npc-brain', 'reference-receipts', 'memory-commands.v1.jsonl'), 'utf8');
    expect(journal).toContain('"type":"dead-letter"');
    expect(host.registry.get('reference-snapshot-reader')?.writer).toBeUndefined();
  });
});
