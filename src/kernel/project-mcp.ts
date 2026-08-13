/**
 * Project MCP bridge shared by the orchestrator kernels.
 *
 * The CLI already has a full MCP capability stack, but the orchestrator must
 * stay below the CLI package boundary. This small stdio client is therefore
 * intentionally dependency-free and only implements the MCP operations needed
 * by a turn: initialize, tools/list and tools/call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolSpec } from '@forgeax/agent-runtime';
import { tt } from '../lib/turn-trace';

type JsonObject = Record<string, unknown>;

interface ProjectStdioConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ProjectServer {
  name: string;
  config: ProjectStdioConfig;
}

interface ProjectMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverName: string;
  remoteName: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: JsonObject;
  error?: { message?: string };
}

const REQUEST_TIMEOUT_MS = 8_000;
export const PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 1_000;
const NATIVE_POOL_DRAIN_TIMEOUT_MS = PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const PARTIAL_RETRY_INTERVAL_MS = 15_000;
const MAX_PARTIAL_RETRY_INTERVAL_MS = 5 * 60_000;
/**
 * Tool schemas are stable until the project MCP config changes. The fingerprint
 * below already contains the full config content, so schema cache invalidation is
 * content based. The separate client pool has an idle TTL: a schema cache hit is
 * cheap even after the processes are evicted, while a tool call lazily rebuilds
 * the live clients.
 */
interface DiscoveryCacheEntry {
  fingerprint: string;
  at: number;
  tools: ToolSpec[];
  failedServers: ProjectServer[];
  nextRetryAt: number;
  retryDelayMs: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
interface ProjectMcpPoolEntry {
  fingerprint: string;
  tools: ProjectMcpTool[];
  clients: Map<string, StdioMcpClient>;
  /** Servers that were unavailable while the other servers were discovered. */
  failedServers: ProjectServer[];
  activeCalls: number;
  lastUsedAt: number;
  nextRetryAt: number;
  retryDelayMs: number;
  retiring: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const clientPool = new Map<string, ProjectMcpPoolEntry>();
const discoveryInFlight = new Map<string, { fingerprint: string; promise: Promise<ProjectMcpPoolEntry | undefined> }>();
const schemaDiscoveryInFlight = new Map<string, { fingerprint: string; promise: Promise<ToolSpec[]> }>();
const partialRetryInFlight = new Map<string, Promise<void>>();
const retiringPools = new Set<ProjectMcpPoolEntry>();
const NATIVE_PROJECT_MCP_KERNELS = new Set(['claude-code', 'cursor-agent', 'kimi-code']);
/** Every spawned project-MCP child remains in this registry until its process
 * actually exits. Pool membership is not enough: a timed-out/failed child is
 * deliberately removed from `entry.clients` but still needs shutdown/reap. */
const liveMcpClients = new Set<StdioMcpClient>();

interface NativeOwnershipState {
  /** Serializes native owners for one project config. */
  tail: Promise<void>;
  active: boolean;
  transition?: Promise<void>;
  /** The current owner may close itself when it is idle, or drain its active turn. */
  handoff?: () => Promise<boolean>;
  handoffInFlight?: Promise<boolean>;
  available: Promise<void>;
  resolveAvailable: () => void;
}

const nativeOwnership = new Map<string, NativeOwnershipState>();

function newAvailabilitySignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function ownershipState(root: string): NativeOwnershipState {
  const existing = nativeOwnership.get(root);
  if (existing) return existing;
  const available = Promise.resolve();
  const state: NativeOwnershipState = {
    tail: Promise.resolve(),
    active: false,
    available,
    resolveAvailable: () => {},
  };
  nativeOwnership.set(root, state);
  return state;
}

export class ProjectMcpNativeOwnershipBusyError extends Error {
  readonly code = 'project_mcp_native_busy';

