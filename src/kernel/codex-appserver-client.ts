// Minimal newline-delimited JSON-RPC 2.0 client over a persistent
// `codex app-server` subprocess. This is the transport the CodexProvider uses
// to get an interactive APPROVAL loop (codex `exec --json` has no approval
// callback channel — see docs in providers/codex.ts).
//
// Wire format (verified live, codex-cli 0.139): each message is a single JSON
// object on its own line. Three message shapes on stdout:
//   • response      { id, result } | { id, error }          — reply to our request
//   • serverRequest { id, method, params }                  — codex asks US (approvals!)
//   • notification  { method, params }  (no id)             — streaming events
// We write the same newline-JSON on stdin: requests { jsonrpc, id, method, params }
// and responses to serverRequests { jsonrpc, id, result }.
//
// One app-server process is shared per provider instance (lazy-spawned, reused
// across threads/turns). On crash/exit the client marks itself dead so the next
// ensureStarted() respawns. Unknown messages are tolerated (experimental proto).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type JsonRpcId = number | string;

/** A server→client request codex expects us to answer (approvals, elicitation). */
export interface ServerRequest {
  id: JsonRpcId;
  method: string;
  params: any;
}

/** Handler for a server→client request. Return the `result` object (becomes
 *  `{ id, result }`). Throw to reply with a JSON-RPC error. */
export type ServerRequestHandler = (req: ServerRequest) => Promise<unknown> | unknown;

/** Handler for a notification (no id). */
export type NotificationHandler = (method: string, params: any) => void;

export interface CodexAppServerOptions {
  /** Binary path (resolved by the provider). */
  binary: string;
  /** Working directory for the app-server process. */
  cwd: string;
  /** Extra env merged onto process.env (e.g. OPENAI_API_KEY/BASE_URL). */
  env?: Record<string, string>;
  /** Global codex args injected BEFORE the `app-server` subcommand (e.g. `-c`
   *  config overrides registering the forgeax-tools MCP server). */
  globalArgs?: string[];
  /** Routes server→client requests we don't otherwise handle. */
  onServerRequest: ServerRequestHandler;
  /** Receives every notification. */
  onNotification: NotificationHandler;
  /** Called when the subprocess exits (so the provider can fail in-flight turns). */
  onExit?: (code: number | null, stderrTail: string) => void;
}

export interface McpReadinessResult {
  ready: boolean;
  pending: string[];
  failed: string[];
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderrTail = '';
  private initialized = false;
  private starting: Promise<void> | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | null = null;
  private readonly mcpStartupByThread = new Map<string, Map<string, string>>();

  constructor(private readonly opts: CodexAppServerOptions) {}

  /**
   * A persistent app-server serves many turns, while notification queues and
   * permission callbacks are turn-scoped. Swap only those callbacks; process
   * configuration (cwd/env/globalArgs) remains immutable and is guarded by the
   * outer pool fingerprint.
   */
  setTurnHandlers(handlers: Pick<CodexAppServerOptions, 'onServerRequest' | 'onNotification' | 'onExit'>): void {
    this.opts.onServerRequest = handlers.onServerRequest;
    this.opts.onNotification = handlers.onNotification;
    this.opts.onExit = handlers.onExit;
  }

  get alive(): boolean {
    return this.proc != null && this.proc.exitCode == null && !this.proc.killed;
  }

