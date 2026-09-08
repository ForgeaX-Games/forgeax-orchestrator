import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsRouter } from '../src/api/settings';
import { DeepSeekHarnessKernel } from '../src/kernel/deepseek-harness-kernel';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';

// Settings normally restarts the shared sidecar after credential changes. The
// contract under test is the next DSH child environment, so keep this test
// hermetic and do not wait for a machine-global sidecar socket to disappear.
let sidecarRestarts = 0;
mock.module('../src/kernel/sidecar-singleton', () => ({
  restartSidecar: async () => { sidecarRestarts++; },
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
  sidecarRestarts = 0;
  root = mkdtempSync(join(tmpdir(), 'fx-dsh-settings-'));
  envFile = join(root, '.env');
  binary = join(root, 'dsh');
  record = join(root, 'child-env.txt');
  writeFileSync(envFile, `FORGEAX_MODEL=${MODEL}\n`);
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n%s\\n%s\' "$DEEPSEEK_API_KEY" "$DEEPSEEK_BASE_URL" "$FORGEAX_MODEL" > "$DSH_TEST_RECORD"\nprintf \'ok\\n\'\n');
  chmodSync(binary, 0o755);
  for (const key of ['LITELLM_PROXY_KEY', 'LITELLM_PROXY_BASE_URL', 'UNLISTED_TEST_SECRET', 'FORGEAX_ENV_FILE', 'FORGEAX_PROJECT_ROOT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'FORGEAX_MODEL', 'DEEPSEEK_HARNESS_CLI_PATH', 'DSH_TEST_RECORD', 'FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS']) SAVED_ENV[key] = process.env[key];
  process.env.FORGEAX_ENV_FILE = envFile;
  process.env.FORGEAX_PROJECT_ROOT = root;
  process.env.FORGEAX_MODEL = MODEL;
  process.env.DEEPSEEK_HARNESS_CLI_PATH = binary;
  process.env.DSH_TEST_RECORD = record;
  process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS = '1';
  delete process.env.LITELLM_PROXY_KEY;
  delete process.env.LITELLM_PROXY_BASE_URL;
  delete process.env.UNLISTED_TEST_SECRET;
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


describe('settings effective runtime credentials', () => {
  async function settings() {
    return await (await createSettingsRouter().fetch(new Request('http://test/'))).json() as { env: Record<string, string | null> };
  }

  test('discovers process-only native credentials without creating a file or exposing secrets', async () => {
    rmSync(envFile);
    process.env.LITELLM_PROXY_KEY = 'native-runtime-secret-fixture';
    process.env.LITELLM_PROXY_BASE_URL = 'https://provider.example.test/v1';
    process.env.UNLISTED_TEST_SECRET = 'must-not-be-returned';
    const payload = await settings();
    expect(payload.env.LITELLM_PROXY_KEY).toBe('nati********ture');
    expect(payload.env.LITELLM_PROXY_BASE_URL).toBe('https://provider.example.test/v1');
    expect(JSON.stringify(payload)).not.toContain('native-runtime-secret-fixture');
    expect(JSON.stringify(payload)).not.toContain('must-not-be-returned');
    expect(payload.env.UNLISTED_TEST_SECRET).toBeUndefined();
    expect(existsSync(envFile)).toBe(false);
  });

  test('process values including explicit empty values win over file fallback', async () => {
    writeFileSync(envFile, 'LITELLM_PROXY_KEY=file-secret-fixture\nLITELLM_PROXY_BASE_URL=https://file.example.test/v1\n');
    expect((await settings()).env.LITELLM_PROXY_KEY).toBe('file********ture');
    process.env.LITELLM_PROXY_KEY = 'runtime-secret-fixture';
    expect((await settings()).env.LITELLM_PROXY_KEY).toBe('runt********ture');
    process.env.LITELLM_PROXY_KEY = '';
    expect((await settings()).env.LITELLM_PROXY_KEY).toBeNull();
  });

  test('clears process-only credentials and saves new values without stale discovery', async () => {
    process.env.LITELLM_PROXY_KEY = 'inherited-secret-fixture';
    const router = createSettingsRouter();
    const put = (value: string) => router.fetch(new Request('http://test/env', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ LITELLM_PROXY_KEY: value }),
    }));
    expect((await put('')).status).toBe(200);
    expect(sidecarRestarts).toBe(1);
    expect(process.env.LITELLM_PROXY_KEY).toBeUndefined();
    expect((await settings()).env.LITELLM_PROXY_KEY).toBeNull();
    expect((await put('new-saved-secret-fixture')).status).toBe(200);
    expect(sidecarRestarts).toBe(2);
    expect((await settings()).env.LITELLM_PROXY_KEY).toBe('new-********ture');
    expect(readFileSync(envFile, 'utf8')).toContain('LITELLM_PROXY_KEY=new-saved-secret-fixture');
    expect((await put('')).status).toBe(200);
    expect(sidecarRestarts).toBe(3);
    expect((await settings()).env.LITELLM_PROXY_KEY).toBeNull();
    expect(readFileSync(envFile, 'utf8')).not.toContain('LITELLM_PROXY_KEY=');
  });
});
