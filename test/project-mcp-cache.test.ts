import { describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProjectMcpBridge,
  acquireProjectMcpNativeLease,
  discoverProjectMcpTools,
  projectMcpExecutionMode,
  resetProjectMcpPoolForTests,
  shutdownProjectMcpPool,
} from '../src/kernel/project-mcp';

function lines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await waitMs(25);
  }
}

describe.serial('project MCP discovery cache', () => {
  test('backs off an all-failed discovery, then retries the same config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-cache-'));
    const script = join(root, 'mcp-fixture.mjs');
    const marker = join(root, 'failed-once');
    const fixture = String.raw`
import { existsSync, writeFileSync } from 'node:fs';

const marker = process.env.FX_MCP_MARKER;
if (!marker) process.exit(2);
if (!existsSync(marker)) {
  writeFileSync(marker, 'failed-once');
  process.exit(1);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
    } else if (request.id === 2) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'recoverable', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    }
  }
});
`;
    const previousRetry = process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
    try {
      process.env.FORGEAX_PROJECT_MCP_RETRY_MS = '20';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          flaky: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_MARKER: marker },
          },
        },
      }), 'utf8');

      expect(await discoverProjectMcpTools(root)).toEqual([]);
      expect(existsSync(marker)).toBe(true);

      // The short failure backoff prevents every turn from paying another
      // initialize/tools-list timeout while still allowing transient recovery.
      expect(await discoverProjectMcpTools(root)).toEqual([]);
      await waitMs(30);
      await discoverProjectMcpTools(root); // schedules the bounded background retry
      const retryDeadline = Date.now() + 5_000;
      let recovered: Awaited<ReturnType<typeof discoverProjectMcpTools>> = [];
      while (Date.now() < retryDeadline) {
        recovered = await discoverProjectMcpTools(root);
        if (recovered.some((tool) => tool.name === 'mcp__flaky__recoverable')) break;
        await waitMs(100);
      }
      expect(recovered.map((tool) => tool.name)).toEqual(['mcp__flaky__recoverable']);
    } finally {
      resetProjectMcpPoolForTests();
      if (previousRetry === undefined) delete process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
      else process.env.FORGEAX_PROJECT_MCP_RETRY_MS = previousRetry;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('schema-only native discovery closes its child before a host bridge needs one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-schema-only-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FX_MCP_STARTS, String(process.pid) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\n');
    if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'native', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    if (request.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'native-ok' }] } }) + '\n');
  }
});
`;
    try {
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: { native: { command: process.execPath, args: [script], env: { FX_MCP_STARTS: starts } } },
      }), 'utf8');

      expect(projectMcpExecutionMode('claude-code', 'own')).toBe('native');
      expect(await discoverProjectMcpTools(root, { retainPool: false })).toEqual([
        { name: 'mcp__native__native', inputSchema: { type: 'object', properties: {} } },
      ]);
      // Schema-only closes its child; a later host bridge must create its own
      // live client rather than accidentally reusing a native discovery child.
      expect(lines(starts)).toHaveLength(1);
      const bridge = createProjectMcpBridge(root);
      expect(await bridge.callIfKnown('mcp__native__native', {})).toBe('native-ok');
      expect(lines(starts)).toHaveLength(2);
      bridge.close();
    } finally {
      resetProjectMcpPoolForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('native schema discovery releases a prewarmed host pool before returning cached schemas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-native-release-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FX_MCP_STARTS, String(process.pid) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\n');
    if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'shared', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    if (request.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'shared-ok' }] } }) + '\n');
  }
});
`;
    try {
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: { shared: { command: process.execPath, args: [script], env: { FX_MCP_STARTS: starts } } },
      }), 'utf8');

      expect(await discoverProjectMcpTools(root)).toEqual([
        { name: 'mcp__shared__shared', inputSchema: { type: 'object', properties: {} } },
      ]);
      const pid = Number(lines(starts)[0]);
      expect(pid).toBeGreaterThan(0);

      // The native turn uses the prewarmed schema cache, but must release the
      // host-owned process before Claude/Cursor/Kimi mounts its own server.
      expect(await discoverProjectMcpTools(root, { retainPool: false })).toEqual([
        { name: 'mcp__shared__shared', inputSchema: { type: 'object', properties: {} } },
      ]);
      expect(lines(starts)).toHaveLength(1);
      expect(() => process.kill(pid, 0)).toThrow();

      // Once a native provider owns the project config, a host bridge cannot
      // quietly start a second child. It waits for the lease, then starts one
      // host child after the native owner releases it.
      const lease = await acquireProjectMcpNativeLease(root);
      const bridge = createProjectMcpBridge(root);
      let settled = false;
      const pendingCall = bridge.callIfKnown('mcp__shared__shared', {}).then((result) => {
        settled = true;
        return result;
      });
      await waitMs(100);
      expect(settled).toBe(false);
      expect(lines(starts)).toHaveLength(1);
      await lease.release();
      expect(await pendingCall).toBe('shared-ok');
      expect(lines(starts)).toHaveLength(2);
      bridge.close();
    } finally {
      resetProjectMcpPoolForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('native ownership hands off an idle provider without waiting for its TTL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-handoff-'));
    let owner!: Awaited<ReturnType<typeof acquireProjectMcpNativeLease>>;
    let handoffCalls = 0;
    try {
      resetProjectMcpPoolForTests();
      owner = await acquireProjectMcpNativeLease(root, {
        onHandoffRequested: async () => {
          handoffCalls += 1;
          await owner.release();
          return true;
        },
      });

      const next = await acquireProjectMcpNativeLease(root);
      expect(handoffCalls).toBe(1);
      await next.release();
    } finally {
      await owner?.release();
      resetProjectMcpPoolForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('native ownership returns a retryable busy error instead of stealing an active owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-busy-'));
    let owner!: Awaited<ReturnType<typeof acquireProjectMcpNativeLease>>;
    let allowHandoff = false;
    let handoffCalls = 0;
    try {
      resetProjectMcpPoolForTests();
      owner = await acquireProjectMcpNativeLease(root, {
        onHandoffRequested: async () => {
          handoffCalls += 1;
          if (!allowHandoff) return false;
          await owner.release();
          return true;
        },
      });
      await expect(acquireProjectMcpNativeLease(root)).rejects.toThrow(/retry this turn/);
      allowHandoff = true;
      const next = await acquireProjectMcpNativeLease(root);
      expect(handoffCalls).toBe(2);
      await next.release();
    } finally {
      await owner?.release();
      resetProjectMcpPoolForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shutdown re-entry preserves the native handoff callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-shutdown-reentry-'));
    let first!: Awaited<ReturnType<typeof acquireProjectMcpNativeLease>>;
    let second!: Awaited<ReturnType<typeof acquireProjectMcpNativeLease>>;
    let shutdownPromise: Promise<void> | undefined;
    let secondHandoffCalls = 0;
    try {
      resetProjectMcpPoolForTests();
      first = await acquireProjectMcpNativeLease(root, {
        onHandoffRequested: async () => {
          await first.release();
          shutdownPromise = shutdownProjectMcpPool();
          // Keep the shutdown promise observable while the waiting acquire
          // reaches its post-queue admission check.
          await Promise.resolve();
          return true;
        },
      });
      second = await acquireProjectMcpNativeLease(root, {
        onHandoffRequested: async () => {
          secondHandoffCalls += 1;
          await second.release();
          return true;
        },
      });
      await shutdownPromise;

      const third = await acquireProjectMcpNativeLease(root);
      expect(secondHandoffCalls).toBe(1);
      await third.release();
    } finally {
      await second?.release();
      await first?.release();
      await shutdownPromise;
      await shutdownProjectMcpPool();
      resetProjectMcpPoolForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a discovery waiting for native ownership cannot spawn after shutdown completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-shutdown-admission-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FX_MCP_STARTS, String(process.pid) + '\n');
process.stdin.resume();
`;
    let resolveHandoffCalled!: () => void;
    const handoffCalled = new Promise<void>((resolve) => { resolveHandoffCalled = resolve; });
    let releaseHandoff!: (value: boolean) => void;
    const handoffGate = new Promise<boolean>((resolve) => { releaseHandoff = resolve; });
    let owner!: Awaited<ReturnType<typeof acquireProjectMcpNativeLease>>;
    try {
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: { late: { command: process.execPath, args: [script], env: { FX_MCP_STARTS: starts } } },
      }), 'utf8');
      owner = await acquireProjectMcpNativeLease(root, {
        onHandoffRequested: async () => {
          resolveHandoffCalled();
          return handoffGate;
        },
      });

      const pendingDiscovery = discoverProjectMcpTools(root);
      await handoffCalled;
      await shutdownProjectMcpPool();
      releaseHandoff(true);
      await owner.release();

      expect(await pendingDiscovery).toEqual([]);
      expect(lines(starts)).toEqual([]);
    } finally {
      releaseHandoff?.(true);
      await owner?.release();
      await shutdownProjectMcpPool();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('schema-only failure backoff performs a real background retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-schema-retry-'));
    const script = join(root, 'mcp-fixture.mjs');
    const marker = join(root, 'ready');
    const starts = join(root, 'starts.log');
    const fixture = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(process.env.FX_MCP_STARTS, 'start\n');
if (!existsSync(process.env.FX_MCP_READY)) process.exit(1);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\n');
    if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'recovered', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
  }
});
`;
    const previousRetry = process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
    try {
      process.env.FORGEAX_PROJECT_MCP_RETRY_MS = '20';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          retryable: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_READY: marker, FX_MCP_STARTS: starts },
          },
        },
      }), 'utf8');

      expect(await discoverProjectMcpTools(root, { retainPool: false })).toEqual([]);
      writeFileSync(marker, 'ready');
      await waitMs(30);
      // This call returns the stale schema immediately and launches the actual
      // refresh in the background; it must not recurse into the cache branch.
      expect(await discoverProjectMcpTools(root, { retainPool: false })).toEqual([]);
      const retryDeadline = Date.now() + 2_500;
      let recovered: Awaited<ReturnType<typeof discoverProjectMcpTools>> = [];
      while (Date.now() < retryDeadline) {
        await waitMs(100);
        recovered = await discoverProjectMcpTools(root, { retainPool: false });
        if (recovered.some((tool) => tool.name === 'mcp__retryable__recovered')) break;
      }
      expect(recovered).toEqual([
        { name: 'mcp__retryable__recovered', inputSchema: { type: 'object', properties: {} } },
      ]);
      expect(lines(starts)).toHaveLength(2);
    } finally {
      resetProjectMcpPoolForTests();
      if (previousRetry === undefined) delete process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
      else process.env.FORGEAX_PROJECT_MCP_RETRY_MS = previousRetry;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('execution mode keeps native and host providers explicit', () => {
    expect(projectMcpExecutionMode('claude-code', 'own')).toBe('native');
    expect(projectMcpExecutionMode('cursor-agent', 'own')).toBe('native');
    expect(projectMcpExecutionMode('kimi-code', 'own')).toBe('native');
    expect(projectMcpExecutionMode('codebuddy', 'own')).toBe('host');
    expect(projectMcpExecutionMode('codex', 'own')).toBe('host');
    expect(projectMcpExecutionMode('claude-code', 'imported')).toBe('host');
  });

  test('retains healthy servers when another configured server is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-partial-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FX_MCP_STARTS, process.env.FX_MCP_NAME + '\n');
if (process.env.FX_MCP_FAIL === '1') process.exit(1);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'healthy', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    }
  }
});
`;
    try {
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          healthy: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'healthy' },
          },
          unavailable: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'unavailable', FX_MCP_FAIL: '1' },
          },
        },
      }), 'utf8');

      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__healthy__healthy']);
      // A failed unrelated server must not force the healthy server through a
      // second initialize/tools-list handshake on the next turn.
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__healthy__healthy']);
      const started = readFileSync(starts, 'utf8').split('\n').filter(Boolean);
      expect(started).toHaveLength(2);
      expect(started).toContain('healthy');
      expect(started).toContain('unavailable');
    } finally {
      resetProjectMcpPoolForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reuses a healthy MCP client, expires it by idle TTL, and rebuilds on config change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-pool-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const calls = join(root, 'calls.log');
    const previousTtl = process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS;
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FX_MCP_STARTS, String(process.pid) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'pooled', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    } else if (request.method === 'tools/call') {
      appendFileSync(process.env.FX_MCP_CALLS, request.params.name + '\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'pooled-ok' }] } }) + '\n');
    }
  }
});
`;
    try {
      process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS = '1000';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      const writeConfig = (label: string) => writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          pooled: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_CALLS: calls, FX_MCP_LABEL: label },
          },
        },
      }), 'utf8');
      writeConfig('one');

      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__pooled__pooled']);
      expect(lines(starts)).toHaveLength(1);
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__pooled__pooled']);
      expect(lines(starts)).toHaveLength(1);

      const bridge = createProjectMcpBridge(root);
      expect(await bridge.callIfKnown('mcp__pooled__pooled', {})).toBe('pooled-ok');
      expect(lines(starts)).toHaveLength(1);
      expect(lines(calls)).toEqual(['pooled']);

      await waitMs(1200);
      // Expiration keeps the schema cache but releases the child process.
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__pooled__pooled']);
      expect(lines(starts)).toHaveLength(1);
      expect(await bridge.callIfKnown('mcp__pooled__pooled', {})).toBe('pooled-ok');
      expect(lines(starts)).toHaveLength(2);

      writeConfig('two');
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__pooled__pooled']);
      expect(lines(starts)).toHaveLength(3);
      bridge.close();
    } finally {
      resetProjectMcpPoolForTests();
      if (previousTtl === undefined) delete process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS;
      else process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS = previousTtl;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers a partial catalog after idle eviction without losing healthy schemas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-recovery-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const ready = join(root, 'flaky-ready');
    const previousTtl = process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS;
    const previousRetry = process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
    const fixture = String.raw`
import { appendFileSync, existsSync } from 'node:fs';

appendFileSync(process.env.FX_MCP_STARTS, process.env.FX_MCP_NAME + '\n');
if (process.env.FX_MCP_FAIL_UNTIL && !existsSync(process.env.FX_MCP_FAIL_UNTIL)) process.exit(1);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: process.env.FX_MCP_NAME, inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    }
  }
});
`;
    try {
      process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS = '50';
      process.env.FORGEAX_PROJECT_MCP_RETRY_MS = '20';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          healthy: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'healthy' },
          },
          flaky: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'flaky', FX_MCP_FAIL_UNTIL: ready },
          },
        },
      }), 'utf8');

      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__healthy__healthy']);
      writeFileSync(ready, 'ready');
      // Let the live pool expire. The schema cache must still remember that
      // flaky was missing and rebuild it in the background on the next turn.
      await waitMs(90);
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__healthy__healthy']);
      const recoveryDeadline = Date.now() + 2_500;
      let recovered: Awaited<ReturnType<typeof discoverProjectMcpTools>> = [];
      while (Date.now() < recoveryDeadline) {
        await waitMs(100);
        recovered = await discoverProjectMcpTools(root);
        if (recovered.some((tool) => tool.name === 'mcp__flaky__flaky')) break;
      }
      expect(recovered.map((tool) => tool.name).sort()).toEqual([
        'mcp__flaky__flaky',
        'mcp__healthy__healthy',
      ]);
      const started = lines(starts);
      expect(started.filter((name) => name === 'healthy')).toHaveLength(2);
      expect(started.filter((name) => name === 'flaky')).toHaveLength(2);
    } finally {
      resetProjectMcpPoolForTests();
      if (previousTtl === undefined) delete process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS;
      else process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS = previousTtl;
      if (previousRetry === undefined) delete process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
      else process.env.FORGEAX_PROJECT_MCP_RETRY_MS = previousRetry;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('isolates a crashed server and keeps its healthy sibling pooled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-crash-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const previousRetry = process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FX_MCP_STARTS, process.env.FX_MCP_NAME + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: process.env.FX_MCP_NAME, inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
      if (process.env.FX_MCP_EXIT_AFTER_LIST === '1') setTimeout(() => process.exit(1), 20);
    }
  }
});
`;
    try {
      process.env.FORGEAX_PROJECT_MCP_RETRY_MS = '100000';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          stable: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'stable' },
          },
          crashy: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'crashy', FX_MCP_EXIT_AFTER_LIST: '1' },
          },
        },
      }), 'utf8');

      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name).sort()).toEqual([
        'mcp__crashy__crashy',
        'mcp__stable__stable',
      ]);
      await waitMs(100);
      expect(await discoverProjectMcpTools(root)).toEqual([
        { name: 'mcp__stable__stable', inputSchema: { type: 'object', properties: {} } },
      ]);
      expect(lines(starts).sort()).toEqual(['crashy', 'stable']);
    } finally {
      resetProjectMcpPoolForTests();
      if (previousRetry === undefined) delete process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
      else process.env.FORGEAX_PROJECT_MCP_RETRY_MS = previousRetry;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('drains an in-flight tool call before retiring a pool on config change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-drain-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const calls = join(root, 'calls.log');
    const release = join(root, 'release-call');
    const previousTtl = process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS;
    const fixture = String.raw`
