import type { ActionCatalogEntry, ActionPrecondition } from './action-catalog-contract';
type ActionCatalogDeclaration = Omit<ActionCatalogEntry, 'schema'>;

const NO_ARGS_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
} as const);
const GENERIC_RESULT_SCHEMA = Object.freeze({ type: 'object' } as const);
const NO_PRECONDITIONS = Object.freeze([]) as readonly ActionPrecondition[];

function precondition(
  id: string,
  description: string,
  errorCode: string,
): ActionPrecondition {
  return Object.freeze({ id, description, errorCode });
}




/** Orchestration-owned role and session lifecycle actions. */
export const BUILTIN_ACTION_DECLARATIONS = [
{
    id: 'role.create',
    title: '创建新角色',
    description:
      'Mint a NEW teammate/agent role when no existing role in the roster fits. Args: id (single segment [a-zA-Z0-9_-]) + persona (markdown: who they are / what they are good at / when to delegate to them / what they produce) + optional displayName / role / avatar / color / scope("global"|"project") / tools(host-tool allow globs). The new role persists and joins the roster (delegate_to_subagent can then dispatch it). Duplicate ids are rejected, never overwritten.',
    argsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '单段 [a-zA-Z0-9_-];如 "level-designer"' },
        persona: { type: 'string', description: '角色 markdown:是谁 / 擅长什么 / 何时被派 / 产出什么' },
        displayName: {
          type: 'object',
          properties: { zh: { type: 'string' }, en: { type: 'string' } },
        },
        role: { type: 'string', description: "定位,如 'pillar' / 'artist' / 'peer'" },
        avatar: { type: 'string', description: 'emoji / 单字符' },
        color: { type: 'string', description: '#hex' },
        scope: { type: 'string', enum: ['global', 'project'] },
        tools: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'persona'],
    },
    resultSchema: GENERIC_RESULT_SCHEMA,
    preconditions: [
      precondition(
        'role-id-available',
        'The requested id does not already exist in the role roster.',
        'role-id-conflict',
      ),
    ],
    effect: 'write',
    exposedToAI: true,
    requireConfirm: false,
    capability: 'delegate',
    firstClass: true,
    surface: 'both',
    timeoutMs: 15_000,
  },
{
    id: 'role.list',
    title: '列出角色',
    description: 'List all currently dispatchable roles (plugin agents + built-ins). Returns { count, roles:[{id,role,displayName,source}] }.',
    argsSchema: NO_ARGS_SCHEMA,
    resultSchema: GENERIC_RESULT_SCHEMA,
    preconditions: NO_PRECONDITIONS,
    effect: 'read',
    exposedToAI: true,
    requireConfirm: false,
    capability: 'read',
    firstClass: true,
    surface: 'both',
  },
{
    id: 'session.create',
    title: '新建会话',
    description: 'Create a new chat session (optionally named) and switch to it.',
    argsSchema: { type: 'object', properties: { displayName: { type: 'string' } } },
    resultSchema: GENERIC_RESULT_SCHEMA,
    preconditions: NO_PRECONDITIONS,
    effect: 'write',
    exposedToAI: true,
    requireConfirm: false,
    capability: 'write',
    firstClass: true,
    surface: 'both',
    timeoutMs: 20_000,
  },
{
    id: 'session.close',
    title: '关闭会话',
    description: 'Close (delete) a chat session by sid. Destructive: the session and its history are removed from disk.',
    argsSchema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] },
    resultSchema: GENERIC_RESULT_SCHEMA,
    preconditions: [
      precondition(
        'session-exists',
        'The requested sid identifies a session in the current game scope.',
        'session-not-found',
      ),
    ],
    effect: 'destructive',
    exposedToAI: true,
    requireConfirm: true,
    capability: 'delete',
    firstClass: true,
    surface: 'both',
    timeoutMs: 15_000,
  },
{
    id: 'sessions.list',
    title: '列出会话',
    description: 'List chat sessions of the current game scope. Returns sid/displayName rows in stateDigest.',
    argsSchema: NO_ARGS_SCHEMA,
    resultSchema: GENERIC_RESULT_SCHEMA,
    preconditions: NO_PRECONDITIONS,
    effect: 'read',
    exposedToAI: true,
    requireConfirm: false,
    capability: 'read',
    surface: 'both',
  }
] as const satisfies readonly ActionCatalogDeclaration[];
