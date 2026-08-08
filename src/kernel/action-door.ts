/** action-door —— 回答"这个 catalog action 有没有一扇人能看见的门",并在能证明
 *  语义等价时给出**可执行的行走信息**,让派发咽喉把执行改道给统一行走协议。
 *
 * 2026-08-04 实测:agent 用 ui_invoke(trajectory.read) 无头调用后,用户问
 * "它是从哪点出来的?"——答案是哪都点不出来,那个能力没有 UI 入口。问题不在
 * agent 走错路,在于工具没替它交代。
 *
 * 设计纪律(2026-08-05 重写)——**对账只消费事实,不携带 per-entry 指南**:
 *  - 事实来源三路:菜单树投影(host.menubar,叶子带 commandId/args,动态子菜单带
 *    childCommandId/childIdFromArg)、rail 投影(host.sidebar entries,当前无发布者
 *    恒 null,仅 workbench 对账在其真实在场时消费)、catalog 条目自己声明的 door
 *    事实(menuCommandId 别名)。
 *  - 提示语只按**类**存在(有门/无门/未知/仅网格可达),内容由事实填充。
 *  - 空投影 ≠ 无门。菜单投影缺席时输出"未知",绝不指控 headless —— 上一版按空集
 *    对账,把每一个有菜单门的能力都说成"屏幕上不会有任何变化"(2026-08-05 实测
 *    role.open 中招)。
 *  - 上一版还有 app.set_mode 的硬编码特判 —— per-entry 补丁,role.open 第二天就
 *    证明它不 scale。现在同类信息一律走 catalog 的 door 事实。
 */

interface MenuTreeNodeLike {
  id?: unknown;
  label?: unknown;
  commandId?: unknown;
  args?: unknown;
  dynamic?: unknown;
  childCommandId?: unknown;
  childIdFromArg?: unknown;
  children?: unknown;
}

/** 语义等价、可交给统一行走协议执行的门。 */
export interface DoorWalk {
  /** editor_ui_browse 可直接消费的链地址,如 `menu:file/打开最近`。 */
  chain: string;
  /** 静态叶子:链本身走到底即执行(open 一次调用完成)。 */
  kind: 'static-leaf' | 'dynamic-leaf';
  /** dynamic-leaf 专用:展开 chain 后,经 host.menubar.invoke 落在具体子项上。 */
  invoke?: { parentId: string; itemId: string };
}

export interface ActionDoor {
  visible: boolean;
  /** editor_ui_browse 可直接消费的链,如 `menu:window/聊天` 或 `rail:agents`。 */
  path?: string;
  /** 对账证据等级:found=投影里配上了;declared=仅 catalog 事实声明(投影缺席);
   *  unknown=投影缺席且无声明,无从对账;none=投影在场且确实无门。 */
  certainty: 'found' | 'declared' | 'unknown' | 'none';
  hint: string;
  /** 仅当语义等价可证明(同 commandId 同 args,或 catalog 别名事实背书)时给出。 */
  walk?: DoorWalk;
}

export interface DoorSources {
  /** host.menubar 投影的菜单树。 */
  menus?: unknown;
  /** host.sidebar 投影的 rail entries。2026-08-06 现状:该面无发布者(上游 Page
   *  重构后 rail 未接入 surface 总线),生产恒 null;仅 workbench 插件对账在它
   *  真实存在时消费 —— 空时按"未知"处理,绝不当"无门"。 */
  rail?: Array<{ id?: unknown; label?: unknown }> | null;
  /** catalog 条目声明的门位事实(action-catalog.ts `door` 字段)。 */
  fact?: { menuCommandId?: string };
}