import { appendFileSync, existsSync } from 'node:fs';

appendFileSync(process.env.FX_MCP_STARTS, process.env.FX_MCP_LABEL + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'pooled', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    } else if (request.method === 'tools/call') {
      appendFileSync(process.env.FX_MCP_CALLS, process.env.FX_MCP_LABEL + '\n');
      const finish = () => {
        if (!existsSync(process.env.FX_MCP_RELEASE)) return setTimeout(finish, 5);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: process.env.FX_MCP_LABEL + '-ok' }] } }) + '\n');
      };
      finish();
    }
  }
});
`;
    try {
      process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS = '10000';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      const writeConfig = (label: string) => writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          pooled: {
            command: process.execPath,
            args: [script],
            env: {
              FX_MCP_STARTS: starts,
              FX_MCP_CALLS: calls,
              FX_MCP_RELEASE: release,
              FX_MCP_LABEL: label,
            },
          },
        },
      }), 'utf8');
      writeConfig('one');
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__pooled__pooled']);
      const bridge = createProjectMcpBridge(root);
      const call = bridge.callIfKnown('mcp__pooled__pooled', {});
      await waitMs(80);
      expect(lines(calls)).toEqual(['one']);

      writeConfig('two');
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name)).toEqual(['mcp__pooled__pooled']);
      expect(lines(starts)).toEqual(['one', 'two']);
      writeFileSync(release, 'release');
      expect(await call).toBe('one-ok');
      bridge.close();
    } finally {
      resetProjectMcpPoolForTests();
      if (previousTtl === undefined) delete process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS;
      else process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS = previousTtl;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bounds a hung JSON-RPC call, reaps only that server, and backs off its retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-hung-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const previousRetry = process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FX_MCP_STARTS, process.env.FX_MCP_NAME + ':' + process.pid + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: process.env.FX_MCP_NAME, inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    } else if (request.method === 'tools/call' && process.env.FX_MCP_NAME !== 'hung') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'stable-ok' }] } }) + '\n');
    }
  }
});
`;
    try {
      process.env.FORGEAX_PROJECT_MCP_RETRY_MS = '100000';
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          stable: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'stable' },
          },
          hung: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_NAME: 'hung' },
          },
        },
      }), 'utf8');

      const bridge = createProjectMcpBridge(root);
      expect((await discoverProjectMcpTools(root)).map((tool) => tool.name).sort()).toEqual([
        'mcp__hung__hung',
        'mcp__stable__stable',
      ]);
      const pids = new Map(lines(starts).map((line) => {
        const [name, pid] = line.split(':');
        return [name, Number(pid)] as const;
      }));
      const stablePid = pids.get('stable');
      const hungPid = pids.get('hung');
      expect(stablePid).toBeGreaterThan(0);
      expect(hungPid).toBeGreaterThan(0);

      const startedAt = Date.now();
      await expect(bridge.callIfKnown('mcp__hung__hung', {})).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_500);
      expect(await waitForExit(hungPid!)).toBe(true);

      // The timed-out child is removed from the pool; its healthy sibling is
      // still the live owner and must answer immediately without a full
      // project discovery or a second hung-server launch.
      expect(await bridge.callIfKnown('mcp__stable__stable', {})).toBe('stable-ok');
      expect(() => process.kill(stablePid!, 0)).not.toThrow();
      expect(await bridge.callIfKnown('mcp__hung__hung', {})).toBeUndefined();
      expect(lines(starts)).toHaveLength(2);
      bridge.close();
    } finally {
      resetProjectMcpPoolForTests();
      if (previousRetry === undefined) delete process.env.FORGEAX_PROJECT_MCP_RETRY_MS;
      else process.env.FORGEAX_PROJECT_MCP_RETRY_MS = previousRetry;
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 15_000 });

  test('shutdown reaps both the current pool and a retiring in-flight pool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-project-mcp-shutdown-'));
    const script = join(root, 'mcp-fixture.mjs');
    const starts = join(root, 'starts.log');
    const release = join(root, 'release-call');
    const fixture = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(process.env.FX_MCP_STARTS, String(process.pid) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\n');
    if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'held', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    if (request.method === 'tools/call' && existsSync(process.env.FX_MCP_RELEASE)) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'released' }] } }) + '\n');
  }
});
`;
    try {
      resetProjectMcpPoolForTests();
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(script, fixture, 'utf8');
      const writeConfig = (version: number) => writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: {
          held: {
            command: process.execPath,
            args: [script],
            env: { FX_MCP_STARTS: starts, FX_MCP_RELEASE: release },
            version,
          },
        },
      }), 'utf8');
      writeConfig(1);
      expect(await discoverProjectMcpTools(root)).toHaveLength(1);
      const bridge = createProjectMcpBridge(root);
      const inFlight = bridge.callIfKnown('mcp__held__held', {}).catch(() => undefined);
      await waitMs(60);
      writeConfig(2);
      expect(await discoverProjectMcpTools(root)).toHaveLength(1);
      const pids = lines(starts).map(Number);
      expect(pids.length).toBe(2);
      await shutdownProjectMcpPool();
      await inFlight; // shutdown intentionally rejects the call
      for (const pid of pids) {
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        expect(alive).toBe(false);
      }
      bridge.close();
    } finally {
      await shutdownProjectMcpPool();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
