/**
 * Host-tool allow resolution.
 *
 * Session `agent.json` `kits.config.host-tools.allow` is the recorded
 * snapshot from scaffold time. It does not update when an extension
 * ships new chat-callable tools, so a plugin that only sets `exposedToAI`
 * still looks missing in an existing conversation.
 *
 * This module unions, at list time:
 *   1. the session allowlist
 *   2. the live plugin or Brand assistant `tools` globs for this agent
 *   3. plugin tools marked `defaultAgentAllow` when this is the default
 *      conversation agent (Brand assistant / aliases)
 *
 * Empty after union still means opt-in deny-all for specialist agents.
 */
import { getExtensionSnapshot } from '../extensions/registry';
import { loadBrand } from '../brand';

const DEFAULT_AGENT_ALIASES = new Set(['forge', 'default', 'root']);

export interface HostToolAllowSource {
  personaTools: (agentId: string) => string[];
  defaultAgentId: string;
  defaultAgentToolIds: string[];
}

export function globToRegExp(token: string): RegExp {
  const escaped = token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function unionAllowTokens(...groups: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const token of group ?? []) {
      if (typeof token !== 'string' || !token || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export function agentLeafId(agentId: string): string {
  const segs = agentId.split('/').filter(Boolean).filter((s) => s !== 'agents');
  return segs[segs.length - 1] ?? agentId;
}

export function brandAssistantAgentId(): string {
  try {
    return loadBrand().config.assistant.agent.id || 'forge';
  } catch {
    return 'forge';
  }
}

function brandAssistantTools(agentId: string): string[] {
  try {
    const agent = loadBrand().config.assistant.agent;
    if (agent.id !== agentId) return [];
    return agent.tools?.filter((tool): tool is string => typeof tool === 'string') ?? [];
  } catch {
    return [];
  }
}

export function livePersonaTools(agentId: string): string[] {
  const leaf = agentLeafId(agentId);
  const plugin = getExtensionSnapshot().kinds.agents.find((a) => a.definition.id === leaf);
  const fromPlugin = plugin?.definition.tools?.filter((t): t is string => typeof t === 'string') ?? [];
  if (fromPlugin.length > 0) return fromPlugin;
  return brandAssistantTools(leaf);
}

export function defaultAgentHostToolIds(): string[] {
  return getExtensionSnapshot()
    .kinds.tools.filter((t) => t.exposedToAI && t.defaultAgentAllow)
    .map((t) => t.toolId);
}

export function isDefaultConversationAgent(
  agentId: string,
  defaultAgentId = brandAssistantAgentId(),
): boolean {
  const leaf = agentLeafId(agentId);
  return DEFAULT_AGENT_ALIASES.has(leaf) || leaf === defaultAgentId;
}

/** Session allow ∪ live persona globs ∪ plugin defaultAgentAllow ids (default agent only). */
export function resolveHostToolAllow(
  agentId: string,
  sessionAllow: string[],
  source?: Partial<HostToolAllowSource>,
): string[] {
  const personaTools = source?.personaTools?.(agentId) ?? livePersonaTools(agentId);
  const defaultId = source?.defaultAgentId ?? brandAssistantAgentId();
  const pluginDefaults = source?.defaultAgentToolIds ?? defaultAgentHostToolIds();
  const extra = isDefaultConversationAgent(agentId, defaultId) ? pluginDefaults : [];
  return unionAllowTokens(sessionAllow, personaTools, extra);
}