/** 类级提示模板 —— 全文件只允许这几句散文,内容由事实填充。 */
const HINTS = {
  found: (path: string) =>
    `这个能力有可见的门:${path}。用户在场时优先用 editor_ui_browse open('${path}') 沿人类路径打开,让用户看见;ui_invoke 是无头直调,屏幕上不会展示路径。`,
  declared: (path: string) =>
    `按 catalog 声明,这个能力的门在 ${path};当前投影不可用,无法现场核实。用户在场时优先走 editor_ui_browse。`,
  unknown:
    '菜单投影此刻不可用(页面未打开或尚未重新注册),无法对账这个能力有没有可见的门。'
    + '**不要**据此告诉用户"没有入口"或"屏幕不会变化" —— 那是未知,不是否定。如实说明门位未知即可。',
  none:
    '菜单与 rail 的投影里都没有这个能力的入口 —— headless 能力,界面上没有对应控件。'
    + '请向用户说明:这是后台直调,屏幕上不会有任何变化;不要描述"打开了"某个并不存在的界面。',
  shellWidget:
    '菜单树里没有它,但它是 shell 级控件动作(面板/会话/控制台一类)—— 这类门通常是'
    + '界面上的小控件或 rail 页签,而不是菜单项,对账表覆盖不到。**不要**断言"屏幕上'
    + '不会有任何变化";如实说门位未知,需要定位就用 editor_ui_browse find 查 rail 与面板分支。',
  argsDiffer:
    '菜单里有同一个控件的门,但那一项声明的参数与这次调用的目标状态**不同** —— 沿它'
    + '走会得到相反/别的结果(如菜单只有「进入全屏」而你要退出)。不要打开那一项;'
    + '如需可见执行,请让用户手动操作,或改用与菜单项等价的参数调用。',
  railGridOnly: (label: string) =>
    `「${label}」已安装,但不在 rail 的固定分类清单里 —— rail 和「更多插件」里都看不到它。`
    + '用户仍可从**工作台网格**点到它(打开任一插件后点右上角 × 返回工作台,再点对应 tile)。'
    + '教路径时请教这一条真实存在的;并把"未收录进 rail 分类"作为产品缺口反馈给用户。',
} as const;

/** 等价性比较前的归一:{} 与 undefined 视为同一。两个真实调用方(MCP shim 与
 *  preflightUiToolDispatch)都把缺省参数补成 {},而菜单投影对无 args 的项整个省略
 *  args 键 —— 不归一,"无参数 + 有菜单门"的能力永远 argsDiffer,咽喉护栏 100% 失效
 *  (2026-08-05 终审实测 panel.toggle_chatpanel 中招)。 */
