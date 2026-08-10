/**
 * /api/kernel-permissions —— per-kernel 权限姿态(Studio 设置页后端)。
 *
 *   GET  /api/kernel-permissions → { config:{perKernel}, kernels:[{id,supported,defaultMode,configured?}],
 *                                    defaultMode }
 *   PUT  /api/kernel-permissions → 保存 {perKernel};回 { ok, config }
 *
 * 配置落 `<projectRoot>/.forgeax/kernel-permissions.json`(SSOT = kernel/permission-config);
 * `supported` 从各内核 profile 派生(**不入持久化**),故前端下拉永远只列该内核真能兑现的档。
 * 形状与读写口径对齐 memory-settings(同为「设置页写、运行时读」的项目级配置)。
 */
import { Hono } from 'hono';
import type { AgentKernel } from '@forgeax/agent-runtime';
import {
  coercePerKernelModes,
  readKernelPermissions,
  writeKernelPermissions,
  type KernelPermissionConfig,
} from '../kernel/permission-config';
import { DEFAULT_KERNEL_PERMISSION_MODE, listKernelPermissionCaps } from '../kernel/permission-catalog';

/**
 * The product shell may provide its own registry view. This is important for
 * hosts that load the orchestrator and the product adapter through different
 * module-resolution paths: the API must enumerate the same kernels that the
 * shell registered, rather than silently falling back to a second registry.
 */
export function createKernelPermissionsRouter(
  kernelProvider?: () => readonly AgentKernel[],
): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    return c.json({
      config: readKernelPermissions(),
      kernels: listKernelPermissionCaps(undefined, kernelProvider?.()),
      defaultMode: DEFAULT_KERNEL_PERMISSION_MODE,
    });
  });

  r.put('/', async (c) => {
    let body: Partial<KernelPermissionConfig>;
    try {
      body = (await c.req.json()) as Partial<KernelPermissionConfig>;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    // 净化在 SSOT 那一处(coercePerKernelModes):非法档位剔除而非放行,详见其注释。
    const cfg: KernelPermissionConfig = { perKernel: coercePerKernelModes(body.perKernel) };
    try {
      writeKernelPermissions(cfg);
      return c.json({ ok: true, config: cfg });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return r;
}
