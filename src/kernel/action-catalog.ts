/**
 * Trusted server-side action declarations.
 *
 * M1 keeps these contract types local to forgeax-cli. Promote them to
 * `@forgeax/types` in M2 once the server and UI projections share the contract.
 */
export type ActionCapability =
  | 'read'
  | 'write'
  | 'delete'
  | 'exec'
  | 'network'
  | 'credential'
  | 'delegate'
  | 'other';

export type ActionSurface = 'ui' | 'server' | 'both';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonSchemaObject = { readonly [key: string]: JsonValue };

export interface ActionCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly schema?: JsonSchemaObject;
  readonly capability: ActionCapability;
  readonly surface?: ActionSurface;
  readonly timeoutMs?: number;
  /** 是否每轮作为独立 ToolSpec 常驻模型上下文。缺省/false 仍可经通用目录发现。
   *  新增 true 只用于领域入口/发现能力,或已有可复核跨场景高频证据的能力;
   *  PR 必须说明命中哪条及上下文成本。现有 14 项是存量兼容基线,不据此扩张。 */
  readonly firstClass?: boolean;
  /** 状态性前置条件 —— 事实,不是行为指南。只写"世界需要什么样",禁写顺序规则。
   *  反例(现有 description 里这类句式不许进本字段):
   *  "Discover existing roles first via role.list" / "list existing slugs"。
   *  缺省 = 无已知前置;空数组非法(缺席=无,不用空数组冒充)。 */
  readonly preconditions?: readonly string[];
  /** 门位**事实**(不是行为指南):这个能力的人类入口在哪。
   *  - menuCommandId:菜单叶子用了别的 command id(同一能力两个名字)时的别名,
   *    如 game.switch 的菜单门走 game.pick。门对账凭它把两个 id 认成同一能力。
   *  缺省 = 无声明;对账仍会拿 actionId 自己去菜单树里配。
   *  2026-08-06 撤除 railTab/railMode:host.sidebar 无发布者(上游 Page 重构后
   *  rail 从未接入 surface 总线),声明这两类门会让对账以最高置信度把 agent 指向
   *  必死的 open('rail:...')。rail 重新发布后按需恢复 —— 恢复时 compileEntry 的
   *  unknown-key 校验会大声报错,提醒同步这里与 action-door。 */
  readonly door?: { readonly menuCommandId?: string };
}

export const HEADLESS_ACTION_GRANDFATHER_IDS = Object.freeze([
  'game.create',
  'game.switch',
  'session.rename',
  'sessions.refresh',
] as const);

export interface ActionCatalogBuildOptions {
  readonly headlessHandlerActionIds: readonly string[];
  readonly grandfatheredHeadlessActionIds: readonly string[];
}

/**
 * M1 migration bundle, transcribed from interface's 23 builtin actions and
 * two trajectory actions. Client-only run/available/choices functions stay out.
 */
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
    id: 'game.switch',
    title: '切换游戏',
    door: { menuCommandId: 'game.pick' },
    description: 'Select the active game (project) by slug. Every open Studio page follows the server authority.',
    schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    capability: 'write',
    firstClass: true,
    surface: 'both',
    timeoutMs: 20_000,
    preconditions: [
      'The requested slug must identify an existing game.',
    ],
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

const VALID_CAPABILITIES: ReadonlySet<string> = new Set<ActionCapability>([
  'read',
  'write',
  'delete',
  'exec',
  'network',
  'credential',
  'delegate',
  'other',
]);

const VALID_SURFACES: ReadonlySet<string> = new Set<ActionSurface>(['ui', 'server', 'both']);

interface ActionCatalogSnapshot {
  readonly all: readonly ActionCatalogEntry[];
  readonly firstClass: readonly ActionCatalogEntry[];
  readonly byId: ReadonlyMap<string, ActionCatalogEntry>;
}

const EMPTY_ENTRIES = Object.freeze([]) as readonly ActionCatalogEntry[];

let currentCatalog: ActionCatalogSnapshot = Object.freeze({
  all: EMPTY_ENTRIES,
  firstClass: EMPTY_ENTRIES,
  byId: new Map<string, ActionCatalogEntry>(),
});
let activeHeadlessRegistryOptions: Readonly<ActionCatalogBuildOptions> | undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidJson(path: string): never {
  throw new Error(`schema contains a non-JSON value at ${path}`);
}

function cloneAndFreezeJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJson(path);
    return value;
  }
  if (typeof value !== 'object') invalidJson(path);

  const objectValue = value as object;
  if (ancestors.has(objectValue)) invalidJson(path);
  ancestors.add(objectValue);

  if (Array.isArray(value)) {
    const clone: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) invalidJson(`${path}[${index}]`);
      clone.push(cloneAndFreezeJson(descriptor.value, `${path}[${index}]`, ancestors));
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) invalidJson(path);
    ancestors.delete(objectValue);
    return Object.freeze(clone);
  }

  if (!isPlainObject(value)) invalidJson(path);
  const clone: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidJson(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalidJson(`${path}.${key}`);
    Object.defineProperty(clone, key, {
      value: cloneAndFreezeJson(descriptor.value, `${path}.${key}`, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(objectValue);
  return Object.freeze(clone);
}

function requireString(
  raw: Record<string, unknown>,
  field: 'id' | 'title',
  declarationIndex: number,
): string {
  const value = raw[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`ActionCatalog: declaration ${declarationIndex} has invalid ${field}`);
  }
  return value;
}

function compileEntry(raw: unknown, declarationIndex: number): ActionCatalogEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`ActionCatalog: declaration ${declarationIndex} must be a plain object`);
  }

  const id = requireString(raw, 'id', declarationIndex);
  const title = requireString(raw, 'title', declarationIndex);
  const capability = raw.capability;
  if (typeof capability !== 'string' || !VALID_CAPABILITIES.has(capability)) {
    throw new Error(`ActionCatalog: action "${id}" has unsupported capability "${String(capability)}"`);
  }

  const description = raw.description;
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`ActionCatalog: action "${id}" has invalid description`);
  }

  let schema: JsonSchemaObject | undefined;
  if (raw.schema !== undefined) {
    if (!isPlainObject(raw.schema)) {
      throw new Error(`ActionCatalog: action "${id}" schema must be a plain JSON object`);
    }
    try {
      schema = cloneAndFreezeJson(raw.schema, '$', new Set()) as JsonSchemaObject;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`ActionCatalog: action "${id}" ${reason}`);
    }
  }

  const surface = raw.surface;
  if (surface !== undefined && (typeof surface !== 'string' || !VALID_SURFACES.has(surface))) {
    throw new Error(`ActionCatalog: action "${id}" has unsupported surface "${String(surface)}"`);
  }

  const timeoutMs = raw.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`ActionCatalog: action "${id}" has invalid timeoutMs`);
  }

  const firstClass = raw.firstClass;
  if (firstClass !== undefined && typeof firstClass !== 'boolean') {
    throw new Error(`ActionCatalog: action "${id}" has invalid firstClass flag`);
  }

  let preconditions: readonly string[] | undefined;
  if (raw.preconditions !== undefined) {
    if (!Array.isArray(raw.preconditions) || raw.preconditions.length === 0) {
      throw new Error(`ActionCatalog: action "${id}" preconditions must be a non-empty string array`);
    }
    if (raw.preconditions.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`ActionCatalog: action "${id}" preconditions must contain non-empty strings`);
    }
    preconditions = Object.freeze([...raw.preconditions]) as readonly string[];
  }

  // door 门位事实:构建层必须原样放行 —— 2026-08-05 实测,这里的白名单静默丢掉了
  // door,门对账拿不到别名事实,咽喉改道整条失效(agent 又走回无头直调)。
  // 2026-08-06:railTab/railMode 随 rail 死门下线一并撤出合法键 —— 有人重新声明时
  // 这里会大声报错,提醒先把 rail 面发布回 surface 总线再恢复 action-door 分支。
  let door: ActionCatalogEntry['door'];
  if (raw.door !== undefined) {
    if (!isPlainObject(raw.door)) throw new Error(`ActionCatalog: action "${id}" door must be a plain object`);
    const { menuCommandId, ...rest } = raw.door as Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error(`ActionCatalog: action "${id}" door has unknown keys ${Object.keys(rest).join(',')}`);
    if (menuCommandId !== undefined && typeof menuCommandId !== 'string') throw new Error(`ActionCatalog: action "${id}" door.menuCommandId must be a string`);
    door = Object.freeze({
      ...(menuCommandId !== undefined ? { menuCommandId } : {}),
    });
  }

  return Object.freeze({
    id,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(schema !== undefined ? { schema } : {}),
    capability: capability as ActionCapability,
    ...(surface !== undefined ? { surface: surface as ActionSurface } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(firstClass !== undefined ? { firstClass } : {}),
    ...(preconditions !== undefined ? { preconditions } : {}),
    ...(door !== undefined ? { door } : {}),
  });
}

