/**
 * A bounded pool for the reference agent CLI's supported stream-json input protocol.
 *
 * `claude -p --input-format stream-json` keeps its stdin open and accepts the
 * next `{type:"user"}` frame after a result. The old `spawnJsonl` adapter is
 * intentionally one-shot because it closes stdin; this adapter owns the
 * long-lived process and exposes one completed turn at a time.
 *
 * The pool is transport-agnostic. The kernel supplies either a direct child
 * transport or the agent-host/sidecar transport, so the optimization does not
 * bypass the existing credential and process-supervision boundaries.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS,
  projectMcpConfigFingerprint,
} from './project-mcp';
import { tt } from '../lib/turn-trace';

export interface ClaudeSessionTransport {
  write(data: string): Promise<void> | void;
  onData(cb: (stream: 'stdout' | 'stderr', chunk: string) => void): () => void;
  onExit(cb: (info: { code: number; signal?: string; error?: Error }) => void): () => void;
  close(): Promise<void>;
  readonly pid?: number;
}

export interface PooledTurn<T = unknown> {
  lines: AsyncIterable<T>;
  exit: Promise<{ code: number; stderr: string }>;
}

interface TurnState<T> {
  queue: T[];
  finished: boolean;
  resultSeen: boolean;
  stderr: string;
  error?: Error;
  wake: (() => void) | null;
  resolveExit: (value: { code: number; stderr: string }) => void;
  exit: Promise<{ code: number; stderr: string }>;
  release: () => void;
}

interface ControlWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PoolEntry<T> {
  key: string;
  threadId: string;
  session: ClaudeSession<T>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const CONTROL_INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * A capability handoff is allowed to wait for the current user turn, but it
 * must not kill that turn in order to make room for a different capability
 * surface. Callers can retry this error without resending the model turn.
 */
export class ClaudeSessionPoolBusyError extends Error {
  readonly code = 'claude_session_pool_busy';
  readonly retryable = true;
  readonly retryAfterMs = 250;

  constructor(readonly threadId: string) {
    super(`Claude session capability handoff is busy for thread ${threadId}; retry this turn`);
    this.name = 'ClaudeSessionPoolBusyError';
  }
}

/**
 * Cancellation is a terminal user decision, never a reason to replay the same
 * message through the one-shot fallback. Keeping it distinct also lets a
 * pre-aborted/queued-aborted turn leave an otherwise healthy warm process alive.
 */
export class ClaudeSessionCancelledError extends Error {
  readonly code = 'cancelled';
  readonly retryable = false;

  constructor() {
    super('Claude session turn was cancelled');
    this.name = 'ClaudeSessionCancelledError';
  }
}

const NATIVE_TREE_LIMIT = 4096;
const NATIVE_TREE_DEPTH_LIMIT = 32;

function statStamp(path: string, seen = new Set<string>(), depth = 0): string {
  try {
    if (depth > NATIVE_TREE_DEPTH_LIMIT) return `${path}:depth-limit`;
    const stat = lstatSync(path);
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      realPath = path;
    }
    if (seen.has(realPath)) return `${path}:cycle:${realPath}`;
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      // Claude managers commonly install plugins/skills through symlinks. The
      // link name alone is not a capability fingerprint: a manager can update
      // the target in place while the warm process keeps the old surface.
      return `${path}:link:${target}\n${statStamp(realPath, seen, depth + 1)}`;
    }
    if (stat.isFile()) return `${path}:file:${stat.size}:${stat.mtimeMs}`;
    if (!stat.isDirectory()) return `${path}:other:${stat.mtimeMs}`;
    const nextSeen = new Set(seen);
    nextSeen.add(realPath);
    const entries = readdirSync(path).sort();
    const children: string[] = [];
    for (const entry of entries) {
      if (children.length >= NATIVE_TREE_LIMIT) {
        children.push(`${path}:overflow:${entries.length}`);
        break;
      }
      children.push(statStamp(join(path, entry), nextSeen, depth + 1));
    }
    return `${path}:dir:${stat.mtimeMs}\n${children.join('\n')}`;
  } catch {
    return `${path}:missing`;
  }
}

