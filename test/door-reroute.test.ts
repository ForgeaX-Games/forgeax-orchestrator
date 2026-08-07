/** 咽喉改道的共用层钉子(2026-08-06,B3)。
 *
 *  外审实锤:walkDoorInstead 此前只在 POST /:sid/kernel-tool 路由里被调 —— 原生
 *  内核的执行口 host-tool-bridge 整条绕开,agent 调 ui_act_* 是无头直调,屏幕什么
 *  都不发生;"一等公民工具不能绕开护栏"在主内核路径上不成立。且 walkDoorInstead
 *  全仓零测试、door 事实从未穿过真实管道(测试里的 fact 都是手搓的)。
 *
 *  本文件钉两条:
 *  ① 真实管道:buildActionCatalog 构建的 catalog + 真实 bus surface 投影 →
 *     runForgeaxBuiltinTool('ui_invoke') 在能力实现层改道走 editor_ui_browse;
 *  ② 原生内核口:makeInProcessExecuteTool(host-tool-bridge)注入最小假协作方,
 *     同一改道在 bridge 路径上同样生效 —— 回退本修复(收口挪层)即红。 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createBusRouter } from '../src/api/bus';
import { buildActionCatalog } from '../src/kernel/action-catalog';
import { runForgeaxBuiltinTool } from '../src/kernel/forgeax-builtin-tools';
import { makeInProcessExecuteTool } from '../src/kernel/host-tool-bridge';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';

const browseCalls: Array<Record<string, unknown>> = [];
// test double 的返回值按用例可变:改道的终态判定要靠不同的失败形状才能钉住。
const defaultBrowseRespond = (): unknown => ({ ok: true, path: ['window', '聊天'], visible_change: '「聊天」面板已切换' });
let browseRespond: (args: Record<string, unknown>) => unknown = defaultBrowseRespond;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'fx-door-reroute-'));
  resetPathManager();
  initPathManager({ userRoot: root });
  buildActionCatalog(); // door 对账消费真实构建产物,不吃手搓 fact
  initOrchestrationSeams({
    hostTools: [{
      name: 'editor_ui_browse',
      description: 'test double',
      schema: { type: 'object' },
      run: async (args: Record<string, unknown>) => {
        browseCalls.push(args);
        return browseRespond(args);
      },
    } as never],
  });
  const app = new Hono();
  app.route('/api/bus', createBusRouter());
  // 真实投影:panel.toggle_chatpanel 的菜单门(与 action-door.test 同一形状,但走真 bus)。
  await app.request('/api/bus/ui/surfaces/host.menubar/snapshot', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot: { menus: { window: [
      { id: 'window.chat', label: '聊天', kind: 'command', commandId: 'panel.toggle_chatpanel' },
    ] } } }),
  });
});

afterEach(() => { browseRespond = defaultBrowseRespond; browseCalls.length = 0; });

afterAll(() => {
  resetOrchestrationSeams();
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

describe('咽喉改道收口在能力实现层(两张嘴共用)', () => {
  it('runForgeaxBuiltinTool 直调:ui_invoke 有可见门 → 改道走 editor_ui_browse', async () => {
    browseCalls.length = 0;
    const out = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'panel.toggle_chatpanel', args: {} },
      { projectRoot: root, agentId: 'forge' },
    ) as Record<string, unknown>;

    expect(out.via).toBe('editor_ui_browse');
    expect(out.ok).toBe(true);
    expect(browseCalls[0]).toMatchObject({ verb: 'open', node: 'menu:window/聊天' });
  });

  it('叶子命令已开始执行时禁止回落 —— 否则同一命令跑两次(2026-08-07 外审 N2)', async () => {
    // open 链的**尾节点就是命令本体**(点到叶子=执行)。它以 started 失败时若回落原路,
    // 无头路径会把同一个命令再执行一次:写了一半就抛错的 file.save、后置步骤失败的
    // 新建游戏都会因此跑两次,而 agent 被告知"一次都没跑"。
    browseRespond = () => ({ ok: false, error: { code: 'SHELL_DISPATCH_FAILED', started: true } });

    const out = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'panel.toggle_chatpanel', args: {} },
      { projectRoot: root, agentId: 'forge' },
    ) as Record<string, unknown>;

    expect(out.via).toBe('editor_ui_browse');   // 终态:留在改道路径上,不回落
    expect(out.ok).toBe(false);
    expect(browseCalls).toHaveLength(1);        // 只发生过一次 open,没有第二次执行
  });

  it('普通失败仍允许回落 —— 修复不能顺手把正常恢复路径也封死', async () => {
    // 既没超时也没 started = 确定什么都没执行过,回落原路是安全的。
    browseRespond = () => ({ ok: false, error: { code: 'NOT_FOUND' } });

    const out = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'panel.toggle_chatpanel', args: {} },
      { projectRoot: root, agentId: 'forge' },
    ) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(out, 'via')).toBe(false); // 已回落原路
    expect(browseCalls).toHaveLength(1);
  });

  it('原生内核口(host-tool-bridge):同一改道同样生效,不再整条绕开', async () => {
    browseCalls.length = 0;
    const fakeSession = {
      scheduler: { getAgent: () => ({ agentContext: { tools: { list: () => [] } } }) },
      eventBus: { publish: () => {} },
      config: {},
    };
    const bridge = makeInProcessExecuteTool('forge', {
      getSessionManager: (() => ({
        peek: () => fakeSession,
        open: async () => fakeSession,
      })) as never,
      loadAgentRecord: (async () => ({ trustTier: 'own' })) as never,
      checkKernelTool: (() => ({ outcome: 'allow' })) as never,
    });

    const out = await bridge('ui_invoke', { actionId: 'panel.toggle_chatpanel', args: {} }, 'sid-reroute', 'forge') as Record<string, unknown>;

    expect(out.via).toBe('editor_ui_browse');
    expect(browseCalls[0]).toMatchObject({ verb: 'open', node: 'menu:window/聊天' });
  });
});
