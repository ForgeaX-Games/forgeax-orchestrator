import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPathManager, resetPathManager, getPathManager } from '../src/fs/path-manager';
import { initSessionManager, resetSessionManager } from '../src/core/session-manager';

let root: string;
beforeEach(async () => {
  await resetSessionManager();
  resetPathManager();
  root = mkdtempSync(join(tmpdir(), 'forgeax-session-open-'));
  initPathManager({ userRoot: root });
});
afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

test('concurrent cold opens share one restored session', async () => {
  const sm = initSessionManager(getPathManager());
  const { sid } = await sm.create({ displayName: 'concurrent' });
  await sm.close(sid);
  const sessions = await Promise.all(Array.from({ length: 12 }, () => sm.open(sid)));
  try {
    expect(new Set(sessions).size).toBe(1);
    expect(sm.peek(sid)).toBe(sessions[0]);
  } finally {
    for (const session of new Set(sessions)) {
      if (session !== sm.peek(sid)) await session.dispose();
    }
  }
});

test('close waits for a cold open and leaves no restored session behind', async () => {
  const sm = initSessionManager(getPathManager());
  const { sid } = await sm.create({ displayName: 'closing' });
  await sm.close(sid);
  const opening = sm.open(sid);
  await sm.close(sid);
  await opening;
  expect(sm.peek(sid)).toBeNull();
});

test('failed restoration can be retried after the config is repaired', async () => {
  const paths = getPathManager();
  const sm = initSessionManager(paths);
  const { sid } = await sm.create({ displayName: 'retry' });
  await sm.close(sid);
  const file = paths.session(sid).configFile();
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, '{');
  await expect(sm.open(sid)).rejects.toThrow();
  writeFileSync(file, original);
  expect((await sm.open(sid)).sid).toBe(sid);
});

test('shutdown drains pending restoration and refuses new opens', async () => {
  const sm = initSessionManager(getPathManager());
  const { sid } = await sm.create({ displayName: 'shutdown' });
  await sm.close(sid);
  const opening = sm.open(sid);
  await sm.shutdown();
  await opening;
  expect(sm.peek(sid)).toBeNull();
  await expect(sm.open(sid)).rejects.toThrow('shutting down');
});
