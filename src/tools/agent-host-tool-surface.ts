/**
 * Canonical projection of product Host tools into one live Agent runtime.
 *
 * Desktop Kit assets are bundled independently from the Server sidecar. A Kit
 * plugin that imports the Host registries therefore observes its own module
 * graph, not the registries populated by the running product. Runtime-facing
 * advertisement and execution must be derived in the Server graph and use the
 * live AgentContext for allow/deny configuration.
 */
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AgentContext, ToolDefinition } from '../core/types';
import {
  callExtensionAgentTool,
  listExtensionAgentTools,
} from '../extension-host/agent-tools';
import { markHostToolDefinition } from '../kernel/host-tool-confirmation';
import { globToRegExp, resolveHostToolAllow } from './host-tool-allow';
import {
  callTool,
  hostToolWireName,
  listTools,
  type ToolDescriptor,
} from './registry';

interface HostToolsConfig {
  allow?: string[];
  deny?: string[];
}

function normalizeTokens(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function sharedDescriptor(tool: ReturnType<typeof listExtensionAgentTools>[number]): ToolDescriptor {
  return {
    id: tool.id,
    extensionId: '@forgeax/extension-host',
    description: tool.description,
    exposedToAI: true,
    hasHandler: true,
    argsSchema: tool.inputSchema,
  };
}

/**
 * Select the Host descriptors visible to an agent. The legacy/product registry
 * wins when the shared Extension Host projects the same id because it owns
 * confirmation policy and session-scoped game injection.
 */
export function selectAgentHostToolDescriptors(
  agentId: string,
  sessionAllow: readonly string[],
  deny: readonly string[],
): ToolDescriptor[] {
  const allowRes = resolveHostToolAllow(agentId, [...sessionAllow]).map(globToRegExp);
  if (allowRes.length === 0) return [];
  const denyRes = [...deny].map(globToRegExp);
  const visible = (id: string) =>
    allowRes.some((pattern) => pattern.test(id))
    && !denyRes.some((pattern) => pattern.test(id));

  const legacy = listTools().filter((descriptor) =>
    descriptor.exposedToAI
    && descriptor.hasHandler
    && visible(descriptor.id));
  const legacyIds = new Set(legacy.map((descriptor) => descriptor.id));
  const shared = listExtensionAgentTools()
    .filter((descriptor) => !legacyIds.has(descriptor.id) && visible(descriptor.id))
    .map(sharedDescriptor);

  // Different ids can normalize to the same LLM-facing wire name. Such a
  // collision is ambiguous and therefore omitted rather than chosen by order.
  const combined = [...legacy, ...shared];
  const counts = new Map<string, number>();
  for (const descriptor of combined) {
    const wire = hostToolWireName(descriptor.id);
    counts.set(wire, (counts.get(wire) ?? 0) + 1);
  }
  return combined.filter((descriptor) => counts.get(hostToolWireName(descriptor.id)) === 1);
}

function toInputSchema(argsSchema: unknown): ToolDefinition['input_schema'] {
  let schema = argsSchema;
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(readFileSync(schema, 'utf8'));
    } catch {
      schema = undefined;
    }
  }
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const value = schema as Record<string, unknown>;
    if (value.type === 'object' && value.properties && typeof value.properties === 'object') {
      return {
        type: 'object',
        properties: value.properties as Record<string, unknown>,
        ...(Array.isArray(value.required) ? { required: value.required as string[] } : {}),
      };
    }
  }
  return { type: 'object', properties: {} };
}

function definitionForDescriptor(
  descriptor: ToolDescriptor,
  ctx: AgentContext,
): ToolDefinition {
  return markHostToolDefinition({
    name: hostToolWireName(descriptor.id),
    description: descriptor.description ?? descriptor.id,
    input_schema: toInputSchema(descriptor.argsSchema),
    async execute(args) {
      if (descriptor.extensionId === '@forgeax/extension-host') {
        const result = await callExtensionAgentTool({
          gameId: basename(ctx.cwd),
          toolId: descriptor.id,
          args,
        });
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }
      const result = await callTool({
        toolId: descriptor.id,
        args,
        caller: {
          kind: 'ai',
          agentId: ctx.agentPath,
          ...(ctx.sid ? { sessionId: ctx.sid } : {}),
        },
      });
      if (result.ok) {
        return typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result, null, 2);
      }
      return JSON.stringify({ error: result.error, code: result.code });
    },
  }, descriptor.id);
}

/** Derive executable Host definitions from the live AgentContext. */
export function agentHostToolDefinitions(ctx: AgentContext): ToolDefinition[] {
  // A few legacy bridge seams construct the minimal AgentContext required for
  // builtin execution. Missing live config must fail closed instead of making
  // those unrelated tools crash at the projection boundary.
  if (typeof ctx.agentPath !== 'string' || !ctx.agentPath || typeof ctx.getAgentJson !== 'function') {
    return [];
  }
  const config = (ctx.getAgentJson().kits?.config?.['host-tools'] ?? {}) as HostToolsConfig;
  const descriptors = selectAgentHostToolDescriptors(
    ctx.agentPath,
    normalizeTokens(config.allow),
    normalizeTokens(config.deny),
  );
  return descriptors.map((descriptor) => definitionForDescriptor(descriptor, ctx));
}

/** Merge Kit and canonical Host definitions, preserving the Kit declaration on
 * an exact wire-name collision while filling product tools absent from a
 * separately bundled Kit registry. */
export function withAgentHostToolDefinitions(
  kitTools: readonly ToolDefinition[],
  ctx: AgentContext,
): ToolDefinition[] {
  const merged = [...kitTools];
  const seen = new Set(kitTools.map((tool) => tool.name));
  for (const tool of agentHostToolDefinitions(ctx)) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    merged.push(tool);
  }
  return merged;
}
