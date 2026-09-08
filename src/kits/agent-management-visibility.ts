import { BaseKitLoader } from './base-loader';
import { readFileSync } from 'node:fs';
import { getPathManager } from '../fs/path-manager';
import type { KitIdentity, KitsConfig } from './types';

/** The builtin tools owned by the agent_manage kit.
 *
 * Keep this identity list separate from the tool implementations so the
 * composer and the host-tool adapter can agree on the narrow agent-level
 * visibility seam without importing each other.
 */
export const AGENT_MANAGEMENT_TOOL_NAMES = [
  'delegate_to_subagent',
  'list_subagents',
] as const;

export type AgentManagementToolName = (typeof AGENT_MANAGEMENT_TOOL_NAMES)[number];

const AGENT_MANAGEMENT_TOOL_NAME_SET = new Set<string>(AGENT_MANAGEMENT_TOOL_NAMES);

/**
 * Resolve the canonical agent_manage wire name from either the bare LLM-facing
 * name or the qualified kit-registry name. Do not normalize arbitrary
 * `<kit>/tools/<name>` values here: an extension with the same final segment
 * is not the builtin agent_manage capability.
 */
export function canonicalAgentManagementToolName(
  name: string,
): AgentManagementToolName | undefined {
  if (AGENT_MANAGEMENT_TOOL_NAME_SET.has(name)) return name as AgentManagementToolName;
  const prefix = 'agent_manage/tools/';
  if (!name.startsWith(prefix)) return undefined;
  const bare = name.slice(prefix.length);
  return AGENT_MANAGEMENT_TOOL_NAME_SET.has(bare) ? bare as AgentManagementToolName : undefined;
}

function bareToolName(name: string): string {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
}

/** Keep kit execution aligned with the canonical advertisement projection.
 * Qualified registry names are accepted because KitToolLoader stores those
 * names internally while the wire surface uses bare names. */
export function filterVisibleAgentManagementTools<T extends { name?: string }>(
  tools: readonly T[],
  visible: ReadonlySet<string> | readonly string[],
): T[] {
  const visibleNames = visible instanceof Set ? visible : new Set(visible);
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? bareToolName(tool.name) : '';
    return !AGENT_MANAGEMENT_TOOL_NAME_SET.has(name) || visibleNames.has(name);
  });
}

/**
 * Canonical identities for the builtin `agent_manage/tools/*` descriptors.
 *
 * These are deliberately not derived from a merged host `ToolSpec`: an
 * extension manifest may register the same wire name, but it cannot become a
 * builtin kit descriptor by doing so. `BaseKitLoader.isVisibleByConfig` is the
 * single authority for the enable/disable token grammar.
 */
export const AGENT_MANAGEMENT_TOOL_IDENTITIES = [
  { name: 'delegate_to_subagent', pkg: 'agent_manage', layer: 'builtin' },
  { name: 'list_subagents', pkg: 'agent_manage', layer: 'builtin' },
] as const satisfies readonly (KitIdentity & { name: AgentManagementToolName })[];

function isWellFormedKitsConfig(value: unknown): value is KitsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  for (const key of ['enable', 'disable'] as const) {
    const tokens = config[key];
    if (tokens !== undefined && (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string'))) {
      return false;
    }
  }
  for (const key of ['user', 'session'] as const) {
    const layer = config[key];
    if (layer !== undefined && layer !== 'all' && layer !== 'none') return false;
  }
  return true;
}

/**
 * Resolve the canonical agent_manage visibility for one kits configuration.
 *
 * This preserves `BaseKitLoader.isVisibleByConfig` semantics for whole-kit,
 * bare-tool, qualified-tool, and wildcard tokens. Callers must pass this
 * result alongside any merged host tool specs; host specs never decide this
 * builtin visibility.
 */
export function visibleAgentManagementToolsFromConfig(
  config: KitsConfig | undefined,
): AgentManagementToolName[] {
  // An omitted argument is the direct-call default. A present but malformed
  // runtime value is different: do not let invalid config silently restore
  // builtin visibility.
  if (config !== undefined && !isWellFormedKitsConfig(config)) return [];
  const kits = config ?? {};
  return AGENT_MANAGEMENT_TOOL_IDENTITIES
    .filter((descriptor) => BaseKitLoader.isVisibleByConfig(descriptor, kits))
    .map((descriptor) => descriptor.name);
}

/** Read the authoritative kits config for a session agent. A missing sid,
 * unreadable agent.json, or malformed kits field fails closed as `undefined`;
 * a readable config with no overrides is the normal builtin-visible `{}`. */
export function readAgentKitsConfig(
  sid: string | undefined,
  agentPath: string,
): KitsConfig | undefined {
  if (!sid) return undefined;
  try {
    const path = getPathManager().session(sid).agent(agentPath).agentJson();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { kits?: unknown };
    if (parsed.kits === undefined) return {};
    if (!isWellFormedKitsConfig(parsed.kits)) return undefined;
    return parsed.kits as KitsConfig;
  } catch {
    return undefined;
  }
}

/** Resolve canonical agent_manage visibility directly from `(sid, agentPath)`.
 * This is the shared authority for rented-kernel and fork callers; merged host
 * tool names never participate in the decision. */
export function visibleAgentManagementToolsForAgent(
  sid: string | undefined,
  agentPath: string,
): AgentManagementToolName[] {
  const config = readAgentKitsConfig(sid, agentPath);
  // `undefined` means there is no authoritative agent config. The direct
  // config helper intentionally treats an omitted config as the normal
  // builtin-visible default, but an agent-resolved read must fail closed so
  // fork and host callers advertise the same executable surface.
  return config === undefined ? [] : visibleAgentManagementToolsFromConfig(config);
}
