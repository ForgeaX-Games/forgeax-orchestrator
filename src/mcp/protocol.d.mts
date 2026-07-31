export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface McpServerSpec {
  serverInfo: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
  tools: readonly McpTool[] | (() => Promise<readonly McpTool[]> | readonly McpTool[]);
  onUnknownTool?: (name: string, tools: readonly McpTool[]) => Promise<unknown> | unknown;
}

export class RpcError extends Error {
  constructor(code: number, message: string);
  code: number;
}

export function textResult(text: string, isError?: boolean): Record<string, unknown>;
export function toToolResult(out: unknown): Record<string, unknown>;
export function defaultNotFound(name: string, tools: readonly McpTool[]): Record<string, unknown>;
export function createMcpDispatcher(
  spec: McpServerSpec,
): (message: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export function serveStdio(
  dispatch: ReturnType<typeof createMcpDispatcher>,
  streams?: { input?: Readable; output?: Writable },
): Promise<void>;
import type { Readable, Writable } from 'node:stream';