  constructor(projectRoot: string) {
    super(`project MCP native ownership is busy for ${projectRoot}; retry this turn`);
    this.name = 'ProjectMcpNativeOwnershipBusyError';
  }
}

async function settledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestNativeHandoff(root: string, state: NativeOwnershipState): Promise<void> {
  if (!(state.active || state.transition)) return;

  if (state.handoff) {
    const handoffRequested = state.handoff;
    const handoffInFlight = state.handoffInFlight ?? Promise.resolve()
      .then(() => handoffRequested())
      .catch(() => false);
    state.handoffInFlight = handoffInFlight;
    void handoffInFlight.finally(() => {
      if (state.handoffInFlight === handoffInFlight) state.handoffInFlight = undefined;
    });
    const handoff = await settledWithin(handoffInFlight, PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS);
    if (handoff.timedOut || handoff.value !== true) throw new ProjectMcpNativeOwnershipBusyError(root);
  }

  if (!(state.active || state.transition)) return;
  const released = await settledWithin(state.available, PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS);
  if (released.timedOut) throw new ProjectMcpNativeOwnershipBusyError(root);
}

async function waitForNativeAvailability(root: string): Promise<void> {
  const state = ownershipState(root);
  while (state.active || state.transition) await requestNativeHandoff(root, state);
}
let poolGeneration = 0;
let shutdownInFlight: Promise<void> | undefined;

function normalizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildProjectMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeName(serverName)}__${normalizeName(toolName)}`;
}

/** Return the normalized project-server component of a canonical MCP tool name. */
export function projectMcpServerKeyForToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator < 1) return undefined;
  return rest.slice(0, separator);
}

/** Whether a canonical tool belongs to a configured project-local stdio server. */
export function isProjectMcpToolName(name: string, projectRoot: string): boolean {
  const key = projectMcpServerKeyForToolName(name);
  return key !== undefined
    && readProjectMcpServers(projectRoot).some((server) => normalizeName(server.name) === key);
}

function projectConfigPath(projectRoot: string): string | undefined {
  for (const candidate of [
    join(projectRoot, '.forgeax', 'mcp.json'),
    join(projectRoot, '.mcp.json'),
    join(projectRoot, 'mcp.json'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function readProjectMcpServers(projectRoot: string): ProjectServer[] {
  const path = projectConfigPath(projectRoot);
  if (!path) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    const entries = raw.mcpServers;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
    const out: ProjectServer[] = [];
    for (const [name, value] of Object.entries(entries as JsonObject)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const cfg = value as JsonObject;
      const type = cfg.type;
      if (type !== undefined && type !== 'stdio') continue;
      if (typeof cfg.command !== 'string' || !cfg.command.trim()) continue;
      const args = Array.isArray(cfg.args) && cfg.args.every((x) => typeof x === 'string')
        ? cfg.args as string[]
        : [];
      const env = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
        ? Object.fromEntries(Object.entries(cfg.env as JsonObject).filter(([, x]) => typeof x === 'string')) as Record<string, string>
        : undefined;
      out.push({ name, config: { command: cfg.command, args, ...(env ? { env } : {}) } });
    }
    return out;
  } catch {
    return [];
  }
}

/** Native ownership is only needed when a project actually has stdio MCP servers. */
export function hasProjectMcpServers(projectRoot: string): boolean {
  return readProjectMcpServers(resolve(projectRoot)).length > 0;
}

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private initialized = false;
  private closed = false;
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly server: ProjectServer, private readonly projectRoot: string) {
    const env = { ...process.env, ...(server.config.env ?? {}) } as NodeJS.ProcessEnv;
    this.child = spawn(server.config.command, server.config.args, {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    liveMcpClients.add(this);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.accept(chunk));
    // MCP diagnostics belong on stderr. Always consume the pipe so a noisy
    // server cannot block its own JSON-RPC stdout and make discovery appear
    // hung. The diagnostics are intentionally not surfaced to the model.
    this.child.stderr.resume();
    this.child.on('error', (error) => {
      this.closed = true;
      liveMcpClients.delete(this);
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      liveMcpClients.delete(this);
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.rejectAll(new Error(`MCP server ${server.name} exited (${code ?? signal ?? 'unknown'})`));
    });
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  private childRunning(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id !== 'number') continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'MCP JSON-RPC error'));
        else pending.resolve(message);
      } catch {
        // Ignore non-JSON diagnostics. MCP servers must keep stdout JSON-RPC clean.
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** Wait briefly after SIGTERM so production shutdown/tests can prove that
   * pooled MCP children have actually reaped, without hanging on a broken
   * third-party server forever. */
  async waitForExit(timeoutMs = 1_500): Promise<void> {
    if (!this.childRunning()) return;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.removeListener('exit', finish);
        this.child.removeListener('error', finish);
        resolveWait();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.child.once('exit', finish);
      this.child.once('error', finish);
      if (!this.childRunning()) finish();
    });
  }

  private request(method: string, params: JsonObject = {}): Promise<JsonRpcResponse> {
    if (!this.isAlive()) return Promise.reject(new Error(`MCP server ${this.server.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`MCP ${this.server.name} ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        // A timed-out JSON-RPC child is no longer trustworthy: retaining it
        // would make every later call pay the same timeout. Kill only this
        // server; sibling project MCP clients remain usable in the pool.
        this.rejectAll(error);
        this.close();
        reject(error);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async listTools(): Promise<JsonObject[]> {
    if (!this.initialized) {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'forgeax-orchestrator', version: '0.1.0' } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      this.initialized = true;
    }
    const response = await this.request('tools/list', {});
    const tools = response.result?.tools;
    return Array.isArray(tools) ? tools.filter((x): x is JsonObject => Boolean(x && typeof x === 'object' && !Array.isArray(x))) : [];
  }

  async callTool(name: string, args: unknown): Promise<JsonObject> {
    if (!this.initialized) await this.listTools();
    const response = await this.request('tools/call', { name, arguments: args ?? {} });
    return response.result ?? {};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error(`MCP server ${this.server.name} closed`));
    if (this.child.exitCode !== null || this.child.signalCode !== null || this.child.killed) return;
    try { this.child.kill('SIGTERM'); } catch { return; }
    this.closeTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 1_000);
    this.closeTimer.unref?.();
  }
}

async function discoverServer(server: ProjectServer, projectRoot: string): Promise<{
  server: ProjectServer;
  client?: StdioMcpClient;
  listed: JsonObject[];
}> {
  const client = new StdioMcpClient(server, projectRoot);
  try {
    return { server, client, listed: await client.listTools() };
  } catch {
    // Keep the failure scoped to this server. Other project MCP servers are
    // independent and their schemas/clients remain useful for this turn.
    client.close();
    await client.waitForExit();
    return { server, listed: [] };
  }
}

async function discover(projectRoot: string): Promise<{
  tools: ProjectMcpTool[];
  clients: Map<string, StdioMcpClient>;
  complete: boolean;
  failedServers: ProjectServer[];
}> {
  const clients = new Map<string, StdioMcpClient>();
  const tools: ProjectMcpTool[] = [];
  const servers = readProjectMcpServers(projectRoot);
  // MCP servers are independent. Starting them serially made the first user
  // message wait for the sum of all initialize/tools-list handshakes.
  const discovered = await Promise.all(servers.map((server) => discoverServer(server, projectRoot)));
  const failedServers: ProjectServer[] = [];
  for (const { server, client, listed } of discovered) {
    if (client) clients.set(server.name, client);
    else failedServers.push(server);
    for (const tool of listed) {
      if (typeof tool.name !== 'string' || !tool.name.trim()) continue;
      tools.push({
        name: buildProjectMcpToolName(server.name, tool.name),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema))
          ? tool.inputSchema as Record<string, unknown>
          : { type: 'object', properties: {} },
        serverName: server.name,
        remoteName: tool.name,
      });
    }
  }
  return { tools, clients, complete: failedServers.length === 0, failedServers };
}

function discoveryFingerprint(projectRoot: string): string {
  const path = projectConfigPath(projectRoot);
  if (!path) return `${projectRoot}\0none`;
  try {
    // Content, rather than only mtime, makes rapid save/replace operations
    // invalidate deterministically on filesystems with coarse timestamps.
    return `${path}\0${readFileSync(path, 'utf8')}`;
  } catch {
    return `${path}\0unreadable`;
  }
}

/**
 * Fingerprint used by long-lived provider sessions as well as this MCP pool.
 * A Claude stream keeps the `--mcp-config` snapshot it was started with, so a
 * project config edit must replace that session before the next turn.
 */
export function projectMcpConfigFingerprint(projectRoot: string): string {
  return discoveryFingerprint(resolve(projectRoot));
}

/**
 * Native MCP-capable providers mount project servers at their own protocol
 * boundary. They still need the canonical schemas during composition, but the
 * discovery clients must be schema-only; otherwise the same project server is
 * also kept alive by the host bridge. Providers not listed here use the pooled
 * host route, which is the only execution path available to them.
 */
export function projectMcpExecutionMode(
  kernelId: string,
  trustTier: 'own' | 'imported' | undefined,
): 'native' | 'host' {
  if (trustTier === 'imported') return 'host';
  return NATIVE_PROJECT_MCP_KERNELS.has(kernelId) ? 'native' : 'host';
}

function configuredIdleTtlMs(): number {
  const raw = process.env.FORGEAX_PROJECT_MCP_IDLE_TTL_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_TTL_MS;
}

function configuredPartialRetryIntervalMs(): number {
  const raw = process.env.FORGEAX_PROJECT_MCP_RETRY_MS?.trim();
  if (!raw) return PARTIAL_RETRY_INTERVAL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : PARTIAL_RETRY_INTERVAL_MS;
}

function finishClosePool(root: string, entry: ProjectMcpPoolEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  for (const client of entry.clients.values()) client.close();
  retiringPools.delete(entry);
  if (clientPool.get(root) === entry) clientPool.delete(root);
  tt('project-mcp.pool-evict', { reason, tools: entry.tools.length });
}

function closeDetachedPool(entry: ProjectMcpPoolEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  for (const client of entry.clients.values()) client.close();
  retiringPools.delete(entry);
  tt('project-mcp.pool-evict', { reason, tools: entry.tools.length });
}

async function waitForClientsToExit(clients: Iterable<StdioMcpClient>): Promise<void> {
  await Promise.all([...new Set(clients)].map((client) => client.waitForExit()));
}

/**
 * Native providers must be the only owner of their project MCP children for a
 * turn. The server prewarm and host-routed kernels may have populated the
 * shared pool first, so release that pool and wait for SIGTERM to be observed
 * before the provider mounts the same project config. A live host call gets a
 * bounded drain window; a broken/hung call is force-closed after the same
 * request timeout budget, so it cannot leave two owners indefinitely.
 */
async function closePoolBeforeNative(root: string, entry: ProjectMcpPoolEntry): Promise<void> {
  const clients = [...entry.clients.values()];
  const startedAt = Date.now();
  while (entry.activeCalls > 0 && Date.now() - startedAt < NATIVE_POOL_DRAIN_TIMEOUT_MS) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  const forced = entry.activeCalls > 0;
  closePool(root, entry, 'native-schema-only', forced);
  await waitForClientsToExit(clients);
  tt('project-mcp.native-pool-drain', {
    waitedMs: Date.now() - startedAt,
    forced,
    clients: clients.length,
  });
}

async function drainHostOwnership(root: string): Promise<void> {
  // Marking the native transition before entering here makes every new host
  // discovery wait. Work already in flight is drained explicitly, including a
  // schema-only discovery that has not installed a pooled entry yet.
  for (;;) {
    const pooledInFlight = discoveryInFlight.get(root);
    if (pooledInFlight) {
      const pooled = await pooledInFlight.promise.catch(() => undefined);
      if (pooled) await closePoolBeforeNative(root, pooled);
      continue;
    }
    const schemaInFlight = schemaDiscoveryInFlight.get(root);
    if (schemaInFlight) {
      await schemaInFlight.promise.catch(() => undefined);
      continue;
    }
    const retryInFlight = partialRetryInFlight.get(root);
    if (retryInFlight) {
      await retryInFlight.catch(() => undefined);
      continue;
    }
    const active = clientPool.get(root);
    if (active) {
      await closePoolBeforeNative(root, active);
      continue;
    }
    return;
  }
}

/**
 * Claim exclusive ownership of one project's native MCP config. The lease is
 * held for the complete lifetime of a native provider transport/turn. Host
 * discovery waits while it is active; an existing host pool is drained before
 * the lease is granted. This coordinates execution ownership without changing
 * the provider's MCP/plugin/skill/CLAUDE.md capability surface.
 */
export interface ProjectMcpNativeLease {
  release(): Promise<void>;
}

export interface ProjectMcpNativeLeaseOptions {
  /** Ask an existing native owner to close an idle transport or bounded-drain its turn. */
  onHandoffRequested?: () => Promise<boolean>;
}

export async function acquireProjectMcpNativeLease(
  projectRoot: string,
  options: ProjectMcpNativeLeaseOptions = {},
): Promise<ProjectMcpNativeLease> {
  const root = resolve(projectRoot);
  const closing = shutdownInFlight;
  if (closing) await closing;
  const state = ownershipState(root);
  const previous = state.tail;
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
  const tail = previous.then(() => queued);
  state.tail = tail;
  try {
    await requestNativeHandoff(root, state);
    const acquired = await settledWithin(previous, PROJECT_MCP_NATIVE_HANDOFF_TIMEOUT_MS);
    if (acquired.timedOut) throw new ProjectMcpNativeOwnershipBusyError(root);
  } catch (error) {
    releaseQueue();
    throw error;
  }

  // A shutdown can begin while this native lease is waiting behind another
  // owner. Do not mount a provider during that shutdown; retry after the
  // shared cleanup has completed.
  const closingAfterWait = shutdownInFlight;
  if (closingAfterWait) {
    releaseQueue();
    if (state.tail === tail) state.tail = Promise.resolve();
    await closingAfterWait;
    return acquireProjectMcpNativeLease(root, options);
  }

  const signal = newAvailabilitySignal();
  state.available = signal.promise;
  state.resolveAvailable = signal.resolve;
  let resolveTransition!: () => void;
  const transition = new Promise<void>((resolveTransitionDone) => { resolveTransition = resolveTransitionDone; });
  state.transition = transition;
  try {
    await drainHostOwnership(root);
    const closingDuringTransition = shutdownInFlight;
    if (closingDuringTransition) {
      state.transition = undefined;
      state.active = false;
      signal.resolve();
      releaseQueue();
      await closingDuringTransition;
      return acquireProjectMcpNativeLease(root, options);
    }
    state.active = true;
    state.handoff = options.onHandoffRequested;
    state.handoffInFlight = undefined;
    state.transition = undefined;
  } catch (error) {
    state.transition = undefined;
    state.active = false;
    state.handoff = undefined;
    state.handoffInFlight = undefined;
    signal.resolve();
    releaseQueue();
    if (state.tail === tail) state.tail = Promise.resolve();
    throw error;
  } finally {
    resolveTransition();
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      state.active = false;
      state.handoff = undefined;
      state.handoffInFlight = undefined;
      signal.resolve();
      releaseQueue();
      if (state.tail === tail) state.tail = Promise.resolve();
    },
  };
}

function closePool(root: string, entry: ProjectMcpPoolEntry, reason: string, force = false): void {
  if (!force && entry.activeCalls > 0) {
    entry.retiring = true;
    retiringPools.add(entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (clientPool.get(root) === entry) clientPool.delete(root);
    tt('project-mcp.pool-retire', { reason, activeCalls: entry.activeCalls, tools: entry.tools.length });
    return;
  }
  finishClosePool(root, entry, reason);
}

function finishRetiringPool(root: string, entry: ProjectMcpPoolEntry): void {
  if (entry.retiring && entry.activeCalls === 0) finishClosePool(root, entry, 'retired-idle');
}

function markServerFailed(root: string, entry: ProjectMcpPoolEntry, serverName: string, reason: string): void {
  const client = entry.clients.get(serverName);
  if (client) client.close();
  entry.clients.delete(serverName);
  entry.tools = entry.tools.filter((tool) => tool.serverName !== serverName);
  const server = readProjectMcpServers(root).find((candidate) => candidate.name === serverName);
  if (server && !entry.failedServers.some((candidate) => candidate.name === serverName)) {
    entry.failedServers.push(server);
  }
  const retryAt = Date.now() + configuredPartialRetryIntervalMs();
  entry.nextRetryAt = Math.min(entry.nextRetryAt || retryAt, retryAt);
  cacheTools(root, entry.fingerprint, entry.tools, entry.failedServers, entry.nextRetryAt, entry.retryDelayMs);
  tt('project-mcp.client-failed', { server: serverName, healthyClients: entry.clients.size, reason });
  if (entry.clients.size === 0 && entry.failedServers.length > 0) {
    closePool(root, entry, reason);
  }
}

function armPoolIdleTimer(root: string, entry: ProjectMcpPoolEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const ttl = configuredIdleTtlMs();
  if (ttl <= 0) return;
  entry.idleTimer = setTimeout(() => {
    if (clientPool.get(root) !== entry) return;
    if (entry.activeCalls > 0) {
      armPoolIdleTimer(root, entry);
      return;
    }
    if (Date.now() - entry.lastUsedAt < ttl) {
      armPoolIdleTimer(root, entry);
      return;
    }
    closePool(root, entry, 'idle-timeout');
  }, ttl);
  // The pool must never keep a CLI/server process alive during shutdown or tests.
  entry.idleTimer.unref?.();
}

function touchPool(root: string, entry: ProjectMcpPoolEntry): void {
  entry.lastUsedAt = Date.now();
  armPoolIdleTimer(root, entry);
}

function livePool(root: string, fingerprint: string): ProjectMcpPoolEntry | undefined {
  const entry = clientPool.get(root);
  if (!entry) return undefined;
  if (entry.fingerprint !== fingerprint) {
    closePool(root, entry, 'config-changed');
    discoveryCache.delete(root);
    return undefined;
  }
  for (const [serverName, client] of entry.clients) {
    if (client.isAlive()) continue;
    markServerFailed(root, entry, serverName, 'client-exited');
  }
  if (entry.clients.size === 0 && entry.failedServers.length > 0) {
    closePool(root, entry, 'client-exited');
    return undefined;
  }
  touchPool(root, entry);
  return entry;
}

function cacheToolSpecs(
  root: string,
  fingerprint: string,
  tools: readonly ToolSpec[],
  failedServers: ProjectServer[] = [],
  nextRetryAt = 0,
  retryDelayMs = configuredPartialRetryIntervalMs(),
): void {
  discoveryCache.set(root, {
    fingerprint,
    at: Date.now(),
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      ...(description ? { description } : {}),
      inputSchema,
    })),
    failedServers: failedServers.map(({ name, config }) => ({ name, config })),
    nextRetryAt,
    retryDelayMs,
  });
}

function cacheTools(
  root: string,
  fingerprint: string,
  tools: ProjectMcpTool[],
  failedServers: ProjectServer[] = [],
  nextRetryAt = 0,
  retryDelayMs = configuredPartialRetryIntervalMs(),
): void {
  cacheToolSpecs(
    root,
    fingerprint,
    tools.map(({ name, description, inputSchema }) => ({
      name,
      ...(description ? { description } : {}),
      inputSchema,
    })),
    failedServers,
    nextRetryAt,
    retryDelayMs,
  );
}

function schedulePartialRetry(root: string, entry: ProjectMcpPoolEntry): void {
  if (entry.failedServers.length === 0) return;
  const now = Date.now();
  if (now < entry.nextRetryAt) return;
  if (partialRetryInFlight.has(root)) return;
  const ownership = ownershipState(root);
  if (ownership.active || ownership.transition || shutdownInFlight) return;

  const retryDelayMs = entry.retryDelayMs;
  const generation = poolGeneration;
  entry.nextRetryAt = now + retryDelayMs;
  const retry = (async (): Promise<void> => {
    const results = await Promise.all(entry.failedServers.map((server) => discoverServer(server, root)));
    if (
      poolGeneration !== generation
      || clientPool.get(root) !== entry
      || discoveryFingerprint(root) !== entry.fingerprint
      || entry.retiring
      || ownershipState(root).active
      || ownershipState(root).transition
      || shutdownInFlight
    ) {
      for (const result of results) result.client?.close();
      await waitForClientsToExit(results.flatMap((result) => result.client ? [result.client] : []));
      return;
    }
    const stillFailed: ProjectServer[] = [];
    for (const result of results) {
      if (!result.client) {
        stillFailed.push(result.server);
        continue;
      }
      entry.clients.set(result.server.name, result.client);
      entry.tools = entry.tools.filter((candidate) => candidate.serverName !== result.server.name);
      for (const tool of result.listed) {
        if (typeof tool.name !== 'string' || !tool.name.trim()) continue;
        entry.tools.push({
          name: buildProjectMcpToolName(result.server.name, tool.name),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema))
            ? tool.inputSchema as Record<string, unknown>
            : { type: 'object', properties: {} },
          serverName: result.server.name,
          remoteName: tool.name,
        });
      }
    }
    entry.failedServers = stillFailed;
    if (stillFailed.length === 0) {
      entry.retryDelayMs = configuredPartialRetryIntervalMs();
      entry.nextRetryAt = 0;
    } else {
      entry.retryDelayMs = Math.min(MAX_PARTIAL_RETRY_INTERVAL_MS, retryDelayMs * 2);
      entry.nextRetryAt = Date.now() + entry.retryDelayMs;
    }
    cacheTools(root, entry.fingerprint, entry.tools, entry.failedServers, entry.nextRetryAt, entry.retryDelayMs);
    tt('project-mcp.partial-retry', {
      recovered: results.length - stillFailed.length,
      failed: stillFailed.length,
      tools: entry.tools.length,
    });
  })().catch((error) => {
    tt('project-mcp.partial-retry-failed', { error: (error as Error).message });
  });
  partialRetryInFlight.set(root, retry);
  void retry.finally(() => {
    if (partialRetryInFlight.get(root) === retry) partialRetryInFlight.delete(root);
  });
}

async function discoverAndPool(root: string, fingerprint: string): Promise<ProjectMcpPoolEntry | undefined> {
  const closing = shutdownInFlight;
  if (closing) {
    await closing;
    return discoverAndPool(root, fingerprint);
  }
  const admissionGeneration = poolGeneration;
  await waitForNativeAvailability(root);
  // The native wait is an admission point. Shutdown may have completed while
  // this caller was waiting behind a provider transport; do not let that
  // waiter become a new child after the shutdown sweep has returned.
  if (shutdownInFlight || poolGeneration !== admissionGeneration) return undefined;
  const current = discoveryInFlight.get(root);
  if (current?.fingerprint === fingerprint) {
    tt('project-mcp.inflight-wait');
    return current.promise;
  }

  const inFlightEntry: { fingerprint: string; promise?: Promise<ProjectMcpPoolEntry | undefined> } = { fingerprint };
  const generation = poolGeneration;
  const promise = (async (): Promise<ProjectMcpPoolEntry | undefined> => {
    const startedAt = Date.now();
    // Native schema-only discovery and the host pool are two different
    // execution owners for the same project MCP config. If schema discovery
    // already owns the config, wait for it to finish and reap its children
    // before starting a host pool. The symmetric check in
    // discoverSchemasOnly waits for an existing host discovery.
    const schemaInFlight = schemaDiscoveryInFlight.get(root);
    if (schemaInFlight?.fingerprint === fingerprint) {
      await schemaInFlight.promise.catch(() => undefined);
      if (poolGeneration !== generation) return undefined;
    }
    const discovered = await discover(root);
    const isCurrent = discoveryInFlight.get(root)?.promise === inFlightEntry.promise
      && discoveryFingerprint(root) === fingerprint
      && poolGeneration === generation;
    // Keep a partial pool when at least one server initialized successfully.
    // The old all-or-nothing behavior discarded healthy schemas and clients
    // whenever an unrelated server (for example a browser MCP) was slow or
    // unavailable, forcing every following turn through the same cold
    // handshakes and hiding the healthy tools from the model.
    if ((!discovered.complete && discovered.clients.size === 0) || !isCurrent) {
      for (const client of discovered.clients.values()) client.close();
      await waitForClientsToExit(discovered.clients.values());
      const cached = discoveryCache.get(root);
      if (isCurrent && cached?.fingerprint === fingerprint && cached.failedServers.length > 0) {
        // An idle-evicted partial pool can temporarily lose every child during
        // a background rebuild. Keep the last known healthy schemas and carry
        // the retry metadata forward instead of turning a transient outage
        // into a permanent empty catalog.
        cached.failedServers = readProjectMcpServers(root);
        cached.retryDelayMs = Math.min(MAX_PARTIAL_RETRY_INTERVAL_MS, cached.retryDelayMs * 2);
        cached.nextRetryAt = Date.now() + cached.retryDelayMs;
        cached.at = Date.now();
      } else if (isCurrent && discovered.failedServers.length > 0) {
        // All configured servers failed. Remember the failure briefly so every
        // concurrent/next turn does not synchronously pay another full MCP
        // handshake timeout. A later call retries after the bounded backoff.
        const previousDelay = cached?.fingerprint === fingerprint ? cached.retryDelayMs : configuredPartialRetryIntervalMs();
        const retryDelayMs = Math.min(MAX_PARTIAL_RETRY_INTERVAL_MS, previousDelay);
        cacheTools(
          root,
          fingerprint,
          discovered.tools,
          discovered.failedServers,
          Date.now() + retryDelayMs,
          retryDelayMs,
        );
      }
      tt('project-mcp.discover', {
        ms: Date.now() - startedAt,
        servers: readProjectMcpServers(root).length,
        tools: discovered.tools.length,
        complete: discovered.complete,
        failed: discovered.failedServers.map((server) => server.name),
        cache: 'miss',
        retained: false,
      });
      return undefined;
    }

    const tools = discovered.tools.map(({ name, description, inputSchema, serverName, remoteName }) => ({
      name,
      ...(description ? { description } : {}),
      inputSchema,
      serverName,
      remoteName,
    }));
    const entry: ProjectMcpPoolEntry = {
      fingerprint,
      tools,
      clients: discovered.clients,
      failedServers: discovered.failedServers,
      activeCalls: 0,
      lastUsedAt: Date.now(),
      nextRetryAt: discovered.failedServers.length > 0 ? Date.now() + configuredPartialRetryIntervalMs() : 0,
      retryDelayMs: configuredPartialRetryIntervalMs(),
      retiring: false,
    };
    const old = clientPool.get(root);
    if (old && old !== entry) closePool(root, old, 'replaced');
    clientPool.set(root, entry);
    cacheTools(root, fingerprint, tools, entry.failedServers, entry.nextRetryAt, entry.retryDelayMs);
    armPoolIdleTimer(root, entry);
    tt('project-mcp.discover', {
      ms: Date.now() - startedAt,
      servers: readProjectMcpServers(root).length,
      tools: tools.length,
      complete: discovered.complete,
      failed: discovered.failedServers.map((server) => server.name),
      cache: 'miss',
      retained: true,
    });
    return entry;
  })();
  inFlightEntry.promise = promise;
  discoveryInFlight.set(root, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (discoveryInFlight.get(root)?.promise === promise) discoveryInFlight.delete(root);
  }
}

async function ensurePooledDiscovery(root: string): Promise<ProjectMcpPoolEntry | undefined> {
  const fingerprint = discoveryFingerprint(root);
  const active = livePool(root, fingerprint);
  if (active) {
    schedulePartialRetry(root, active);
    tt('project-mcp.pool-hit', { tools: active.tools.length });
    return active;
  }
  const cached = discoveryCache.get(root);
  const configuredCount = readProjectMcpServers(root).length;
  if (
    cached?.fingerprint === fingerprint
    && configuredCount > 0
    && cached.failedServers.length >= configuredCount
    && cached.tools.length === 0
    && Date.now() < cached.nextRetryAt
  ) {
    tt('project-mcp.failure-backoff', { retryInMs: cached.nextRetryAt - Date.now(), servers: configuredCount });
    return undefined;
  }
  return discoverAndPool(root, fingerprint);
}

async function discoverSchemasOnlyCold(root: string, fingerprint: string, refresh = false): Promise<ToolSpec[]> {
  const active = livePool(root, fingerprint);
  if (active) {
    const tools = [
      ...(discoveryCache.get(root)?.tools ?? active.tools.map(({ name, description, inputSchema }) => ({
        name,
        ...(description ? { description } : {}),
        inputSchema,
      }))),
    ];
    await closePoolBeforeNative(root, active);
    return tools;
  }

  // The server prewarm/another host turn may still be discovering its pool.
  // Wait for that single discovery, then release its clients before the native
  // provider is allowed to mount the same project config.
  const pooledInFlight = discoveryInFlight.get(root);
  if (pooledInFlight?.fingerprint === fingerprint) {
    const pooled = await pooledInFlight.promise;
    if (pooled) {
      const tools = [
        ...(discoveryCache.get(root)?.tools ?? pooled.tools.map(({ name, description, inputSchema }) => ({
          name,
          ...(description ? { description } : {}),
          inputSchema,
        }))),
      ];
      await closePoolBeforeNative(root, pooled);
      return tools;
    }
  }

  const cached = discoveryCache.get(root);
  const current = schemaDiscoveryInFlight.get(root);
  if (!refresh && cached?.fingerprint === fingerprint) {
    const now = Date.now();
    if (cached.failedServers.length > 0 && now >= cached.nextRetryAt && !current) {
      // This is an actual refresh. Calling the cache-facing function without a
      // force bit only returned the same stale entry and never retried.
      cached.nextRetryAt = now + cached.retryDelayMs;
      void discoverSchemasOnly(root, fingerprint, true).catch(() => { /* next turn retries */ });
    }
    return [...cached.tools];
  }
  if (current?.fingerprint === fingerprint) return current.promise;

  const generation = poolGeneration;
  const promise = (async (): Promise<ToolSpec[]> => {
    const startedAt = Date.now();
    const discovered = await discover(root);
    const isCurrent = discoveryFingerprint(root) === fingerprint && poolGeneration === generation;
    for (const client of discovered.clients.values()) client.close();
    await waitForClientsToExit(discovered.clients.values());
    if (!isCurrent) return [];

    const previous = discoveryCache.get(root);
    const previousMatches = previous?.fingerprint === fingerprint;
    // Preserve the last known healthy native schemas if every server failed on
    // a transient refresh; otherwise one flaky server would erase all tools.
    const tools = (!discovered.complete && discovered.clients.size === 0 && previousMatches)
      ? previous.tools
      : discovered.tools.map(({ name, description, inputSchema }) => ({
          name,
          ...(description ? { description } : {}),
          inputSchema,
        }));
    const failedServers = (!discovered.complete && discovered.clients.size === 0 && previousMatches)
      ? readProjectMcpServers(root)
      : discovered.failedServers;
    const baseRetryDelayMs = configuredPartialRetryIntervalMs();
    const retryDelayMs = failedServers.length > 0
      ? Math.min(
          MAX_PARTIAL_RETRY_INTERVAL_MS,
          previousMatches ? Math.max(baseRetryDelayMs, previous.retryDelayMs * 2) : baseRetryDelayMs,
        )
      : baseRetryDelayMs;
    cacheToolSpecs(
      root,
      fingerprint,
      tools,
      failedServers,
      failedServers.length > 0 ? Date.now() + retryDelayMs : 0,
      retryDelayMs,
    );
    tt('project-mcp.schema-only', {
      ms: Date.now() - startedAt,
      servers: readProjectMcpServers(root).length,
      tools: tools.length,
      complete: discovered.complete,
      failed: failedServers.map((server) => server.name),
    });
    return [...tools];
  })();
  schemaDiscoveryInFlight.set(root, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (schemaDiscoveryInFlight.get(root)?.promise === promise) schemaDiscoveryInFlight.delete(root);
  }
}

async function discoverSchemasOnly(root: string, fingerprint: string, refresh = false): Promise<ToolSpec[]> {
  const closing = shutdownInFlight;
  if (closing) {
    await closing;
    return discoverSchemasOnly(root, fingerprint, refresh);
  }

  if (!hasProjectMcpServers(root)) return [];

  // A valid schema cache needs no child process. It can be returned while a
  // prewarmed native transport owns the config, but a live host pool must be
  // drained so the caller can immediately mount the native MCP config.
  if (!refresh) {
    const cached = discoveryCache.get(root);
    if (cached?.fingerprint === fingerprint) {
      const ownership = ownershipState(root);
      if (!ownership.active && !ownership.transition
        && (clientPool.has(root) || discoveryInFlight.has(root))) {
        const lease = await acquireProjectMcpNativeLease(root);
        await lease.release();
      }
      const now = Date.now();
      if (cached.failedServers.length > 0 && now >= cached.nextRetryAt && !schemaDiscoveryInFlight.has(root)) {
        cached.nextRetryAt = now + cached.retryDelayMs;
        void discoverSchemasOnly(root, fingerprint, true).catch(() => { /* next turn retries */ });
      }
      return [...cached.tools];
    }
  }

  const admissionGeneration = poolGeneration;
  const lease = await acquireProjectMcpNativeLease(root);
  try {
    // A shutdown can begin in the await above, after the native lease has
    // drained the host pool but before schema discovery registers itself as an
    // in-flight operation. Do not let that narrow window spawn a late child.
    if (shutdownInFlight || poolGeneration !== admissionGeneration) return [];
    return await discoverSchemasOnlyCold(root, fingerprint, refresh);
  } finally {
    await lease.release();
  }
}

export interface ProjectMcpDiscoveryOptions {
  /** Keep live stdio clients for the host bridge. Native provider turns only
   * need schemas and must close discovery clients before mounting their own
   * MCP server, otherwise the same project server starts twice. */
  retainPool?: boolean;
}

export async function discoverProjectMcpTools(
  projectRoot: string,
  options: ProjectMcpDiscoveryOptions = {},
): Promise<ToolSpec[]> {
  const root = resolve(projectRoot);
  const fingerprint = discoveryFingerprint(root);
  if (options.retainPool === false) return discoverSchemasOnly(root, fingerprint);
  const now = Date.now();
  const active = livePool(root, fingerprint);
  if (active) {
    schedulePartialRetry(root, active);
    tt('project-mcp.cache-hit', { ageMs: now - (discoveryCache.get(root)?.at ?? now), tools: active.tools.length });
    return [...(discoveryCache.get(root)?.tools ?? [])];
  }
  const cached = discoveryCache.get(root);
  if (cached && cached.fingerprint === fingerprint) {
    if (cached.failedServers.length > 0 && now >= cached.nextRetryAt && !discoveryInFlight.has(root)) {
      // Schema delivery remains non-blocking after idle eviction. The next
      // actual tool call still awaits a live pool; this background path only
      // restores missing servers without making the first byte wait for them.
      cached.nextRetryAt = now + cached.retryDelayMs;
      void discoverAndPool(root, fingerprint).catch(() => { /* next turn retries */ });
    }
    tt('project-mcp.schema-cache-hit', { ageMs: now - cached.at, tools: cached.tools.length });
    return [...cached.tools];
  }
  const pooled = await discoverAndPool(root, fingerprint);
  return pooled
    ? pooled.tools.map(({ name, description, inputSchema }) => ({ name, ...(description ? { description } : {}), inputSchema }))
    : [];
}

export interface ProjectMcpBridge {
  callIfKnown(name: string, args: unknown): Promise<unknown | undefined>;
  close(): void;
}

export function createProjectMcpBridge(projectRoot: string): ProjectMcpBridge {
  const root = resolve(projectRoot);
  let closed = false;
  const ensure = async (): Promise<ProjectMcpPoolEntry> => {
    if (closed) throw new Error('MCP bridge is closed');
    const state = await ensurePooledDiscovery(root);
    if (!state) throw new Error('MCP project server discovery failed');
    return state;
  };
  return {
    async callIfKnown(name, args) {
      const state = await ensure();
      const tool = state.tools.find((candidate) => candidate.name === name);
      if (!tool) return undefined;
      const client = state.clients.get(tool.serverName);
      if (!client || !client.isAlive()) {
        markServerFailed(root, state, tool.serverName, 'client-exited-during-call');
        throw new Error(`MCP server unavailable: ${tool.serverName}`);
      }
      state.activeCalls += 1;
      if (!state.retiring) touchPool(root, state);
      let result: JsonObject;
      try {
        result = await client.callTool(tool.remoteName, args);
      } catch (error) {
        // A request timeout closes the child. Isolate that server now so a
        // healthy sibling remains callable and the next turn can retry only
        // the failed server.
        if (!client.isAlive()) markServerFailed(root, state, tool.serverName, 'client-failed-during-call');
        throw error;
      } finally {
        state.activeCalls = Math.max(0, state.activeCalls - 1);
        if (!state.retiring) touchPool(root, state);
        finishRetiringPool(root, state);
      }
      if (result.isError === true) {
        throw new Error(JSON.stringify(result));
      }
      if (Array.isArray(result.content)) {
        const text = result.content
          .filter((part) => part && typeof part === 'object' && (part as JsonObject).type === 'text')
          .map((part) => String((part as JsonObject).text ?? ''))
          .join('\n');
        if (text) return text;
      }
      return result.structuredContent ?? result.content ?? result;
    },
    close() {
      // A bridge is a per-turn handle; releasing it must not kill the shared
      // project MCP processes. The pool owns their lifecycle and evicts them
      // after the configured idle TTL or a config/health change.
      closed = true;
    },
  };
}

/** Test-only cleanup; production lifecycle is idle TTL/config/health driven. */
export function resetProjectMcpPoolForTests(): void {
  poolGeneration += 1;
  const entries = new Set<ProjectMcpPoolEntry>([
    ...clientPool.values(),
    ...retiringPools,
  ]);
  for (const [root, entry] of clientPool) closePool(root, entry, 'test-reset', true);
  for (const entry of entries) {
    if (entry.retiring) closeDetachedPool(entry, 'test-reset');
  }
  // Failed/retired clients may no longer be reachable through a pool entry,
  // but the live-child registry still knows how to terminate them.
  for (const client of liveMcpClients) client.close();
  discoveryCache.clear();
  discoveryInFlight.clear();
  schemaDiscoveryInFlight.clear();
  partialRetryInFlight.clear();
  retiringPools.clear();
}

async function closeAllProjectMcpPools(reason: string): Promise<void> {
  const entries = new Set<ProjectMcpPoolEntry>([
    ...clientPool.values(),
    ...retiringPools,
  ]);
  const clients = new Set<StdioMcpClient>([
    ...[...entries].flatMap((entry) => [...entry.clients.values()]),
    ...liveMcpClients,
  ]);
  for (const [root, entry] of [...clientPool]) closePool(root, entry, reason, true);
  for (const entry of [...retiringPools]) {
    // It is already detached from clientPool, so use the force path directly.
    closeDetachedPool(entry, reason);
  }
  clientPool.clear();
  retiringPools.clear();
  // Use the registry snapshot, not only pool membership: failed, retrying and
  // late-created children are all subject to the same close + reap barrier.
  for (const client of clients) client.close();
  await waitForClientsToExit(clients);
}

/** Production shutdown hook: terminate every pooled project MCP child. */
export async function shutdownProjectMcpPool(): Promise<void> {
  if (shutdownInFlight) return shutdownInFlight;
  const shutdown = (async () => {
    // Invalidate every discovery/retry started before shutdown. Those
    // promises are awaited below because they may still own children that are
    // not present in clientPool yet.
    poolGeneration += 1;
    const inFlight = [
      ...[...discoveryInFlight.values()].map(({ promise }) => promise),
      ...[...schemaDiscoveryInFlight.values()].map(({ promise }) => promise),
      ...[...partialRetryInFlight.values()],
    ];
    await closeAllProjectMcpPools('shutdown');
    await Promise.allSettled(inFlight);
    // A discovery can finish after the first pool snapshot. Its generation
    // check closes it, but this second sweep also covers a child that became
    // visible during that finalization window.
    await closeAllProjectMcpPools('shutdown-finalize');
    discoveryCache.clear();
    discoveryInFlight.clear();
    schemaDiscoveryInFlight.clear();
    partialRetryInFlight.clear();
  })();
  const settled = shutdown.finally(() => {
    shutdownInFlight = undefined;
  });
  shutdownInFlight = settled;
  return settled;
}
