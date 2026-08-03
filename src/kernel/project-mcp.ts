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

function normalizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildProjectMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeName(serverName)}__${normalizeName(toolName)}`;
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

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private initialized = false;

  constructor(private readonly server: ProjectServer, private readonly projectRoot: string) {
    const env = { ...process.env, ...(server.config.env ?? {}) } as NodeJS.ProcessEnv;
    this.child = spawn(server.config.command, server.config.args, {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.accept(chunk));
    this.child.on('error', (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    this.child.on('exit', (code, signal) => this.rejectAll(new Error(`MCP server ${server.name} exited (${code ?? signal ?? 'unknown'})`)));
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

  private request(method: string, params: JsonObject = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.server.name} ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
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
    this.rejectAll(new Error(`MCP server ${this.server.name} closed`));
    if (!this.child.killed) this.child.kill();
  }
}

async function discover(projectRoot: string): Promise<{ tools: ProjectMcpTool[]; clients: Map<string, StdioMcpClient> }> {
  const clients = new Map<string, StdioMcpClient>();
  const tools: ProjectMcpTool[] = [];
  for (const server of readProjectMcpServers(projectRoot)) {
    const client = new StdioMcpClient(server, projectRoot);
    try {
      const listed = await client.listTools();
      clients.set(server.name, client);
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
    } catch {
      client.close();
    }
  }
  return { tools, clients };
}

export async function discoverProjectMcpTools(projectRoot: string): Promise<ToolSpec[]> {
  const discovered = await discover(resolve(projectRoot));
  for (const client of discovered.clients.values()) client.close();
  return discovered.tools.map(({ name, description, inputSchema }) => ({
    name,
    ...(description ? { description } : {}),
    inputSchema,
  }));
}

export interface ProjectMcpBridge {
  callIfKnown(name: string, args: unknown): Promise<unknown | undefined>;
  close(): void;
}

export function createProjectMcpBridge(projectRoot: string): ProjectMcpBridge {
  let loaded: Promise<{ tools: ProjectMcpTool[]; clients: Map<string, StdioMcpClient> }> | undefined;
  const ensure = () => (loaded ??= discover(resolve(projectRoot)));
  return {
    async callIfKnown(name, args) {
      const state = await ensure();
      const tool = state.tools.find((candidate) => candidate.name === name);
      if (!tool) return undefined;
      const client = state.clients.get(tool.serverName);
      if (!client) throw new Error(`MCP server unavailable: ${tool.serverName}`);
      const result = await client.callTool(tool.remoteName, args);
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
      void loaded?.then((state) => { for (const client of state.clients.values()) client.close(); });
    },
  };
}
