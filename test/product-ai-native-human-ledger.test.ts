import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBusRouter } from '../src/api/bus';
import { acquireUiLease, clearUiStateForSession } from '../src/api/lib/ui-manifest-registry';
import { resetPathManager, initPathManager } from '../src/fs/path-manager';
import { resetSessionManager, initSessionManager } from '../src/core/session-manager';
import {
  productActionLedgerRegistry,
  readProductActionLedger,
} from '../src/kernel/product-ai-native-ledger';

let projectRoot: string;
let previousProjectRoot: string | undefined;
let sid: string;

function app(): Hono {
  const value = new Hono();
  value.route('/api/bus', createBusRouter());
  return value;
}

function jsonRequest(body: unknown, origin = 'http://localhost'): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, host: 'localhost' },
    body: JSON.stringify(body),
  };
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-human-ledger-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  resetPathManager();
  await resetSessionManager();
  const paths = initPathManager({ userRoot: join(projectRoot, 'user'), projectRoot });
  sid = (await initSessionManager(paths).create({ autoStart: false })).sid;
  productActionLedgerRegistry.clear();
});

afterEach(async () => {
  productActionLedgerRegistry.clear();
  clearUiStateForSession(sid);
  await resetSessionManager();
  resetPathManager();
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('human ActionRegistry protocol ledger adapter', () => {
  test('sessionless same-origin action derives human identity on the server', async () => {
    const server = app();
    const attempted = await server.request('/api/bus/product-ai-native/human-attempt', jsonRequest({
      actionId: 'session.create',
      args: { displayName: 'First session' },
      clientCallId: 'human-call-1',
      actorId: 'spoofed-ai',
      rootActorId: 'spoofed-root',
    }));
    expect(attempted.status).toBe(201);
    const pending = await attempted.json() as { executionId: string; completionToken: string };
    const terminal = await server.request('/api/bus/product-ai-native/human-terminal', jsonRequest({
      ...pending,
      result: { status: 'completed', stateDigest: { created: true } },
      started: true,
    }));
    expect(terminal.status).toBe(200);

    const rows = readProductActionLedger(projectRoot, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      phase: 'attempt',
      actor: { kind: 'human', id: 'human:studio-local' },
      rootActorId: 'human:studio-local',
      actionId: 'session.create',
      clientCallId: 'human-call-1',
    });
    expect(rows[0]).not.toHaveProperty('sessionId');
  });

  test('sessionless action without a browser Origin is rejected before an attempt is written', async () => {
    const server = app();
    const response = await server.request('/api/bus/product-ai-native/human-attempt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'session.create', args: {} }),
    });
    expect(response.status).toBe(403);
    expect(readProductActionLedger(projectRoot, {})).toEqual([]);
  });

  test('sessionless action from the same hostname but a different port is not same-origin', async () => {
    const server = app();
    const response = await server.request('/api/bus/product-ai-native/human-attempt', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:38920',
        host: 'localhost:38900',
      },
      body: JSON.stringify({ actionId: 'session.create', args: {} }),
    });
    expect(response.status).toBe(403);
    expect(readProductActionLedger(projectRoot, {})).toEqual([]);
  });

  test('session action requires its live lease but terminal survives lease displacement', async () => {
    const server = app();
    const denied = await server.request('/api/bus/product-ai-native/human-attempt', jsonRequest({
      sessionId: sid,
      leaseId: 'wrong',
      actionId: 'role.open',
      args: { id: 'level-designer' },
    }));
    expect(denied.status).toBe(403);

    const firstLease = acquireUiLease(sid, 'page-a');
    const attempted = await server.request('/api/bus/product-ai-native/human-attempt', jsonRequest({
      sessionId: sid,
      leaseId: firstLease.leaseId,
      actionId: 'role.open',
      args: { id: 'level-designer' },
    }));
    expect(attempted.status).toBe(201);
    const pending = await attempted.json() as { executionId: string; completionToken: string };

    acquireUiLease(sid, 'page-b');
    const terminal = await server.request('/api/bus/product-ai-native/human-terminal', jsonRequest({
      ...pending,
      result: { status: 'completed' },
      started: true,
    }));
    expect(terminal.status).toBe(200);
    expect(readProductActionLedger(projectRoot, { sessionId: sid })).toEqual([
      expect.objectContaining({ phase: 'attempt', actor: { kind: 'human', id: `human:${sid}` } }),
      expect.objectContaining({ phase: 'terminal', status: 'completed' }),
    ]);
  });

  test('wrong completion token is rejected and a preflight rejection remains started=false', async () => {
    const server = app();
    const lease = acquireUiLease(sid, 'page-a');
    const attempted = await server.request('/api/bus/product-ai-native/human-attempt', jsonRequest({
      sessionId: sid,
      leaseId: lease.leaseId,
      actionId: 'missing.action',
      args: {},
    }));
    const pending = await attempted.json() as { executionId: string; completionToken: string };
    expect((await server.request('/api/bus/product-ai-native/human-terminal', jsonRequest({
      ...pending,
      completionToken: 'wrong',
      result: { status: 'rejected', reason: 'unknown action' },
      started: false,
    }))).status).toBe(403);
    const completed = await server.request('/api/bus/product-ai-native/human-terminal', jsonRequest({
      ...pending,
      result: { status: 'rejected', reason: 'unknown action' },
      started: false,
    }));
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      ok: true,
      receipt: { status: 'rejected', started: false },
    });
  });
});
