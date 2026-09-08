import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from '../src/kernel/codex-appserver-client';

function clientWithStatuses(statuses: unknown[]): CodexAppServerClient {
  const client = new CodexAppServerClient({
    binary: 'codex',
    cwd: process.cwd(),
    onNotification: () => {},
    onServerRequest: () => ({}),
  });
  let index = 0;
  const dispatch = (client as any)._dispatch.bind(client);
  for (const status of statuses) {
    setTimeout(() => dispatch({ method: 'mcpServer/startupStatus/updated', params: status }), ++index * 5);
  }
  Object.defineProperty(client, 'alive', { get: () => true });
  return client;
}

describe('CodexAppServerClient MCP readiness', () => {
  test('waits until every configured local MCP reports thread-scoped ready', async () => {
    const client = clientWithStatuses([
      { threadId: 'thread', name: 'fxt', status: 'ready' },
      { threadId: 'thread', name: 'native', status: 'ready' },
    ]);
    expect(await client.waitForThreadMcpServers('thread', ['native', 'fxt', 'native'], { timeoutMs: 100, pollMs: 10 }))
      .toEqual({ ready: true, pending: [], failed: [] });
  });

  test('returns pending servers at the bounded deadline instead of hanging', async () => {
    const client = clientWithStatuses([{ threadId: 'thread', name: 'native', status: 'starting' }]);
    const started = Date.now();
    const result = await client.waitForThreadMcpServers('thread', ['native'], { timeoutMs: 25, pollMs: 10 });
    expect(result).toEqual({ ready: false, pending: ['native'], failed: [] });
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('settles immediately when an optional local MCP reaches failed', async () => {
    const client = clientWithStatuses([{ threadId: 'thread', name: 'native', status: 'failed' }]);
    const result = await client.waitForThreadMcpServers('thread', ['native'], { timeoutMs: 1_000, pollMs: 10 });
    expect(result).toEqual({ ready: false, pending: [], failed: ['native'] });
  });

  test('keeps waiting when Codex cancels one startup attempt and then retries ready', async () => {
    const client = clientWithStatuses([
      { threadId: 'thread', name: 'native', status: 'cancelled' },
      { threadId: 'thread', name: 'native', status: 'starting' },
      { threadId: 'thread', name: 'native', status: 'ready' },
    ]);
    expect(await client.waitForThreadMcpServers('thread', ['native'], { timeoutMs: 100, pollMs: 10 }))
      .toEqual({ ready: true, pending: [], failed: [] });
  });

  test('aborts before polling when turn admission is cancelled', async () => {
    const client = clientWithStatuses([]);
    const controller = new AbortController();
    controller.abort();
    await expect(client.waitForThreadMcpServers('thread', ['native'], { signal: controller.signal })).rejects.toThrow('cancelled');
  });
});

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function initializeFailureFixture(): { binary: string; globalArgs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-appserver-init-fail-'));
  fixtureDirs.push(dir);
  const script = join(dir, 'codex.mjs');
  writeFileSync(script, `
process.on('SIGTERM', () => process.exit(0));
for await (const line of console) {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'init rejected' } }));
  }
}
`);
  return { binary: process.execPath, globalArgs: [script] };
}

function initializeCmdFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex appserver cmd-'));
  fixtureDirs.push(dir);
  const script = join(dir, 'codex-appserver.mjs');
  writeFileSync(script, `
const expected = JSON.parse(process.env.EXPECTED_CODEX_ARGS ?? '[]');
const actual = process.argv.slice(2);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error('argv mismatch: ' + JSON.stringify(actual));
  process.exit(17);
}
for await (const line of console) {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }));
    setTimeout(() => process.exit(0), 50);
  }
}
`);
  const launcher = join(dir, 'codex.CMD');
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return launcher;
}

function immediateExitFixture(): { binary: string; globalArgs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-appserver-exit-'));
  fixtureDirs.push(dir);
  const script = join(dir, 'codex-exit.mjs');
  writeFileSync(script, `console.error('invalid TOML override from launcher'); process.exit(1);\n`);
  return { binary: process.execPath, globalArgs: [script] };
}

describe('CodexAppServerClient failed initialization lifecycle', () => {
  test('closes its spawned process after initialize rejection', async () => {
    const fixture = initializeFailureFixture();
    const client = new CodexAppServerClient({
      binary: fixture.binary,
      globalArgs: fixture.globalArgs,
      cwd: process.cwd(),
      onNotification: () => {},
      onServerRequest: () => ({}),
    });
    await expect(client.ensureStarted()).rejects.toThrow('init rejected');
    expect(client.alive).toBe(false);
  });

  test('rejects a spawn error promptly instead of waiting for initialize timeout', async () => {
    const client = new CodexAppServerClient({
      binary: join(tmpdir(), `missing-codex-${Date.now()}`),
      cwd: process.cwd(),
      onNotification: () => {},
      onServerRequest: () => ({}),
    });
    const started = Date.now();
    await expect(client.ensureStarted()).rejects.toThrow('spawn failed');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(client.alive).toBe(false);
  });

  test('preserves the stderr tail when app-server exits during initialize', async () => {
    const fixture = immediateExitFixture();
    const client = new CodexAppServerClient({
      binary: fixture.binary,
      globalArgs: fixture.globalArgs,
      cwd: process.cwd(),
      onNotification: () => {},
      onServerRequest: () => ({}),
    });

    await expect(client.ensureStarted()).rejects.toThrow(
      'codex app-server exited (code=1): invalid TOML override from launcher',
    );
    expect(client.alive).toBe(false);
  });
});

describe('CodexAppServerClient Windows launcher', () => {
  test.skipIf(process.platform !== 'win32')('starts app-server through a .CMD launcher', async () => {
    const globalArgs = [
      '--disable',
      'multi_agent',
      '-c',
      String.raw`mcp_servers.fxt.args=["C:\Program Files\ForgeaX\forgeax tools.mjs","A&B"]`,
    ];
    const client = new CodexAppServerClient({
      binary: initializeCmdFixture(),
      cwd: process.cwd(),
      env: { EXPECTED_CODEX_ARGS: JSON.stringify([...globalArgs, 'app-server']) },
      globalArgs,
      onNotification: () => {},
      onServerRequest: () => ({}),
    });

    await client.ensureStarted();
    await client.close();
  });
});