function stableClaudeJsonStamp(path: string, projectRoot: string): string {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const project = value.projects && typeof value.projects === 'object'
      ? (value.projects as Record<string, unknown>)[projectRoot]
      : undefined;
    const stable = {
      // Claude stores usage counters, experiment state and last-used metadata
      // beside this config. Those fields are runtime state, not capabilities;
      // only MCP definitions and the current project's MCP override affect the
      // process capability surface.
      mcpServers: value.mcpServers,
      projectMcpServers: project && typeof project === 'object'
        ? (project as Record<string, unknown>).mcpServers
        : undefined,
    };
    return `${path}:config:${JSON.stringify(stable)}`;
  } catch {
    return statStamp(path);
  }
}

function installedPluginPaths(manifestPath: string): string[] {
  try {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const plugins = value.plugins;
    if (!plugins || typeof plugins !== 'object') return [];
    const paths: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'installPath' && typeof child === 'string' && child.trim()) paths.push(child);
        else visit(child);
      }
    };
    visit(plugins);
    return paths;
  } catch {
    return [];
  }
}

/**
 * Native Claude sources are intentionally observed, not disabled. The process
 * pool must be replaced when a manager edits one of the sources that Claude
 * reads at process start; otherwise the warm process would silently keep an old
 * MCP/plugin/skill/settings surface. The explicit env epoch is available to an
 * external manager for sources outside the known filesystem locations.
 */
