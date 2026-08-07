/** door-reroute —— 咽喉收口的共用层:ui_invoke 有可见门且语义等价时,把执行改道
 *  给统一行走协议(editor_ui_browse),沿人类路径逐级可见落地。
 *
 *  为什么在这一层(2026-08-06,B3):此前改道只装在 `POST /:sid/kernel-tool` 路由里,
 *  而**原生内核**的执行口是 host-tool-bridge → runForgeaxBuiltinTool,整条绕开 ——
 *  agent 调 ui_act_* 是无头直调,屏幕上什么都不发生;"一等公民工具不能绕开护栏"
 *  在主内核路径上不成立。门注解(annotateUiInvokeResult)早就长在能力实现层,
 *  改道理应与它同层:谁调 runForgeaxBuiltinTool 都被盖到,两张嘴共用一份收口。
 *
 *  依赖注入:runCtx 由调用方(forgeax-builtin-tools 的 ui_invoke 分支)构好传入,
 *  本模块不 import forgeax-builtin-tools,避免环。
 */
import { findVisibleDoor } from './action-door';
import { catalogGet } from './action-catalog';
import { getSurfaceSnapshot, shellLivePages, multiPageHint } from '../api/bus';
import { getHostTool, type HostToolRunCtx } from '../orchestration-seams';

/** 门路径**已经派发之后**才发生的异常。带这个标记 = 命令可能已经执行,调用方
 *  **绝不能**回落无头路径重派 —— 那会让它跑第二次。
 *  2026-08-06 外审:调用侧原本是无条件 catch 回落,派发后抛异常就双跑。 */
export class DoorWalkDispatched extends Error {
  readonly dispatched = true as const;
  readonly originalError: unknown;
  constructor(originalError: unknown) {
    super('门路径派发后发生异常,命令执行状态不确定');
    this.name = 'DoorWalkDispatched';
    this.originalError = originalError;
  }
}

/** 统一协议优先:有可见门且语义等价 → 沿人类路径可见执行。
 *  执行改由 editor_ui_browse 沿人类路径完成 —— 一次调用里逐级可见展开、经菜单
 *  自己的命令总线落地,带回 visible_change 证据。等价性由门对账给出(同 commandId
 *  同 args,或 catalog 别名事实背书);headless / 门位未知不改道(无路可走),照旧
 *  派发但带上门位与多页事实(注解层负责)。2026-08-05:此前 ui_act_* 全家绕过
 *  行走协议无头直调,三轮实测 agent 全部选它 —— 护栏必须装在咽喉。 */
