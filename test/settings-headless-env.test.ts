import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsRouter } from '../src/api/settings';
import { DeepSeekHarnessKernel } from '../src/kernel/deepseek-harness-kernel';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';

// Settings normally restarts the shared sidecar after credential changes. The
// contract under test is the next DSH child environment, so keep this test
// hermetic and do not wait for a machine-global sidecar socket to disappear.
mock.module('../src/kernel/sidecar-singleton', () => ({
  restartSidecar: async () => {},
}));

const TEST_KEY = 'dsk-test-key-never-sent-to-network';
const TEST_BASE_URL = 'http://127.0.0.1:9/fake-deepseek';
const MODEL = 'dsh-owned-model-fixture';
const SAVED_ENV: Record<string, string | undefined> = {};
let root: string;
let envFile: string;
let binary: string;
let record: string;

function request(): TurnRequest {
  return {
    callId: 'settings-headless-env-test',
    session: { threadId: 'thread', agentId: 'forge' },
    input: { text: 'test task' },
    systemPrompt: { charter: 'charter', persona: 'persona', dynamicSuffix: '' },
    tools: [],
    budget: {},
    permissionMode: 'autoEdits',
  } as TurnRequest;
}

async function run(kernel: DeepSeekHarnessKernel): Promise<KernelEvent[]> {
  const events: KernelEvent[] = [];
  for await (const event of kernel.runTurn(request(), new AbortController().signal)) events.push(event);
  return events;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fx-dsh-settings-'));
  envFile = join(root, '.env');
  binary = join(root, 'dsh');
  record = join(root, 'child-env.txt');
  writeFileSync(envFile, `FORGEAX_MODEL=${MODEL}\n`);
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n%s\\n%s\' "$DEEPSEEK_API_KEY" "$DEEPSEEK_BASE_URL" "$FORGEAX_MODEL" > "$DSH_TEST_RECORD"\nprintf \'ok\\n\'\n');
  chmodSync(binary, 0o755);
  for (const key of ['FORGEAX_ENV_FILE', 'FORGEAX_PROJECT_ROOT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'FORGEAX_MODEL', 'DEEPSEEK_HARNESS_CLI_PATH', 'DSH_TEST_RECORD', 'FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS']) SAVED_ENV[key] = process.env[key];
  process.env.FORGEAX_ENV_FILE = envFile;
  process.env.FORGEAX_PROJECT_ROOT = root;
  process.env.FORGEAX_MODEL = MODEL;
  process.env.DEEPSEEK_HARNESS_CLI_PATH = binary;
  process.env.DSH_TEST_RECORD = record;
  process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS = '1';
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('settings to DSH headless environment contract', () => {
  test('saves, masks, clears, live-applies, and passes latest values to the next child', async () => {
    const router = createSettingsRouter();
    const save = await router.fetch(new Request('http://test/env', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ DEEPSEEK_API_KEY: TEST_KEY, DEEPSEEK_BASE_URL: TEST_BASE_URL }),
    }));
    expect(save.status).toBe(200);
    expect(process.env.DEEPSEEK_API_KEY).toBe(TEST_KEY);
    expect(process.env.DEEPSEEK_BASE_URL).toBe(TEST_BASE_URL);
    expect(process.env.FORGEAX_MODEL).toBe(MODEL);
    expect(readFileSync(envFile, 'utf8')).toContain(`DEEPSEEK_API_KEY=${TEST_KEY}`);

    const settings = await router.fetch(new Request('http://test/'));
    const payload = await settings.json() as { env: Record<string, string | null> };
    expect(payload.env.DEEPSEEK_API_KEY).toBe('dsk-********work');
    expect(payload.env.DEEPSEEK_API_KEY).not.toBe(TEST_KEY);
    expect(payload.env.DEEPSEEK_BASE_URL).toBe(TEST_BASE_URL);

    const events = await run(new DeepSeekHarnessKernel());
    expect(events.map((event) => event.kind)).toEqual(['message.delta', 'turn.usage', 'turn.done']);
    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual([TEST_KEY, TEST_BASE_URL, MODEL]);

    const clear = await router.fetch(new Request('http://test/env', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: '' }),
    }));
    expect(clear.status).toBe(200);
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(process.env.DEEPSEEK_BASE_URL).toBeUndefined();
    expect(readFileSync(envFile, 'utf8')).not.toContain('DEEPSEEK_API_KEY=');
    expect(readFileSync(envFile, 'utf8')).not.toContain('DEEPSEEK_BASE_URL=');
    expect(process.env.FORGEAX_MODEL).toBe(MODEL);
  });
});
