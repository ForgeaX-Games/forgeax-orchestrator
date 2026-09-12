import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexNativeCheckpoint } from '../src/kernel/codex-native-checkpoint';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const value = mkdtempSync(join(tmpdir(), 'native-checkpoint-')); homes.push(value); return value; }

test('only matching completed identity is available; configuration stays hashed', () => {
  const directory = home();
  const checkpoint = new CodexNativeCheckpoint(directory, 'private configuration');
  expect(checkpoint.read()).toBeUndefined();
  checkpoint.complete('native-thread-a');
  expect(checkpoint.read()).toBe('native-thread-a');
  expect(new CodexNativeCheckpoint(directory, 'different session or configuration').read()).toBeUndefined();
  expect(readFileSync(join(directory, 'forgeax-native-resume.json'), 'utf8')).not.toContain('private configuration');
  checkpoint.clear();
  expect(checkpoint.read()).toBeUndefined();
});

test('damaged or unsupported checkpoint never supplies a native identity', () => {
  const directory = home();
  const checkpoint = new CodexNativeCheckpoint(directory, 'configuration');
  for (const data of ['{broken', 'null', '[]', '{"version":99,"threadId":"foreign"}']) {
    writeFileSync(join(directory, 'forgeax-native-resume.json'), data);
    expect(checkpoint.read()).toBeUndefined();
  }
});
