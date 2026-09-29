import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { complete } from '../src/lib/llm-gateway';
import type { NpcMemoryRuntimeBinding } from '../src/npc-brain/memory-host-seam';
import { createReferenceMemoryRuntimeHost } from '../src/npc-brain/memory/reference-memory-runtime-host';
import {
  REFERENCE_FIXTURE_CLOCK_DOMAIN,
  REFERENCE_FIXTURE_ID,
  REFERENCE_FIXTURE_OWNER,
  REFERENCE_FIXTURE_STORE,
} from '../src/npc-brain/memory/reference-snapshot-fixture';
import {
  startStandaloneNpcBrain,
  type StandaloneNpcBrainServer,
} from '../src/npc-brain/standalone';

interface FrameWaiter {
  readonly predicate: (frame: Record<string, unknown>) => boolean;
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestSocket {
  readonly ws: WebSocket;
  readonly closed: Promise<void>;
  next(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(frame: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function projectRoot(...soulIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-f5-standalone-'));
  for (const soulId of soulIds) {
    const pack = join(root, '.forgeax', 'souls-builtin', soulId);
    mkdirSync(join(pack, 'persona'), { recursive: true });
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ id: soulId }));
    writeFileSync(join(pack, 'persona', 'identity.md'), `Identity for ${soulId}.`);
  }
  return root;
}

function snapshot(npcId: string, eventId: string) {
  return {
    v: 1,
    eventId,
    game: 'reference-game',
    npcId,
    t: 1,
    trigger: 'player_message',
    text: 'What do you remember?',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [],
    events: [],
    affordances: [{ action: 'idle' }],
  };
}

function decisionTransport(observedPrompts: string[] = []): typeof complete {
  return async (request) => {
    observedPrompts.push(request.messages.map((message) => message.content).join('\n'));
    const decision = { utterance: { lines: ['I remember the west gate.'] } };
    const text = request.responseFormat?.name === 'npc_decisions'
      ? JSON.stringify({
          decisions: request.messages[1]!.content.trim().split('\n').map((line) => ({
            npcId: (JSON.parse(line) as { npcId: string }).npcId,
            decision,
          })),
        })
      : JSON.stringify(decision);
    return { text, model: request.model, transport: 'mock', latencyMs: 1 };
  };
}

async function connect(url: string): Promise<TestSocket> {
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  const waiters: FrameWaiter[] = [];
  const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true }));
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    const frame = JSON.parse(event.data) as Record<string, unknown>;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(frame);
    } else {
      frames.push(frame);
    }
  });
  await opened;
  return {
    ws,
    next: (predicate, timeoutMs = 2_000) => {
      const frameIndex = frames.findIndex(predicate);
      if (frameIndex >= 0) return Promise.resolve(frames.splice(frameIndex, 1)[0]!);
      return new Promise((resolve, reject) => {
        const waiter: FrameWaiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for WebSocket frame; buffered=${JSON.stringify(frames)}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'test complete');
      await within(closed, 2_000, 'WebSocket close');
    },
  };
}

async function openSession(service: StandaloneNpcBrainServer, body: unknown) {
  const response = await fetch(`${service.url}/api/npc/session`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer memory-f5-test-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    sessionId: string;
    token: string;
    epoch: number;
    wsUrl: string;
  }>;
}

