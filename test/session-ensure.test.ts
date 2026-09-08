import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { getPathManager, initPathManager, resetPathManager } from '../src/fs/path-manager';
import { ensureSessionWithBootstrap } from '../src/api/lib/session-create';
import { createSessionsRouter } from '../src/api/sessions';

let root: string;

beforeEach(async () => {
  root = mkdtempSync(resolve(tmpdir(), 'forgeax-session-ensure-'));
  await resetSessionManager();
  resetPathManager();
  initPathManager({ projectRoot: root, userRoot: resolve(root, 'user') });
  initSessionManager(getPathManager());
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

describe('ensureSessionWithBootstrap', () => {
  test('concurrent observers converge on one default session', async () => {
    const input = { autoStart: false, bootstrapAgent: false as const };
    const [first, second] = await Promise.all([
      ensureSessionWithBootstrap(input),
      ensureSessionWithBootstrap(input),
    ]);

    expect(first.sid).toBe(second.sid);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(getPathManager().listSessionIds()).toEqual([first.sid]);

    const existing = await ensureSessionWithBootstrap(input);
    expect(existing).toEqual({ sid: first.sid, bootstrappedAgent: null, created: false });
  });

  test('POST /api/sessions/ensure creates once and reuses the session', async () => {
    const app = new Hono().route('/api/sessions', createSessionsRouter());
    const request = () => app.request('/api/sessions/ensure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        autoStart: false,
        bootstrapAgent: false,
      }),
    });

    const firstResponse = await request();
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      sid: string;
      bootstrappedAgent: string | null;
      created: boolean;
    };
    expect(first.created).toBe(true);
    expect(first.bootstrappedAgent).toBeNull();

    const secondResponse = await request();
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      sid: first.sid,
      bootstrappedAgent: null,
      created: false,
    });
  });
});
