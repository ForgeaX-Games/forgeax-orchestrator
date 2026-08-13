import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function initializeFailureFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-appserver-init-fail-'));
  fixtureDirs.push(dir);
  const script = join(dir, 'codex');
  writeFileSync(script, `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(0));
for await (const line of console) {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'init rejected' } }));
  }
}
`);
  chmodSync(script, 0o755);
  return script;
}

describe('CodexAppServerClient failed initialization lifecycle', () => {
  test('closes its spawned process after initialize rejection', async () => {
    const client = new CodexAppServerClient({
      binary: initializeFailureFixture(),
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
});
