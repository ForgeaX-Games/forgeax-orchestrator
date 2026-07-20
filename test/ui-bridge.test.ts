/** UI 语义操作层(产品 AI 化 P0)单测:
 *  - ui-manifest-registry:lease 生命周期(获焦 displace / 心跳续期 / TTL)、manifest
 *    写入的 lease 把关与 ActionCatalog runtime projection。
 *  - trust-gate ui_invoke per-action 特判:capability 真值 = server ActionCatalog,**不信模型
 *    或 UI manifest 自报的值**;catalog miss 由 dispatcher 前置返回 not_found。
 *  - perception-registry lease 把关:ui_* 回灌须持有效 lease,错 lease 不消费 pending。
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  acquireUiLease,
  validateUiLease,
  setUiManifest,
  getUiAction,
  uiInvokeTimeoutMs,
  clearUiStateForSession,
  firstClassUiToolSpecs,
  resolveFirstClassUiTool,
  isUiActionRuntimeAvailable,
} from '../src/api/lib/ui-manifest-registry';
import { checkKernelTool, classifyTool } from '../src/kernel/trust-gate';
import { registerPerception, resolvePerception } from '../src/api/lib/perception-registry';
import { runForgeaxBuiltinTool } from '../src/kernel/forgeax-builtin-tools';
import { makeInProcessExecuteTool } from '../src/kernel/host-tool-bridge';
import { buildActionCatalog } from '../src/kernel/action-catalog';
import { createSessionsRouter } from '../src/api/sessions';
import { initOrchestrationSeams, resetOrchestrationSeams, getHostTool, getHostTools } from '../src/orchestration-seams';
import uiBridgeContract from '../src/kernel/ui-bridge-contract.json';

const SID = 'test-ui-bridge-sid';

function leaseFor(sid: string, clientId = 'tab-a'): string {
  return acquireUiLease(sid, clientId).leaseId;
}

function replyingBus(reply: unknown, lease: string, onPublish?: () => void) {
  return {
    publish(event: { payload?: unknown }) {
      onPublish?.();
      const reqId = (event.payload as { reqId?: string })?.reqId;
      if (reqId) setTimeout(() => resolvePerception(reqId, reply, lease), 0);
    },
  };
}

beforeEach(() => {
  buildActionCatalog();
  clearUiStateForSession(SID);
});

describe('ui-manifest-registry — lease', () => {
  test('acquire 授予;同 clientId 续期保持 leaseId 稳定', () => {
    const a = acquireUiLease(SID, 'tab-a');
    const b = acquireUiLease(SID, 'tab-a');
    expect(a.leaseId).toBe(b.leaseId);
    expect(validateUiLease(SID, a.leaseId)).toBe(true);
  });

  test('另一 tab acquire → displace(前任 lease 失效)', () => {
    const a = acquireUiLease(SID, 'tab-a');
    const b = acquireUiLease(SID, 'tab-b');
    expect(b.leaseId).not.toBe(a.leaseId);
    expect(validateUiLease(SID, a.leaseId)).toBe(false);
    expect(validateUiLease(SID, b.leaseId)).toBe(true);
  });

  test('validate:错值 / 空值 / 未知 sid 都拒', () => {
    expect(validateUiLease(SID, 'nope')).toBe(false);
    expect(validateUiLease(SID, '')).toBe(false);
    expect(validateUiLease(SID, undefined)).toBe(false);
    expect(validateUiLease('other-sid', leaseFor(SID))).toBe(false);
  });
});

describe('ui-manifest-registry — manifest(runtime projection,lease 把守)', () => {
  const decl = (over: Record<string, unknown> = {}) => ({
    id: 'session.close',
    title: 'Close session',
    capability: 'delete',
    ...over,
  });

  test('无/错 lease 拒写 runtime binding,但不影响 catalog 声明查询', () => {
    expect(setUiManifest(SID, [decl()], undefined).ok).toBe(false);
    expect(setUiManifest(SID, [decl()], 'bogus').ok).toBe(false);
    expect(getUiAction(SID, 'session.close')?.capability).toBe('delete');
    expect(isUiActionRuntimeAvailable(SID, 'session.close')).toBe(false);
  });

  test('持有效 lease 可绑定 catalog action runtime executor', () => {
    const lease = leaseFor(SID);
    const res = setUiManifest(SID, [decl()], lease);
    expect(res.ok).toBe(true);
    expect(res.accepted).toBe(1);
    expect(getUiAction(SID, 'session.close')?.capability).toBe('delete');
    expect(isUiActionRuntimeAvailable(SID, 'session.close')).toBe(true);
  });

  test('lease 被另一 tab 取代后,旧 manifest 不再表示 UI executor 在线', () => {
    const lease = leaseFor(SID, 'tab-a');
    setUiManifest(SID, [decl()], lease);
    expect(isUiActionRuntimeAvailable(SID, 'session.close')).toBe(true);
    leaseFor(SID, 'tab-b');
    expect(isUiActionRuntimeAvailable(SID, 'session.close')).toBe(false);
  });

  test('catalog 外 id 丢弃;已知 id 的 capability/surface 篡改被纠偏并审计', () => {
    const lease = leaseFor(SID);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = setUiManifest(
        SID,
        [
          decl({ capability: 'superuser', surface: 'ui', firstClass: false }),
          decl({ id: 'outside.catalog', capability: 'read' }),
        ],
        lease,
      );
      expect(res).toMatchObject({ ok: true, accepted: 1, dropped: 1 });
      expect(getUiAction(SID, 'session.close')).toMatchObject({
        capability: 'delete',
        surface: 'both',
        firstClass: true,
      });
      expect(getUiAction(SID, 'outside.catalog')).toBeUndefined();
      expect(isUiActionRuntimeAvailable(SID, 'outside.catalog')).toBe(false);
      const audit = warn.mock.calls.flat().join('\n');
      expect(audit).toContain('outside.catalog');
      expect(audit).toContain('capability');
      expect(audit).toContain('surface');
    } finally {
      warn.mockRestore();
    }
  });

  test('manifest 超限行计入 dropped 并写审计摘要', () => {
    const lease = leaseFor(SID);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const actions = Array.from({ length: 500 }, () => decl());
      actions.push(decl({ id: 'outside.catalog' }));
      expect(setUiManifest(SID, actions, lease)).toMatchObject({ ok: true, accepted: 1, dropped: 1 });
      expect(warn.mock.calls.flat().join('\n')).toContain('manifest exceeds 500-action limit');
      expect(getUiAction(SID, 'outside.catalog')).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test('catalog timeout 是权威;manifest 不能放大或缩短', () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [decl({ id: 'role.create', capability: 'delegate', timeoutMs: 120_000 })], lease);
    expect(uiInvokeTimeoutMs(SID, 'role.create', 10_000)).toBe(15_000);
    setUiManifest(SID, [decl({ id: 'role.create', capability: 'delegate', timeoutMs: 5 })], lease);
    expect(uiInvokeTimeoutMs(SID, 'role.create', 10_000)).toBe(15_000);
    expect(uiInvokeTimeoutMs(SID, 'unknown.op', 10_000)).toBe(10_000);
  });

  test('catalog timeout 仍 clamp 到 [1s,30s]', () => {
    const declaration = {
      id: 'timeout.probe',
      title: 'Timeout probe',
      capability: 'read',
      surface: 'both',
    } as const;
    try {
      buildActionCatalog([{ ...declaration, timeoutMs: 120_000 }]);
      expect(uiInvokeTimeoutMs(SID, declaration.id, 10_000)).toBe(30_000);
      buildActionCatalog([{ ...declaration, timeoutMs: 5 }]);
      expect(uiInvokeTimeoutMs(SID, declaration.id, 10_000)).toBe(1_000);
    } finally {
      buildActionCatalog();
    }
  });
});

describe('trust-gate — ui_invoke per-action 特判', () => {
  test('capability 真值 = catalog 声明:delete → ask(own),不依赖 manifest seed', () => {
    const d = checkKernelTool('own', 'ui_invoke', { args: { actionId: 'session.close' }, sid: SID });
    expect(d.outcome).toBe('ask');
    expect(d.capability).toBe('delete');
  });

  test('防谎报:模型在 args 里自报 capability 被无视,以 catalog 为准', () => {
    const d = checkKernelTool('own', 'ui_invoke', {
      args: { actionId: 'session.close', capability: 'read' }, // 谎报
      sid: SID,
    });
    expect(d.outcome).toBe('ask');
    expect(d.capability).toBe('delete');
  });

  test('read catalog 声明 → own 直放;绕过 dispatcher 的异常输入 → fail-closed deny', () => {
    expect(checkKernelTool('own', 'ui_invoke', { args: { actionId: 'sessions.list' }, sid: SID }).outcome).toBe('allow');
    expect(checkKernelTool('own', 'ui_invoke', { args: { actionId: 'nope' }, sid: SID }).outcome).toBe('deny');
    expect(checkKernelTool('own', 'ui_invoke', { args: { actionId: 'sessions.list' } }).outcome).toBe('deny');
    expect(checkKernelTool('own', 'ui_invoke', { args: {}, sid: SID }).outcome).toBe('deny');
  });

  test('imported:catalog read 直放,write/delete ask', () => {
    expect(checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'sessions.list' }, sid: SID }).outcome).toBe('allow');
    expect(checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'session.create' }, sid: SID }).outcome).toBe('ask');
    expect(checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'session.close' }, sid: SID }).outcome).toBe('ask');
  });

  test('imported:catalog credential 仍经 UI 专用路径硬 deny', () => {
    try {
      buildActionCatalog([
        { id: 'credential.probe', title: 'Credential probe', capability: 'credential', surface: 'both' },
      ]);
      expect(
        checkKernelTool('imported', 'ui_invoke', { args: { actionId: 'credential.probe' }, sid: SID }),
      ).toMatchObject({ outcome: 'deny', capability: 'credential' });
    } finally {
      buildActionCatalog();
    }
  });

  test('unknown ui_invoke/ui_act_* 在真实 native 分发前置返回 not_found,不进 trust-gate', async () => {
    let gateCalls = 0;
    const bridge = makeInProcessExecuteTool('forge', {
      checkKernelTool: (...args) => {
        gateCalls++;
        return checkKernelTool(...args);
      },
    });
    const direct = await bridge('ui_invoke', { actionId: 'nope', args: {} }, SID);
    expect(direct).toEqual({
      status: 'rejected',
      code: 'not_found',
      reason: 'action "nope" not in server ActionCatalog',
    });
    expect(await bridge('ui_act_not_registered', {}, SID)).toEqual({
      status: 'rejected',
      code: 'not_found',
      reason: 'action "ui_act_not_registered" not in server ActionCatalog',
    });
    expect(gateCalls).toBe(0);
  });

  test('unknown ui_invoke/ui_act_* 在 HTTP 分发前置返回 tool result,不打开 session', async () => {
    const router = createSessionsRouter();
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const response = await router.request(`/${SID}/kernel-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName, args }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await call('ui_invoke', { actionId: 'nope' })).toEqual({
      ok: true,
      result: {
        status: 'rejected',
        code: 'not_found',
        reason: 'action "nope" not in server ActionCatalog',
      },
    });
    expect(await call('ui_act_not_registered', {})).toEqual({
      ok: true,
      result: {
        status: 'rejected',
        code: 'not_found',
        reason: 'action "ui_act_not_registered" not in server ActionCatalog',
      },
    });
  });

  test('ui_snapshot 归 read 直放(own+imported),不因 sh 子串误分 exec', () => {
    // 只读发现工具:两 tier 都直放,capability 显式 read(绕开 classifyTool 的 sh→exec)。
    expect(checkKernelTool('own', 'ui_snapshot', { sid: SID })).toMatchObject({ outcome: 'allow', capability: 'read' });
    expect(checkKernelTool('imported', 'ui_snapshot', { sid: SID })).toMatchObject({ outcome: 'allow', capability: 'read' });
  });
});

describe('perception-registry — ui_* 回灌的 lease 把关', () => {
  test('错 lease 不消费 pending(真持有者仍可回灌);对 lease 有效', async () => {
    const lease = leaseFor(SID);
    const handle = registerPerception('req-ui-1', 2_000, { requireLease: { sid: SID } });
    expect(resolvePerception('req-ui-1', { x: 1 }, 'bogus')).toBe(false);
    expect(resolvePerception('req-ui-1', { x: 1 }, lease)).toBe(true);
    expect(await handle.promise).toEqual({ x: 1 });
    handle.dispose();
  });

  test('传统 world/frame 不受 lease 影响(零回归)', async () => {
    const handle = registerPerception('req-world-1', 2_000);
    expect(resolvePerception('req-world-1', { ok: true })).toBe(true);
    expect(await handle.promise).toEqual({ ok: true });
    handle.dispose();
  });
});

describe('ui_screenshot 往返 — dataUrl → ContentPart 图像块(P3)', () => {
  test('成功回 dataUrl → [image, text meta] ContentPart 数组(模型看得到像素)', async () => {
    const lease = leaseFor(SID);
    const ctx = {
      projectRoot: '/tmp',
      agentId: 'forge',
      sid: SID,
      eventBus: replyingBus({ dataUrl: 'data:image/jpeg;base64,QUJD', width: 800, height: 600 }, lease),
    };
    const out = (await runForgeaxBuiltinTool('ui_screenshot', { target: 'app' }, ctx)) as Array<Record<string, unknown>>;
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
    expect(out[1]!.type).toBe('text');
    expect(JSON.parse(String(out[1]!.text))).toEqual({ width: 800, height: 600 });
  });

  test('畸形 dataUrl → captured:false(fail-soft,不产出坏 image part)', async () => {
    const lease = leaseFor(SID);
    const ctx = {
      projectRoot: '/tmp',
      agentId: 'forge',
      sid: SID,
      eventBus: replyingBus({ dataUrl: 'not-a-data-url', width: 1 }, lease),
    };
    const out = (await runForgeaxBuiltinTool('ui_screenshot', {}, ctx)) as { captured?: boolean; width?: number };
    expect(out.captured).toBe(false);
    expect(out.width).toBe(1);
  });

  test('UI 侧回 captured:false / unavailable → 原样透传', async () => {
    const lease = leaseFor(SID);
    const ctx = {
      projectRoot: '/tmp',
      agentId: 'forge',
      sid: SID,
      eventBus: replyingBus({ captured: false, reason: 'canvas tainted' }, lease),
    };
    const out = (await runForgeaxBuiltinTool('ui_screenshot', {}, ctx)) as { captured: boolean; reason: string };
    expect(out).toEqual({ captured: false, reason: 'canvas tainted' });
  });
});

describe('ui-bridge-contract — 契约单源与产品中立', () => {
  test('三个工具在契约里且 schema 齐全', () => {
    const names = uiBridgeContract.tools.map((t) => t.name).sort();
    expect(names).toEqual(['ui_invoke', 'ui_screenshot', 'ui_snapshot']);
    for (const t of uiBridgeContract.tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  test('措辞产品中立:不出现 game/ECS 等产品词(cli 层业务无关)', () => {
    for (const t of uiBridgeContract.tools) {
      expect(/\bgame\b|\becs\b/i.test(t.description)).toBe(false);
    }
  });

  test('ui_invoke 的 description 写明 accepted 勿等勿重试 + 用 ui_snapshot 观察(P0 断层提示)', () => {
    const invoke = uiBridgeContract.tools.find((t) => t.name === 'ui_invoke')!;
    expect(invoke.description).toMatch(/do NOT wait/i);
    expect(invoke.description).toMatch(/do NOT retry/i);
    expect(invoke.description).toMatch(/ui_snapshot/);
  });

  test('ui_snapshot 契约含 a11y 兜底档(P1-13)', () => {
    const snap = uiBridgeContract.tools.find((t) => t.name === 'ui_snapshot')!;
    const detail = (snap.inputSchema as { properties: { detail: { enum: string[] } } }).properties.detail;
    expect(detail.enum).toContain('a11y');
  });

  test('ui_screenshot 契约(P3):兜底定位 + captured:false 勿重试 + panel target', () => {
    const shot = uiBridgeContract.tools.find((t) => t.name === 'ui_screenshot')!;
    expect(shot.description).toMatch(/fallback/i);
    expect(shot.description).toMatch(/ui_snapshot/); // 主感知通道指回文本 snapshot
    expect(shot.description).toMatch(/do not retry/i);
    const target = (shot.inputSchema as { properties: { target: { description: string } } }).properties.target;
    expect(target.description).toContain('panel:');
  });
});

describe('trust-gate — ui_screenshot read 特判(P3)', () => {
  test("classifyTool 会把 'screenshot' 误分 exec(含 'sh');特判后 allow/read 直放", () => {
    // 花絮成立的前提(方案 §7 风险 8):子串分类确实误判 —— 若哪天分类器改了,这条
    // 提醒重审特判是否还需要。
    expect(classifyTool('ui_screenshot')).toBe('exec');
    for (const tier of ['own', 'imported'] as const) {
      const d = checkKernelTool(tier, 'ui_screenshot', { sid: SID });
      expect(d.outcome).toBe('allow');
      expect(d.capability).toBe('read');
    }
  });
});

describe('P1-9 一等工具化 — firstClass 派生与反解', () => {
  test('真冷启动:catalog firstClass 派生 role.* ToolSpec 并可反解,无需 manifest seed', () => {
    const specs = firstClassUiToolSpecs(SID);
    const names = specs.map((s) => s.name);
    expect(specs).toHaveLength(14);
    expect(names).toContain('ui_act_role_create');
    expect(names).toContain('ui_act_role_list');
    expect(names).toContain('ui_act_game_switch');
    expect(names).not.toContain('ui_act_console_clear');
    const roleCreate = specs.find((s) => s.name === 'ui_act_role_create')!;
    expect(roleCreate.description).toContain('创建新角色');
    expect(roleCreate.description).toMatch(/ui_snapshot/);
    expect(roleCreate.inputSchema).toMatchObject({ required: ['id', 'persona'] });
    expect(resolveFirstClassUiTool(SID, 'ui_act_role_create')).toEqual({ actionId: 'role.create' });
    expect(resolveFirstClassUiTool(SID, 'ui_act_role_list')).toEqual({ actionId: 'role.list' });
    expect(resolveFirstClassUiTool(SID, 'ui_act_game_switch')).toEqual({ actionId: 'game.switch' });
    expect(resolveFirstClassUiTool(SID, 'ui_act_console_clear')).toBeUndefined();
    expect(resolveFirstClassUiTool(SID, 'not_a_ui_tool')).toBeUndefined();
    expect(firstClassUiToolSpecs(undefined)).toEqual([]);
  });

  test('manifest 不能增删 catalog firstClass 暴露', () => {
    const lease = leaseFor(SID);
    setUiManifest(
      SID,
      [
        { id: 'game.switch', title: 'Switch game', capability: 'write', firstClass: false },
        { id: 'console.clear', title: 'Clear console', capability: 'write', firstClass: true },
      ],
      lease,
    );
    const names = firstClassUiToolSpecs(SID).map((s) => s.name);
    expect(names).toContain('ui_act_game_switch');
    expect(names).not.toContain('ui_act_console_clear');
    expect(firstClassUiToolSpecs(SID).find((s) => s.name === 'ui_act_game_switch')?.description).toContain('切换游戏');
  });
});

describe('P1-7 seam — HostToolSpec run 执行位', () => {
  afterEach(() => resetOrchestrationSeams());

  test('shell 注入后 getHostTool 可取,run 收到 ctx.perception', async () => {
    let seenKind = '';
    initOrchestrationSeams({
      hostTools: [
        {
          name: 'query_world',
          description: 'probe',
          inputSchema: { type: 'object', properties: {} },
          run: async (_args, ctx) => {
            if (!ctx.perception) return { unavailable: true };
            return ctx.perception('world', null);
          },
        },
      ],
    });
    expect(getHostTools().length).toBe(1);
    const tool = getHostTool('query_world')!;
    expect(tool.run).toBeTruthy();
    const out = (await tool.run!(
      {},
      {
        agentId: 'forge',
        projectRoot: '/tmp',
        perception: async (kind) => {
          seenKind = kind;
          return { entityCount: 3 };
        },
      },
    )) as { entityCount: number };
    expect(seenKind).toBe('world');
    expect(out.entityCount).toBe(3);
  });
});

describe('P1-8 headless 回落 — surface both/server 的 ui_invoke', () => {
  afterEach(() => resetOrchestrationSeams());

  test('有效 lease + manifest binding → 先走 UI executor,不触发 headless handler', async () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [{ id: 'sessions.list', title: 'List sessions', capability: 'read' }], lease);
    let publishes = 0;
    let handlerCalls = 0;
    initOrchestrationSeams({
      hostUiActions: [
        { actionId: 'sessions.list', run: () => { handlerCalls++; return { status: 'completed' }; } },
      ],
    });
    const out = (await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'sessions.list', args: {} },
      {
        projectRoot: '/tmp',
        agentId: 'forge',
        sid: SID,
        eventBus: {
          publish: (event) => {
            publishes++;
            const reqId = (event.payload as { reqId?: string } | undefined)?.reqId;
            if (reqId) setTimeout(() => resolvePerception(reqId, { status: 'completed', stateDigest: 'ui' }, lease), 0);
          },
        },
      },
    )) as { status: string; executedVia?: string; stateDigest?: unknown };
    expect(out).toMatchObject({ status: 'completed', stateDigest: 'ui' });
    expect(out.executedVia).toBeUndefined();
    expect(handlerCalls).toBe(0);
    expect(publishes).toBe(1);
  });

  test('live UI 返回 unavailable 后,surface both 回落 headless', async () => {
    const lease = leaseFor(SID);
    setUiManifest(SID, [{ id: 'sessions.list', title: 'List sessions', capability: 'read' }], lease);
    let handlerCalls = 0;
    initOrchestrationSeams({
      hostUiActions: [
        {
          actionId: 'sessions.list',
          run: () => {
            handlerCalls++;
            return { status: 'completed', stateDigest: 'headless' };
          },
        },
      ],
    });
    const out = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'sessions.list', args: {} },
      {
        projectRoot: '/tmp',
        agentId: 'forge',
        sid: SID,
        eventBus: replyingBus({ unavailable: true, reason: 'surface unavailable' }, lease),
      },
    );
    expect(out).toMatchObject({ status: 'completed', stateDigest: 'headless', executedVia: 'headless' });
    expect(handlerCalls).toBe(1);
  });

  test("live UI 返回 unavailable 后,surface:'ui' 保持 unavailable", async () => {
    const lease = leaseFor(SID);
    setUiManifest(
      SID,
      [{ id: 'panel.toggle_sidebar', title: 'Toggle sidebar', capability: 'write' }],
      lease,
    );
    let handlerCalls = 0;
    initOrchestrationSeams({
      hostUiActions: [
        {
          actionId: 'panel.toggle_sidebar',
          run: () => {
            handlerCalls++;
            return { status: 'completed' };
          },
        },
      ],
    });
    const out = await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'panel.toggle_sidebar', args: {} },
      {
        projectRoot: '/tmp',
        agentId: 'forge',
        sid: SID,
        eventBus: replyingBus({ unavailable: true, reason: 'surface unavailable' }, lease),
      },
    );
    expect(out).toEqual({ unavailable: true, reason: 'surface unavailable' });
    expect(handlerCalls).toBe(0);
  });

  test('真冷启动:有 EventBus 但零 lease/manifest → 不 publish/不等超时,直接走 both handler', async () => {
    let publishes = 0;
    initOrchestrationSeams({
      hostUiActions: [
        { actionId: 'sessions.list', run: () => ({ status: 'completed', stateDigest: [{ sid: 's1' }] }) },
      ],
    });
    const out = (await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'sessions.list', args: {} },
      { projectRoot: '/tmp', agentId: 'forge', sid: SID, eventBus: { publish: () => publishes++ } },
    )) as { status: string; executedVia?: string; stateDigest?: unknown };
    expect(out.status).toBe('completed');
    expect(out.executedVia).toBe('headless');
    expect(out.stateDigest).toEqual([{ sid: 's1' }]);
    expect(publishes).toBe(0);
  });

  test("真冷启动:surface:'ui' 不回落且不 publish(unavailable 原样返回)", async () => {
    let publishes = 0;
    let handlerCalls = 0;
    initOrchestrationSeams({
      hostUiActions: [{ actionId: 'panel.toggle_sidebar', run: () => { handlerCalls++; return { status: 'completed' }; } }],
    });
    const out = (await runForgeaxBuiltinTool(
      'ui_invoke',
      { actionId: 'panel.toggle_sidebar', args: {} },
      { projectRoot: '/tmp', agentId: 'forge', sid: SID, eventBus: { publish: () => publishes++ } },
    )) as { unavailable?: boolean };
    expect(out.unavailable).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(publishes).toBe(0);
  });
});
