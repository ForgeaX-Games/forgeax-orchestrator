import { getEnabledBuiltinTools } from '../orchestration-seams';
import { canonicalAgentManagementToolName } from '../kits/agent-management-visibility';
import { FORGEAX_BUILTIN_TOOL_NAME_SET } from './builtin-tool-roster';

/** Return the name that must be present in the embedder's builtin opt-in seam. */
export function builtinOptInName(name: string): string | undefined {
  const agentManagementName = canonicalAgentManagementToolName(name);
  if (agentManagementName) return agentManagementName;
  return FORGEAX_BUILTIN_TOOL_NAME_SET.has(name) ? name : undefined;
}

/**
 * Enforce the same builtin opt-in at execution boundaries as at composition.
 * Non-builtin host/extension tools remain governed by their own trust and
 * visibility policies.
 */
export function isBuiltinToolEnabled(
  name: string,
  enabled = getEnabledBuiltinTools(),
): boolean {
  const optInName = builtinOptInName(name);
  return optInName === undefined || enabled.has(optInName);
}
