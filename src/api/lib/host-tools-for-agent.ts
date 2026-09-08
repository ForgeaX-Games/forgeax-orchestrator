/**
 * host-tools-for-agent —— 纯函数:给定 (sid, agentId),算出该 agent **应当**看到的
 * host 工具(插件 `provides.tools` 里 exposedToAI + 有 handler + 命中 agent.json 的
 * host-tools allow)映射成中立 ToolSpec。
 *
 * 为什么需要它:conscious-agent(forgeax-native)路径经 kits `host_tool_bridge` 把这些
 * 工具注册进 agent 的 tool registry,再由 conscious-agent 取出当 extraTools 下发内核。
 * 但 **`/api/cli/chat`(租用内核 cbc/cc/codex 的聊天入口)不经 conscious-agent**,
 * 之前 composeTurnRequest 完全不带 agent host-tools → 插件工具(team + gen3d 等)
 * 对租用内核**不可见**。本 helper 让 cli/chat 用与桥**同一套** allow 过滤规则,无需
 * 一个活着的 conscious agent 就能算出该下发哪些 host 工具。
 *
 * 与 `host_tool_bridge.ts` 的 desiredTools()/toInputSchema()/globToRegExp() 同规则
 * (故意保持一致);差别只是数据源:桥读 AgentContext.getAgentJson(),这里从磁盘读
 * `<sid>/agents/<agentId>/agent.json`。LLM 可见名同样把 `:`/`.` → `_`。
 */
import { readFileSync } from 'node:fs';
import { getPathManager } from '../../fs/path-manager';
import { resolveHostToolAllow } from '../../tools/host-tool-allow';
import { selectAgentHostToolDescriptors } from '../../tools/agent-host-tool-surface';
import {
  readAgentKitsConfig,
  visibleAgentManagementToolsFromConfig,
  type AgentManagementToolName,
} from '../../kits/agent-management-visibility';
export {
  AGENT_MANAGEMENT_TOOL_NAMES,
  visibleAgentManagementToolsFromConfig,
} from '../../kits/agent-management-visibility';
import delegateToSubagent from '../../../builtin/kits/agent_manage/tools/delegate_to_subagent';
import listSubagents from '../../../builtin/kits/agent_manage/tools/list_subagents';
import type { ToolDefinition } from '../../core/types';

export interface HostToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** ToolDescriptor.argsSchema(内联对象 或 schema 文件绝对路径)→ JSONSchema 对象。 */
function toInputSchema(argsSchema: unknown): Record<string, unknown> {
  let schema: unknown = argsSchema;
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(readFileSync(schema, 'utf-8'));
    } catch {
      schema = undefined;
    }
  }
  if (schema && typeof schema === 'object') {
    const s = schema as Record<string, unknown>;
    if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
      return {
        type: 'object',
        properties: s.properties as Record<string, unknown>,
        ...(Array.isArray(s.required) ? { required: s.required } : {}),
      };
    }
  }
  return { type: 'object', properties: {} };
}

const AGENT_MANAGEMENT_TOOLS = [delegateToSubagent, listSubagents] as const;

/** Return the host-graph copy of an agent-management tool.
 *
 * Desktop kits are shipped as independently bundled runtime assets. Their
 * tool objects are valid declarations, but stateful execution must not run
 * through that bundle: doing so would read a second `session-registry`
 * module instance and report "SessionManager not initialized" even though
 * the host process has a live manager. Both HTTP and in-process bridges use
 * this resolver so execution stays in the host's shared module graph. */
export function canonicalAgentManagementTool(
  name: AgentManagementToolName,
): ToolDefinition | undefined {
  return AGENT_MANAGEMENT_TOOLS.find((tool) => tool.name === name);
}

function readAgentAllowDeny(sid: string | undefined, agentId: string): {
  allow: string[];
  deny: string[];
  visibleAgentManagementTools: AgentManagementToolName[];
} {
  // Rented kernels execute host tools through a session-scoped HTTP bridge.
  // Without the sid (or without an authoritative agent config), advertising
  // agent-management tools would create capabilities that the fxt process
  // cannot actually run.
  if (!sid) return { allow: [], deny: [], visibleAgentManagementTools: [] };
  try {
    const kits = readAgentKitsConfig(sid, agentId);
    if (!kits) return { allow: [], deny: [], visibleAgentManagementTools: [] };
    const cfg = kits.config?.['host-tools'] ?? {};
    const allow = Array.isArray(cfg.allow) ? cfg.allow.filter((x): x is string => typeof x === 'string') : [];
    const deny = Array.isArray(cfg.deny) ? cfg.deny.filter((x): x is string => typeof x === 'string') : [];
    return {
      allow,
      deny,
      visibleAgentManagementTools: visibleAgentManagementToolsFromConfig(kits),
    };
  } catch {
    return { allow: [], deny: [], visibleAgentManagementTools: [] };
  }
}

export interface HostToolSurface {
  /** Merged host specs, including any extension-owned duplicate wire names. */
  specs: HostToolSpec[];
  /** Visibility of the canonical builtin agent_manage descriptors only. */
  visibleAgentManagementTools: AgentManagementToolName[];
}

/** Resolve the complete host surface once so specs and canonical visibility
 * are read from the same `(sid, agentId)` config snapshot. */
export function hostToolSurfaceForAgent(sid: string | undefined, agentId: string): HostToolSurface {
  const { allow: sessionAllow, deny, visibleAgentManagementTools } = readAgentAllowDeny(sid, agentId);
  const allow = resolveHostToolAllow(agentId, sessionAllow);
  const visibleNames = new Set<string>(visibleAgentManagementTools);
  const agentManagement: HostToolSpec[] = AGENT_MANAGEMENT_TOOLS
    .filter((tool) => visibleNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    }));
  if (allow.length === 0) return { specs: agentManagement, visibleAgentManagementTools };
  let descriptors: ReturnType<typeof selectAgentHostToolDescriptors>;
  try {
    descriptors = selectAgentHostToolDescriptors(agentId, sessionAllow, deny);
  } catch {
    descriptors = [];
  }
  const host = descriptors
    .map((d) => ({
      name: d.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
      description: d.description ?? d.id,
      inputSchema: toInputSchema(d.argsSchema),
    }));
  return {
    specs: [...agentManagement, ...host],
    visibleAgentManagementTools,
  };
}

/** 该 agent 应下发给内核的 host 工具(ToolSpec)。无权威 sid/config → 空集；
 * agent_manage 是内置能力，只有确认未被禁用时才补入。 */
export function hostToolSpecsForAgent(sid: string | undefined, agentId: string): HostToolSpec[] {
  return hostToolSurfaceForAgent(sid, agentId).specs;
}
