import { globToRegExp } from '../tools/host-tool-allow';

/** Agent-owned grants for capabilities outside its resolved kit/host-tool
 * surface. Tokens match canonical wire names, with `*` as the only wildcard.
 * These do not replace host-tools allow/deny, kernel-native toolPolicy or trust
 * checks. Missing fields grant nothing in that namespace. */
export interface AgentToolGrants {
  host?: readonly string[];
  skills?: readonly string[];
  projectMcp?: readonly string[];
}

/** The Brand assistant is the product coordinator. Its source adapter installs
 * this explicit policy; matching an agent id is never enough to receive it. */
export const COORDINATOR_TOOL_GRANTS: AgentToolGrants = {
  host: ['*'], skills: ['*'], projectMcp: ['*'],
};

// Product opt-in and agent_manage kit visibility still apply. These are the
// reusable agent interaction, planning, memory and delegation infrastructure;
// product UI, asset and project MCP tools are deliberately not infrastructure.
const INFRASTRUCTURE = new Set([
  'ask_user', 'todo_write', 'memory_search', 'remember',
  'delegate_to_subagent', 'list_subagents',
]);

export function parseAgentToolGrants(value: unknown): AgentToolGrants {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('toolGrants must be an object');
  }
  const raw = value as Record<string, unknown>;
  const result: AgentToolGrants = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'host' && key !== 'skills' && key !== 'projectMcp') {
      throw new Error(`unknown toolGrants namespace: ${key}`);
    }
    const tokens = raw[key];
    if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error(`toolGrants.${key} must be an array of nonempty wire-name globs`);
    }
    result[key] = [...tokens];
  }
  return result;
}

export function createAgentToolScope(grants: unknown, declaredNames: readonly string[] = []) {
  const policy = parseAgentToolGrants(grants);
  const declared = new Set(declaredNames);
  const patterns = {
    host: (policy.host ?? []).map(globToRegExp),
    skills: (policy.skills ?? []).map(globToRegExp),
    projectMcp: (policy.projectMcp ?? []).map(globToRegExp),
  };
  return {
    hasProjectMcpGrants: patterns.projectMcp.length > 0 || declaredNames.some((name) => name.startsWith('mcp__')),
    allows(name: string): boolean {
      if (declared.has(name) || INFRASTRUCTURE.has(name)) return true;
      const namespace = name.startsWith('mcp__') ? 'projectMcp'
        : name.startsWith('skill_') ? 'skills' : 'host';
      return patterns[namespace].some((pattern) => pattern.test(name));
    },
  };
}