export function claudeNativeSourceFingerprint(projectRoot: string): string {
  const home = homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  const files = new Set<string>([
    join(home, '.claude.json'),
    join(configDir, 'settings.json'),
    join(configDir, 'settings.local.json'),
    join(configDir, 'CLAUDE.md'),
    join(configDir, 'plugins', 'installed_plugins.json'),
    join(configDir, 'plugins', 'known_marketplaces.json'),
  ]);
  const trees = new Set<string>([join(configDir, 'skills')]);
  let current = projectRoot;
  for (;;) {
    files.add(join(current, 'CLAUDE.md'));
    files.add(join(current, '.claude', 'CLAUDE.md'));
    files.add(join(current, '.claude', 'settings.json'));
    files.add(join(current, '.claude', 'settings.local.json'));
    trees.add(join(current, '.claude', 'plugins'));
    trees.add(join(current, '.claude', 'skills'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of installedPluginPaths(join(configDir, 'plugins', 'installed_plugins.json'))) trees.add(path);
  const source = [
    process.env.FORGEAX_CLAUDE_NATIVE_FINGERPRINT?.trim() ?? '',
    ...[...files].sort().map((path) => path === join(home, '.claude.json')
      ? stableClaudeJsonStamp(path, projectRoot)
      : statStamp(path)),
    ...[...trees].sort().map((path) => statStamp(path)),
  ].join('\n');
  return createHash('sha256').update(source).digest('hex');
}

function configuredIdleTtlMs(): number {
  const raw = process.env.FORGEAX_CLAUDE_SESSION_IDLE_TTL_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_TTL_MS;
}

function configuredHandoffTimeoutMs(): number {
  const raw = process.env.FORGEAX_CLAUDE_SESSION_HANDOFF_TIMEOUT_MS?.trim();
  if (!raw) return PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS;
}

function configuredControlInitializeTimeoutMs(): number {
  const raw = process.env.FORGEAX_CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS?.trim();
  if (!raw) return CONTROL_INITIALIZE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : CONTROL_INITIALIZE_TIMEOUT_MS;
}

function isResultLine(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'result');
}

/** One persistent Claude process. Only one turn is written at a time. */
class ClaudeSession<T = unknown> {
  private readonly removeData: () => void;
  private readonly removeExit: () => void;
  private stdoutBuffer = '';
  private current: TurnState<T> | undefined;
  private turnTail: Promise<void> = Promise.resolve();
  private initializePromise: Promise<void> | undefined;
  private initialized = false;
  /** Includes active and turnTail-queued callers from execute() entry onward. */
  private pendingTurns = 0;
  private readonly controlWaiters = new Map<string, ControlWaiter>();
  private closed = false;
  private stderr = '';
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly transport: ClaudeSessionTransport) {
    this.removeData = transport.onData((stream, chunk) => {
      if (stream === 'stderr') {
        this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
        if (this.current) this.current.stderr = `${this.current.stderr}${chunk}`.slice(-16_384);
        return;
      }
      this.stdoutBuffer += chunk;
      for (;;) {
        const newline = this.stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as T;
          if (this.acceptControlResponse(parsed)) continue;
          this.accept(parsed);
        } catch {
          // Claude diagnostics belong on stderr. Keep malformed stdout from
          // poisoning the current turn; the normal mapper will report a CLI
          // error if no result arrives.
        }
      }
    });
    this.removeExit = transport.onExit((info) => {
      this.closed = true;
      const error = info.error ?? new Error(`claude session exited (${info.code}${info.signal ? `/${info.signal}` : ''})`);
      this.rejectControlWaiters(error);
      this.finishCurrent(info.code, error);
    });
  }

  get pid(): number | undefined { return this.transport.pid; }
  get isAlive(): boolean { return !this.closed; }
  get isBusy(): boolean {
    return Boolean(
      (this.current && !this.current.finished)
      || (this.initializePromise && !this.initialized)
      || this.pendingTurns > 0,
    );
  }

  private acceptControlResponse(line: unknown): boolean {
    if (!line || typeof line !== 'object' || (line as { type?: unknown }).type !== 'control_response') {
      return false;
    }
    const response = (line as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return true;
    const requestId = (response as { request_id?: unknown }).request_id;
    if (typeof requestId !== 'string') return true;
    const waiter = this.controlWaiters.get(requestId);
    if (!waiter) return true;
    this.controlWaiters.delete(requestId);
    if ((response as { subtype?: unknown }).subtype === 'success') {
      waiter.resolve();
    } else {
      const error = (response as { error?: unknown }).error;
      const message = typeof error === 'string'
        ? error
        : `Claude control initialize failed: ${JSON.stringify(error ?? response)}`;
      // A provider may initialize its control plane eagerly before the first
      // stdin frame. That is an idempotent success, not a reason to throw away
      // a correctly-capable warm process.
      if (/already initialized/i.test(message)) waiter.resolve();
      else waiter.reject(new Error(message));
    }
    return true;
  }

  private rejectControlWaiters(error: Error): void {
    const waiters = [...this.controlWaiters.values()];
    this.controlWaiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  /**
   * Ask the reference agent CLI to initialize its native control plane without submitting a
   * model/user turn. Claude's documented stream-json control channel returns
   * the loaded commands/skills surface and lets MCP/plugin discovery finish;
   * unlike an empty prompt this does not create transcript or usage entries.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    const previous = this.turnTail;
    const initialize = (async () => {
      await previous.catch(() => {});
      if (this.closed) throw new Error('claude session is not alive');
      const requestId = `forgeax-init-${randomUUID()}`;
      const response = new Promise<void>((resolve, reject) => {
        this.controlWaiters.set(requestId, { resolve, reject });
      });
      try {
        await this.transport.write(`${JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'initialize' },
        })}\n`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          response,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Claude control initialize timed out')),
              configuredControlInitializeTimeoutMs(),
            );
            timer.unref?.();
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        this.initialized = true;
      } finally {
        this.controlWaiters.delete(requestId);
        this.notifyIdle();
      }
    })();
    this.initializePromise = initialize;
    try {
      await initialize;
    } catch (error) {
      if (this.initializePromise === initialize) this.initializePromise = undefined;
      this.notifyIdle();
      throw error;
    }
  }

  private accept(line: T): void {
    const state = this.current;
    if (!state || state.finished) return;
    state.queue.push(line);
    if (isResultLine(line)) {
      state.resultSeen = true;
      state.finished = true;
      state.resolveExit({ code: 0, stderr: state.stderr || this.stderr });
      state.release();
      this.notifyIdle();
    }
    const wake = state.wake;
    state.wake = null;
    wake?.();
  }

  private finishCurrent(code: number, error?: Error): void {
    const state = this.current;
    if (!state || state.finished) return;
    state.error = error;
    state.finished = true;
    state.resolveExit({ code, stderr: state.stderr || this.stderr });
    state.release();
    this.notifyIdle();
    const wake = state.wake;
    state.wake = null;
    wake?.();
  }

  private notifyIdle(): void {
    const waiters = [...this.idleWaiters];
    for (const resolveIdle of waiters) resolveIdle();
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.isBusy) return true;
    return new Promise<boolean>((resolveIdle) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolveIdle(idle);
      };
      const onIdle = () => {
        // A result may release the current turn and immediately admit a turn
        // already reserved behind turnTail. Re-check the complete state before
        // allowing capability handoff to close the process.
        if (!this.isBusy) finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.idleWaiters.add(onIdle);
      if (!this.isBusy) finish(true);
    });
  }

  async execute(message: string, signal: AbortSignal): Promise<PooledTurn<T>> {
    if (signal.aborted) throw new ClaudeSessionCancelledError();
    this.pendingTurns += 1;
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) return;
      reservationReleased = true;
      this.pendingTurns -= 1;
      this.notifyIdle();
    };
    // A caller may skip the optional HTTP warm endpoint. Keep the same native
    // initialization barrier on the first real turn so capability discovery is
    // still completed before Claude receives user content.
    try {
      await this.initialize();
    } catch (error) {
      releaseReservation();
      throw error;
    }
    if (signal.aborted) {
      releaseReservation();
      throw new ClaudeSessionCancelledError();
    }
    const previous = this.turnTail;
    let release!: () => void;
    this.turnTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    if (signal.aborted) {
      release();
      releaseReservation();
      throw new ClaudeSessionCancelledError();
    }
    if (this.closed) {
      release();
      releaseReservation();
      throw new Error('claude session is not alive');
    }

    let resolveExit!: (value: { code: number; stderr: string }) => void;
    const exit = new Promise<{ code: number; stderr: string }>((resolve) => { resolveExit = resolve; });
    const state: TurnState<T> = {
      queue: [],
      finished: false,
      resultSeen: false,
      stderr: '',
      wake: null,
      resolveExit,
      exit,
      release: (() => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          release();
          releaseReservation();
        };
      })(),
    };
    this.current = state;

    const onAbort = () => {
      // A cancelled turn cannot leave a live process with an unknown protocol
      // boundary. Terminate the whole pooled session and let the next turn use
      // a fresh process.
      void this.close();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      await this.close();
      signal.removeEventListener('abort', onAbort);
      throw new ClaudeSessionCancelledError();
    }

    try {
      await this.transport.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: message } })}\n`);
    } catch (error) {
      this.finishCurrent(-1, error instanceof Error ? error : new Error(String(error)));
    }

    const lines = (async function* (): AsyncGenerator<T> {
      try {
        for (;;) {
          while (state.queue.length) yield state.queue.shift() as T;
          if (state.finished) return;
          await new Promise<void>((resolve) => { state.wake = resolve; });
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    })();
    return { lines, exit };
  }

  async close(): Promise<void> {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectControlWaiters(new Error('claude session closed'));
    this.finishCurrent(-1, new Error('claude session closed'));
    this.removeData();
    this.removeExit();
    if (!wasClosed) await this.transport.close();
  }
}

/**
 * Pool ownership is thread-scoped. A capability key change replaces that
 * thread's old process instead of retaining two sessions with different tool
 * or permission surfaces.
 */
export class ClaudeSessionPool<T = unknown> {
  private readonly entries = new Map<string, PoolEntry<T>>();
  private readonly threadOwners = new Map<string, string>();
  /** Serializes owner lookup, idle handoff, and registration per thread. */
  private readonly threadAdmissions = new Map<string, Promise<void>>();
  private readonly creating = new Map<string, Promise<PoolEntry<T>>>();
  private closeEpoch = 0;
  /** A close in progress is a real admission barrier. An acquire that arrives
   * after shutdown started must wait for the sweep instead of creating a new
   * transport behind closeAll's snapshot. */
  private closeInFlight?: Promise<void>;

  async acquire(
    threadId: string,
    key: string,
    create: () => Promise<ClaudeSessionTransport>,
  ): Promise<{ session: ClaudeSessionHandle<T>; reused: boolean }> {
    for (;;) {
      if (this.closeInFlight) await this.closeInFlight;
      const releaseAdmission = await this.enterThread(threadId);
      if (this.closeInFlight) {
        releaseAdmission();
        continue;
      }
      let acquired: { session: ClaudeSessionHandle<T>; reused: boolean } | undefined;
      try {
        acquired = await this.acquireWithAdmission(threadId, key, create);
      } finally {
        releaseAdmission();
      }
      if (acquired) return acquired;
    }
  }

  private async enterThread(threadId: string): Promise<() => void> {
    const previous = this.threadAdmissions.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.threadAdmissions.set(threadId, current);
    await previous;
    return () => {
      if (this.threadAdmissions.get(threadId) === current) this.threadAdmissions.delete(threadId);
      release();
    };
  }

  private async acquireWithAdmission(
    threadId: string,
    key: string,
    create: () => Promise<ClaudeSessionTransport>,
  ): Promise<{ session: ClaudeSessionHandle<T>; reused: boolean } | undefined> {
    const acquireEpoch = this.closeEpoch;
    const ownerKey = this.threadOwners.get(threadId);
    if (ownerKey && ownerKey !== key) {
      const old = this.entries.get(ownerKey);
      if (old) {
        // A capability change cannot interrupt an active model/tool turn. Wait
        // for a clean protocol boundary; the caller receives a retryable busy
        // error if the bounded wait expires.
        if (!await old.session.waitForIdle(configuredHandoffTimeoutMs())) {
          throw new ClaudeSessionPoolBusyError(threadId);
        }
        await this.evict(ownerKey, old, 'capability-changed');
      } else if (this.threadOwners.get(threadId) === ownerKey) {
        this.threadOwners.delete(threadId);
      }
    }
    // closeAll can begin while the bounded handoff above is waiting. Let the
    // outer admission loop wait for that sweep before creating a replacement.
    if (this.closeInFlight) return undefined;
    const existing = this.entries.get(key);
    if (existing?.session.isAlive) {
      this.touch(key, existing);
      this.threadOwners.set(threadId, key);
      tt('cc.pool-hit', { threadId, pid: existing.session.pid });
      return { session: this.handle(key, existing), reused: true };
    }
    if (existing) await this.evict(key, existing, 'dead');

    const pending = this.creating.get(key);
    if (pending) {
      const entry = await pending;
      if (this.closeEpoch !== acquireEpoch || !entry.session.isAlive) {
        throw new Error('Claude session pool is closing');
      }
      this.threadOwners.set(threadId, key);
      this.touch(key, entry);
      tt('cc.pool-hit', { threadId, pid: entry.session.pid, reusedAfterInflight: true });
      return { session: this.handle(key, entry), reused: true };
    }

    // closeAll may have started after the existing-entry check. Re-enter only
    // after that sweep has finished; otherwise this acquire could create a late
    // transport outside the sweep.
    if (this.closeInFlight) return undefined;

    const creating = (async (): Promise<PoolEntry<T>> => {
      const transport = await create();
      if (this.closeEpoch !== acquireEpoch) {
        await transport.close();
        throw new Error('Claude session pool is closing');
      }
      const session = new ClaudeSession<T>(transport);
      const entry: PoolEntry<T> = { key, threadId, session };
      this.entries.set(key, entry);
      this.threadOwners.set(threadId, key);
      this.armTimer(key, entry);
      tt('cc.pool-miss', { threadId, pid: session.pid });
      return entry;
    })();
    this.creating.set(key, creating);
    try {
      const entry = await creating;
      return { session: this.handle(key, entry), reused: false };
    } finally {
      if (this.creating.get(key) === creating) this.creating.delete(key);
    }
  }

  private handle(key: string, entry: PoolEntry<T>): ClaudeSessionHandle<T> {
    return {
      pid: entry.session.pid,
      execute: async (message, signal) => {
        this.touch(key, entry);
        try {
          const turn = await entry.session.execute(message, signal);
          void turn.exit.then(() => this.touch(key, entry));
          return turn;
        } catch (error) {
          if (error instanceof ClaudeSessionCancelledError) throw error;
          // initialize() failures (control error, timeout, or transport exit)
          // invalidate the persistent entry before the kernel's one-shot
          // fallback can run. Otherwise the next turn would reuse the same
          // poisoned process and pay the failure again.
          await this.evict(key, entry, 'execute-failed');
          throw error;
        }
      },
      initialize: async () => {
        try {
          await entry.session.initialize();
        } catch (error) {
          await this.evict(key, entry, 'initialize-failed');
          throw error;
        }
      },
      close: () => this.evict(key, entry, 'explicit'),
      requestHandoff: () => this.requestHandoff(key, entry),
    };
  }

  private async requestHandoff(key: string, entry: PoolEntry<T>): Promise<boolean> {
    if (this.entries.get(key) !== entry) return true;
    if (!await entry.session.waitForIdle(configuredHandoffTimeoutMs())) return false;
    await this.evict(key, entry, 'native-handoff');
    return true;
  }

  private touch(key: string, entry: PoolEntry<T>): void {
    if (this.entries.get(key) !== entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.armTimer(key, entry);
  }

  private armTimer(key: string, entry: PoolEntry<T>): void {
    const ttl = configuredIdleTtlMs();
    if (ttl <= 0) return;
    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(key) !== entry) return;
      if (entry.session.isBusy) {
        this.armTimer(key, entry);
        return;
      }
      void this.evict(key, entry, 'idle-timeout');
    }, ttl);
    entry.idleTimer.unref?.();
  }

  private async evict(key: string, entry: PoolEntry<T>, reason: string): Promise<void> {
    if (this.entries.get(key) !== entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.entries.delete(key);
    if (this.threadOwners.get(entry.threadId) === key) this.threadOwners.delete(entry.threadId);
    tt('cc.pool-evict', { reason, threadId: entry.threadId, pid: entry.session.pid });
    await entry.session.close();
  }

  async closeAll(): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight;
    this.closeEpoch += 1;
    const closing = (async () => {
      const creating = [...this.creating.values()];
      await Promise.all([...this.entries].map(([key, entry]) => this.evict(key, entry, 'pool-reset')));
      // A transport may be created concurrently with shutdown and is not in
      // entries until its factory resolves. Await those factories, then sweep
      // entries once more so the newly materialized process is also reaped.
      await Promise.allSettled(creating);
      await Promise.all([...this.entries].map(([key, entry]) => this.evict(key, entry, 'pool-reset')));
    })();
    this.closeInFlight = closing;
    try {
      await closing;
    } finally {
      if (this.closeInFlight === closing) this.closeInFlight = undefined;
    }
  }
}

export interface ClaudeSessionHandle<T = unknown> {
  readonly pid?: number;
  initialize(): Promise<void>;
  execute(message: string, signal: AbortSignal): Promise<PooledTurn<T>>;
  close(): Promise<void>;
  /** Close this transport for a project-MCP owner handoff without interrupting an active turn. */
  requestHandoff(): Promise<boolean>;
}

export function claudeSessionPoolEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.FORGEAX_CLAUDE_CLI_POOL?.trim() ?? '');
}

export function claudeSessionEligible(req: { trustTier?: string }): boolean {
  // Imported turns remain cold: their sidecar credential budget and hermetic
  // boundary are per-turn. Dynamic suffix text is part of the user frame (see
  // buildCcInput), not a capability change, so it must not disable warm reuse.
  return req.trustTier !== 'imported';
}
