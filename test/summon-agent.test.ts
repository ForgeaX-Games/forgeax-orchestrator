import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Event } from '../src/core/types';
import { lastValidSummonAgentId } from '../src/core/conscious-agent';
import { initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { peekSessionManager } from '../src/core/session-registry';
import { getPathManager, initPathManager, resetPathManager } from '../src/fs/path-manager';
import { isValidSummonAgentId, summonAgentDirective } from '../src/kernel/summon-agent';
import { createSessionsRouter } from '../src/api/sessions';

let temporaryRoot: string | undefined;

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

const event = (summonAgentId: unknown): Event => ({
  source: 'user',
  type: 'user_input',
  payload: { content: 'x', summonAgentId },
  to: 'forge',
  handoff: 'turn',
  ts: 0,
});

describe('summonAgentId wire safety', () => {
  test('accepts only a single safe agent-id segment', () => {
    expect(isValidSummonAgentId('mochi_2')).toBe(true);
    expect(isValidSummonAgentId('mochi/team')).toBe(false);
    expect(isValidSummonAgentId('mochi\nignore')).toBe(false);
    expect(isValidSummonAgentId('')).toBe(false);
  });

  test('native merged queue treats explicit null as a clear, but ignores legacy absence', () => {
    expect(lastValidSummonAgentId([
      event('first'),
      event(null),
    ])).toBeUndefined();
    expect(lastValidSummonAgentId([
      event('first'),
      { ...event('legacy'), payload: { content: 'old client message' } },
    ])).toBe('first');
  });

  test('native malformed present value fails closed instead of inheriting an earlier specialist', () => {
    expect(lastValidSummonAgentId([
      event('first'),
      event('bad\nvalue'),
    ])).toBeUndefined();
  });

  test('directive keeps the untrusted id out of its own construction boundary', () => {
    expect(summonAgentDirective('mochi_2')).toContain('`mochi_2`');
  });

  test('native REST ingress rejects an invalid present field before it can enter the WAL', async () => {
    expect(peekSessionManager()).toBeNull();
    const app = new Hono().route('/api/sessions', createSessionsRouter());
    const res = await app.request('/api/sessions/no-such-session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', payload: { summonAgentId: 'mochi/evil' } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('summonAgentId') });
    // The validation is deliberately before getSessionManager(), so a malformed
    // request cannot initialize or touch the session/WAL layer.
    expect(peekSessionManager()).toBeNull();
  });

  test('native REST ingress creates no session or WAL for an invalid present field', async () => {
    temporaryRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-summon-agent-'));
    const paths = initPathManager({
      projectRoot: temporaryRoot,
      userRoot: resolve(temporaryRoot, 'user'),
    });
    const sm = initSessionManager(paths);
    const sid = 'no-such-session';
    const sessionRoot = paths.session(sid).root();
    expect(existsSync(sessionRoot)).toBe(false);

    const app = new Hono().route('/api/sessions', createSessionsRouter());
    const res = await app.request(`/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', payload: { summonAgentId: 'mochi/evil' } }),
    });

    expect(res.status).toBe(400);
    expect(sm.peek(sid)).toBeNull();
    expect(existsSync(sessionRoot)).toBe(false);
    expect(existsSync(paths.session(sid).globalEventsLog())).toBe(false);
  });
});