function wsUrl(service: StandaloneNpcBrainServer, session: { sessionId: string; token: string; wsUrl: string }): string {
  const url = new URL(session.wsUrl, service.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('sessionId', session.sessionId);
  url.searchParams.set('token', session.token);
  return url.toString();
}

describe('Memory F5 standalone TCP acceptance', () => {
  test('drives the formal Reference cache through HTTP and a real WebSocket lifecycle', async () => {
    const root = projectRoot(REFERENCE_FIXTURE_OWNER.soulId);
    const prompts: string[] = [];
    const host = createReferenceMemoryRuntimeHost({
      mode: 'active',
      projectRoot: root,
      fixtures: REFERENCE_FIXTURE_STORE,
      allowedSubjects: [{
        fixtureId: REFERENCE_FIXTURE_ID,
        clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
        ...REFERENCE_FIXTURE_OWNER,
      }],
      subjectFor: ({ npcId, soulId }) => ({
        ownerNpcId: npcId,
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
    let service: StandaloneNpcBrainServer | undefined;
    const sockets: TestSocket[] = [];
    try {
      await host.start();
      service = startStandaloneNpcBrain({
        dataDir: root,
        authToken: 'memory-f5-test-secret',
        port: 0,
        complete: decisionTransport(prompts),
        memory: host.binding,
      });
      const session = await openSession(service, {
        game: 'reference-game',
        npcs: [{
          npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
          soulId: REFERENCE_FIXTURE_OWNER.soulId,
        }],
      });
      expect(host.fixtureReadCount).toBe(1);

      const chat = await fetch(`${service.url}/api/npc/chat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': 'application/json',
          'x-npc-session': session.sessionId,
        },
        body: JSON.stringify(snapshot(REFERENCE_FIXTURE_OWNER.ownerNpcId, 'http-reference')),
      });
      expect(await chat.json()).toMatchObject({
        ok: true,
        decision: { utterance: { lines: ['I remember the west gate.'] } },
      });
      expect(prompts.at(-1)).toContain('Alice keeps a careful ledger of promises.');
      expect(host.fixtureReadCount).toBe(1);

      const first = await connect(wsUrl(service, session));
      sockets.push(first);
      await expect(first.next((frame) => frame.type === 'session_ready')).resolves.toMatchObject({
        sessionId: session.sessionId,
      });
      first.send({ v: 1, eventId: 'heartbeat-1', epoch: session.epoch, seq: 1, type: 'heartbeat' });
      await expect(first.next((frame) => frame.type === 'heartbeat' && frame.eventId === 'heartbeat-1')).resolves.toBeDefined();

      first.send({
        v: 1, eventId: 'detach-1', epoch: session.epoch, seq: 2, type: 'detach',
        sessionId: session.sessionId, npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
      });
      await expect(first.next((frame) => frame.type === 'heartbeat' && frame.eventId === 'detach-1')).resolves.toBeDefined();
      first.send({
        v: 1, eventId: 'attach-1', epoch: session.epoch, seq: 3, type: 'attach',
        sessionId: session.sessionId,
        binding: {
          npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
          soulId: REFERENCE_FIXTURE_OWNER.soulId,
        },
      });
      await expect(first.next((frame) => frame.type === 'heartbeat' && frame.eventId === 'attach-1')).resolves.toBeDefined();

      const readsBeforeDecision = host.fixtureReadCount;
      first.send({
        v: 1, eventId: 'ws-reference', epoch: session.epoch, seq: 4, type: 'snapshots',
        snapshots: [snapshot(REFERENCE_FIXTURE_OWNER.ownerNpcId, 'ws-reference-snapshot')],
      });
      const decisions = await first.next((frame) => frame.type === 'decisions' && frame.eventId === 'ws-reference');
      expect(decisions).toMatchObject({
        decisions: [{ npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId }],
      });
      expect(host.fixtureReadCount).toBe(readsBeforeDecision);
      await first.close();
      sockets.splice(sockets.indexOf(first), 1);

      const resumed = await connect(wsUrl(service, session));
      sockets.push(resumed);
      await resumed.next((frame) => frame.type === 'session_ready');
      resumed.send({
        v: 1, eventId: 'resume-1', epoch: session.epoch, seq: 1, type: 'resume',
        sessionId: session.sessionId,
        resume: {
          ack: 0,
          fromSeq: 1,
          lastDecisionSeq: { [REFERENCE_FIXTURE_OWNER.ownerNpcId]: 0 },
        },
      });
      await expect(resumed.next((frame) => frame.type === 'decision' && frame.eventId === 'resume-1')).resolves.toMatchObject({
        decision: { npcId: REFERENCE_FIXTURE_OWNER.ownerNpcId },
      });
      resumed.send({ v: 1, eventId: 'heartbeat-after-resume', epoch: session.epoch, seq: 2, type: 'heartbeat' });
      await expect(resumed.next((frame) => frame.type === 'heartbeat' && frame.eventId === 'heartbeat-after-resume')).resolves.toBeDefined();

      resumed.send({
        v: 1, eventId: 'episode-end', epoch: session.epoch, seq: 3, type: 'episode_end',
        sessionId: session.sessionId, reason: 'acceptance complete',
      });
      await expect(resumed.next((frame) => frame.type === 'heartbeat' && frame.eventId === 'episode-end')).resolves.toBeDefined();
      await within(resumed.closed, 2_000, 'episode-end WebSocket close');
      sockets.splice(sockets.indexOf(resumed), 1);

      const stopped = service;
      const oldPort = stopped.server.port;
      const pending = `requests=${stopped.server.pendingRequests}, websockets=${stopped.server.pendingWebSockets}`;
      await within(stopped.stop(), 2_000, `standalone server stop (${pending})`);
      service = startStandaloneNpcBrain({
        dataDir: root,
        authToken: 'memory-f5-test-secret',
        port: oldPort,
        complete: decisionTransport(),
        memory: host.binding,
      });
      expect(service.server.port).toBe(oldPort);
      expect((await fetch(`${service.url}/healthz`)).status).toBe(200);
    } finally {
      for (const socket of sockets) await socket.close();
      if (service) {
        const pending = `requests=${service.server.pendingRequests}, websockets=${service.server.pendingWebSockets}`;
        await within(service.stop(), 2_000, `standalone server stop (${pending})`);
      }
      await within(host.stop({ mode: 'abort' }), 2_000, 'Reference memory host stop');
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test('keeps a real WebSocket alive across provider failure and one member recall timeout', async () => {
    const root = projectRoot('reference-game.short', 'reference-game.long');
    let recallMode: 'fail' | 'timeout' = 'fail';
    const audits: Array<Record<string, unknown>> = [];
    const memory: NpcMemoryRuntimeBinding = {
      mode: 'active',
      writePolicy: 'deny',
      reader: {
        recall: async (request) => {
          if (request.subject.ownerNpcId === 'short') {
            if (recallMode === 'fail') throw new Error('injected provider failure');
            return new Promise((_, reject) => request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason),
              { once: true },
            ));
          }
          return {
            source: { kind: 'live-file' },
            rawRecallVersion: 1,
            rawBlocks: [{ name: 'current-world-memory', text: 'cached long-member memory' }],
            diagnostics: {
              stale: false,
              volatileStateUsed: false,
              projectionMode: 'full',
              identityResolved: true,
            },
          };
        },
      },
      preload: async () => undefined,
      subjectFor: ({ game, npcId, soulId }) => ({
        ownerNpcId: npcId,
        soulId,
        scope: {
          authority: 'forgeax-file',
          game,
          memoryGame: game,
          soulId,
          storagePartition: { kind: 'soul-shared' },
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
      audit: (event) => audits.push(event as unknown as Record<string, unknown>),
    };
    let service: StandaloneNpcBrainServer | undefined;
    let socket: TestSocket | undefined;
    try {
      service = startStandaloneNpcBrain({
        dataDir: root,
        authToken: 'memory-f5-test-secret',
        port: 0,
        complete: decisionTransport(),
        memory,
      });
      const session = await openSession(service, {
        game: 'reference-game',
        npcs: [
          {
            npcId: 'short', soulId: 'reference-game.short',
            decisionDeadline: { preset: 'fast' },
          },
          {
            npcId: 'long', soulId: 'reference-game.long',
            decisionDeadline: { preset: 'patient' },
          },
        ],
      });
      socket = await connect(wsUrl(service, session));
      await socket.next((frame) => frame.type === 'session_ready');

      socket.send({
        v: 1, eventId: 'provider-failure', epoch: session.epoch, seq: 1, type: 'snapshots',
        snapshots: [snapshot('short', 'provider-failure-short'), snapshot('long', 'provider-failure-long')],
      });
      const afterFailure = await socket.next((frame) => frame.type === 'decisions' && frame.eventId === 'provider-failure');
      expect((afterFailure.decisions as Array<{ npcId: string }>).map((decision) => decision.npcId).sort())
        .toEqual(['long', 'short']);
      expect(audits).toContainEqual(expect.objectContaining({
        operation: 'recall', ownerNpcId: 'short', status: 'failed', reason: 'provider-error',
      }));

      recallMode = 'timeout';
      socket.send({
        v: 1, eventId: 'mixed-timeout', epoch: session.epoch, seq: 2, type: 'snapshots',
        snapshots: [snapshot('short', 'timeout-short'), snapshot('long', 'timeout-long')],
      });
      const afterTimeout = await socket.next(
        (frame) => frame.type === 'decisions' && frame.eventId === 'mixed-timeout',
        5_000,
      );
      expect((afterTimeout.decisions as Array<{ npcId: string }>).map((decision) => decision.npcId))
        .toEqual(['long']);
      expect(audits).toContainEqual(expect.objectContaining({
        operation: 'recall', ownerNpcId: 'short', status: 'expired', reason: 'deadline',
      }));

      socket.send({ v: 1, eventId: 'still-alive', epoch: session.epoch, seq: 3, type: 'heartbeat' });
      await expect(socket.next((frame) => frame.type === 'heartbeat' && frame.eventId === 'still-alive')).resolves.toBeDefined();
    } finally {
      if (socket) await socket.close();
      if (service) {
        const pending = `requests=${service.server.pendingRequests}, websockets=${service.server.pendingWebSockets}`;
        await within(service.stop(), 2_000, `standalone server stop (${pending})`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
