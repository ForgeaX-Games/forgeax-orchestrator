/** POST /ui/surfaces/:id/dispatch 与 GET /product-ai-native/ledger 的两道闸
 *  (Product AI Native v0.1 跟修轮)。
 *
 *  两条都是"邻居有闸、自己没有"的口子:
 *  ① dispatch 把每一条入队动作打成 source:'ai',却没有任何 caller gate,也不看
 *     surface 自己声明的 exposedToAI —— 协议 1(只有 exposedToAI === true 可被 AI
 *     执行、且必须在 handler 之前拒绝)在这条路上根本不成立。
 *  ② ledger 的 GET 允许缺 sessionId(= 跨会话全读),而协议 7 要求 readLedger 是
 *     **带作用域的授权投影**。
 *
 *  回退任一修复即红。 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBusRouter, dispatchToSurface, HiddenSurfaceActionError } from '../src/api/bus';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';

const ID = 'ui.dispatch.gate';
let projectRoot: string;
let previousProjectRoot: string | undefined;

function freshApp(): Hono {
  const app = new Hono();
  app.route('/api/bus', createBusRouter());
  return app;
}

/** 同源 Studio 浏览器的请求头(与 human-attempt 用例同款)。 */
function sameOrigin(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' },
    body: JSON.stringify(body),
  };
}

async function register(app: Hono, actions: Array<Record<string, unknown>>): Promise<void> {
  await app.request(`/api/bus/ui/surfaces/${ID}`, { method: 'DELETE' });
  await app.request('/api/bus/ui/surfaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: ID, layer: 'host', actions }),
  });
}

async function pendingCount(app: Hono): Promise<number> {
  const res = await app.request(`/api/bus/ui/surfaces/${ID}`);
  if (res.status !== 200) return 0;
  return ((await res.json()) as { pendingCount: number }).pendingCount;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-dispatch-gate-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
});

afterEach(async () => {
  await freshApp().request(`/api/bus/ui/surfaces/${ID}`, { method: 'DELETE' });
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /ui/surfaces/:id/dispatch —— caller 闸 + exposedToAI 闸', () => {
  it('无 Origin 的本机非浏览器客户端被拒,且不入队', async () => {
    const app = freshApp();
    await register(app, [{ id: 'selectTab', exposedToAI: true }]);
    const res = await app.request(`/api/bus/ui/surfaces/${ID}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'selectTab', args: { tab: 'agents' } }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin-not-allowed' });
    expect(await pendingCount(app)).toBe(0);
  });

  it('同名不同端口的跨源浏览器同样被拒', async () => {
    const app = freshApp();
    await register(app, [{ id: 'selectTab', exposedToAI: true }]);
    const res = await app.request(`/api/bus/ui/surfaces/${ID}/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:38920',
        host: 'localhost:38900',
      },
      body: JSON.stringify({ action: 'selectTab', args: {} }),
    });
    expect(res.status).toBe(403);
    expect(await pendingCount(app)).toBe(0);
  });

  it('同源浏览器派发已暴露的 action —— 入队并回 token', async () => {
    const app = freshApp();
    await register(app, [{ id: 'selectTab', exposedToAI: true }]);
    const res = await app.request(
      `/api/bus/ui/surfaces/${ID}/dispatch`,
      sameOrigin({ action: 'selectTab', args: { tab: 'agents' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, token: expect.stringContaining(`${ID}-1-`) });
    expect(await pendingCount(app)).toBe(1);
  });

  it('surface 声明为隐藏的 action —— 403 hidden-action,且在入队与总线事件之前就被拒', async () => {
    const app = freshApp();
    await register(app, [{ id: 'selectTab', exposedToAI: true }, { id: 'secretWipe', exposedToAI: false }]);
    _resetEventBusForTests();
    const res = await app.request(
      `/api/bus/ui/surfaces/${ID}/dispatch`,
      sameOrigin({ action: 'secretWipe', args: {} }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'hidden-action', action: 'secretWipe', surfaceId: ID });
    expect(await pendingCount(app)).toBe(0);
    // 拒绝必须发生在 handler / 队列 / 账本之前:一条 ui.surface.action 都不许出去。
    expect(getEventBus().recent('ui.surface.action', 10)).toEqual([]);
  });

  it('缺 exposedToAI 键 = 隐藏(默认拒绝),不是"未声明"', async () => {
    const app = freshApp();
    await register(app, [{ id: 'selectTab' }]);
    const res = await app.request(
      `/api/bus/ui/surfaces/${ID}/dispatch`,
      sameOrigin({ action: 'selectTab', args: {} }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'hidden-action' });
    expect(await pendingCount(app)).toBe(0);
  });

  it('进程内直调者不豁免:dispatchToSurface 对隐藏 action 直接抛 HiddenSurfaceActionError', async () => {
    const app = freshApp();
    await register(app, [{ id: 'secretWipe', exposedToAI: false }]);
    expect(() => dispatchToSurface(ID, 'secretWipe', {})).toThrow(HiddenSurfaceActionError);
    expect(await pendingCount(app)).toBe(0);
  });

  it('surface 没登记这条 action = 未暴露:入队前拒绝(协议 1:只有显式 true 才可执行)', async () => {
    const app = freshApp();
    await register(app, []);
    expect(() => dispatchToSurface(ID, 'anything', {})).toThrow(HiddenSurfaceActionError);
    expect(await pendingCount(app)).toBe(0);
  });
});

describe('GET /product-ai-native/ledger —— 带作用域的授权投影', () => {
  it('缺 sessionId 时 400,不回任何行', async () => {
    const res = await freshApp().request('/api/bus/product-ai-native/ledger');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: 'bad-request' });
    expect(body).not.toHaveProperty('items');
  });

  it('只带别的过滤条件也不算作用域 —— 仍是 400', async () => {
    const res = await freshApp().request('/api/bus/product-ai-native/ledger?actionId=session.create&limit=5');
    expect(res.status).toBe(400);
  });

  it('空白 sessionId 不算作用域', async () => {
    const res = await freshApp().request('/api/bus/product-ai-native/ledger?sessionId=%20');
    expect(res.status).toBe(400);
  });

  it('带 sessionId 时正常读(无账本文件 → 空投影)', async () => {
    const res = await freshApp().request('/api/bus/product-ai-native/ledger?sessionId=sess-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], count: 0 });
  });
});
