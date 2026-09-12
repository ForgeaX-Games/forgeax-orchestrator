/**
 * Trusted server-side action declarations.
 *
 * Hosts provide these pure-data contracts through ProductContext.
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
   *    门对账凭它把两个 id 认成同一能力。
   *  缺省 = 无声明;对账仍会拿 actionId 自己去菜单树里配。
   *  2026-08-06 撤除 railTab/railMode:host.sidebar 无发布者(上游 Page 重构后
   *  rail 从未接入 surface 总线),声明这两类门会让对账以最高置信度把 agent 指向
   *  必死的 open('rail:...')。rail 重新发布后按需恢复 —— 恢复时 compileEntry 的
   *  unknown-key 校验会大声报错,提醒同步这里与 action-door。 */
  readonly door?: { readonly menuCommandId?: string };
}

export interface ActionCatalogBuildOptions {
  /** Explicit host handlers: each must be declared and support headless execution. */
  readonly headlessHandlerActionIds: readonly string[];
  /** Available generic fallbacks, enabled only for declared IDs without a host handler. */
  readonly builtinHeadlessHandlerActionIds?: readonly string[];
  readonly grandfatheredHeadlessActionIds: readonly string[];
}

