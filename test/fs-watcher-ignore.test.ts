import { describe, expect, test } from 'bun:test';
import { isIgnoredFsWatcherPath } from '../src/api/lib/watcher';

describe('FsWatcher runtime path filtering', () => {
  test('ignores per-game DDC and session output on both path styles', () => {
    expect(isIgnoredFsWatcherPath('.forgeax/games/demo/.forgeax/ddc/v2/staging/receipt.json')).toBe(true);
    expect(isIgnoredFsWatcherPath('.forgeax\\games\\demo\\.forgeax\\ddc\\v2\\entries\\payload.json')).toBe(true);
    expect(isIgnoredFsWatcherPath('.forgeax/games/demo/sessions/run/logs/latest.log')).toBe(true);
  });

  test('keeps authored game source observable', () => {
    expect(isIgnoredFsWatcherPath('.forgeax/games/demo/main.ts')).toBe(false);
    expect(isIgnoredFsWatcherPath('.forgeax/games/demo/assets/scene.pack.json')).toBe(false);
  });
});
