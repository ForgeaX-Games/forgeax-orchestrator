/** Historical UI host fixture for routing/permission regressions, not a default
 * catalog or a product authority. Production Studio declarations live in Server.
 */
import { buildActionCatalog as compile, type ActionCatalogEntry, type ActionCatalogBuildOptions } from '../../src/kernel/action-catalog';
const ACTION_CATALOG_DECLARATIONS = [
  {
    id: 'panel.toggle_sidebar',
    title: '折叠/展开侧栏',
    description: 'Toggle the left sidebar collapsed state.',
    capability: 'write',
    surface: 'ui',
  },
  {
    id: 'panel.toggle_chatpanel',
    title: '折叠/展开聊天面板',
    description: 'Toggle the chat panel collapsed state.',
    capability: 'write',
    surface: 'ui',
  },
  {
    id: 'app.set_fullscreen',
    title: '沉浸模式',
    description: 'Enter or exit fullscreen (immersive) mode which hides all chrome around the main area.',
    schema: { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] },
    capability: 'write',
    surface: 'ui',
  },
  {
    id: 'extension.list',
    title: '列出扩展页面',
    description: 'List installed extensions that contribute pages. Returns { count, plugins:[{id,name,description}] }.',
    capability: 'read',
    firstClass: true,
    surface: 'ui',
  },
  {
    id: 'extension.open',
    title: '打开扩展页面',
    description: 'Open the Page contributed by a specific extension id. Discover valid ids via extension.list.',
    schema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] },
    capability: 'write',
    firstClass: true,
    surface: 'ui',
    preconditions: [
      'The target extension must contribute an available singleton page.',
    ],
  },
  {
    id: 'role.create',
    title: '创建新角色',
    description:
      'Mint a NEW teammate/agent role when no existing role in the roster fits. Args: id (single segment [a-zA-Z0-9_-]) + persona (markdown: who they are / what they are good at / when to delegate to them / what they produce) + optional displayName / role / avatar / color / scope("global"|"project") / tools(host-tool allow globs). The new role persists and joins the roster (delegate_to_subagent can then dispatch it). Duplicate ids are rejected, never overwritten.',
    schema: {
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
    capability: 'delegate',
    firstClass: true,
    surface: 'both',
    timeoutMs: 15_000,
    preconditions: [
      'The requested id must not already exist in the role roster.',
    ],
  },
  {
    id: 'role.list',
    title: '列出角色',
    description: 'List all currently dispatchable roles (plugin agents + built-ins). Returns { count, roles:[{id,role,displayName,source}] }.',
    capability: 'read',
    firstClass: true,
    surface: 'both',
  },
  {
    id: 'role.open',
    title: '打开角色页',
    description:
      'Open the roles/team Page. With { id } it also binds that role to the current chat session so its persona detail is shown.',
    schema: { type: 'object', properties: { id: { type: 'string' } } },
    capability: 'read',
    firstClass: true,
    surface: 'ui',
    preconditions: [
      'When id is provided, it must identify a role in the current roster.',
      'When id is provided, an active chat session must exist for the role binding.',
    ],
  },
  {
    id: 'overlay.open',
    title: '打开浮层',
    description: "Open an overlay by id (e.g. 'settings'). Optional param selects a section inside it.",
    schema: {
      type: 'object',
      properties: { id: { type: 'string' }, param: { type: 'string' } },
      required: ['id'],
    },
    capability: 'write',
    surface: 'ui',
    preconditions: [
      'The requested id must identify an overlay currently registered by the product shell.',
    ],
  },
  {
    id: 'overlay.close',
    title: '关闭浮层',
    description: 'Close the currently open overlay, if any.',
    capability: 'write',
    surface: 'ui',
  },
  {
    id: 'console.clear',
    title: '清空控制台',
    description:
      "Clear a collected console buffer. source:'browser' (default) clears the studio-shell browser console buffer PLUS the cross-tier health entries (fatal region banners are preserved). source:'game' clears the in-app game/editor console (store.consoleLog). Neither touches the raw browser DevTools buffer.",
    schema: { type: 'object', properties: { source: { type: 'string', enum: ['browser', 'game'] } } },
    capability: 'write',
    surface: 'ui',
  },
  {
    id: 'console.read',
    title: '读取控制台',
    description:
      "Read the studio's collected console feed. source:'browser' (default) = the full studio-shell browser console (ALL levels: log/info/warn/error/debug, captured into a 500-entry ring buffer) merged with cross-tier iframe/health signals (window.onerror, unhandled rejections, forwarded play/edit/plugin/engine health). source:'game' = the in-app game/editor console stream. Params: source ('browser'|'game'), level (filter), limit (default 50, max 200). Returns { source, total, count, lines } in the result. This is the studio's own captured console (a web page cannot read the raw browser DevTools buffer directly).",
    schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['browser', 'game'] },
        level: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    capability: 'read',
    firstClass: true,
    surface: 'ui',
  },
  {
    id: 'network.clear',
    title: '清空网络日志',
    description: 'Clear the in-app network log panel (store.networkLog). NOT the browser DevTools network tab.',
    capability: 'write',
    surface: 'ui',
  },
  {
    id: 'session.switch',
    title: '切换会话',
    description: 'Switch the active chat session to the given sid (see the session.tabs state slice for candidates).',
    schema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] },
    capability: 'write',
    firstClass: true,
    surface: 'ui',
    timeoutMs: 15_000,
  },
  {
    id: 'session.create',
    title: '新建会话',
    description: 'Create a new chat session (optionally named) and switch to it.',
    schema: { type: 'object', properties: { displayName: { type: 'string' } } },
    capability: 'write',
    firstClass: true,
    surface: 'both',
    timeoutMs: 20_000,
  },
  {
    id: 'session.close',
    title: '关闭会话',
    description: 'Close (delete) a chat session by sid. Destructive: the session and its history are removed from disk.',
    schema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] },
    capability: 'delete',
    firstClass: true,
    surface: 'both',
    timeoutMs: 15_000,
  },
  {
    id: 'session.rename',
    title: '重命名会话',
    description: 'Persistent session rename is not available in this Studio version; this action rejects instead of changing only the temporary tab label.',
    schema: {
      type: 'object',
      properties: { sid: { type: 'string' }, displayName: { type: 'string' } },
      required: ['sid', 'displayName'],
    },
    capability: 'write',
    surface: 'both',
  },
  {
    id: 'sessions.refresh',
    title: '刷新会话列表',
    description: 'Re-fetch the session list from the server.',
    capability: 'read',
    surface: 'both',
  },
  {
    id: 'sessions.list',
    title: '列出会话',
    description: 'List chat sessions of the current game scope. Returns sid/displayName rows in stateDigest.',
    capability: 'read',
    surface: 'both',
  },
  {
    id: 'game.create',
    title: '新建游戏',
    description: 'Create a new game (project) from the template and give it its own dedicated chat session. The action does not switch the UI to the new game.',
    schema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: '1-41 位小写字母/数字/连字符,首位字母或数字;如 "neon-runner"',
        },
        name: { type: 'string', description: '显示名(可选,缺省用 slug)' },
        brief: { type: 'string', description: '一句话说明要做什么游戏(可选,写进 FORGE.md)' },
      },
      required: ['slug'],
    },
    capability: 'write',
    firstClass: true,
    surface: 'both',
    timeoutMs: 20_000,
    preconditions: [
      'The requested slug must not already identify an existing game.',
    ],
  },
  {
    id: 'trajectory.read',
    title: '读取操作轨迹',
    description:
      'Read the recent trajectory of UI operations performed on the page by BOTH the human and the AI, ordered oldest→newest. Every operation dispatched through the action registry is recorded (page mode switches, panel toggles, session/game/role/extension ops, etc.). Use this to understand what the user just did before asking you something. Params: limit (default 50, max 200), source ("human"|"ai" to filter by who performed it). Returns { total, count, entries:[{seq,ts,id,title,source,capability,args}] } in the result.',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        source: { type: 'string', enum: ['human', 'ai'] },
      },
    },
    capability: 'read',
    firstClass: true,
    surface: 'ui',
  },
  {
    id: 'trajectory.clear',
    title: '清空操作轨迹',
    description:
      'Clear the recorded UI operation trajectory buffer. Returns { cleared } — how many entries were removed.',
    capability: 'write',
    surface: 'ui',
  },
] as const satisfies readonly ActionCatalogEntry[];

export const HEADLESS_ACTION_GRANDFATHER_IDS = Object.freeze([
  'game.create', 'session.rename', 'sessions.refresh',
] as const);
export function buildActionCatalog(declarations: readonly unknown[] = ACTION_CATALOG_DECLARATIONS, options?: ActionCatalogBuildOptions) {
  return compile(declarations, options);
}