export async function walkDoorInstead(
  invokeArgs: Record<string, unknown>,
  io: { runCtx: HostToolRunCtx },
): Promise<{ result: Record<string, unknown> } | null> {
  const actionId = typeof invokeArgs.actionId === 'string' ? invokeArgs.actionId : '';
  if (!actionId) return null;
  const actionArgs = invokeArgs.args;
  const menubar = getSurfaceSnapshot('host.menubar') as { menus?: unknown } | null;
  const sidebar = getSurfaceSnapshot('host.sidebar') as { entries?: Array<{ id?: unknown; label?: unknown }> } | null;
  const door = findVisibleDoor(
    { menus: menubar?.menus ?? null, rail: sidebar?.entries ?? null, fact: catalogGet(actionId)?.door },
    actionId,
    actionArgs,
  );
  if (!door.walk) return null;
  const tool = getHostTool('editor_ui_browse');
  if (!tool?.run) return null;
  const runCtx = io.runCtx;
  // 一旦第一刀发出去,执行状态就不再确定 —— open 的链尾若是命令项,它**本身**
  // 就会执行命令。所以标记在调用**之前**置位,而不是之后。
  let dispatched = false;
  try {
  const steps: Array<{ call: string; result: unknown }> = [];
  dispatched = true;
  const opened = await tool.run({ verb: 'open', node: door.walk.chain }, runCtx);
  steps.push({ call: `open('${door.walk.chain}')`, result: opened });
  const failInfo = (value: unknown): { failed: boolean; code?: unknown; timedOut?: boolean; started?: boolean } => {
    if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== false) return { failed: false };
    const error = (value as { error?: { code?: unknown; timedOut?: unknown; started?: unknown } }).error;
    return { failed: true, code: error?.code, timedOut: error?.timedOut === true, started: error?.started === true };
  };
  /** 执行不确定(叶派发超时:命令可能已跑、ack 丢了)→ 绝不回落 legacy 再派一次。 */
  const terminal = (why: string): { result: Record<string, unknown> } => ({
    result: {
      ok: false,
      via: 'editor_ui_browse',
      actionId,
      door: door.path ?? door.walk!.chain,
      steps,
      error: {
        code: 'DOOR_WALK_INDETERMINATE',
        hint: `${why} 命令**可能已经执行**(页面可能在超时后才跑完),不要重试这个动作、`
          + '不要换无头路径再派一次 —— 那会让它跑两次。先 look/verify 核对实际状态再决定。',
      },
    },
  });
  const opendone = failInfo(opened);
  const openBlocked = opendone.failed && opendone.code === 'EDITOR_NOT_FOREGROUND';
  if (opendone.failed && !openBlocked) {
    // 叶派发超时 = 执行状态未知 → 终态,禁止回落;其余失败(解析 NOT_FOUND、传输死
    // 等)确定没执行过任何东西 → 回落原路是安全的。
    if (opendone.code === 'SHELL_DISPATCH_FAILED' && opendone.timedOut) {
      return terminal('沿人类路径执行到叶子时派发超时。');
    }
    // 与超时同级的终态:open 链的**尾节点就是命令本体**(点到叶子=执行)。已经开始
    // 执行才失败的,回落原路等于把同一个命令跑第二次(2026-08-07 外审 N2)。
    // 执行分支早就判了 started,这一支漏了 —— 两口判据必须同形。
    if (opendone.started) {
      return terminal('沿人类路径执行时叶子命令已经开始执行,不能回落重试。');
    }
    return null;
  }

  let executed: unknown;
  if (door.walk.kind === 'dynamic-leaf' && door.walk.invoke) {
    executed = await tool.run(
      { verb: 'act', op: { surface: 'host.menubar', action: 'invoke', args: door.walk.invoke } },
      runCtx,
    );
    steps.push({ call: `host.menubar.invoke(${JSON.stringify(door.walk.invoke)})`, result: executed });
  } else if (openBlocked) {
    // 静态叶子 + 无法展开:按叶子文本经菜单命令总线执行(与人点击同一 handler)。
    const label = door.walk.chain.split('/').pop() ?? '';
    executed = await tool.run(
      { verb: 'act', op: { surface: 'host.menubar', action: 'invoke', args: { label } } },
      runCtx,
    );
    steps.push({ call: `host.menubar.invoke({label:'${label}'})`, result: executed });
  }
  const execdone = failInfo(executed);
  if (execdone.failed && execdone.code === 'SHELL_DISPATCH_FAILED' && execdone.timedOut) {
    return terminal('经菜单命令总线执行时派发超时。');
  }
  // 命令**已经开始执行**才失败(页面侧的 started 标记)—— 与超时同级的终态:
  // 部分效果可能已经落下,回落无头路径重派就是让它跑第二次(2026-08-06 自探)。
  if (execdone.failed && execdone.started) {
    return terminal('经菜单命令总线执行时,命令已开始但中途失败。');
  }
  // 页面明确回执了"根本没启动"(解析不到 / 项被禁用)= 确定没执行 → 回落原路是
  // 安全的,且 legacy 的 server 侧执行器往往能兜住(冷缓存解析不到 ≠ 能力不可用)。
  if (execdone.failed) return null;
  const pages = shellLivePages();
  return {
    result: {
      ok: true,
      via: 'editor_ui_browse',
      actionId,
      door: door.path ?? door.walk.chain,
      walked: !openBlocked,
      ...(openBlocked
        ? { note: '编辑器执行通道不在前台,菜单未逐级展开;已改经菜单自己的命令总线执行(与人点击同一 handler、同账本)。' }
        : {}),
      steps,
      ...(pages > 1 ? { multiplePages: multiPageHint(pages) } : {}),
    },
  };
  } catch (error: unknown) {
    if (dispatched) throw new DoorWalkDispatched(error);
    throw error;
  }
}
