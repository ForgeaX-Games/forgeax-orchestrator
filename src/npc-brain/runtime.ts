import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { NpcBrainService, type NpcBrainDecideOptions } from './service';
import {
  NPC_LIMITS,
  NPC_PROTOCOL_VERSION,
  npcBudgetFrameSchema,
  npcDecisionFrameSchema,
  npcDecisionsFrameSchema,
  npcErrorFrameSchema,
  npcHeartbeatFrameSchema,
  npcSessionRequestSchema,
  npcSessionReadyFrameSchema,
  parseNpcWireEnvelope,
  perceptionSnapshotSchema,
  resolveNpcDecisionDeadlineMs,
  type NpcDecisionWire,
  type NpcSessionRequest,
  type NpcSoulBinding,
  type NpcWireEnvelope,
  type ResumeRequest,
} from './protocol';
import type { TrustTier } from '../soul';
import { findSoulPack } from '../soul/soul-pack-loader';
import { NpcBatchCollector } from './batch-collector';

export interface NpcSessionGrant {
  sessionId: string;
  token: string;
  epoch: number;
  expiresAt: number;
}

export interface ResolvedNpcSoulBinding {
  npcId: string;
  soulId: string;
  decisionTimeoutMs: number;
  trustTier?: TrustTier;
  /** Internal marker: an explicit producer declaration must resolve to a physical pack. */
  requiresPack?: boolean;
}

export interface NpcSession extends NpcSessionGrant {
  game: string;
  playerId: string;
  npcIds: Set<string>;
  soulBindings: Map<string, ResolvedNpcSoulBinding>;
  lastSeq: Map<string, number>;
  replay: Map<string, NpcDecisionWire[]>;
}

export interface NpcRuntimeConfig {
  projectRoot: string;
  brain?: NpcBrainService;
  sessionTtlMs?: number;
  now?: () => number;
  maxSessions?: number;
}

export interface NpcWsClientData {
  id: string;
  npc: { sessionId: string; token: string };
}

export class NpcRuntime {
  readonly brain: NpcBrainService;
  readonly #sessions = new Map<string, NpcSession>();
  readonly #settlements = new Map<string, { promise: Promise<number>; expiresAt: number }>();
  readonly #now: () => number;
  readonly #sessionTtlMs: number;
  readonly #maxSessions: number;
  readonly #projectRoot: string;
  readonly #enforceDeclaredPacks: boolean;

  constructor(config: NpcRuntimeConfig) {
    this.brain = config.brain ?? new NpcBrainService({ projectRoot: config.projectRoot });
    this.#projectRoot = config.projectRoot;
    // An injected Brain owns its loader contract (tests and deployment-C use this).
    // The normal Studio runtime must never silently replace an explicitly bound Soul.
    this.#enforceDeclaredPacks = config.brain === undefined;
    this.#now = config.now ?? Date.now;
    this.#sessionTtlMs = config.sessionTtlMs ?? 30 * 60_000;
    this.#maxSessions = config.maxSessions ?? 256;
  }

