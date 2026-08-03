import { afterEach, describe, expect, test } from 'bun:test';
import { coreServeSpawnTimeoutMs } from '../src/kernel/forgeax-core-kernel';

const original = process.env.FORGEAX_CORE_SERVE_SPAWN_TIMEOUT_MS;

afterEach(() => {
  if (original == null) delete process.env.FORGEAX_CORE_SERVE_SPAWN_TIMEOUT_MS;
  else process.env.FORGEAX_CORE_SERVE_SPAWN_TIMEOUT_MS = original;
});

describe('forgeax-core serve startup timeout', () => {
  test('defaults to 30 seconds for cold Node/Docker startup', () => {
    delete process.env.FORGEAX_CORE_SERVE_SPAWN_TIMEOUT_MS;
    expect(coreServeSpawnTimeoutMs()).toBe(30_000);
  });

  test('accepts a positive deployment override', () => {
    process.env.FORGEAX_CORE_SERVE_SPAWN_TIMEOUT_MS = '45000';
    expect(coreServeSpawnTimeoutMs()).toBe(45_000);
  });

  test.each(['0', '-1', 'not-a-number'])('rejects invalid override %s', (value) => {
    process.env.FORGEAX_CORE_SERVE_SPAWN_TIMEOUT_MS = value;
    expect(coreServeSpawnTimeoutMs()).toBe(30_000);
  });
});
