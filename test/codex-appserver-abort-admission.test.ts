import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';
import { CodexKernel } from '../src/kernel/codex-kernel';
import { deriveThreadId } from '../src/lib/thread-id';

const dirs: string[] = [];
const prior = {
  home: process.env.CODEX_HOME,
  binary: process.env.CODEX_CLI_PATH,
  control: process.env.FAKE_CODEX_CONTROL,
  log: process.env.FAKE_CODEX_LOG,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('CODEX_HOME', prior.home);
  restore('CODEX_CLI_PATH', prior.binary);
  restore('FAKE_CODEX_CONTROL', prior.control);
  restore('FAKE_CODEX_LOG', prior.log);
});

function fixture(): { log: string; control: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-abort-admission-'));
  dirs.push(dir);
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), 'model = "fixture"\n');
  const log = join(dir, 'calls.log');
  const control = join(dir, 'control.txt');
  writeFileSync(log, '');
  writeFileSync(control, '');
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.143.0'); process.exit(0); }
const log = process.env.FAKE_CODEX_LOG;
const control = process.env.FAKE_CODEX_CONTROL;
const emit = (value) => console.log(JSON.stringify(value));
const mode = () => { try { return readFileSync(control, 'utf8').trim(); } catch { return ''; } };
if (process.argv.includes('exec')) {
  appendFileSync(log, 'exec\\n');
  appendFileSync(log, 'exec-args:' + JSON.stringify(process.argv.slice(2)) + '\\n');
  emit({ type: 'thread.started', thread_id: 'fixture-exec-thread' });
  emit({ type: 'item.completed', item: { id: 'exec-message', type: 'agent_message', text: 'exec-ok' } });
  emit({ type: 'turn.completed', usage: {} });
  process.exit(0);
}
process.on('SIGTERM', () => process.exit(0));
for await (const line of console) {
  const req = JSON.parse(line);
  appendFileSync(log, req.method + '\\n');
  if (req.method === 'initialize') {
    if (mode() === 'initialize-fail') emit({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'fixture initialize failure' } });
    else emit({ jsonrpc: '2.0', id: req.id, result: { userAgent: 'fixture' } });
  }
  else if (req.method === 'thread/start') {
    if (mode() === 'thread/start') await Bun.sleep(250);
    emit({ jsonrpc: '2.0', id: req.id, result: { thread: { id: 'fixture-thread' } } });
    emit({ method: 'mcpServer/startupStatus/updated', params: { threadId: 'fixture-thread', name: 'fxt', status: 'starting' } });
    appendFileSync(log, 'readiness\\n');
    if (mode() === 'readiness') await Bun.sleep(250);
    emit({ method: 'mcpServer/startupStatus/updated', params: { threadId: 'fixture-thread', name: 'fxt', status: mode() === 'fxt-failed' ? 'failed' : 'ready' } });
  } else if (req.method === 'thread/resume') {
    if (mode() === 'thread/resume') await Bun.sleep(250);
    emit({ jsonrpc: '2.0', id: req.id, result: { thread: { id: 'fixture-thread' } } });
  } else if (req.method === 'turn/start') {
    emit({ jsonrpc: '2.0', id: req.id, result: { turn: { id: 'fixture-turn' } } });
    emit({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
  }
}
`);
  chmodSync(binary, 0o755);
  process.env.CODEX_HOME = home;
  process.env.CODEX_CLI_PATH = binary;
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_CONTROL = control;
  return { log, control };
}

function req(sessionId: string): TurnRequest {
  return {
    session: { threadId: deriveThreadId(sessionId, 'forge'), agentId: 'forge' },
    hostSessionId: sessionId,
    input: { text: 'MUST_NOT_SEND' },
    systemPrompt: { charter: 'fixture', persona: '', mode: 'replace' },
    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    budget: {},
    trustTier: 'own',
  };
}

async function waitFor(log: string, marker: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (readFileSync(log, 'utf8').split('\n').includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fixture never reached ${marker}`);
}

