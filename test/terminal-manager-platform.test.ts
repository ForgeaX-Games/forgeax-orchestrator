import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  resolveHostShellPath,
  shellNoRcFlags,
  waitForChildSpawn,
} from '../src/terminal/manager';

describe('terminal manager platform seams', () => {
  test('discovers Git Bash outside PATH on Windows', () => {
    const shell = resolveHostShellPath({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe',
      findOnPath: () => undefined,
    });
    expect(shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(shellNoRcFlags(shell)).toEqual(['--norc', '--noprofile']);
  });

  test('prefers an explicit shell and falls back only after a real PATH lookup', () => {
    expect(resolveHostShellPath({
      platform: 'win32',
      env: { FORGEAX_BASH_PATH: 'D:\\PortableGit\\bin\\bash.exe' },
      exists: (path) => path.startsWith('D:'),
      findOnPath: () => undefined,
    })).toBe('D:\\PortableGit\\bin\\bash.exe');
    expect(resolveHostShellPath({
      platform: 'win32', env: {}, exists: () => false, findOnPath: () => undefined,
    })).toBe('bash');
  });

  test('waits for asynchronous spawn success or failure when pid is absent', async () => {
    const success = new EventEmitter() as EventEmitter & { pid?: number };
    const pending = waitForChildSpawn(success as unknown as Parameters<typeof waitForChildSpawn>[0]);
    success.pid = 123;
    success.emit('spawn');
    await pending;

    const failed = new EventEmitter() as EventEmitter & { pid?: number };
    const failedPending = waitForChildSpawn(failed as unknown as Parameters<typeof waitForChildSpawn>[0]);
    failed.emit('error', new Error('ENOENT'));
    await failedPending;
  });
});
