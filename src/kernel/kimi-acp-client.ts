import * as acp from '@agentclientprotocol/sdk';
import type {
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  createKimiAcpMapperState,
  mapKimiAcpUpdate,
  permissionCallFromAcp,
  selectKimiPermissionOption,
  type KimiAcpMapperState,
} from './kimi-acp-mapper';
import type { KernelEvent, PermissionCall, PermissionDecision } from '@forgeax/agent-runtime';

export class KimiAcpAuthRequiredError extends Error {
  constructor(message = 'Kimi Code login required; run `kimi login`') {
    super(message);
    this.name = 'KimiAcpAuthRequiredError';
  }
}

export interface KimiAcpClientOptions {
  binary: string;
  cwd: string;
  envOverride?: Record<string, string | undefined>;
  onEvent(event: KernelEvent): void;
  onPermission(call: PermissionCall, request: RequestPermissionRequest): Promise<PermissionDecision>;
  onExit?(code: number | null, stderrTail: string): void;
}

interface SessionSetup {
  sessionId: string;
  configOptions: SessionConfigOption[];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAuthRequired(error: unknown): boolean {
  const text = errorText(error);
  return /auth[_ -]?required|login[_ -]?required|not authenticated|authentication required/i.test(text);
}

export class KimiAcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private stderrTail = '';
  private sessionId?: string;
  private mapper: KimiAcpMapperState = createKimiAcpMapperState();
  private initialized = false;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: KimiAcpClientOptions) {}

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode == null && !this.proc.killed;
  }

  async ensureStarted(): Promise<void> {
    if (this.alive && this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(this.options.envOverride ?? {})) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    const proc = spawn(this.options.binary, ['acp'], {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: isWindows,
      shell: isWindows && /\.(cmd|bat)$/i.test(this.options.binary),
    });
    this.proc = proc;
    this.stderrTail = '';
    this.mapper = createKimiAcpMapperState();

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    let exitReported = false;
    const reportExit = (code: number | null): void => {
      if (exitReported) return;
      exitReported = true;
      this.initialized = false;
      this.connection = null;
      try {
        this.options.onExit?.(code, this.stderrTail.split('\n').filter(Boolean).slice(-3).join(' | '));
      } catch {}
    };
    proc.on('error', (error) => {
      this.stderrTail = (this.stderrTail + `\n${error.message}`).slice(-4000);
      reportExit(null);
    });
    proc.on('exit', reportExit);

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin),
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    const client: acp.Client = {
      requestPermission: (params) => this.requestPermission(params),
      sessionUpdate: (params) => this.sessionUpdate(params),
    };
    const connection = new acp.ClientSideConnection(() => client, stream);
    this.connection = connection;
    try {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'forgeax', version: '0.1.0' },
      });
      this.initialized = true;
    } catch (error) {
      this.shutdown();
      throw error;
    }
  }

  async newSession(mcpServers: McpServer[] = []): Promise<SessionSetup> {
    await this.ensureStarted();
    try {
      const response = await this.requireConnection().newSession({ cwd: this.options.cwd, mcpServers });
      this.sessionId = response.sessionId;
      return { sessionId: response.sessionId, configOptions: response.configOptions ?? [] };
    } catch (error) {
      if (isAuthRequired(error)) throw new KimiAcpAuthRequiredError();
      throw error;
    }
  }

  async resumeSession(sessionId: string, mcpServers: McpServer[] = []): Promise<SessionSetup> {
    await this.ensureStarted();
    try {
      const response = await this.requireConnection().resumeSession({
        cwd: this.options.cwd,
        sessionId,
        mcpServers,
      });
      this.sessionId = sessionId;
      return { sessionId, configOptions: response.configOptions ?? [] };
    } catch (error) {
      if (isAuthRequired(error)) throw new KimiAcpAuthRequiredError();
      throw error;
    }
  }

  async setModel(model: string): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.requireConnection().setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: model,
    });
  }

  async prompt(text: string): Promise<PromptResponse> {
    return this.requireConnection().prompt({
      sessionId: this.requireSessionId(),
      prompt: [{ type: 'text', text }],
    });
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch {}
  }

  shutdown(): void {
    const proc = this.proc;
    this.proc = null;
    this.connection = null;
    this.initialized = false;
    if (!proc) return;
    const pid = proc.pid;
    const kill = (signal: NodeJS.Signals): void => {
      if (typeof pid === 'number' && pid > 0 && process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
          return;
        } catch {}
      }
      try { proc.kill(signal); } catch {}
    };
    try { proc.stdin.destroy(); } catch {}
    try { proc.stdout.destroy(); } catch {}
    try { proc.stderr.destroy(); } catch {}
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1000);
    timer.unref?.();
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) throw new Error('Kimi ACP connection is not running');
    return this.connection;
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error('Kimi ACP session is not initialized');
    return this.sessionId;
  }

  private async sessionUpdate(params: SessionNotification): Promise<void> {
    if (this.sessionId && params.sessionId !== this.sessionId) return;
    for (const event of mapKimiAcpUpdate(params.update, this.mapper)) {
      this.options.onEvent(event);
    }
  }

  private async requestPermission(params: RequestPermissionRequest) {
    const decision = await this.options.onPermission(permissionCallFromAcp(params), params);
    const optionId = selectKimiPermissionOption(params.options, decision);
    return optionId
      ? { outcome: { outcome: 'selected' as const, optionId } }
      : { outcome: { outcome: 'cancelled' as const } };
  }
}