  createSession(input: unknown): NpcSessionGrant {
    const request = npcSessionRequestSchema.parse(input);
    this.prune();
    if (this.#sessions.size >= this.#maxSessions) throw new Error('session capacity reached');
    const sessionId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const grant: NpcSessionGrant = {
      sessionId, token, epoch: 1, expiresAt: this.#now() + this.#sessionTtlMs,
    };
    const bindings = this.#soulBindings(request.game, request.npcIds, request.npcs);
    this.#sessions.set(sessionId, {
      ...grant,
      game: request.game,
      playerId: request.playerId ?? 'local',
      npcIds: new Set(bindings.keys()),
      soulBindings: bindings,
      lastSeq: new Map(),
      replay: new Map(),
    });
    return grant;
  }

  async preloadSession(session: NpcSession): Promise<void> {
    for (const binding of session.soulBindings.values()) this.#assertDeclaredPack(binding);
    const loaded = await this.brain.preload(
      session.game,
      session.soulBindings.values(),
      session.playerId,
    );
    const trustBySoul = new Map(loaded.map((item) => [item.soulId, item.trustTier]));
    for (const binding of session.soulBindings.values()) {
      binding.trustTier = trustBySoul.get(binding.soulId);
    }
    for (const npcId of session.npcIds) this.brain.attach(session.game, npcId);
  }

  authorize(sessionId: string | undefined, token: string | undefined): NpcSession | undefined {
    this.prune();
    if (!sessionId || !token) return undefined;
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    const supplied = Buffer.from(token);
    const expected = Buffer.from(session.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    session.expiresAt = this.#now() + this.#sessionTtlMs;
    return session;
  }

  async decide(
    session: NpcSession,
    input: unknown,
    options: Omit<NpcBrainDecideOptions, 'soulId'> = {},
  ): Promise<NpcDecisionWire | undefined> {
    const snapshot = perceptionSnapshotSchema.parse(input);
    const binding = session.soulBindings.get(snapshot.npcId);
    if (snapshot.game !== session.game || !binding) {
      throw new Error('snapshot outside session capability');
    }
    const decision = await this.brain.decide(
      { ...snapshot, playerId: session.playerId },
      {
        ...options,
        deadlineMs: options.deadlineMs ?? binding.decisionTimeoutMs,
        soulId: binding.soulId,
      },
    );
    if (!decision) return undefined;
    session.lastSeq.set(decision.npcId, decision.seq);
    const replay = session.replay.get(decision.npcId) ?? [];
    replay.push(decision);
    if (replay.length > 128) replay.splice(0, replay.length - 128);
    session.replay.set(decision.npcId, replay);
    return decision;
  }

  async decideBatch(
    session: NpcSession,
    inputs: unknown[],
    options: Omit<NpcBrainDecideOptions, 'soulId'> = {},
  ): Promise<NpcDecisionWire[]> {
    const snapshots = inputs.map((input) => perceptionSnapshotSchema.parse(input));
    for (const snapshot of snapshots) {
      if (snapshot.game !== session.game || !session.soulBindings.has(snapshot.npcId)) {
        throw new Error('snapshot outside session capability');
      }
    }
    const groups = new Map<string, typeof snapshots>();
    for (const snapshot of snapshots) {
      const key = `${snapshot.scene ?? ''}${snapshot.visibilityGroup ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(snapshot);
      groups.set(key, group);
    }
    const decisions = (await Promise.all([...groups.values()].map((group) => this.brain.decideBatch(
      group.map((snapshot) => ({ ...snapshot, playerId: session.playerId })),
      (snapshot) => {
        const binding = session.soulBindings.get(snapshot.npcId)!;
        return {
          ...options,
          deadlineMs: options.deadlineMs ?? binding.decisionTimeoutMs,
          soulId: binding.soulId,
        };
      },
    )))).flat();
    for (const decision of decisions) {
      session.lastSeq.set(decision.npcId, decision.seq);
      const replay = session.replay.get(decision.npcId) ?? [];
      replay.push(decision);
      session.replay.set(decision.npcId, replay.slice(-128));
    }
    return decisions;
  }

  async attach(session: NpcSession, binding: NpcSoulBinding): Promise<ResolvedNpcSoulBinding> {
    if (!session.soulBindings.has(binding.npcId) && session.soulBindings.size >= NPC_LIMITS.maxSessionNpcs) {
      throw new Error('session NPC capacity reached');
    }
    const resolved: ResolvedNpcSoulBinding = {
      npcId: binding.npcId,
      soulId: binding.soulId ?? `${session.game}.${binding.npcId}`,
      decisionTimeoutMs: resolveNpcDecisionDeadlineMs(binding.decisionDeadline),
      requiresPack: binding.soulId !== undefined,
    };
    this.#assertDeclaredPack(resolved);
    session.npcIds.add(resolved.npcId);
    session.soulBindings.set(resolved.npcId, resolved);
    const [loaded] = await this.brain.preload(session.game, [resolved], session.playerId);
    resolved.trustTier = loaded?.trustTier;
    this.brain.attach(session.game, resolved.npcId);
    return resolved;
  }

  detach(session: NpcSession, npcId: string): boolean {
    session.npcIds.delete(npcId);
    session.lastSeq.delete(npcId);
    session.replay.delete(npcId);
    this.brain.detach(session.game, npcId);
    return session.soulBindings.delete(npcId);
  }

  decisionTimeoutMs(session: NpcSession, npcId: string): number {
    const binding = session.soulBindings.get(npcId);
    if (!binding) throw new Error('NPC outside session capability');
    return binding.decisionTimeoutMs;
  }

  resume(session: NpcSession, epoch: number | undefined, request: ResumeRequest) {
    if (epoch !== session.epoch) {
      return { epoch: session.epoch, reset: true, decisions: [] as NpcDecisionWire[] };
    }
    const decisions = [...session.replay].flatMap(([npcId, replay]) => {
      const after = request.lastDecisionSeq?.[npcId] ?? 0;
      return replay.filter((decision) => decision.seq > after);
    }).sort((a, b) => a.seq - b.seq);
    return { epoch: session.epoch, reset: false, decisions };
  }

  async end(session: NpcSession): Promise<number> {
    const existing = this.#settlements.get(session.sessionId);
    if (existing && existing.expiresAt > this.#now()) return existing.promise;
    const settlement = this.brain.settle(session.game, session.playerId, session.npcIds)
      .finally(() => this.#sessions.delete(session.sessionId));
    this.#settlements.set(session.sessionId, {
      promise: settlement,
      expiresAt: this.#now() + this.#sessionTtlMs,
    });
    return settlement;
  }

  prune(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
    for (const [id, settlement] of this.#settlements) {
      if (settlement.expiresAt <= now) this.#settlements.delete(id);
    }
  }

  #soulBindings(
    game: string,
    npcIds: NpcSessionRequest['npcIds'],
    npcs: NpcSessionRequest['npcs'],
  ): Map<string, ResolvedNpcSoulBinding> {
    const bindings = new Map<string, ResolvedNpcSoulBinding>();
    for (const npcId of npcIds ?? []) {
      bindings.set(npcId, {
        npcId,
        soulId: `${game}.${npcId}`,
        decisionTimeoutMs: resolveNpcDecisionDeadlineMs(),
      });
    }
    for (const item of npcs ?? []) {
      bindings.set(item.npcId, {
        npcId: item.npcId,
        soulId: item.soulId ?? `${game}.${item.npcId}`,
        decisionTimeoutMs: resolveNpcDecisionDeadlineMs(item.decisionDeadline),
        requiresPack: item.soulId !== undefined,
      });
    }
    return bindings;
  }

  #assertDeclaredPack(binding: ResolvedNpcSoulBinding): void {
    if (!this.#enforceDeclaredPacks || !binding.requiresPack) return;
    if (!findSoulPack(binding.soulId, this.#projectRoot)) {
      throw new Error(`Declared Soul pack not found: ${binding.soulId}`);
    }
  }
}

export function createNpcWebSocketHandler(runtime: NpcRuntime): WebSocketHandler<NpcWsClientData> {
  const sessions = new WeakMap<ServerWebSocket<NpcWsClientData>, NpcSession>();
  const send = (ws: ServerWebSocket<NpcWsClientData>, value: NpcWireEnvelope) => ws.send(JSON.stringify(parseNpcWireEnvelope(value)));
  const messageWindows = new WeakMap<ServerWebSocket<NpcWsClientData>, { startedAt: number; count: number }>();
  const serverSeq = new WeakMap<ServerWebSocket<NpcWsClientData>, number>();
  const lastAck = new WeakMap<ServerWebSocket<NpcWsClientData>, number>();
  const collectors = new WeakMap<
    ServerWebSocket<NpcWsClientData>,
    NpcBatchCollector<unknown, NpcDecisionWire>
  >();
  const latestSpotlight = new WeakMap<ServerWebSocket<NpcWsClientData>, Map<string, unknown>>();
  const heartbeatTimers = new WeakMap<ServerWebSocket<NpcWsClientData>, ReturnType<typeof setInterval>>();
  const header = (ws: ServerWebSocket<NpcWsClientData>, eventId: string, session: NpcSession) => ({
    v: NPC_PROTOCOL_VERSION,
    eventId,
    epoch: session.epoch,
    seq: (serverSeq.get(ws) ?? 0) + 1,
    ...(lastAck.get(ws) !== undefined ? { ack: lastAck.get(ws)! } : {}),
  });
  return {
    open(ws) {
      const session = runtime.authorize(ws.data.npc.sessionId, ws.data.npc.token);
      if (!session) {
        ws.close(1008, 'invalid NPC session capability');
        return;
      }
      sessions.set(ws, session);
      latestSpotlight.set(ws, new Map());
      collectors.set(ws, new NpcBatchCollector({
        windowMs: 100,
        flush: async (snapshots) => {
          const decisions = await runtime.decideBatch(session, [...snapshots]);
          const eventId = `batch-${Date.now()}`;
          sendDecisions(ws, session, eventId, decisions);
          sendBudget(ws, session, eventId);
          return decisions;
        },
      }));
      const heartbeatTimer = setInterval(() => {
        const latest = latestSpotlight.get(ws);
        if (!latest || latest.size === 0) return;
        const snapshots = [...latest.values()].filter((value) => {
          const snapshot = perceptionSnapshotSchema.parse(value);
          return snapshot.nearby.some((entity) => entity.kind === 'player');
        }).map((value, index) => {
          const snapshot = perceptionSnapshotSchema.parse(value);
          return {
            ...snapshot,
            eventId: `server-heartbeat-${Date.now()}-${index}`,
            trigger: 'heartbeat' as const,
          };
        });
        if (snapshots.length === 0) return;
        void runtime.decideBatch(session, snapshots).then((decisions) => {
          const eventId = `server-heartbeat-${Date.now()}`;
          sendDecisions(ws, session, eventId, decisions);
          sendBudget(ws, session, eventId);
        }).catch(() => undefined);
      }, 30_000);
      heartbeatTimer.unref?.();
      heartbeatTimers.set(ws, heartbeatTimer);
      messageWindows.set(ws, { startedAt: Date.now(), count: 0 });
      const frame = npcSessionReadyFrameSchema.parse({
        ...header(ws, `ready-${session.epoch}`, session),
        type: 'session_ready',
        sessionId: session.sessionId,
      });
      serverSeq.set(ws, frame.seq);
      send(ws, frame);
    },
    async message(ws, raw) {
      const session = sessions.get(ws);
      if (!session) return;
      const window = messageWindows.get(ws) ?? { startedAt: Date.now(), count: 0 };
      if (Date.now() - window.startedAt >= 1_000) {
        window.startedAt = Date.now();
        window.count = 0;
      }
      window.count += 1;
      messageWindows.set(ws, window);
      if (window.count > 20) {
        ws.close(1008, 'NPC frame rate exceeds limit');
        return;
      }
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024) {
        ws.close(1009, 'NPC frame exceeds limit');
        return;
      }
      let envelope: NpcWireEnvelope;
      try { envelope = parseNpcWireEnvelope(JSON.parse(raw)); } catch { sendError(ws, session, 'invalid_json', 'invalid_json', 'invalid NPC wire frame'); return; }
      lastAck.set(ws, envelope.seq);
      try {
        if (envelope.type === 'snapshot') {
          latestSpotlight.get(ws)?.set(envelope.snapshot.npcId, envelope.snapshot);
          await collectors.get(ws)?.add(envelope.snapshot);
        } else if (envelope.type === 'snapshots') {
          for (const snapshot of envelope.snapshots) latestSpotlight.get(ws)?.set(snapshot.npcId, snapshot);
          const decisions = await runtime.decideBatch(session, envelope.snapshots);
          if (decisions.length > 0) {
            const frame = npcDecisionsFrameSchema.parse({
              ...header(ws, envelope.eventId, session),
              type: 'decisions',
              decisions,
            });
            serverSeq.set(ws, frame.seq);
            send(ws, frame);
          } else {
            sendHeartbeat(ws, session, envelope.eventId);
          }
          sendBudget(ws, session, envelope.eventId);
        } else if (envelope.type === 'attach') {
          if (envelope.sessionId !== session.sessionId) throw new Error('attach outside session capability');
          await runtime.attach(session, envelope.binding);
          sendHeartbeat(ws, session, envelope.eventId);
        } else if (envelope.type === 'detach') {
          if (envelope.sessionId !== session.sessionId) throw new Error('detach outside session capability');
          runtime.detach(session, envelope.npcId);
          latestSpotlight.get(ws)?.delete(envelope.npcId);
          sendHeartbeat(ws, session, envelope.eventId);
        } else if (envelope.type === 'resume') {
          if (envelope.sessionId !== session.sessionId) throw new Error('resume outside session capability');
          const replay = runtime.resume(session, envelope.epoch, envelope.resume);
          for (const decision of replay.decisions) {
            const frame = npcDecisionFrameSchema.parse({
              ...header(ws, envelope.eventId, session),
              type: 'decision',
              decision,
            });
            serverSeq.set(ws, frame.seq);
            send(ws, frame);
          }
          if (replay.decisions.length === 0) sendHeartbeat(ws, session, envelope.eventId);
        } else if (envelope.type === 'episode_end') {
          await runtime.end(session);
          sendHeartbeat(ws, session, envelope.eventId);
          ws.close(1000, envelope.reason ?? 'episode ended');
        } else if (envelope.type === 'heartbeat') {
          sendHeartbeat(ws, session, envelope.eventId);
        } else {
          sendError(ws, session, envelope.eventId, 'unsupported_message', 'unsupported_message');
        }
      } catch (error) {
        sendError(ws, session, envelope.eventId, 'invalid_request', (error as Error).message);
      }
    },
    close(ws) {
      sessions.delete(ws);
      messageWindows.delete(ws);
      serverSeq.delete(ws);
      lastAck.delete(ws);
      collectors.delete(ws);
      latestSpotlight.delete(ws);
      const heartbeatTimer = heartbeatTimers.get(ws);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimers.delete(ws);
    },
  };

  function sendHeartbeat(ws: ServerWebSocket<NpcWsClientData>, session: NpcSession, eventId: string) {
    const frame = npcHeartbeatFrameSchema.parse({
      ...header(ws, eventId, session),
      type: 'heartbeat',
    });
    serverSeq.set(ws, frame.seq);
    send(ws, frame);
  }

  function sendBudget(ws: ServerWebSocket<NpcWsClientData>, session: NpcSession, eventId: string) {
    const frame = npcBudgetFrameSchema.parse({
      ...header(ws, `${eventId}-budget`, session),
      type: 'budget',
      budget: runtime.brain.budgetState(session.game),
    });
    serverSeq.set(ws, frame.seq);
    send(ws, frame);
  }

  function sendDecisions(
    ws: ServerWebSocket<NpcWsClientData>,
    session: NpcSession,
    eventId: string,
    decisions: readonly NpcDecisionWire[],
  ) {
    if (decisions.length === 0) {
      sendHeartbeat(ws, session, eventId);
      return;
    }
    const frame = npcDecisionsFrameSchema.parse({
      ...header(ws, eventId, session),
      type: 'decisions',
      decisions,
    });
    serverSeq.set(ws, frame.seq);
    send(ws, frame);
  }

  function sendError(
    ws: ServerWebSocket<NpcWsClientData>,
    session: NpcSession,
    eventId: string,
    code: string,
    message: string,
  ) {
    const frame = npcErrorFrameSchema.parse({
      ...header(ws, eventId, session),
      type: 'error',
      code,
      message: message.slice(0, 200) || code,
    });
    serverSeq.set(ws, frame.seq);
    send(ws, frame);
  }
}