  /** Lazily spawn `codex app-server` + run the `initialize` handshake once.
   *  Idempotent + concurrency-safe (a single in-flight start is shared). */
  async ensureStarted(): Promise<void> {
    if (this.alive && this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this._start()
      .catch(async (error) => {
        // A successful spawn followed by initialize error/timeout still leaves
        // a live child. The client itself owns that half-started process until
        // ensureStarted resolves, so reclaim it here for every caller.
        await this.close();
        throw error;
      })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private async _start(): Promise<void> {
    const proc = spawn(this.opts.binary, [...(this.opts.globalArgs ?? []), 'app-server'], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });
    this.initialized = false;
    this.buf = '';
    this.stderrTail = '';
    let settled = false;

    const settle = (error: Error, code: number | null): void => {
      if (settled) return;
      settled = true;
      this.initialized = false;
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
      try { this.opts.onExit?.(code, this.stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ')); } catch { /* ignore */ }
      this.resolveExit?.();
      this.resolveExit = null;
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this._onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    // Absorb EPIPE/ECONNRESET on the long-lived stdio streams so a dead
    // app-server can't bubble an unhandled stream 'error' into a process-wide
    // uncaughtException. The 'exit' handler below rejects pending requests and
    // notifies the provider; these listeners just stop the error escaping.
    proc.stdin.on('error', () => { /* EPIPE — app-server gone; exit handler handles it */ });
    proc.stdout.on('error', () => { /* swallow — exit handler handles it */ });
    proc.stderr.on('error', () => { /* swallow — exit handler handles it */ });
    proc.on('error', (error) => {
      if (this.proc === proc) this.proc = null;
      settle(new Error(`codex app-server spawn failed: ${error.message}`), null);
    });
    proc.on('exit', (code) => settle(new Error(`codex app-server exited (code=${code})`), code));

    // Handshake. clientInfo shape verified: { name, title|null, version }.
    await this.request('initialize', {
      clientInfo: { name: 'forgeax', title: 'forgeax-studio', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;
  }

  private _onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; /* tolerate noise */ }
      this._dispatch(msg);
    }
  }

  private _dispatch(msg: any): void {
    // Response to one of our requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // Server→client request (approvals etc.) — has BOTH id and method.
    if (msg.id != null && typeof msg.method === 'string') {
      void this._handleServerRequest(msg as ServerRequest);
      return;
    }
    // Notification (no id).
    if (typeof msg.method === 'string') {
      if (msg.method === 'mcpServer/startupStatus/updated') {
        const threadId = typeof msg.params?.threadId === 'string' ? msg.params.threadId : '';
        const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
        const status = typeof msg.params?.status === 'string' ? msg.params.status : '';
        if (threadId && name && status) {
          const states = this.mcpStartupByThread.get(threadId) ?? new Map<string, string>();
          states.set(name, status);
          this.mcpStartupByThread.set(threadId, states);
        }
      }
      try { this.opts.onNotification(msg.method, msg.params); } catch { /* never let a handler break the read loop */ }
    }
  }

  private async _handleServerRequest(req: ServerRequest): Promise<void> {
    try {
      const result = await this.opts.onServerRequest(req);
      this._send({ jsonrpc: '2.0', id: req.id, result });
    } catch (e) {
      this._send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } });
    }
  }

  /** Send a request and await its response. Rejects if the process dies. */
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!this.proc || this.proc.exitCode != null) {
      return Promise.reject(new Error('codex app-server not running'));
    }
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    this._send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /** Fire-and-forget notification to the server. */
  notify(method: string, params: unknown): void {
    this._send({ jsonrpc: '2.0', method, params });
  }

  /**
   * `initialize` acknowledges the app-server before optional native stdio MCPs
   * necessarily finish starting. A thread created in that gap snapshots an
   * incomplete tool catalog for the turn. Wait a bounded interval for the
   * configured local servers (plus ForgeaX's required `fxt`) to report the
   * thread-scoped `ready` startup state; failure remains optional Codex
   * behavior after the deadline.
   */
  async waitForThreadMcpServers(
    threadId: string,
    names: readonly string[],
    options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<McpReadinessResult> {
    const expected = [...new Set(names.filter(Boolean))];
    if (expected.length === 0) return { ready: true, pending: [], failed: [] };
    const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
    const pollMs = Math.max(10, options.pollMs ?? 250);
    const deadline = Date.now() + timeoutMs;
    let pending = expected;
    let failed: string[] = [];

    do {
      if (options.signal?.aborted) throw new Error('codex MCP readiness cancelled');
      if (!this.alive) throw new Error('codex app-server exited during MCP readiness');
      const states = this.mcpStartupByThread.get(threadId);
      // Codex may publish `cancelled` for an interrupted startup attempt and
      // then retry the same configured server on this thread. Only `failed`
      // is terminal; treating `cancelled` as terminal moves that retry back
      // onto the user's first turn and can snapshot an incomplete tool set.
      failed = expected.filter((name) => states?.get(name) === 'failed');
      pending = expected.filter((name) => {
        const state = states?.get(name);
        return state !== 'ready' && state !== 'failed';
      });
      if (pending.length === 0) return { ready: failed.length === 0, pending: [], failed };
      const waitMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    } while (Date.now() < deadline);

    return { ready: false, pending, failed };
  }

  private _send(obj: unknown): void {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* stdin closed — the exit handler will reject pending requests */
    }
  }

  /** Best-effort terminate. */
  shutdown(): void {
    try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
    this.proc = null;
    this.initialized = false;
  }

  /** Wait for process exit so pool replacement never overlaps one CODEX_HOME. */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const exit = this.exitPromise;
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    await Promise.race([
      exit,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (proc.exitCode == null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      await Promise.race([
        exit,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    if (this.proc === proc) this.proc = null;
    this.initialized = false;
  }
}