async function abortAt(kernel: CodexKernel, request: TurnRequest, log: string, marker: string): Promise<KernelEvent[]> {
  const controller = new AbortController();
  const events: KernelEvent[] = [];
  const consuming = (async () => {
    for await (const event of kernel.runTurn(request, controller.signal)) events.push(event);
  })();
  await waitFor(log, marker);
  controller.abort();
  await consuming;
  return events;
}

describe('Codex app-server cancellation admission', () => {
  test('abort while thread/start awaits never submits turn/start', async () => {
    const fx = fixture();
    writeFileSync(fx.control, 'thread/start');
    const events = await abortAt(new CodexKernel(), req(randomUUID()), fx.log, 'thread/start');
    expect(readFileSync(fx.log, 'utf8').match(/^turn\/start$/gm)).toBeNull();
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'cancelled' });
  });

  test('abort while MCP readiness awaits never submits turn/start', async () => {
    const fx = fixture();
    writeFileSync(fx.control, 'readiness');
    const events = await abortAt(new CodexKernel(), req(randomUUID()), fx.log, 'readiness');
    expect(readFileSync(fx.log, 'utf8').match(/^turn\/start$/gm)).toBeNull();
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'cancelled' });
  });

  test('abort while thread/resume awaits never submits turn/start', async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    const request = req(sessionId);
    const kernel = new CodexKernel();
    expect((await kernel.prewarm(request)).warmed).toBe(true);
    // Simulate a persisted thread being loaded by this process rather than the
    // just-created prewarm thread; this selects the real resume branch.
    (kernel as any).appThreadOwnerMap.delete(request.session.threadId);
    writeFileSync(fx.control, 'thread/resume');
    appendFileSync(fx.log, 'resume-test-start\n');
    const events = await abortAt(kernel, request, fx.log, 'thread/resume');
    const after = readFileSync(fx.log, 'utf8').split('resume-test-start\n')[1] ?? '';
    expect(after.match(/^turn\/start$/gm)).toBeNull();
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'cancelled' });
  });

  test('process replacement rejects a delta before creating a blank native thread', async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    const request = req(sessionId);
    (request as any).historyPlan = { mode: 'delta' };
    const kernel = new CodexKernel();
    const tid = request.session.threadId;
    (kernel as any).appThreadIdMap.set(tid, 'old-native-thread');
    (kernel as any).appThreadOwnerMap.set(tid, {});

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);

    expect(readFileSync(fx.log, 'utf8').match(/^thread\/start$/gm)).toBeNull();
    expect(readFileSync(fx.log, 'utf8').match(/^turn\/start$/gm)).toBeNull();
    expect(events.find((event) => event.kind === 'error')).toEqual({
      kind: 'error',
      error: { code: 'protocol', message: 'codex native process changed; retry to synchronize a fresh history snapshot' },
    });
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'error' });
  });

  test('required fxt startup failure never submits a tool-less model turn', async () => {
    const fx = fixture();
    writeFileSync(fx.control, 'fxt-failed');
    const events: KernelEvent[] = [];
    for await (const event of new CodexKernel().runTurn(req(randomUUID()), new AbortController().signal)) {
      events.push(event);
    }
    expect(readFileSync(fx.log, 'utf8').match(/^turn\/start$/gm)).toBeNull();
    expect(events.find((event) => event.kind === 'error')).toEqual({
      kind: 'error',
      error: {
        code: 'protocol',
        message: 'codex_mcp_unavailable: required fxt server did not become ready; retry without losing tool capability',
      },
    });
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'error' });
  });

  test('delta for an established exec session stays on exec instead of starting a blank app-server thread', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    request.tools = [];
    (request as any).historyPlan = { mode: 'delta' };
    const transports: string[] = [];
    const kernel = new CodexKernel({ onTransportSelected: (transport) => transports.push(transport) });
    (kernel as any).threadIdMap.set(request.session.threadId, 'existing-exec-thread');

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);

    expect(transports).toEqual(['exec']);
    expect(readFileSync(fx.log, 'utf8').match(/^thread\/start$/gm)).toBeNull();
    expect(readFileSync(fx.log, 'utf8').match(/^exec$/gm)).toHaveLength(1);
    expect(events.find((event) => event.kind === 'message.delta')).toEqual({
      kind: 'message.delta', role: 'assistant', text: 'exec-ok',
    });
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'stop' });
  });

  test('history mode none for an established exec session also stays on exec', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    request.tools = [];
    (request as any).historyPlan = { mode: 'none' };
    const transports: string[] = [];
    const kernel = new CodexKernel({ onTransportSelected: (transport) => transports.push(transport) });
    (kernel as any).threadIdMap.set(request.session.threadId, 'existing-exec-thread');

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);

    expect(transports).toEqual(['exec']);
    expect(readFileSync(fx.log, 'utf8').match(/^thread\/start$/gm)).toBeNull();
    expect(readFileSync(fx.log, 'utf8').match(/^exec$/gm)).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'stop' });
  });

  test('prewarm never creates an empty app-server thread for an exec-owned session', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    const kernel = new CodexKernel();
    (kernel as any).threadIdMap.set(request.session.threadId, 'existing-exec-thread');

    expect(await kernel.prewarm(request)).toEqual({ warmed: false, reused: false });
    expect(readFileSync(fx.log, 'utf8')).toBe('');
    expect((kernel as any).appThreadIdMap.has(request.session.threadId)).toBe(false);
  });

  test('successful snapshot migration leaves app-server as the only native owner', async () => {
    fixture();
    const request = req(randomUUID());
    request.tools = [];
    (request as any).historyPlan = { mode: 'snapshot' };
    const kernel = new CodexKernel();
    (kernel as any).threadIdMap.set(request.session.threadId, 'exec-before-snapshot');

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);

    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'stop' });
    expect((kernel as any).threadIdMap.has(request.session.threadId)).toBe(false);
    expect((kernel as any).appThreadIdMap.get(request.session.threadId)).toBe('fixture-thread');
  });

  test('consumer return immediately after turn.done keeps the healthy app-server reusable', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    request.tools = [];
    const kernel = new CodexKernel();

    expect((await kernel.prewarm(request)).warmed).toBe(true);
    const first = kernel.runTurn(request, new AbortController().signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await first.next();
      if (next.done || next.value.kind === 'turn.done') break;
    }
    // The product SSE bridge stops at its terminal frame and invokes return()
    // instead of asking the kernel iterator for one more item.
    await first.return?.();

    appendFileSync(fx.log, 'second-after-terminal-return\n');
    const secondEvents: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) secondEvents.push(event);
    const after = readFileSync(fx.log, 'utf8').split('second-after-terminal-return\n')[1] ?? '';

    expect(after.match(/^thread\/start$/gm)).toBeNull();
    expect(after.match(/^turn\/start$/gm)).toHaveLength(1);
    expect(secondEvents.find((event) => event.kind === 'error')).toBeUndefined();
    expect(secondEvents.at(-1)).toEqual({ kind: 'turn.done', reason: 'stop' });
  });

  test('replacement of a compatibility dual owner rejects none history without starting a thread', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    request.tools = [];
    (request as any).historyPlan = { mode: 'none' };
    const kernel = new CodexKernel();
    const tid = request.session.threadId;
    (kernel as any).threadIdMap.set(tid, 'stale-exec-thread');
    (kernel as any).appThreadIdMap.set(tid, 'stale-app-thread');
    (kernel as any).appThreadOwnerMap.set(tid, {});

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);

    expect(readFileSync(fx.log, 'utf8').match(/^thread\/start$/gm)).toBeNull();
    expect(readFileSync(fx.log, 'utf8').match(/^turn\/start$/gm)).toBeNull();
    expect(events.find((event) => event.kind === 'error')).toEqual({
      kind: 'error',
      error: { code: 'protocol', message: 'codex native process changed; retry to synchronize a fresh history snapshot' },
    });
    expect((kernel as any).threadIdMap.has(tid)).toBe(false);
    expect((kernel as any).appThreadIdMap.has(tid)).toBe(false);
  });

  test('prewarm on a replaced compatibility dual owner does not create a thread', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    const kernel = new CodexKernel();
    const tid = request.session.threadId;
    (kernel as any).threadIdMap.set(tid, 'stale-exec-thread');
    (kernel as any).appThreadIdMap.set(tid, 'stale-app-thread');
    (kernel as any).appThreadOwnerMap.set(tid, {});

    expect(await kernel.prewarm(request)).toEqual({ warmed: false, reused: false });
    expect(readFileSync(fx.log, 'utf8').match(/^thread\/start$/gm)).toBeNull();
    expect((kernel as any).threadIdMap.has(tid)).toBe(false);
    expect((kernel as any).appThreadIdMap.has(tid)).toBe(false);
  });

  test('snapshot fallback starts a fresh exec thread instead of resuming the old owner', async () => {
    const fx = fixture();
    writeFileSync(fx.control, 'initialize-fail');
    const request = req(randomUUID());
    request.tools = [];
    (request as any).historyPlan = { mode: 'snapshot' };
    const kernel = new CodexKernel();
    const tid = request.session.threadId;
    (kernel as any).threadIdMap.set(tid, 'exec-before-snapshot');

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);
    const argsLine = readFileSync(fx.log, 'utf8').split('\n').find((line) => line.startsWith('exec-args:'))!;
    const args = JSON.parse(argsLine.slice('exec-args:'.length)) as string[];

    expect(args).not.toContain('resume');
    expect(args).not.toContain('exec-before-snapshot');
    expect((kernel as any).threadIdMap.get(tid)).toBe('fixture-exec-thread');
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'stop' });
  });

  test('reused app-server thread with failed fxt never submits turn/start', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    const kernel = new CodexKernel();
    expect((await kernel.prewarm(request)).warmed).toBe(true);
    const client = (kernel as any).appThreadOwnerMap.get(request.session.threadId);
    client._dispatch({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'fixture-thread', name: 'fxt', status: 'failed' },
    });
    appendFileSync(fx.log, 'reused-failed-start\n');

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);
    const after = readFileSync(fx.log, 'utf8').split('reused-failed-start\n')[1] ?? '';

    expect(after.match(/^turn\/start$/gm)).toBeNull();
    expect(events.find((event) => event.kind === 'error')).toEqual({
      kind: 'error',
      error: {
        code: 'protocol',
        message: 'codex_mcp_unavailable: required fxt server did not become ready; retry without losing tool capability',
      },
    });
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'error' });
  });

  test('reused app-server thread waits through cancelled fxt retry and submits exactly one turn', async () => {
    const fx = fixture();
    const request = req(randomUUID());
    const kernel = new CodexKernel();
    expect((await kernel.prewarm(request)).warmed).toBe(true);
    const client = (kernel as any).appThreadOwnerMap.get(request.session.threadId);
    client._dispatch({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'fixture-thread', name: 'fxt', status: 'cancelled' },
    });
    appendFileSync(fx.log, 'reused-retry-start\n');
    setTimeout(() => {
      client._dispatch({
        method: 'mcpServer/startupStatus/updated',
        params: { threadId: 'fixture-thread', name: 'fxt', status: 'starting' },
      });
      client._dispatch({
        method: 'mcpServer/startupStatus/updated',
        params: { threadId: 'fixture-thread', name: 'fxt', status: 'ready' },
      });
    }, 20);

    const events: KernelEvent[] = [];
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);
    const after = readFileSync(fx.log, 'utf8').split('reused-retry-start\n')[1] ?? '';

    expect(after.match(/^turn\/start$/gm)).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn.done', reason: 'stop' });
  });
});
