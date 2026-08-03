import { Hono } from 'hono';
import type { Context } from 'hono';
import type { NpcRuntime, NpcSession } from '../npc-brain/runtime';
import { NpcRuntime as DefaultNpcRuntime } from '../npc-brain/runtime';
import { perceptionSnapshotSchema, resumeRequestSchema } from '../npc-brain/protocol';

export interface NpcRouterOptions {
  projectRoot: string;
  runtime?: NpcRuntime;
}

export function createNpcRouter(options: NpcRouterOptions) {
  const app = new Hono();
  const runtime = options.runtime ?? new DefaultNpcRuntime({ projectRoot: options.projectRoot });

  app.post('/session', async (c) => {
    try {
      const grant = runtime.createSession(await readJson(c, null));
      const session = runtime.authorize(grant.sessionId, grant.token);
      if (session) await runtime.preloadSession(session);
      const loaded = session ? [...session.soulBindings.values()].map((binding) => ({
        npcId: binding.npcId,
        soulId: binding.soulId,
        decisionTimeoutMs: binding.decisionTimeoutMs,
        ...(binding.trustTier ? { trustTier: binding.trustTier } : {}),
      })) : [];
      return c.json({ ok: true, ...grant, loaded, wsUrl: '/api/npc/ws' });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ ok: false, error: message }, statusForError(message));
    }
  });

  app.post('/chat', async (c) => {
    const session = authorize(c, runtime);
    if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
    // Pass a RELATIVE deadline so the Brain anchors it to its own clock (single
    // clock source): mixing Date.now() here with the service's injectable now()
    // breaks the abort timer under clock-injecting (form-C) deployments.
    try {
      const snapshot = perceptionSnapshotSchema.parse(await readJson(c, null));
      const decisionTimeoutMs = runtime.decisionTimeoutMs(session, snapshot.npcId);
      const wallDeadlineAt = Date.now() + decisionTimeoutMs;
      const decision = await runtime.decide(session, snapshot, {
        signal: c.req.raw.signal,
      });
      if (!decision) {
        return c.json({
          ok: true,
          fallback: true,
          reason: noDecisionReason(c.req.raw.signal, wallDeadlineAt),
          epoch: session.epoch,
        });
      }
      return c.json({ ok: true, decision, epoch: session.epoch });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ ok: false, error: message }, statusForError(message));
    }
  });

  app.post('/resume', async (c) => {
    const session = authorize(c, runtime);
    if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
    try {
      const body = await readJson(c, {}) as { epoch?: number; resume?: unknown };
      const resume = resumeRequestSchema.parse(body.resume);
      return c.json({ ok: true, ...runtime.resume(session, body.epoch, resume) });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
  });

  app.post('/episode-end', async (c) => {
    const session = authorize(c, runtime);
    if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const settled = await runtime.end(session);
    return c.json({ ok: true, settled });
  });

  return app;
}

function authorize(c: Context, runtime: NpcRuntime): NpcSession | undefined {
  return runtime.authorize(c.req.header('x-npc-session'), bearerToken(c));
}

function bearerToken(c: Context): string | undefined {
  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token || undefined;
}

async function readJson(c: Context, fallback: unknown): Promise<unknown> {
  return c.req.json().catch(() => fallback);
}

function statusForError(message: string): 400 | 403 | 429 {
  if (message.includes('capacity')) return 429;
  if (message.includes('outside session')) return 403;
  return 400;
}

function noDecisionReason(signal: AbortSignal, deadlineAt: number): string {
  if (signal.aborted) return 'aborted';
  if (Date.now() >= deadlineAt) return 'timeout';
  return 'no_decision';
}
