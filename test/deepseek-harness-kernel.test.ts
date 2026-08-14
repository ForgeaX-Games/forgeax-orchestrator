import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { KernelEvent, PermissionMode, TurnRequest } from '@forgeax/agent-runtime';
import { DeepSeekHarnessKernel } from '../src/kernel/deepseek-harness-kernel';
import {
  buildDeepSeekHarnessArgs,
  composeDeepSeekHarnessTask,
  resolveDeepSeekHarnessBinary,
} from '../src/kernel/deepseek-harness-profile';

let root: string;
let binary: string;
let record: string;
const savedEnv: Record<string, string | undefined> = {};

function req(permissionMode: PermissionMode = 'autoEdits'): TurnRequest {
  return {
    callId: 'dsh-test-call',
    session: { threadId: 'thread', agentId: 'forge' },
    input: { text: 'DO THE CURRENT TASK' },
    systemPrompt: {
      charter: 'CHARTER',
      persona: 'PERSONA',
      dynamicSuffix: '## Prior context\nAUTHORITATIVE HISTORY',
    },
    tools: [],
    budget: {},
    permissionMode,
  } as TurnRequest;
}

async function events(kernel: DeepSeekHarnessKernel, request = req(), signal?: AbortSignal): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const event of kernel.runTurn(request, signal ?? new AbortController().signal)) out.push(event);
  return out;
}

function installFake(body: string): void {
  writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  chmodSync(binary, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fx-dsh-kernel-'));
  binary = join(root, 'dsh');
  record = join(root, 'record.txt');
  for (const key of ['DEEPSEEK_HARNESS_CLI_PATH', 'DSH_CLI_PATH', 'FORGEAX_PROJECT_ROOT', 'DSH_TEST_RECORD', 'HOST_TEST_TOKEN']) {
    savedEnv[key] = process.env[key];
  }
  process.env.DEEPSEEK_HARNESS_CLI_PATH = binary;
  process.env.FORGEAX_PROJECT_ROOT = root;
  process.env.DSH_TEST_RECORD = record;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('DeepSeekHarnessKernel public headless contract', () => {
  test('composes charter/persona, current task, then explicitly marked prior context', () => {
    const task = composeDeepSeekHarnessTask(req());
    expect(task).toContain('CHARTER');
    expect(task).toContain('## Persona\n\nPERSONA');
    expect(task).toContain('## Current task\n\nDO THE CURRENT TASK');
    expect(task.indexOf('DO THE CURRENT TASK')).toBeLessThan(task.indexOf('## Prior context'));
    expect(buildDeepSeekHarnessArgs(req())).toEqual(['--profile', 'headless', task]);
  });

  test('success uses canonical argv, project cwd, workspace permission, and ordered final-only events', async () => {
    installFake(`printf '%s\\n' "$PWD" "$1" "$2" "$DSH_PERMISSION_MODE" "$3" > "$DSH_TEST_RECORD"\nprintf 'final answer\\n'`);
    const out = await events(new DeepSeekHarnessKernel());
    const captured = readFileSync(record, 'utf8').split('\n');
    expect(captured.slice(0, 4)).toEqual([realpathSync(root), '--profile', 'headless', 'workspace-write']);
    expect(captured.slice(4).join('\n')).toContain('DO THE CURRENT TASK');
    expect(out).toEqual([
      { kind: 'message.delta', role: 'assistant', text: 'final answer' },
      { kind: 'turn.usage' },
      { kind: 'turn.done', reason: 'stop' },
    ]);
  });

  test('unrestricted maps to danger-full-access', async () => {
    installFake(`printf '%s' "$DSH_PERMISSION_MODE" > "$DSH_TEST_RECORD"\nprintf 'ok\\n'`);
    await events(new DeepSeekHarnessKernel(), req('unrestricted'));
    expect(readFileSync(record, 'utf8')).toBe('danger-full-access');
  });

  test('imported trust scrubs host secrets but restores only required DSH permission fact', async () => {
    process.env.HOST_TEST_TOKEN = 'must-not-leak';
    installFake(`printf '%s|%s' "\${HOST_TEST_TOKEN-unset}" "$DSH_PERMISSION_MODE" > "$DSH_TEST_RECORD"\nprintf 'ok\\n'`);
    await events(new DeepSeekHarnessKernel(), { ...req(), trustTier: 'imported' } as TurnRequest);
    expect(readFileSync(record, 'utf8')).toBe('unset|workspace-write');
  });

  test('nonzero exit does not treat stdout as success and redacts stderr credentials', async () => {
    installFake(`printf 'partial output\\n'\nprintf 'DSH_API_TOKEN=super-secret-value\\n' >&2\nexit 7`);
    const out = await events(new DeepSeekHarnessKernel());
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect(JSON.stringify(out)).not.toContain('partial output');
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
    expect(JSON.stringify(out)).toContain('[REDACTED]');
  });

  test('retains only a bounded stderr tail', async () => {
    installFake(`printf '%05000dTAIL_MARKER\\n' 0 >&2\nexit 9`);
    const out = await events(new DeepSeekHarnessKernel());
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('TAIL_MARKER');
    expect(serialized.length).toBeLessThan(5_000);
  });

  test('zero exit with empty output is an explicit error', async () => {
    installFake(`exit 0`);
    const out = await events(new DeepSeekHarnessKernel());
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect(JSON.stringify(out)).toContain('without a final response');
  });

  test('unsupported permission fails before spawn', async () => {
    installFake(`touch "$DSH_TEST_RECORD"\nprintf 'should not run\\n'`);
    const out = await events(new DeepSeekHarnessKernel(), req('planning'));
    expect(out.map((e) => e.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect(JSON.stringify(out)).toContain('autoEdits, unrestricted');
    expect(() => readFileSync(record)).toThrow();
  });

  test('abort and handle cancellation reap process without also emitting error', async () => {
    installFake(`printf 'started' > "$DSH_TEST_RECORD"\ntrap 'exit 143' TERM\nwhile :; do sleep 1; done`);
    const kernel = new DeepSeekHarnessKernel();
    const running = events(kernel);
    while (true) {
      try { if (readFileSync(record, 'utf8') === 'started') break; } catch { /* wait */ }
      await Bun.sleep(10);
    }
    await kernel.openHandle('dsh-test-call').cancel();
    const out = await running;
    expect(out).toEqual([{ kind: 'turn.usage' }, { kind: 'turn.done', reason: 'cancelled' }]);
  });

  test('binary precedence is primary, alias, then dsh', async () => {
    process.env.DEEPSEEK_HARNESS_CLI_PATH = '/primary/dsh';
    process.env.DSH_CLI_PATH = '/alias/dsh';
    expect(await resolveDeepSeekHarnessBinary()).toBe('/primary/dsh');
    delete process.env.DEEPSEEK_HARNESS_CLI_PATH;
    expect(await resolveDeepSeekHarnessBinary()).toBe('/alias/dsh');
  });

  test('probe is bounded and runs public --version', async () => {
    installFake(`test "$1" = --version || exit 9\nprintf 'dsh-test-version\\n'`);
    const health = await new DeepSeekHarnessKernel().probe();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('dsh-test-version');
  });
});
