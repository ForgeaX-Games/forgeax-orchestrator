import { describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeSessionCancelledError,
  ClaudeSessionPool,
  claudeNativeSourceFingerprint,
  claudeSessionEligible,
} from '../src/kernel/claude-session-pool';
import { createDirectClaudeTransport } from '../src/kernel/claude-session-transport';
import type { ClaudeSessionTransport } from '../src/kernel/claude-session-pool';

function countLines(path: string): number {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

async function waitForLineCount(path: string, expected: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (countLines(path) < expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (countLines(path) < expected) throw new Error(`timed out waiting for ${expected} lines in ${path}`);
}

async function collect<T>(lines: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

let nextFakePid = 50_000;

function createFakeTransport(
  initialize: 'success' | 'error' | 'timeout' | 'exit',
  onClose: () => void,
): ClaudeSessionTransport {
  const dataCbs = new Set<(stream: 'stdout' | 'stderr', chunk: string) => void>();
  const exitCbs = new Set<(info: { code: number; signal?: string; error?: Error }) => void>();
  let closed = false;
  const emit = (value: unknown): void => {
    const chunk = `${JSON.stringify(value)}\n`;
    for (const cb of dataCbs) cb('stdout', chunk);
  };
  const emitExit = (code: number, error?: Error): void => {
    if (closed) return;
    closed = true;
    onClose();
    for (const cb of exitCbs) cb({ code, ...(error ? { error } : {}) });
  };
  return {
    pid: nextFakePid++,
    write(data) {
      if (closed) throw new Error('fake transport is closed');
      const request = JSON.parse(data) as { type?: string; request_id?: string };
      if (request.type === 'control_request') {
        if (initialize === 'timeout') return;
        if (initialize === 'exit') {
          emitExit(17, new Error('fixture transport exited'));
          return;
        }
        emit({
          type: 'control_response',
          response: {
            subtype: initialize === 'error' ? 'error' : 'success',
            request_id: request.request_id,
            ...(initialize === 'error' ? { error: 'fixture initialize failed' } : {}),
          },
        });
        return;
      }
      if (request.type === 'user') emit({ type: 'result', result: 'RECOVERED', stop_reason: 'end_turn' });
    },
    onData(cb) { dataCbs.add(cb); return () => dataCbs.delete(cb); },
    onExit(cb) { exitCbs.add(cb); return () => exitCbs.delete(cb); },
    async close() {
      if (closed) return;
      emitExit(-1, new Error('fake transport closed'));
    },
  };
}

describe('Claude stream-json session pool', () => {
  test('keeps own dynamic context eligible and keeps imported turns cold', () => {
    expect(claudeSessionEligible({ trustTier: 'own' })).toBe(true);
    expect(claudeSessionEligible({ trustTier: 'own' })).toBe(true);
    expect(claudeSessionEligible({ trustTier: 'imported' })).toBe(false);
  });

  test('external native capability epoch changes the session fingerprint', () => {
    const previous = process.env.FORGEAX_CLAUDE_NATIVE_FINGERPRINT;
    try {
      process.env.FORGEAX_CLAUDE_NATIVE_FINGERPRINT = 'epoch-a';
      const first = claudeNativeSourceFingerprint('/tmp/forgeax-session-pool-test');
      process.env.FORGEAX_CLAUDE_NATIVE_FINGERPRINT = 'epoch-b';
      const second = claudeNativeSourceFingerprint('/tmp/forgeax-session-pool-test');
      expect(second).not.toBe(first);
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_CLAUDE_NATIVE_FINGERPRINT;
      else process.env.FORGEAX_CLAUDE_NATIVE_FINGERPRINT = previous;
    }
  });

  test('follows symlinked native capability targets when fingerprinting', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-claude-native-link-'));
    const target = mkdtempSync(join(tmpdir(), 'forgeax-claude-native-target-'));
    const linkedSkills = join(root, '.claude', 'skills');
    try {
      mkdirSync(linkedSkills, { recursive: true });
      writeFileSync(join(target, 'SKILL.md'), 'version-one', 'utf8');
      symlinkSync(target, join(linkedSkills, 'linked-skill'), 'dir');

      const first = claudeNativeSourceFingerprint(root);
      writeFileSync(join(target, 'SKILL.md'), 'version-two-with-a-different-size', 'utf8');
      const second = claudeNativeSourceFingerprint(root);

      expect(second).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('reuses one process across turns and replaces it when the capability key changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-claude-session-pool-'));
    const script = join(root, 'fixture.mjs');
    const starts = join(root, 'starts.log');
    const fixture = String.raw`
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FX_STARTS, String(process.pid) + '\n');
let buffer = '';
let turn = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === 'control_request') {
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id, response: { commands: [] } },
      }) + '\n');
      continue;
    }
    if (request.type !== 'user') continue;
    turn += 1;
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-session' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: turn === 1 ? 'FIRST' : 'SECOND', stop_reason: 'end_turn' }) + '\n');
  }
});
`;
    const previousTtl = process.env.FORGEAX_CLAUDE_SESSION_IDLE_TTL_MS;
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    const make = (key: string) => pool.acquire('thread-1', key, async () => createDirectClaudeTransport({
      cmd: process.execPath,
      args: [script],
      cwd: root,
      envOverride: { FX_STARTS: starts },
    }));
    try {
      process.env.FORGEAX_CLAUDE_SESSION_IDLE_TTL_MS = '1000';
      mkdirSync(root, { recursive: true });
      writeFileSync(script, fixture, 'utf8');

      const first = await make('capability-a');
      const firstTurn = await first.session.execute('FIRST', new AbortController().signal);
      const firstLines = await collect(firstTurn.lines);
      expect(firstLines.some((line) => line.type === 'result')).toBe(true);
      expect((await firstTurn.exit).code).toBe(0);
      expect(countLines(starts)).toBe(1);

      const second = await make('capability-a');
      expect(second.reused).toBe(true);
      const secondTurn = await second.session.execute('SECOND', new AbortController().signal);
      const secondLines = await collect(secondTurn.lines);
      expect(secondLines.some((line) => line.type === 'result')).toBe(true);
      expect((await secondTurn.exit).code).toBe(0);
      expect(countLines(starts)).toBe(1);

      // A new native provider/session must be able to reclaim an idle Claude
      // prewarm immediately; it must not wait for the five-minute idle TTL.
      expect(await second.session.requestHandoff()).toBe(true);

      const replaced = await make('capability-b');
      expect(replaced.reused).toBe(false);
      const replacedTurn = await replaced.session.execute('REPLACED', new AbortController().signal);
      await collect(replacedTurn.lines);
      expect((await replacedTurn.exit).code).toBe(0);
      expect(countLines(starts)).toBe(2);
    } finally {
      await pool.closeAll();
      if (previousTtl === undefined) delete process.env.FORGEAX_CLAUDE_SESSION_IDLE_TTL_MS;
      else process.env.FORGEAX_CLAUDE_SESSION_IDLE_TTL_MS = previousTtl;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes concurrent capability changes to one thread owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-claude-session-pool-race-'));
    const script = join(root, 'fixture.mjs');
    const starts = join(root, 'starts.log');
    const closes = join(root, 'closes.log');
    writeFileSync(script, String.raw`
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FX_STARTS, String(process.pid) + '\n');
process.on('SIGTERM', () => { appendFileSync(process.env.FX_CLOSES, String(process.pid) + '\n'); process.exit(0); });
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
    if (request.type === 'control_request') {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } }) + '\n');
    } else if (request.type === 'user') {
      process.stdout.write(JSON.stringify({ type: 'result', result: 'OK', stop_reason: 'end_turn' }) + '\n');
    }
  }
});
`, 'utf8');
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    let creates = 0;
    const make = (key: string) => pool.acquire('thread-race', key, async () => {
      creates += 1;
      // Keep both callers concurrent at the admission boundary. Without a
      // per-thread lock both factories create live processes and neither old
      // owner is reclaimed deterministically.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const transport = createDirectClaudeTransport({
        cmd: process.execPath,
        args: [script],
        cwd: root,
        envOverride: { FX_STARTS: starts, FX_CLOSES: closes },
      });
      await waitForLineCount(starts, creates);
      return transport;
    });
    try {
      const [first, second] = await Promise.all([make('key-a'), make('key-b')]);
      expect(creates).toBe(2);
      await waitForLineCount(starts, 2);
      expect(countLines(starts)).toBe(2);
      // Exactly one old owner is closed; the second acquisition is the only
      // live owner for this thread.
      expect(countLines(closes)).toBe(1);
      expect(second.reused).toBe(false);
      await expect(first.session.execute('must-not-run', new AbortController().signal)).rejects.toThrow('not alive');

      const turn = await second.session.execute('live-owner', new AbortController().signal);
      await collect(turn.lines);
      expect((await turn.exit).code).toBe(0);
    } finally {
      await pool.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not interrupt an active turn during capability handoff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-claude-session-pool-active-'));
    const script = join(root, 'fixture.mjs');
    const started = join(root, 'active.started');
    const release = join(root, 'active.release');
    const closes = join(root, 'closes.log');
    writeFileSync(script, String.raw`
import { appendFileSync, existsSync } from 'node:fs';
let buffer = '';
process.on('SIGTERM', () => { appendFileSync(process.env.FX_CLOSES, String(process.pid) + '\n'); process.exit(0); });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === 'control_request') {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } }) + '\n');
      continue;
    }
    if (request.type !== 'user') continue;
    appendFileSync(process.env.FX_STARTED, '1\n');
    const timer = setInterval(() => {
      if (!existsSync(process.env.FX_RELEASE)) return;
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ type: 'result', result: 'ACTIVE_OK', stop_reason: 'end_turn' }) + '\n');
    }, 5);
  }
});
`, 'utf8');
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    const previousTimeout = process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS;
    const make = (key: string) => pool.acquire('thread-active', key, async () => createDirectClaudeTransport({
      cmd: process.execPath,
      args: [script],
      cwd: root,
      envOverride: {
        FX_STARTED: started,
        FX_RELEASE: release,
        FX_CLOSES: closes,
      },
    }));
    try {
      process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS = '40';
      const first = await make('key-a');
      const active = await first.session.execute('active', new AbortController().signal);
      await waitForFile(started);

      await expect(make('key-b')).rejects.toMatchObject({
        code: 'claude_session_pool_busy',
        retryable: true,
        retryAfterMs: 250,
      });
      expect(countLines(closes)).toBe(0);

      writeFileSync(release, 'release\n', 'utf8');
      const activeLines = await collect(active.lines);
      expect(activeLines.some((line) => line.result === 'ACTIVE_OK')).toBe(true);
      expect((await active.exit).code).toBe(0);

      const replacement = await make('key-b');
      expect(replacement.reused).toBe(false);
      expect(countLines(closes)).toBe(1);
    } finally {
      await pool.closeAll();
      if (previousTimeout === undefined) delete process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS;
      else process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS = previousTimeout;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('waits for an already queued turn before capability handoff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-claude-session-pool-queued-'));
    const script = join(root, 'fixture.mjs');
    const started = join(root, 'started.log');
    const releaseFirst = join(root, 'release-first');
    const releaseSecond = join(root, 'release-second');
    const closes = join(root, 'closes.log');
    writeFileSync(script, String.raw`
import { appendFileSync, existsSync } from 'node:fs';
let buffer = '';
let turn = 0;
process.on('SIGTERM', () => { appendFileSync(process.env.FX_CLOSES, String(process.pid) + '\n'); process.exit(0); });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === 'control_request') {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } }) + '\n');
      continue;
    }
    if (request.type !== 'user') continue;
    turn += 1;
    const current = turn;
    appendFileSync(process.env.FX_STARTED, request.message.content + '\n');
    const release = current === 1 ? process.env.FX_RELEASE_FIRST : process.env.FX_RELEASE_SECOND;
    const timer = setInterval(() => {
      if (!existsSync(release)) return;
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ type: 'result', result: current === 1 ? 'FIRST_OK' : 'SECOND_OK', stop_reason: 'end_turn' }) + '\n');
    }, 5);
  }
});
`, 'utf8');
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    const previousTimeout = process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS;
    const make = (key: string) => pool.acquire('thread-queued', key, async () => createDirectClaudeTransport({
      cmd: process.execPath,
      args: [script],
      cwd: root,
      envOverride: {
        FX_STARTED: started,
        FX_RELEASE_FIRST: releaseFirst,
        FX_RELEASE_SECOND: releaseSecond,
        FX_CLOSES: closes,
      },
    }));
    try {
      process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS = '1000';
      const first = await make('key-a');
      const firstTurn = await first.session.execute('FIRST', new AbortController().signal);
      await waitForLineCount(started, 1);

      // Reserve a second turn behind the first before changing capabilities.
      const secondTurnPromise = first.session.execute('SECOND', new AbortController().signal);
      const replacementPromise = make('key-b');
      writeFileSync(releaseFirst, 'release\n', 'utf8');
      expect((await collect(firstTurn.lines)).some((line) => line.result === 'FIRST_OK')).toBe(true);
      await waitForLineCount(started, 2);
      expect(countLines(closes)).toBe(0);

      const secondTurn = await secondTurnPromise;
      writeFileSync(releaseSecond, 'release\n', 'utf8');
      expect((await collect(secondTurn.lines)).some((line) => line.result === 'SECOND_OK')).toBe(true);
      const replacement = await replacementPromise;
      expect(replacement.reused).toBe(false);
      expect(countLines(closes)).toBe(1);
    } finally {
      await pool.closeAll();
      if (previousTimeout === undefined) delete process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS;
      else process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS = previousTimeout;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('pre-aborted turns write nothing and do not evict a healthy warm session', async () => {
    const writes: string[] = [];
    let closeCount = 0;
    const transport = createFakeTransport('success', () => { closeCount += 1; });
    const originalWrite = transport.write.bind(transport);
    transport.write = (data) => { writes.push(data); return originalWrite(data); };
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    try {
      const acquired = await pool.acquire('thread-pre-abort', 'key', async () => transport);
      const aborted = new AbortController();
      aborted.abort();
      await expect(acquired.session.execute('MUST_NOT_WRITE', aborted.signal)).rejects.toBeInstanceOf(ClaudeSessionCancelledError);
      expect(writes).toEqual([]);
      expect(closeCount).toBe(0);

      const reused = await pool.acquire('thread-pre-abort', 'key', async () => { throw new Error('must reuse'); });
      expect(reused.reused).toBe(true);
      const turn = await reused.session.execute('SAFE', new AbortController().signal);
      expect((await collect(turn.lines)).some((line) => line.result === 'RECOVERED')).toBe(true);
      expect(writes.filter((line) => JSON.parse(line).type === 'user')).toHaveLength(1);
    } finally {
      await pool.closeAll();
    }
  });

  test('a queued abort never writes the queued message or closes the active process', async () => {
    const dataCbs = new Set<(stream: 'stdout' | 'stderr', chunk: string) => void>();
    const exitCbs = new Set<(info: { code: number; signal?: string; error?: Error }) => void>();
    const userMessages: string[] = [];
    let closeCount = 0;
    const emit = (value: unknown) => {
      for (const cb of dataCbs) cb('stdout', `${JSON.stringify(value)}\n`);
    };
    const transport: ClaudeSessionTransport = {
      pid: nextFakePid++,
      write(data) {
        const request = JSON.parse(data) as { type: string; request_id?: string; message?: { content?: string } };
        if (request.type === 'control_request') {
          emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } });
        } else if (request.type === 'user') {
          userMessages.push(request.message?.content ?? '');
        }
      },
      onData(cb) { dataCbs.add(cb); return () => dataCbs.delete(cb); },
      onExit(cb) { exitCbs.add(cb); return () => exitCbs.delete(cb); },
      async close() { closeCount += 1; for (const cb of exitCbs) cb({ code: -1 }); },
    };
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    try {
      const acquired = await pool.acquire('thread-queued-abort', 'key', async () => transport);
      const first = await acquired.session.execute('FIRST', new AbortController().signal);
      const queuedAbort = new AbortController();
      const secondPromise = acquired.session.execute('MUST_NOT_WRITE', queuedAbort.signal);
      queuedAbort.abort();
      emit({ type: 'result', result: 'FIRST_OK', stop_reason: 'end_turn' });
      await collect(first.lines);
      await expect(secondPromise).rejects.toBeInstanceOf(ClaudeSessionCancelledError);
      expect(userMessages).toEqual(['FIRST']);
      expect(closeCount).toBe(0);
    } finally {
      await pool.closeAll();
    }
  });

  test('evicts a persistent session after initialize error, timeout, or transport exit', async () => {
    const previousTimeout = process.env.FORGEAX_CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS;
    process.env.FORGEAX_CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS = '40';
    try {
      for (const mode of ['error', 'timeout', 'exit']) {
        const pool = new ClaudeSessionPool<Record<string, unknown>>();
        let createCount = 0;
        let closeCount = 0;
        const make = () => pool.acquire('thread-init', 'same-capability-key', async () => {
          createCount += 1;
          return createFakeTransport(createCount === 1 ? mode as 'error' | 'timeout' | 'exit' : 'success', () => { closeCount += 1; });
        });
        try {
          const first = await make();
          await expect(first.session.execute(`first-${mode}`, new AbortController().signal)).rejects.toBeInstanceOf(Error);
          expect(createCount).toBe(1);
          expect(closeCount).toBe(1);

          const recovered = await make();
          expect(recovered.reused).toBe(false);
          const turn = await recovered.session.execute(`second-${mode}`, new AbortController().signal);
          const lines = await collect(turn.lines);
          expect(lines.some((line) => line.result === 'RECOVERED')).toBe(true);
          expect((await turn.exit).code).toBe(0);
          expect(createCount).toBe(2);
        } catch (error) {
          throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        } finally {
          await pool.closeAll();
        }
      }
    } finally {
      if (previousTimeout === undefined) delete process.env.FORGEAX_CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS;
      else process.env.FORGEAX_CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS = previousTimeout;
    }
  });

  test('closeAll waits for a concurrent transport creation and reaps it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-claude-session-pool-close-'));
    const pool = new ClaudeSessionPool<Record<string, unknown>>();
    let beginCreate!: () => void;
    let releaseCreate!: () => void;
    let transport: Awaited<ReturnType<typeof createDirectClaudeTransport>> | undefined;
    const createBegan = new Promise<void>((resolve) => { beginCreate = resolve; });
    const createRelease = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const acquiring = pool.acquire('thread-close', 'capability-close', async () => {
      beginCreate();
      await createRelease;
      transport = createDirectClaudeTransport({
        cmd: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
      });
      return transport;
    }).catch((error: unknown) => error);
    let lateStarted = false;

    try {
      await createBegan;
      const closing = pool.closeAll();
      const lateAcquire = pool.acquire('thread-late', 'capability-late', async () => {
        lateStarted = true;
        return createDirectClaudeTransport({
          cmd: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
        });
      });
      await Promise.resolve();
      expect(lateStarted).toBe(false);
      releaseCreate();
      const result = await acquiring;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('closing');
      await closing;
      expect(transport?.pid).toBeGreaterThan(0);
      await new Promise<void>((resolve) => {
        transport?.onExit(() => resolve());
        if (!transport?.pid) resolve();
      });
      const late = await lateAcquire;
      expect(lateStarted).toBe(true);
      await late.session.close();
    } finally {
      await pool.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
