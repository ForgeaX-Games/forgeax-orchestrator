import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNpcRouter } from '../src/api/npc';
import { NpcBrainService } from '../src/npc-brain/service';
import { NpcRuntime, createNpcWebSocketHandler, type NpcWsClientData } from '../src/npc-brain/runtime';
import type { complete } from '../src/lib/llm-gateway';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(tmpdir(), 'npc-api-'));
  roots.push(value);
  return value;
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    v: 1, eventId: 'evt-1', game: 'demo', npcId: 'guide', t: 1,
    trigger: 'player_message', text: 'Take me to the square.',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [{ kind: 'waypoint', id: 'square', pos: { x: 10, y: 5 }, facts: ['public square'] }],
    events: [],
    affordances: [
      { action: 'walk_to', params: { target: { type: 'enum', source: 'waypoint' } } },
      { action: 'idle' },
    ],
    ...overrides,
  };
}

const goodDecision: typeof complete = async (req) => {
  const decision = {
    intent: { action: 'walk_to', params: { target: 'square' }, ttlSec: 20 },
    utterance: { lines: ['Follow me.'] },
  };
  const text = req.responseFormat?.name === 'npc_decisions'
    ? JSON.stringify({
      decisions: req.messages[1]!.content.trim().split('\n').map((line) => ({
        npcId: JSON.parse(line).npcId,
        decision,
      })),
    })
    : JSON.stringify(decision);
  return { text, model: req.model, transport: 'mock', latencyMs: 1 };
};

function makeRouter(projectRoot: string, complete: typeof import('../src/lib/llm-gateway').complete) {
  const runtime = new NpcRuntime({
    projectRoot,
    brain: new NpcBrainService({ projectRoot, complete }),
  });
  return { runtime, app: createNpcRouter({ projectRoot, runtime }) };
}

