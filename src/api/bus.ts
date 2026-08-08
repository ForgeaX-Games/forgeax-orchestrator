/**
 * /api/bus —— interface 还期望的最小 bus 路由（wu-tian807 R2 重写已删原 src/bus,
 * 但前端 Sidebar / BuildBadge / WorkbenchMode / BusAdminPanel / lib/surface.ts 还在调）。
 *
 * 这里不是恢复完整 Bus runtime,只是把 plugin manifest 读出来 + ui/surfaces 当
 * stub 返回空,让 UI 在 R3 重写 sidebar 之前不会因为 404 把工作区清空。
 *
 * Endpoints：
 *   GET    /ui/surfaces
 *   GET    /ui/surfaces/:id
 *   GET    /ui/surfaces/:id/snapshot
 *   GET    /ui/surfaces/:id/pending
 *   POST   /ui/surfaces
 *   PUT    /ui/surfaces/:id/snapshot
 *   POST   /ui/surfaces/:id/ack
 *   DELETE /ui/surfaces/:id
 */

import { Hono } from 'hono';
import { getEventBus } from '../events/bus';

export function createBusRouter(): Hono {
  const router = new Hono();


  // ui/surfaces —— Map-backed live store. dual-modality 入口:
  //   - 插件 panel.tsx 走 POST/PUT/GET 注册自身 + 上报 snapshot + poll pending
  //   - AI tool handler (/api/wb/character/*) 走 dispatchToSurface() 在
  //     pending 队列里挂 action,等 panel 下一轮 poll 拉走 → 渲染端调 __ceInvoke
  //   两路汇合在同一个 Map<surfaceId, SurfaceRecord>,不持久化(进程重启即清)。
  //
  // DUAL-MODALITY 9.8 ledger replay - every register/snapshot/dispatch/ack/
  // delete also emits a `ui.surface.*` event onto the global EventBus ring
  // buffer. /api/events/recent?topic=ui.surface.*&n=N returns the history so
  // a chat session that boots after the player has been clicking around can
  // inject "what the player did since last time" into the AI prompt context.
  // The ring buffer is process-local (2048 slots); cross-process persistence
  // is an EventBus journal sink concern, not a bus.ts concern.

  router.get('/ui/surfaces', (c) => {
    const items = listSurfacesSlim();
    return c.json({ items });
  });

  // DUAL-MODALITY 9.8 - bulk snapshot replay. Returns the current snapshot
  // of every registered surface in one call so the chat session can inject
  // "what the player sees right now" into the AI prompt context on boot
  // (or on reconnect). Skips surfaces where snapshot===null.
  router.get('/ui/surfaces/snapshots', (c) => {
    const items: Array<{ id: string; layer: SurfaceLayer; snapshot: unknown; updatedAt: number }> = [];
    for (const rec of surfaces.values()) {
      if (rec.snapshot === null) continue;
      items.push({ id: rec.id, layer: rec.layer, snapshot: rec.snapshot, updatedAt: rec.updatedAt });
    }
    return c.json({ items, count: items.length });
  });

  router.get('/ui/surfaces/:id', (c) => {
    const rec = surfaces.get(c.req.param('id'));
    if (!rec) return c.json({ error: 'not-found', id: c.req.param('id') }, 404);
    return c.json(surfaceSlim(rec));
  });

  router.get('/ui/surfaces/:id/snapshot', (c) => {
    const rec = surfaces.get(c.req.param('id'));
    if (!rec) return c.json({ snapshot: null }, 404);
    return c.json({ snapshot: rec.snapshot });
  });

  router.get('/ui/surfaces/:id/pending', (c) => {
    const id = c.req.param('id');
    const rec = surfaces.get(id);
    // 返回所有未 ack 的 pending; 前端 panel 拉到后逐条 run + POST /ack。
    //
    // `actions` 与 `items` 是同一个数组的两个名字,不是笔误。lib/surface.ts 的轮询
    // 读的是 `body.items`(大概率是从 GET /ui/surfaces 的列表响应抄来的键名),
    // 而这里一直只给 `actions` —— 于是 `for (const item of undefined)` 抛错,被轮询
    // 里那个静默 catch 吞掉,重试,再抛。结果:人点按钮的本地路径一直好使,AI 入队
    // 的这条路径从来没跑通过,action 只上了 ledger 没被执行,dispatchAndWait 必超时。
    // 2026-08-04 对照实验:同一次 dispatch,读 items 超时 10s 且页面不动;改读
    // actions 则 511ms ack、工作区真的切过去了。
    // 这里同时给两个键把两侧都救活(editor 仓里那份 fork 的 surface.ts 也读 items),
    // 不必改任何前端。等两侧客户端都收敛到 `actions` 之后可以删掉 `items`。
    // 交付租约:GET 不消费 pending(要等客户端 POST /ack),这对单页是正确的
    // ——崩溃/刷新后动作还能重投。但同一个 surface id 会被**多个页面**同时注册
    // (两个 ForgeaX 标签页都注册 host.sidebar,共用这一条记录和这一个队列),
    // 而它们各自 1s 轮询:B 的 GET 只要落在 A 的 ack 之前,同一条动作会被两个
    // 页面各执行一次(新建游戏建两个、切两次页签)。租约让一条动作在 10s 内只
    // 交付一次(DELIVERY_LEASE_MS),过期未 ack 才重投 —— 重投语义保住,重复执行堵死。
    const now = Date.now();
    // 谁在听。不带 page 参数的客户端(editor 子模块里那份 fork 的 surface.ts)全部
    // 归到一个匿名桶 —— 它自己内部分不清几页,但只要它和一个带 id 的页面同时存在,
    // 计数照样翻到 2,警告照样出得来。
    if (rec) {
      const pollingPage = c.req.query('page') || 'anonymous';
      rec.pollers.set(pollingPage, now);
      rec.members.add(pollingPage); // 轮询即证明在册;pollers 仍只管活跃度
    }
    const pending = rec
      ? rec.pending.filter((entry) => entry.deliveredAt === undefined || now - entry.deliveredAt >= DELIVERY_LEASE_MS)
      : [];
    for (const entry of pending) entry.deliveredAt = now;
    // surfaceId 随条目下发:PendingActionWire 声明了它,页面侧 handler 可能据此分流。
    const wire = pending.map((entry) => ({ ...entry, surfaceId: id }));
    return c.json({ actions: wire, items: wire });
  });

  router.post('/ui/surfaces', async (c) => {
    let body: { id?: string; layer?: string; schema?: unknown; actions?: Array<{ id: string; exposedToAI?: boolean; argsSchema?: unknown }>; initialSnapshot?: unknown; snapshot?: unknown; page?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    if (!body.id || typeof body.id !== 'string') return c.json({ error: 'missing-id' }, 400);
    const now = Date.now();
    const existing = surfaces.get(body.id);
    const layer = (body.layer as SurfaceLayer) ?? 'plugin';
    // 键名接缝(2026-08-06 外审 P1):interface 的 useSurface 注册时发的是 `snapshot`,
    // 这里此前只读 `initialSnapshot` —— 初始快照**恒被丢弃**,hasInitialSnapshot 是
    // 恒假的死字段。menubar 靠紧跟的 PUT 兜住属于竞态兜底;照模板接入、不额外 PUT
    // 的下一个团队会拿到空 snapshot。两个键都认,谁在用谁。
    const initialSnapshot = body.initialSnapshot !== undefined ? body.initialSnapshot : body.snapshot;
    surfaces.set(body.id, {
      id: body.id,
      layer,
      schema: body.schema ?? null,
      actions: body.actions ?? [],
      snapshot: initialSnapshot ?? existing?.snapshot ?? null,
      pending: existing?.pending ?? [],
      pollers: existing?.pollers ?? new Map(),
      members: existing?.members ?? new Set<string>(),
      seqCounter: existing?.seqCounter ?? 0,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    });
    const registeredPage = (body as { page?: unknown }).page;
    if (typeof registeredPage === 'string' && registeredPage) {
      surfaces.get(body.id)?.members.add(registeredPage);
    }
    getEventBus().emit('ui.surface.registered', {
      id: body.id,
      layer,
      remount: existing != null,
      hasInitialSnapshot: initialSnapshot !== undefined,
    });
    return c.json({ ok: true });
  });

  router.put('/ui/surfaces/:id/snapshot', async (c) => {
    const id = c.req.param('id');
    let body: { snapshot?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    // Upsert: hosts (e.g. host.sidebar) may PUT a snapshot before they have
    // explicitly POST-registered the surface — the registration and the first
    // snapshot can race during React mount. Rather than 404 (which surfaces a
    // noisy console error in the UI), lazily register the surface so the
    // snapshot lands. Layer is inferred from the id prefix.
    let rec = surfaces.get(id);
    if (!rec) {
      const now = Date.now();
      const layer: SurfaceLayer = id.startsWith('host.') ? 'host' : 'plugin';
      rec = {
        id,
        layer,
        schema: null,
        actions: [],
        snapshot: null,
        pending: [],
        pollers: new Map(),
        members: new Set<string>(),
        seqCounter: 0,
        updatedAt: now,
        createdAt: now,
      };
      surfaces.set(id, rec);
      getEventBus().emit('ui.surface.registered', {
        id,
        layer,
        remount: false,
        hasInitialSnapshot: false,
      });
    }
    rec.snapshot = body.snapshot ?? null;
    rec.updatedAt = Date.now();
    getEventBus().emit('ui.surface.snapshot', {
      id,
      layer: rec.layer,
      snapshot: rec.snapshot,
    });
    return c.json({ ok: true });
  });

  router.post('/ui/surfaces/:id/ack', async (c) => {
    const id = c.req.param('id');
    const rec = surfaces.get(id);
    if (!rec) return c.json({ error: 'not-found' }, 404);
    // started:页面侧"命令已经开始执行"的结构化标记。缺省 = 未知,不是"确定没开始" ——
    // 有值才往下传(2026-08-07 外审 N3:此前它只活在中文错误文案的子串里)。
    let body: { token?: string; ok?: boolean; error?: string; result?: unknown; started?: boolean };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const idx = rec.pending.findIndex((p) => p.token === body.token);
    if (idx >= 0) {
      const [removed] = rec.pending.splice(idx, 1);
      const waiter = ackWaiters.get(removed.token);
      if (waiter) {
        waiter.resolve({ ok: body.ok !== false, error: body.error, result: body.result, ...(body.started === undefined ? {} : { started: body.started }) });
        ackWaiters.delete(removed.token);
      }
      getEventBus().emit('ui.surface.acked', {
        id,
        token: removed.token,
        action: removed.action,
        ok: body.ok !== false,
        error: body.error,
        result: body.result,
        ...(body.started === undefined ? {} : { started: body.started }),
      });
    }
    return c.json({ ok: true });
  });

  // 新增 endpoint: AI 通过 HTTP 派发动作到 surface (服务端内部也可用 dispatchToSurface 直调)
  router.post('/ui/surfaces/:id/dispatch', async (c) => {
    const id = c.req.param('id');
    let body: { action?: string; args?: unknown; awaitAck?: boolean; timeoutMs?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    if (!body.action) return c.json({ error: 'missing-action' }, 400);
    try {
      if (body.awaitAck) {
        const r = await dispatchAndWait(id, body.action, body.args, body.timeoutMs ?? 10000);
        return c.json(r);
      }
      const token = dispatchToSurface(id, body.action, body.args);
      return c.json({ ok: true, token });
    } catch (e) {
      return c.json({ error: 'dispatch-failed', message: (e as Error).message }, 400);
    }
  });

  router.post('/ui/surfaces/:id/dispatched', async (c) => {
    const id = c.req.param('id');
    // 懒注册(与 PUT /snapshot 同款)。surfaces 是纯内存 Map,进程重启即清;而已打开
    // 的页面不会重新注册(注册只挂在 mount 上,menubar 又只在菜单结构变化时才 PUT)。
    // 此前这里对未注册直接 404,而人路径的补账是 fire-and-forget、404 不是 fetch 异常
    // → 每次 dev 重启后,人点菜单在账本里变成小时级黑洞,且全程无声。AI 侧反而会
    // 抛可见错误,两侧不对称 —— "人机同账"的人半边就是这么悄悄断掉的。
    let rec = surfaces.get(id);
    if (!rec) {
      const now = Date.now();
      rec = {
        id,
        layer: (id.startsWith('host.') ? 'host' : 'plugin') as SurfaceLayer,
        schema: null,
        actions: [],
        snapshot: null,
        pending: [],
        pollers: new Map(),
        members: new Set<string>(),
        seqCounter: 0,
        updatedAt: now,
        createdAt: now,
      };
      surfaces.set(id, rec);
    }
    let body: { action?: string; args?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    if (!body.action) return c.json({ error: 'missing-action' }, 400);
    rec.seqCounter += 1;
    rec.updatedAt = Date.now();
    getEventBus().emit('ui.surface.action', {
      id,
      layer: rec.layer,
      action: body.action,
      args: body.args,
      token: null,
      seq: rec.seqCounter,
      source: 'user',
    });
    return c.json({ ok: true });
  });

  router.delete('/ui/surfaces/:id', (c) => {
    const id = c.req.param('id');
    const page = c.req.query('page');
    // 按页注销(2026-08-06 外审 MAJOR):surface id 是"这类界面"的名字,不是"哪个
    // 页面"的名字 —— 两个标签页注册同一个 id、共用这一条记录。此前任意一页卸载都
    // 整条删除,剩下的页面继续轮询却永远拿不到东西,AI 操作能力持续消失到有人刷新。
    // 我们已经按页数活(pollers/PAGE_LIVENESS_MS),注销也必须按页。
    if (page !== undefined) {
      const rec = surfaces.get(id);
      if (!rec) return c.json({ ok: true, retained: false, members: 0 });
      rec.pollers.delete(page);
      // 全是不带 page 的老客户端时,"没有登记信息"不等于"没有成员" —— 宁可留一条
      // 垃圾记录,也不把别的页面弄哑。
      if (rec.members.size === 0) {
        return c.json({ ok: true, retained: true, members: 0, reason: 'no-registered-members' });
      }
      rec.members.delete(page);
      const members = rec.members.size;
      if (members > 0) return c.json({ ok: true, retained: true, members });
      const removed = surfaces.delete(id);
      if (removed) getEventBus().emit('ui.surface.removed', { id });
      return c.json({ ok: true, retained: false, members: 0 });
    }
    // 不带 page 的整删只保留给管理/测试口 —— 页面卸载**不得**走这条。
    const existed = surfaces.delete(id);
    if (existed) getEventBus().emit('ui.surface.removed', { id });
    return c.json({ ok: true });
  });

  return router;
}

// ───────────────────────── Surfaces in-memory store ─────────────────────────
//
// Surface 是一份「UI 状态 + 可触发动作集合」的注册项. panel.tsx 在 mount 时
// 调 POST /ui/surfaces 注册,自己维护 snapshot+actions. AI 想驱动 UI 时调
// dispatchToSurface() 往 pending 队列加一条; panel poll 拉走 → run → ack.

type SurfaceLayer = 'host' | 'plugin' | 'iframe';

interface SurfaceActionDef {
  id: string;
  exposedToAI?: boolean;
  argsSchema?: unknown;
}

interface PendingAction {
  seq: number;
  token: string;
  action: string;
  args: unknown;
  ts: number;
  /** 派发来源。PendingActionWire(interface/lib/surface.ts)声明了它,页面侧
   *  `def.run(args, {source})` 靠它区分人机 —— 2026-08-06 外审 P1:此前服务端从不
   *  下发,任何 surface 写 `if (ctx.source === 'ai')` 都会静默走 else 分支,而
   *  "人机同账、只用 source 区分"正是这套模板要教的核心语义。队列只由 AI/系统
   *  派发填充(人点击不进队列),故恒 'ai'。 */
  source: 'ai';
  /** 最近一次被 GET /pending 交付出去的时刻。见 DELIVERY_LEASE_MS。 */
  deliveredAt?: number;
}

/** 一个页面多久没来轮询就算它走了。轮询间隔 1s(lib/surface.ts),取 5s 容忍抖动
 *  与一次慢 run,又不至于把已关掉的标签页长期算进来。 */
const PAGE_LIVENESS_MS = 5_000;

/** 一条 pending 动作被交付后,多久内不再交付给别的轮询者。
 *
 *  必须**长于**一次动作 run 的合理耗时,否则同一个页面自己的慢动作会在租约到期后
 *  被重新交付给它自己 —— 把防重复执行修成了制造重复执行。取 10s:长于派发方的等待
 *  上限(editor_ui_browse 的 SHELL_DISPATCH_TIMEOUT_MS = 8s,到点它已经放弃了),
 *  又短到让真正掉线的页面不会把动作永久卡住。 */
const DELIVERY_LEASE_MS = 10_000;

interface SurfaceRecord {
  id: string;
  layer: SurfaceLayer;
  schema: unknown;
  actions: SurfaceActionDef[];
  snapshot: unknown;
  pending: PendingAction[];
  /** pageId → 最近一次轮询时刻。surface id 是"这类界面"的名字,不是"哪个页面"的
   *  名字:两个 ForgeaX 标签页注册同一个 id、共用这一条记录。派发落在哪一页是
   *  随机的,而回读 snapshot 必然"验证成功"(那份 snapshot 正是执行的那一页写的)。
   *  数出有几个页面在听,消费方就能在 >1 时改口"无法确认是哪一页动了"。 */
  pollers: Map<string, number>;
  /** 注册在册的页面 id 集合。**成员资格与活跃度是两套事实**:pollers 回答"现在
   *  有几页在听"(给多页警告用),members 回答"这条记录还有没有页面持有"。
   *  2026-08-06 外审:上一轮的按页注销拿 pollers 当成员资格,而(a)注册请求根本
   *  不带 page、(b)只读面(host.toast:所有 action 对 AI 隐藏)**结构性永不轮询**
   *  —— 于是两页都注册但还没轮询时,关一页就删掉共享记录,剩余页面全部 404。 */
  members: Set<string>;
  seqCounter: number;
  createdAt: number;
  updatedAt: number;
}

interface SurfaceSlim {
  id: string;
  layer: SurfaceLayer;
  actions: SurfaceActionDef[];
  hasSnapshot: boolean;
  pendingCount: number;
  updatedAt: number;
  /** 最近仍在轮询这个 surface 的**页面数**。见 pollers / PAGE_LIVENESS_MS。 */
  pages: number;
}

const surfaces = new Map<string, SurfaceRecord>();
const ackWaiters = new Map<string, { resolve: (v: { ok: boolean; error?: string; result?: unknown; started?: boolean }) => void }>();

function livePageCount(rec: SurfaceRecord, now = Date.now()): number {
  let live = 0;
  for (const [pageId, seenAt] of rec.pollers) {
    if (now - seenAt <= PAGE_LIVENESS_MS) live += 1;
    else rec.pollers.delete(pageId);
  }
  return live;
}

function surfaceSlim(rec: SurfaceRecord): SurfaceSlim {
  return {
    id: rec.id,
    layer: rec.layer,
    actions: rec.actions,
    hasSnapshot: rec.snapshot !== null,
    pendingCount: rec.pending.length,
    updatedAt: rec.updatedAt,
    pages: livePageCount(rec),
  };
}

function listSurfacesSlim(): SurfaceSlim[] {
  return [...surfaces.values()].map(surfaceSlim);
}

/**
 * The registered shell/plugin surfaces and the actions each one publishes —
 * the same projection GET /ui/surfaces returns, for in-process callers (a host
 * tool building the UI capability tree without an HTTP hop to itself).
 */
export function listSurfaces(): SurfaceSlim[] {
  return listSurfacesSlim();
}

/** shell 门此刻有几个页面在听(host.sidebar / host.menubar 取最大)。>1 = 派发落点
 *  不确定:中继与 pending 队列都不带页面身份。单源导出 —— 消费方(kernel-tool 咽喉、
 *  ui_invoke 注解)共用同一个数字与同一句话,不再各自维护。 */
export function shellLivePages(): number {
  try {
    return Math.max(0, ...listSurfacesSlim()
      .filter((row) => row.id === 'host.sidebar' || row.id === 'host.menubar')
      .map((row) => row.pages ?? 0));
  } catch {
    return 0;
  }
}

/** 类级模板:多页警告(事实填充)。 */
export function multiPageHint(pages: number): string {
  return `⚠️ 现在有 ${pages} 个 ForgeaX 页面同时连着,这次执行可能落在用户没在看的那一页上。`
    + '不要向用户声称界面已经变了;请他只保留一个 ForgeaX 页面并刷新后重试。';
}

/**
 * Enqueue an action for `surfaceId`. Returns the token panel will ack with.
 * Throws if the surface isn't registered yet — caller decides whether to
 * surface that to AI or buffer and retry. Used by /api/wb/character/* tool
 * handlers AND by the HTTP POST /ui/surfaces/:id/dispatch endpoint.
 */
export function dispatchToSurface(surfaceId: string, action: string, args: unknown): string {
  const rec = surfaces.get(surfaceId);
  if (!rec) throw new Error(`surface ${surfaceId} not registered`);
  rec.seqCounter += 1;
  const token = `${surfaceId}-${rec.seqCounter}-${Math.random().toString(36).slice(2, 8)}`;
  rec.pending.push({ seq: rec.seqCounter, token, action, args, ts: Date.now(), source: 'ai' });
  rec.updatedAt = Date.now();
  getEventBus().emit('ui.surface.action', {
    id: surfaceId,
    layer: rec.layer,
    action,
    args,
    token,
    seq: rec.seqCounter,
    source: 'ai',
  });
  return token;
}

/**
 * Same as dispatchToSurface() but blocks until panel acks (or timeout). Useful
 * when AI tool handler wants the panel's result before returning to @forgeax/orchestrator.
 * If panel never acks, resolves to {ok:false, error:'timeout'} after timeoutMs.
 *
 * 回执始终携带铸出的 token:它是 ui-events.jsonl 里这次派发那条记录的唯一键,
 * 不交还的话,agent 侧工具结果与人机同账文件之间没有任何机械可连的键
 * (2026-08-06 实测:两条 AI 派发的 token 在 agent 账本里 0 命中)。超时分支
 * 尤其需要它 —— 页面可能已在租约内执行,token 是事后回查 ui-events 的唯一线索。
 */
export function dispatchAndWait(
  surfaceId: string,
  action: string,
  args: unknown,
  timeoutMs = 10000,
): Promise<{ ok: boolean; error?: string; result?: unknown; timedOut?: boolean; started?: boolean; token: string }> {
  const token = dispatchToSurface(surfaceId, action, args);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(token);
      // Best-effort: drop the pending entry too so the panel doesn't run a stale one
      const rec = surfaces.get(surfaceId);
      if (rec) {
        const idx = rec.pending.findIndex((p) => p.token === token);
        if (idx >= 0) rec.pending.splice(idx, 1);
      }
      resolve({ ok: false, error: 'timeout', timedOut: true, token });
    }, timeoutMs);
    ackWaiters.set(token, {
      resolve: (v) => { clearTimeout(timer); resolve({ ...v, token }); },
    });
  });
}

/** For testing / diagnostics: returns the snapshot if the surface exists. */
export function getSurfaceSnapshot(surfaceId: string): unknown {
  return surfaces.get(surfaceId)?.snapshot ?? null;
}