function isHeadlessSurface(entry: ActionCatalogEntry): boolean {
  return entry.surface === 'server' || entry.surface === 'both';
}

function validateRegistryIds(
  ids: readonly string[],
  label: 'handler' | 'grandfather',
  issues: string[],
): Set<string> {
  if (!Array.isArray(ids)) {
    issues.push(`${label} action ids must be an array`);
    return new Set();
  }

  const unique = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
      issues.push(`${label} action id at index ${index} is invalid`);
      continue;
    }
    if (unique.has(id)) {
      issues.push(`duplicate headless ${label} action ${JSON.stringify(id)}`);
      continue;
    }
    unique.add(id);
  }
  return unique;
}

function validateHeadlessRegistry(
  entries: readonly ActionCatalogEntry[],
  byId: ReadonlyMap<string, ActionCatalogEntry>,
  options: ActionCatalogBuildOptions,
): void {
  const issues: string[] = [];
  const handlerIds = validateRegistryIds(options.headlessHandlerActionIds, 'handler', issues);
  const grandfatherIds = validateRegistryIds(
    options.grandfatheredHeadlessActionIds,
    'grandfather',
    issues,
  );

  for (const id of handlerIds) {
    const entry = byId.get(id);
    if (!entry) {
      issues.push(`orphan headless handler ${JSON.stringify(id)} is not declared`);
    } else if (!isHeadlessSurface(entry)) {
      issues.push(
        `orphan headless handler ${JSON.stringify(id)} targets non-headless surface ${JSON.stringify(entry.surface ?? 'ui')}`,
      );
    }
  }

  for (const id of grandfatherIds) {
    const entry = byId.get(id);
    if (!entry) {
      issues.push(`headless grandfather ${JSON.stringify(id)} is not declared`);
    } else if (!isHeadlessSurface(entry)) {
      issues.push(
        `headless grandfather ${JSON.stringify(id)} targets non-headless surface ${JSON.stringify(entry.surface ?? 'ui')}`,
      );
    } else if (handlerIds.has(id)) {
      issues.push(`headless grandfather ${JSON.stringify(id)} has a handler and must be removed`);
    }
  }

  for (const entry of entries) {
    if (
      isHeadlessSurface(entry) &&
      !handlerIds.has(entry.id) &&
      !grandfatherIds.has(entry.id)
    ) {
      issues.push(`missing headless handler for action ${JSON.stringify(entry.id)}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`ActionCatalog: headless registry mismatch:\n- ${issues.join('\n- ')}`);
  }
}

/**
 * Validate and publish a complete catalog in one swap. Failed builds leave the
 * previously published snapshot untouched.
 */
export function buildActionCatalog(
  declarations: readonly unknown[] = ACTION_CATALOG_DECLARATIONS,
  options?: ActionCatalogBuildOptions,
): readonly ActionCatalogEntry[] {
  if (!Array.isArray(declarations)) {
    throw new Error('ActionCatalog: declarations must be an array');
  }

  const byId = new Map<string, ActionCatalogEntry>();
  const entries: ActionCatalogEntry[] = [];
  for (const [index, raw] of declarations.entries()) {
    const entry = compileEntry(raw, index);
    if (byId.has(entry.id)) {
      throw new Error(`ActionCatalog: duplicate action id "${entry.id}"`);
    }
    byId.set(entry.id, entry);
    entries.push(entry);
  }

  const validationOptions = options ?? activeHeadlessRegistryOptions;
  if (validationOptions) validateHeadlessRegistry(entries, byId, validationOptions);

  const all = Object.freeze(entries);
  const firstClass = Object.freeze(entries.filter((entry) => entry.firstClass === true));
  const next = Object.freeze({ all, firstClass, byId });
  currentCatalog = next;
  if (options) {
    activeHeadlessRegistryOptions = Object.freeze({
      headlessHandlerActionIds: Object.freeze([...options.headlessHandlerActionIds]),
      grandfatheredHeadlessActionIds: Object.freeze([
        ...options.grandfatheredHeadlessActionIds,
      ]),
    });
  }
  return next.all;
}

export function _resetActionCatalogValidationForTests(): void {
  activeHeadlessRegistryOptions = undefined;
}

export function catalogGet(id: string): ActionCatalogEntry | undefined {
  return currentCatalog.byId.get(id);
}

export function catalogFirstClass(): readonly ActionCatalogEntry[] {
  return currentCatalog.firstClass;
}

export function catalogAll(): readonly ActionCatalogEntry[] {
  return currentCatalog.all;
}
