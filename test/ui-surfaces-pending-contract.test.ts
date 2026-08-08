/**
 * GET /api/bus/ui/surfaces/:id/pending — 键名契约。
 *
 * 服务端历史上只给 `actions`,而 lib/surface.ts 的 AI 轮询读的是 `body.items`
 * (键名多半是从 GET /ui/surfaces 的列表响应抄来的)。两边对不上 → 轮询里
 * `for (const item of undefined)` 抛错 → 被静默 catch 吞掉 → 重试 → 再抛。
 * 净效果:人点按钮的本地路径一直正常,而 AI 入队的动作只上了 ledger、永远不被
 * 执行,dispatchAndWait 必然超时。2026-08-04 用对照实验确认了这就是唯一原因
 * (同一次 dispatch:读 items 超时 10s 页面不动;读 actions 则 511ms ack 且
 * 工作区真的切了过去)。
 *
 * 这组测试把"两个键都在、且指向同一批 pending"钉住,免得日后有人顺手删掉一个,
 * 把 AI 路径又静默弄死一次。
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { createBusRouter, dispatchToSurface } from '../src/api/bus';

const ID = 'ui.pending.contract';

function freshApp(): Hono {
  const app = new Hono();
  app.route('/api/bus', createBusRouter());
  return app;
}

async function pending(app: Hono, id = ID): Promise<{ actions?: unknown[]; items?: unknown[] }> {
  const r = await app.request(`/api/bus/ui/surfaces/${id}/pending`);
  return (await r.json()) as { actions?: unknown[]; items?: unknown[] };
}

describe('GET /ui/surfaces/:id/pending — actions 与 items 必须同时存在', () => {
  let app: Hono;
  beforeEach(async () => {
    app = freshApp();
    await app.request(`/api/bus/ui/surfaces/${ID}`, { method: 'DELETE' });
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ID, layer: 'host', actions: [{ id: 'selectTab' }] }),
    });
  });

  it('未注册的 surface 两个键都给空数组', async () => {
    const body = await pending(app, 'ui.pending.nope');
    expect(body.actions).toEqual([]);
    expect(body.items).toEqual([]);
  });

  it('已注册但无 pending 时两个键都给空数组', async () => {
    const body = await pending(app);
    expect(body.actions).toEqual([]);
    expect(body.items).toEqual([]);
  });

  it('入队后两个键给出同一批动作 —— 读任一键的客户端都能跑通', async () => {
    dispatchToSurface(ID, 'selectTab', { tab: 'agents' });
    dispatchToSurface(ID, 'selectTab', { tab: 'wb:skill' });
    const body = await pending(app);

    expect(body.actions).toHaveLength(2);
    expect(body.items).toEqual(body.actions);
    expect(body.actions?.[0]).toMatchObject({ action: 'selectTab', args: { tab: 'agents' }, seq: 1 });
    expect(body.actions?.[1]).toMatchObject({ action: 'selectTab', args: { tab: 'wb:skill' }, seq: 2 });
    for (const entry of body.actions as Array<{ token?: unknown }>) {
      expect(typeof entry.token).toBe('string');
    }
  });

  it('人机同账:人路径 /dispatched 与 AI 路径 dispatchToSurface 落同一 topic,仅 source 区分', async () => {
    const { getEventBus, _resetEventBusForTests } = await import('../src/events/bus');
    _resetEventBusForTests();

    dispatchToSurface(ID, 'selectTab', { tab: 'agents' });                       // AI 路径
    await app.request(`/api/bus/ui/surfaces/${ID}/dispatched`, {                 // 人路径(handler 已本地跑完,只补账)
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'selectTab', args: { tab: 'agents' } }),
    });

    const events = getEventBus().recent('ui.surface.action', 10);
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({ id: ID, action: 'selectTab', source: 'ai' });
    expect(events[1]!.payload).toMatchObject({ id: ID, action: 'selectTab', source: 'user', token: null });
  });

  it('按轮询者 id 数出"有几个页面在听" —— 多页时消费方才可能停止撒谎', async () => {
    // surface id 是"这类界面"的名字,不是"哪个页面"的名字:两个标签页注册同一个
    // id、共用同一份 snapshot。派发落在哪一页随机,而回读 snapshot 必然"验证成功"
    // (那份 snapshot 正是执行的那一页写的)→ 工具会断言一个用户看不见的变化。
    const list = async (): Promise<Array<{ id: string; pages: number }>> => {
      const r = await app.request('/api/bus/ui/surfaces');
      return ((await r.json()) as { items: Array<{ id: string; pages: number }> }).items;
    };

    await app.request(`/api/bus/ui/surfaces/${ID}/pending?page=pAAA`);
    expect(list().then((items) => items.find((i) => i.id === ID)?.pages)).resolves.toBe(1);

    await app.request(`/api/bus/ui/surfaces/${ID}/pending?page=pBBB`);
    expect((await list()).find((item) => item.id === ID)?.pages).toBe(2);

    // 同一页反复轮询不会把自己数成多页。
    await app.request(`/api/bus/ui/surfaces/${ID}/pending?page=pAAA`);
    expect((await list()).find((item) => item.id === ID)?.pages).toBe(2);

    // 不带 page 的客户端(editor 子模块那份 fork)归匿名桶,仍能把计数顶起来。
    const fresh = freshApp();
    await fresh.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui.anon.count', layer: 'host', actions: [{ id: 'x' }] }),
    });
    await fresh.request('/api/bus/ui/surfaces/ui.anon.count/pending');
    await fresh.request('/api/bus/ui/surfaces/ui.anon.count/pending?page=pCCC');
    const r = await fresh.request('/api/bus/ui/surfaces');
    const items = ((await r.json()) as { items: Array<{ id: string; pages: number }> }).items;
    expect(items.find((item) => item.id === 'ui.anon.count')?.pages).toBe(2);
  });

  it('GET 不消费 pending,但租约内不重复交付 —— 只有 POST /ack 才算处理完', async () => {
    // 同一个 surface id 会被**多个页面**同时注册(两个 ForgeaX 标签页都注册
    // host.sidebar),共用这一条队列。GET 不消费是对的(崩溃/刷新后动作还能重投),
    // 但两页各自 1s 轮询时,B 的 GET 只要落在 A 的 ack 之前就会拿到同一条并再执行
    // 一次 —— 新建游戏建两个。交付租约把"可重投"和"不重复执行"两件事同时保住。
    dispatchToSurface(ID, 'selectTab', { tab: 'agents' });
    const first = (await pending(app)).items as Array<{ token: string }>;
    expect(first).toHaveLength(1);

    // 第二个轮询者(另一个标签页)在租约内拿不到同一条。
    expect((await pending(app)).items).toHaveLength(0);

    // 但它没有被消费:token 依然认,ack 才是真正的处理完。
    const acked = await app.request(`/api/bus/ui/surfaces/${ID}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: first[0]!.token, ok: true }),
    });
    expect(acked.status).toBe(200);

    const { getEventBus } = await import('../src/events/bus');
    expect(getEventBus().recent('ui.surface.acked', 5)).toHaveLength(1);
    expect((await pending(app)).items).toHaveLength(0);
  });

  it('dispatchAndWait 的回执带回铸出的 token —— 工具结果与 ui-events 之间的机械连接键', async () => {
    // ui-events.jsonl 里每条 AI 派发都带 token,但工具结果一直不带 —— 2026-08-06
    // 实测两条 AI 派发的 token 在 agent 侧账本 0 命中,两套记录除时间戳外无键可连。
    // ack 分支与超时分支都必须携带:超时时页面可能已在租约内执行,token 是事后
    // 回查 ui-events 的唯一线索。
    const { dispatchAndWait } = await import('../src/api/bus');

    const waiting = dispatchAndWait(ID, 'selectTab', { tab: 'agents' }, 2_000);
    const queued = (await pending(app)).items as Array<{ token: string }>;
    expect(queued).toHaveLength(1);
    await app.request(`/api/bus/ui/surfaces/${ID}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: queued[0]!.token, ok: true, result: { done: true } }),
    });
    const acked = await waiting;
    expect(acked.ok).toBe(true);
    expect(acked.token).toBe(queued[0]!.token);

    const expired = await dispatchAndWait(ID, 'selectTab', { tab: 'x' }, 10);
    expect(expired.timedOut).toBe(true);
    expect(typeof expired.token).toBe('string');
  });

  it('"命令已开始执行"是结构化字段,不是错误文案里的子串', async () => {
    // 2026-08-07 外审 N3:此前跨仓判据是 `acked.error.includes('[started=true')` ——
    // 把那句中文重排一下判据就静默失效,而且没有任何测试会红。
    // 这个信号决定"失败后能不能回落重试":判错 → 同一个命令被执行两次。
    const { dispatchAndWait } = await import('../src/api/bus');

    const waiting = dispatchAndWait(ID, 'invoke', { itemId: 'file.save' }, 2_000);
    const queued = (await pending(app)).items as Array<{ token: string }>;
    await app.request(`/api/bus/ui/surfaces/${ID}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 页面侧:命令跑起来了才失败 —— 文案里**不**带任何机器标记。
      body: JSON.stringify({ token: queued[0]!.token, ok: false, error: 'save failed', started: true }),
    });
    const acked = await waiting;
    expect(acked.ok).toBe(false);
    expect(acked.started).toBe(true);

    // 没带 started 时必须**缺席**,不能被补成 false —— "未知"与"确定没开始"是两回事:
    // 前者不许回落重试,后者可以。
    const second = dispatchAndWait(ID, 'invoke', { itemId: 'file.open' }, 2_000);
    const q2 = (await pending(app)).items as Array<{ token: string }>;
    await app.request(`/api/bus/ui/surfaces/${ID}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: q2[0]!.token, ok: false, error: 'not found' }),
    });
    expect('started' in (await second)).toBe(false);
  });

  it('注销按**在册成员**,不按轮询者 —— 两页注册后关一页不得弄哑另一页', async () => {
    // 2026-08-06 外审 MAJOR:上一轮按 pollers 判成员资格,而(a)注册请求当时不带
    // page、(b)只读面(所有 action 对 AI 隐藏)结构性永不轮询 —— 于是两页都注册但
    // 还没轮询时,关一页就删掉共享记录,剩余页面全部 404。
    const SID = 'ui.two.pages';
    for (const page of ['pAAA', 'pBBB']) {
      await app.request('/api/bus/ui/surfaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: SID, layer: 'host', page, actions: [{ id: 'noop' }] }),
      });
    }
    // 注意:两页**都没有轮询过**(只读面根本不会轮询)。
    const closed = await app.request(`/api/bus/ui/surfaces/${SID}?page=pAAA`, { method: 'DELETE' });
    expect(await closed.json()).toMatchObject({ ok: true, retained: true, members: 1 });
    expect((await app.request(`/api/bus/ui/surfaces/${SID}`)).status).toBe(200); // 另一页仍在

    const last = await app.request(`/api/bus/ui/surfaces/${SID}?page=pBBB`, { method: 'DELETE' });
    expect(await last.json()).toMatchObject({ ok: true, retained: false, members: 0 });
    expect((await app.request(`/api/bus/ui/surfaces/${SID}`)).status).toBe(404); // 最后一页走才真删
  });

  it('全是不带 page 的老客户端时,带 page 的注销不得误删', async () => {
    // "没有登记信息" ≠ "没有成员"。宁可留一条垃圾记录,也不把别人弄哑。
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui.legacy.only', layer: 'host', actions: [{ id: 'noop' }] }),
    });
    const r = await app.request('/api/bus/ui/surfaces/ui.legacy.only?page=pZZZ', { method: 'DELETE' });
    expect(await r.json()).toMatchObject({ retained: true, reason: 'no-registered-members' });
    expect((await app.request('/api/bus/ui/surfaces/ui.legacy.only')).status).toBe(200);
  });

  it('注册契约:interface 发的是 `snapshot` 键,初始快照必须存活(不许恒丢)', async () => {
    // 2026-08-06 外审 P1:interface/lib/surface.ts 注册时发 `snapshot`,这里此前只读
    // `initialSnapshot` —— 初始快照恒被丢弃,hasInitialSnapshot 恒假。menubar 靠紧跟
    // 的 PUT 兜住是竞态兜底;照模板接入、不额外 PUT 的下一个团队拿到的是空 snapshot。
    // 本用例用 interface 真实发送的键名打真实路由 —— 跨侧键名契约的钉子。
    await app.request('/api/bus/ui/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'ui.initial.snapshot',
        layer: 'host',
        actions: [{ id: 'noop' }],
        snapshot: { hello: 'world' },
      }),
    });
    const r = await app.request('/api/bus/ui/surfaces/ui.initial.snapshot/snapshot');
    expect(((await r.json()) as { snapshot: unknown }).snapshot).toEqual({ hello: 'world' });
  });

  it('pending 条目下发 source 与 surfaceId —— PendingActionWire 声明的字段不许是空头支票', async () => {
    // 2026-08-06 外审 P1:wire 类型声明了 source/surfaceId,服务端此前从不下发 →
    // 页面侧 `if (ctx.source === 'ai')` 静默走 else,而"人机同账只用 source 区分"
    // 正是模板要教的核心语义。
    dispatchToSurface(ID, 'selectTab', { tab: 'agents' });
    const rows = (await pending(app)).items as Array<{ source?: string; surfaceId?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('ai');
    expect(rows[0]!.surfaceId).toBe(ID);
  });
});
