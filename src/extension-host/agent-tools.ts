export interface ExtensionAgentHost {
  listTools(gameId: string): ReadonlyArray<{
    readonly id: string;
    readonly description?: string;
    readonly inputSchema: string | Record<string, unknown>;
    readonly exposedToAI?: boolean;
  }>;
  toolInputSchema(toolId: string): Promise<unknown>;
  callTool(input: unknown): Promise<unknown>;
}

export interface ExtensionAgentTool {
  readonly id: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

let configuredHost: ExtensionAgentHost | undefined;
let configuredTools: ExtensionAgentTool[] = [];

function wireName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function objectSchema(value: unknown): Record<string, unknown> {
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === 'object'
  ) {
    return value as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

/**
 * Installs one shared Host executor and eagerly resolves public schemas before
 * any agent starts. Runtime calls remain game-bound and use the same Host
 * instance as the iframe HTTP adapter.
 */
export async function configureExtensionAgentTools(
  host: ExtensionAgentHost,
): Promise<void> {
  const exposed = host.listTools('catalog').filter((tool) => tool.exposedToAI === true);
  const projected = await Promise.all(exposed.map(async (tool) => ({
    id: tool.id,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: objectSchema(await host.toolInputSchema(tool.id)),
  })));

  const counts = new Map<string, number>();
  for (const tool of projected) {
    const wire = wireName(tool.id);
    counts.set(wire, (counts.get(wire) ?? 0) + 1);
  }
  configuredHost = host;
  configuredTools = projected.filter((tool) => counts.get(wireName(tool.id)) === 1);
}

export function listExtensionAgentTools(): ExtensionAgentTool[] {
  return configuredTools.map((tool) => ({
    ...tool,
    inputSchema: structuredClone(tool.inputSchema),
  }));
}

export function hasExtensionAgentTool(toolId: string): boolean {
  return configuredTools.some((tool) => tool.id === toolId);
}

export async function callExtensionTool(input: {
  readonly caller: 'ui' | 'ai';
  readonly gameId: string;
  readonly toolId: string;
  readonly args: unknown;
}): Promise<unknown> {
  if (!configuredHost) throw new Error('Extension agent Host is not configured');
  if (!configuredTools.some((tool) => tool.id === input.toolId)) {
    throw new Error(`Extension tool is not exposed to AI: ${input.toolId}`);
  }
  const result = await configuredHost.callTool({
    caller: input.caller,
    gameId: input.gameId,
    toolId: input.toolId,
    args: input.args,
  }) as {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (result?.ok === true) return result.result;
  const error = result?.error;
  const message = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Extension tool call failed';
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'invoke_error';
  throw Object.assign(new Error(message), { code });
}

export function callExtensionAgentTool(input: {
  readonly gameId: string;
  readonly toolId: string;
  readonly args: unknown;
}): Promise<unknown> {
  return callExtensionTool({ ...input, caller: 'ai' });
}

export function resetExtensionAgentToolsForTests(): void {
  configuredHost = undefined;
  configuredTools = [];
}
