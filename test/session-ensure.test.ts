import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { getPathManager, initPathManager, resetPathManager } from '../src/fs/path-manager';
import { ensureSessionWithBootstrap } from '../src/api/lib/session-create';

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
});