async function openSession(app: ReturnType<typeof makeRouter>['app'], body: unknown) {
  const res = await app.request('/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('createNpcRouter (M0 HTTP path)', () => {
  test('rejects a session when an explicitly declared Soul pack is missing', async () => {
    const projectRoot = root();
    const runtime = new NpcRuntime({ projectRoot });
    const app = createNpcRouter({ projectRoot, runtime });

    const session = await openSession(app, {
      game: 'demo',
      npcIds: ['guide'],
      npcs: [{ npcId: 'guide', soulId: 'demo.guide' }],
    });

    expect(session.status).toBe(400);
    expect(session.body.error).toContain('Declared Soul pack not found: demo.guide');
  });

  test('session + chat yields an affordance-bounded decision', async () => {
    const { app, runtime } = makeRouter(root(), goodDecision);
    const session = await openSession(app, { game: 'demo', npcIds: ['guide'] });
    expect(session.status).toBe(200);
    expect(session.body.sessionId).toBeTruthy();
    expect(runtime.brain.cachedSoulCount).toBe(1);

    const chat = await app.request('/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.body.token}`,
        'x-npc-session': session.body.sessionId,
      },
      body: JSON.stringify(snapshot()),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.decision.intent.action).toBe('walk_to');
    expect('memoryOps' in body.decision).toBe(false);
  });

  test('rejects chat without a valid capability token', async () => {
    const { app } = makeRouter(root(), goodDecision);
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot()),
    });
    expect(res.status).toBe(401);
  });

  test('rejects a snapshot for an npc outside the session capability', async () => {
    const { app } = makeRouter(root(), goodDecision);
    const session = await openSession(app, { game: 'demo', npcIds: ['guide'] });
    const res = await app.request('/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.body.token}`,
        'x-npc-session': session.body.sessionId,
      },
      body: JSON.stringify(snapshot({ npcId: 'intruder' })),
    });
    expect(res.status).toBe(403);
  });

  test('rejects a session that attempts to self-assert own trust', async () => {
    const { app } = makeRouter(root(), goodDecision);
    const session = await openSession(app, {
      game: 'demo',
      npcs: [{ npcId: 'guide', soulId: 'untrusted.guide', trustTier: 'own' }],
    });
    expect(session.status).toBe(400);
    expect(session.body.ok).toBe(false);
  });

  test('maps an LLM failure to the explicit M0 fallback response', async () => {
    const { app } = makeRouter(root(), async () => { throw new Error('llm down'); });
    const session = await openSession(app, { game: 'demo', npcIds: ['guide'] });
    const res = await app.request('/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.body.token}`,
        'x-npc-session': session.body.sessionId,
      },
      body: JSON.stringify(snapshot()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.fallback).toBe(true);
    expect(body.decision).toBeUndefined();
    expect(body.reason).toBeTruthy();
  });

  test('resumes through the shared ack and per-NPC decision cursor contract', async () => {
    const { app } = makeRouter(root(), goodDecision);
    const session = await openSession(app, { game: 'demo', npcIds: ['guide'] });
    await app.request('/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.body.token}`,
        'x-npc-session': session.body.sessionId,
      },
      body: JSON.stringify(snapshot()),
    });
    const resumed = await app.request('/resume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.body.token}`,
        'x-npc-session': session.body.sessionId,
      },
      body: JSON.stringify({
        epoch: session.body.epoch,
        resume: { ack: 0, fromSeq: 1, lastDecisionSeq: { guide: 0 } },
      }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      ok: true,
      reset: false,
      decisions: [{ npcId: 'guide', seq: 1 }],
    });
  });

  test('deduplicates concurrent episode settlement', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const brain = {
      settle: async () => {
        calls += 1;
        await gate;
        return 1;
      },
    } as unknown as NpcBrainService;
    const runtime = new NpcRuntime({ projectRoot: root(), brain });
    const grant = runtime.createSession({ game: 'demo', npcIds: ['guide'] });
    const session = runtime.authorize(grant.sessionId, grant.token)!;
    const first = runtime.end(session);
    const second = runtime.end(session);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(await runtime.end(session)).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('createNpcWebSocketHandler (M1 WS path)', () => {
  function fakeWs(data: NpcWsClientData) {
    const sent: unknown[] = [];
    let closed: { code: number; reason: string } | undefined;
    return {
      sent,
      get closed() { return closed; },
      ws: {
        data,
        send: (value: string) => { sent.push(JSON.parse(value)); },
        close: (code: number, reason: string) => { closed = { code, reason }; },
      } as any,
    };
  }

  test('valid capability opens with a session_ready frame and answers snapshots', async () => {
    const { runtime, app } = makeRouter(root(), goodDecision);
    const session = await openSession(app, { game: 'demo', npcIds: ['guide'] });
    const handler = createNpcWebSocketHandler(runtime);
    const conn = fakeWs({ id: 'c1', npc: { sessionId: session.body.sessionId, token: session.body.token } });

    handler.open?.(conn.ws);
    expect(conn.sent[0]).toMatchObject({ type: 'session_ready' });

    await handler.message?.(
      conn.ws,
      JSON.stringify({ v: 1, eventId: 'evt-1', epoch: session.body.epoch, seq: 1, type: 'snapshot', snapshot: snapshot() }),
    );
    const decisionFrame = conn.sent.find((f: any) => f.type === 'decisions') as any;
    expect(decisionFrame.decisions[0].intent.action).toBe('walk_to');
    expect(conn.sent.find((f: any) => f.type === 'budget')).toMatchObject({
      budget: { limit: 30, used: 1, remaining: 29 },
    });
  });

  test('partitions batch prompts by scene and visibility group', async () => {
    let calls = 0;
    const projectRoot = root();
    const brain = new NpcBrainService({
      projectRoot,
      complete: async (req) => {
        calls += 1;
        return goodDecision(req);
      },
    });
    const runtime = new NpcRuntime({ projectRoot, brain });
    const grant = runtime.createSession({ game: 'demo', npcIds: ['guide', 'merchant'] });
    const session = runtime.authorize(grant.sessionId, grant.token)!;
    await runtime.preloadSession(session);
    const decisions = await runtime.decideBatch(session, [
      snapshot({ npcId: 'guide', eventId: 'public', scene: 'square', visibilityGroup: 'public' }),
      snapshot({ npcId: 'merchant', eventId: 'private', scene: 'shop', visibilityGroup: 'private' }),
    ]);
    expect(decisions).toHaveLength(2);
    expect(calls).toBe(2);
  });

  test('supports dotted-soul attach, batch decisions, and detach on the shared wire contract', async () => {
    const { runtime, app } = makeRouter(root(), goodDecision);
    const session = await openSession(app, { game: 'demo', npcIds: ['guide'] });
    const handler = createNpcWebSocketHandler(runtime);
    const conn = fakeWs({ id: 'batch', npc: { sessionId: session.body.sessionId, token: session.body.token } });
    handler.open?.(conn.ws);

    await handler.message?.(conn.ws, JSON.stringify({
      v: 1,
      eventId: 'attach-merchant',
      epoch: 1,
      seq: 1,
      type: 'attach',
      sessionId: session.body.sessionId,
      binding: { npcId: 'merchant', soulId: 'demo.merchant' },
    }));
    await handler.message?.(conn.ws, JSON.stringify({
      v: 1,
      eventId: 'batch-1',
      epoch: 1,
      seq: 2,
      type: 'snapshots',
      snapshots: [
        snapshot({ eventId: 'guide-batch' }),
        snapshot({ eventId: 'merchant-batch', npcId: 'merchant' }),
      ],
    }));
    const decisions = conn.sent.find((frame: any) => frame.type === 'decisions') as any;
    expect(decisions.decisions.map((value: any) => value.npcId).sort()).toEqual(['guide', 'merchant']);

    await handler.message?.(conn.ws, JSON.stringify({
      v: 1,
      eventId: 'detach-merchant',
      epoch: 1,
      seq: 3,
      type: 'detach',
      sessionId: session.body.sessionId,
      npcId: 'merchant',
    }));
    await handler.message?.(conn.ws, JSON.stringify({
      v: 1,
      eventId: 'merchant-after-detach',
      epoch: 1,
      seq: 4,
      type: 'snapshot',
      snapshot: snapshot({ eventId: 'merchant-after-detach', npcId: 'merchant' }),
    }));
    expect(conn.sent.at(-1)).toMatchObject({ type: 'error', code: 'invalid_request' });
  });

  test('an invalid capability is closed with policy code 1008', async () => {
    const { runtime } = makeRouter(root(), goodDecision);
    const handler = createNpcWebSocketHandler(runtime);
    const conn = fakeWs({ id: 'c2', npc: { sessionId: 'nope', token: 'nope' } });
    handler.open?.(conn.ws);
    expect(conn.closed?.code).toBe(1008);
  });
});
