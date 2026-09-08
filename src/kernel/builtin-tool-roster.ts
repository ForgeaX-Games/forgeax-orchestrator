/**
 * The canonical builtin tool roster shared by composition and host execution.
 *
 * Keeping the declarations outside the turn composer lets both execution
 * authorities enforce the same opt-in boundary without importing the full
 * composition pipeline. The roster is still derived into
 * `FORGEAX_BUILTIN_TOOL_NAMES`, so an embedder cannot enable a name that is not
 * actually part of the shared builtin surface.
 */
import uiBridgeContract from './ui-bridge-contract.json';
import askUserTool from '../../builtin/kits/workspace/tools/ask_user';
import { NPC_TOOL_CONTRACTS } from '@forgeax/types/npc-tools';
import delegateToSubagentTool from '../../builtin/kits/agent_manage/tools/delegate_to_subagent';
import listSubagentsTool from '../../builtin/kits/agent_manage/tools/list_subagents';

const TODO_WRITE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The full todo list (replaces the prior list).',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id; keep it unchanged across updates for the same task.' },
          content: { type: 'string', description: 'Imperative task description.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string', description: 'Present-continuous form shown while in_progress.' },
        },
        required: ['content', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
} as const;

/** 编排层声明的基础工具(中立 ToolSpec)。内核据此挂 MCP server + `--allowedTools` 放行。
 *  `memory_search`/`remember` = 数字生命(R6)通道,真实后端 = soul 分层记忆库。
 *  游戏语义工具(list_games/query_world/capture_frame)**不再硬编码于此**——由产品壳
 *  经 HostToolSpec seam 注入(阶段A §3.2),cli 层保持业务无关。 */
export const FORGEAX_TOOLS = [
  {
    name: askUserTool.name,
    description: askUserTool.description,
    inputSchema: askUserTool.input_schema,
  },
  // Sub-agent delegation. Rented kernels (claude-code / codex / cursor / kimi / cbc /
  // deepseek) have no built-in Task tool the way the forgeax-core sidecar facade does,
  // so without these two specs the whole roster is invisible on the kernel path and a
  // persona that says "hand this to X" can only *announce* a dispatch it cannot perform.
  // Execution already worked (host-tool bridge → the always-on `agent_manage` kit);
  // only the advertisement was missing. Description/schema are referenced from the kit
  // modules, never re-worded here, so the kit stays the single source of truth.
  {
    name: delegateToSubagentTool.name,
    description: delegateToSubagentTool.description,
    inputSchema: delegateToSubagentTool.input_schema,
  },
  {
    name: listSubagentsTool.name,
    description: listSubagentsTool.description,
    inputSchema: listSubagentsTool.input_schema,
  },
  {
    name: 'todo_write',
    description:
      'Create or replace the task plan for a multi-step request. Provide verb-led items and keep exactly one item in_progress, marking it completed when done; progress is tracked from these updates. (When to plan and how it is presented is defined by the product system prompt.)',
    inputSchema: TODO_WRITE_INPUT_SCHEMA,
  },
  {
    name: 'memory_search',
    description:
      "Search your long-term layered memory (identity / traits / episodes, including past-life worlds) for relevant entries. Returns { query, matches:[{tier, game?, file, text}] }.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'remember',
    description:
      "Persist a durable memory about the user or this game into your long-term layered memory so you recall it in future sessions (数字生命成长). kind:'general' = portable fact about the user (carries across games); kind:'game' = bound to the current game world.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['general', 'game'] }, title: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'soul_create',
    description: NPC_TOOL_CONTRACTS.soul_create.description,
    inputSchema: NPC_TOOL_CONTRACTS.soul_create.inputSchema,
  },
  {
    name: 'npc_wire',
    description: NPC_TOOL_CONTRACTS.npc_wire.description,
    inputSchema: NPC_TOOL_CONTRACTS.npc_wire.inputSchema,
  },
  // UI 语义操作层(产品 AI 化 P0):ui_snapshot / ui_invoke。契约 SSOT =
  // ui-bridge-contract.json(与 .mjs MCP server 共读同一文件 → 各内核看到字节一致的
  // 工具说明)。宿主侧实现在 forgeax-builtin-tools.ts,权限见 trust-gate 的 per-action 特判。
  ...uiBridgeContract.tools,
];

/** Every builtin is opt-in. Derived from FORGEAX_TOOLS itself (§2 Derive). */
export const FORGEAX_BUILTIN_TOOL_NAMES: readonly string[] = FORGEAX_TOOLS.map((tool) => tool.name);
export const FORGEAX_BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(FORGEAX_BUILTIN_TOOL_NAMES);