function normalizeArgs(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0
    ? undefined
    : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

interface MenuHit {
  menuId: string;
  prefix: string[];
  label: string;
  node: MenuTreeNodeLike;
  /** 命中的是动态子菜单的 childCommandId(叶子本身不在静态树里)。 */
  dynamicParent?: boolean;
  /** 同 commandId 但 args 不同:门存在,但目标状态不同,不能自动改道。 */
  argsDiffer?: boolean;
}

function findInMenus(menus: unknown, commandId: string, wantArgs: unknown): MenuHit | null {
  const tree = menus && typeof menus === 'object' ? (menus as Record<string, unknown>) : null;
  if (!tree) return null;
  let argMismatch: MenuHit | null = null;
  for (const [menuId, nodes] of Object.entries(tree)) {
    const walk = (list: MenuTreeNodeLike[], prefix: string[]): MenuHit | null => {
      for (const node of list) {
        const label = typeof node.label === 'string' ? node.label : String(node.id ?? '');
        if (node.commandId === commandId) {
          // 等价性:同 commandId 还要同 args(overlay.open{settings} ≠ overlay.open{shortcuts})。
          if (deepEqual(normalizeArgs(node.args), normalizeArgs(wantArgs))) return { menuId, prefix, label, node };
          if (!argMismatch) argMismatch = { menuId, prefix, label, node, argsDiffer: true };
        }
        if (node.childCommandId === commandId && node.dynamic) {
          return { menuId, prefix, label, node, dynamicParent: true };
        }
        if (Array.isArray(node.children)) {
          const hit = walk(node.children as MenuTreeNodeLike[], [...prefix, label]);
          if (hit) return hit;
        }
      }
      return null;
    };
    const hit = walk(Array.isArray(nodes) ? (nodes as MenuTreeNodeLike[]) : [], []);
    if (hit) return hit;
  }
  return argMismatch;
}

/** 对着各面自己的投影 + catalog 门位事实反查可见路径。 */
export function findVisibleDoor(
  sources: DoorSources | unknown,
  actionId: string,
  actionArgs?: unknown,
): ActionDoor {
  const src: DoorSources = sources && typeof sources === 'object'
    && ('menus' in (sources as object) || 'rail' in (sources as object) || 'fact' in (sources as object))
    ? (sources as DoorSources)
    : { menus: sources };
  const fact = src.fact ?? {};
  const args = actionArgs && typeof actionArgs === 'object' ? (actionArgs as Record<string, unknown>) : {};

  // 2026-08-06 删除 railMode/railTab 分支:railMode 此前**不查任何投影**就返回最高
  // 置信度 found + rail: 路径,而 host.sidebar 全树零发布者 —— open('rail:...') 必死,
  // 文案还让 agent 请用户"打开页面"(页面明明开着)。同文件 railTab 分支做了核实
  // 降级、railMode 却没有,是同一文件里的双标准。rail 重新接入总线后再恢复,恢复
  // 入口:action-catalog 的 door 校验会对 railTab/railMode 大声报错。

  // ── workbench 插件门:rail entries 精确对账;不在 rail ≠ 点不到(工作台网格兜底) ──
  if ((actionId === 'workbench.open_plugin' || actionId === 'workbench.open') && Array.isArray(src.rail)) {
    const wanted = [args.extensionId, args.tab, args.id].find((v) => typeof v === 'string' && v) as string | undefined;
    if (wanted) {
      const slug = wanted.replace(/^.*\//, '');
      const entry = src.rail.find((row) => typeof row.id === 'string'
        && (row.id === wanted || row.id === `wb:${slug}` || String(row.id).replace(/^wb:/, '') === slug.replace(/^wb-/, '')));
      if (entry && typeof entry.id === 'string') {
        const path = `rail:${entry.id}`;
        return { visible: true, path, certainty: 'found', hint: HINTS.found(path) };
      }
      const label = typeof args.extensionId === 'string' ? args.extensionId : wanted;
      // 2026-08-05 修正:上一版在这里指控"孤儿界面,用户自己点不到"。经实测工作台
      // 网格(installed − hidden)列出全部插件且 tile 可点 —— "不在 rail" 只证明
      // 不在 rail,不证明不可达。只对一个账源就下"没有"的结论,是本文件修过两次的病。
      return { visible: true, certainty: 'found', hint: HINTS.railGridOnly(label) };
    }
  }

  // ── 菜单门:actionId 本身,或 catalog 别名事实(同能力双 id) ──
  if (src.menus === null || src.menus === undefined) {
    return { visible: false, certainty: 'unknown', hint: HINTS.unknown };
  }
  for (const commandId of [actionId, ...(fact.menuCommandId ? [fact.menuCommandId] : [])]) {
    const hit = findInMenus(src.menus, commandId, commandId === actionId ? actionArgs : undefined);
    if (!hit) continue;
    const chain = `menu:${hit.menuId}${hit.prefix.map((p) => `/${p}`).join('')}/${hit.label}`;
    // args 不等价:门"在",但那一项走不到这次调用要的结果。不给 path —— 给了,类级
    // 模板会指示 agent 去 open 它,执行的就是**相反动作**(2026-08-05 终审:菜单只有
    // 「进入全屏」,退出全屏的调用被指去点它,指纹还真检出变化,假成功闭环)。
    if (hit.argsDiffer) {
      return { visible: true, certainty: 'declared', hint: HINTS.argsDiffer };
    }
    const door: ActionDoor = { visible: true, path: chain, certainty: 'found', hint: HINTS.found(chain) };
    if (hit.dynamicParent) {
      // 动态叶子:链走到父级可见展开;具体子项凭投影声明的 id 构成事实定位。
      const fromArg = typeof hit.node.childIdFromArg === 'string' ? hit.node.childIdFromArg : null;
      const argValue = fromArg ? args[fromArg] : undefined;
      if (fromArg && typeof argValue === 'string' && typeof hit.node.id === 'string') {
        door.walk = {
          chain,
          kind: 'dynamic-leaf',
          invoke: { parentId: hit.node.id, itemId: `${hit.node.id}.${argValue}` },
        };
      }
      return door;
    }
    door.walk = { chain, kind: 'static-leaf' };
    return door;
  }
  // shell 控件命名空间:门是界面小控件(面板开关/会话条/控制台按钮),本来就不在
  // 菜单树里 —— 配不上 ≠ 无门。只有这些命名空间之外的未命中(如 trajectory.*)
  // 才是有正面证据的 headless。
  // `role.` 在列(2026-08-06):它的门(rail 的 Agents 页签)在**界面上真实可见**,
  // 只是 rail 未接入 surface 总线、AI 无法沿它可见执行 —— 这是"门位未知",不是
  // "没有门";说成 headless 就是对着用户看得见的按钮说"屏幕上不会有变化"。
  const SHELL_WIDGET_PREFIXES = ['app.', 'panel.', 'console.', 'network.', 'session.', 'sessions.', 'workbench.', 'role.'];
  if (SHELL_WIDGET_PREFIXES.some((prefix) => actionId.startsWith(prefix))) {
    return { visible: false, certainty: 'unknown', hint: HINTS.shellWidget };
  }
  return { visible: false, certainty: 'none', hint: HINTS.none };
}
