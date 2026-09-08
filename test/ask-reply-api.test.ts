import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createSessionsRouter } from '../src/api/sessions';
import { registerAsk, type AskHandle } from '../src/core/ask-user-registry';

const handles: AskHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
});

describe('POST /api/sessions/:sid/ask-reply', () => {
  it('accepts grouped question answers from AskUserCard without flattening them', async () => {
    const sid = 'grouped-ask-reply-api';
    const agent = 'forgeax';
    const handle = registerAsk(sid, agent, 0);
    handles.push(handle);
    const answers = [
      { questionId: 'view', values: ['3D third-person'] },
      { questionId: 'scope', values: ['Concise design'] },
    ];
    const app = new Hono().route('/api/sessions', createSessionsRouter());

    const response = await app.request(`/api/sessions/${sid}/ask-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, requestId: handle.requestId, answers }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.promise).toEqual(answers);
  });

  it('keeps accepting the legacy flat values payload', async () => {
    const sid = 'legacy-ask-reply-api';
    const agent = 'forgeax';
    const handle = registerAsk(sid, agent, 0);
    handles.push(handle);
    const app = new Hono().route('/api/sessions', createSessionsRouter());

    const response = await app.request(`/api/sessions/${sid}/ask-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, requestId: handle.requestId, values: ['Legacy'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.promise).toEqual(['Legacy']);
  });

  it('rejects malformed grouped answers', async () => {
    const app = new Hono().route('/api/sessions', createSessionsRouter());
    const response = await app.request('/api/sessions/malformed/ask-reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'forgeax',
        answers: [{ questionId: 'view', values: 'not-an-array' }],
      }),
    });

    expect(response.status).toBe(400);
  });
});
