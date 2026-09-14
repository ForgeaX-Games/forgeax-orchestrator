/**
 * /api/memory-settings — 记忆自动沉淀开关(Studio 设置页后端)。
 *
 *   GET  /api/memory-settings  → { config: {master, perKernel}, kernels: [{id, cacheWarmCapable}] }
 *   PUT  /api/memory-settings  → 保存 {master, perKernel};回 { ok, config }
 *
 * 配置落 `<projectRoot>/.forgeax/memory-settings.json`(soul/memory-config SSOT);kernels 的
 * cacheWarmCapable 从内核 registry 派生(capabilities.forkExtract)→ 前端据此渲染「省/不省 token」
 * 标 + 切到 cache-incapable 内核时的提示。
 */
import { Hono } from 'hono';
import type { MemorySwitchConfig } from '@forgeax/types';
import { readMemorySwitch, writeMemorySwitch, listKernelCacheCaps, coercePerKernel } from '../soul/memory-config';

export function createMemorySettingsRouter(): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    return c.json({ config: readMemorySwitch(), kernels: listKernelCacheCaps() });
  });

  r.patch('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !(typeof body.master === 'boolean' || (typeof body.kernelId === 'string' && body.kernelId.trim() && typeof body.enabled === 'boolean'))) return c.json({ error: 'master or kernelId and enabled required' }, 400);
    const config = readMemorySwitch();
    if (typeof body.master === 'boolean') config.master = body.master;
    else {
      const patch = coercePerKernel({ [body.kernelId]: body.enabled });
      if (!Object.hasOwn(patch, body.kernelId)) return c.json({ error: 'invalid kernelId' }, 400);
      config.perKernel = { ...config.perKernel, ...patch };
    }
    writeMemorySwitch(config);
    return c.json({ ok: true, config });
  });

  r.put('/', async (c) => {
    let body: Partial<MemorySwitchConfig>;
    try {
      body = (await c.req.json()) as Partial<MemorySwitchConfig>;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const cfg: MemorySwitchConfig = {
      master: typeof body.master === 'boolean' ? body.master : true,
      perKernel: coercePerKernel(body.perKernel),
    };
    try {
      writeMemorySwitch(cfg);
      return c.json({ ok: true, config: cfg });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return r;
}
