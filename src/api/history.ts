import { Hono } from 'hono';
import { getSessionManager } from '../core/session-manager';
import { HistoryService } from '../history/service';
import { cloneHistoryBundle, verifyHistoryBundle } from '../history/bundle';
import { createSessionWithBootstrap } from './lib/session-create';

export function createHistoryRouter(): Hono {
  const router = new Hono();
  router.get('/:sid', async (c) => {
    const sid = c.req.param('sid');
    const session = getSessionManager().peek(sid);
    if (!session) return c.json({ code: 'history_permission_denied', message: 'history unavailable' }, 404);
    try {
      const page = await new HistoryService(session).query({
        agentId: c.req.query('agent') ?? 'forge',
        ...(c.req.query('kernel') ? { kernelId: c.req.query('kernel') } : {}),
        ...(c.req.query('after') ? { after: c.req.query('after') } : {}),
        ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
        ...(c.req.query('since') ? { since: Number(c.req.query('since')) } : {}),
        ...(c.req.query('until') ? { until: Number(c.req.query('until')) } : {}),
      });
      return c.json({ sid, ...page });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ code: message === 'history_permission_denied' ? message : 'history_unavailable', message: 'history unavailable' }, 403);
    }
  });
  router.get('/:sid/export', async (c) => {
    const session = getSessionManager().peek(c.req.param('sid'));
    if (!session) return c.json({ code: 'history_permission_denied', message: 'history unavailable' }, 404);
    try { return c.json(await new HistoryService(session).export({ agentId: c.req.query('agent') ?? 'forge' })); }
    catch { return c.json({ code: 'history_unavailable', message: 'history unavailable' }, 403); }
  });
  router.post('/import', async (c) => {
    try {
      const body = await c.req.json() as { bundle?: unknown; agentId?: string; displayName?: string };
      verifyHistoryBundle(body.bundle);
      const agentId = body.agentId ?? body.bundle.sourceAgentId;
      if (!agentId || agentId.includes('..') || agentId.startsWith('/')) throw new Error('history_permission_denied');
      const created = await createSessionWithBootstrap({ displayName: body.displayName ?? `Imported ${body.bundle.sourceSid}`, bootstrapAgent: agentId });
      const session = getSessionManager().peek(created.sid);
      if (!session) throw new Error('history_unavailable');
      const ledger = session.getOrCreateLedger(agentId);
      const imported = cloneHistoryBundle(body.bundle, created.sid, agentId);
      for (const item of imported) {
        const type = item.message.role === 'user' ? 'user_input' : item.message.role === 'assistant' ? 'assistant.message' : 'tool.result';
        ledger.append({
          type,
          ts: item.ts ?? Date.now(),
          source: 'history-import',
          payload: { llmMessage: item.message, turnId: item.turnId, providerId: item.kernelId },
        } as never, 'history-import', {
          eventId: item.cursor.eventId,
          turnId: item.turnId,
          origin: { kernelId: item.kernelId ?? 'import', laneId: 'import', epoch: 1 },
        });
      }
      ledger.append({ type: 'history_imported', ts: Date.now(), source: 'history-import', payload: { sourceSid: body.bundle.sourceSid, sourceAgentId: body.bundle.sourceAgentId, count: imported.length } } as never, 'history-import');
      return c.json({ sid: created.sid, agentId, imported: imported.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === 'history_permission_denied' ? message : message.startsWith('history_bundle_') ? message : 'history_unavailable';
      return c.json({ code, message: code === 'history_bundle_digest_mismatch' ? 'history bundle digest mismatch' : 'history unavailable' }, code === 'history_permission_denied' ? 403 : 400);
    }
  });
  return router;
}
