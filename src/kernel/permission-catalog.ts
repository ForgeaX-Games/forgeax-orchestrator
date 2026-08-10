/**
 * 权限能力 resolver —— 各内核声明能力，平台统一聚合给 API/UI。
 *
 * 方向与 model-catalog 对齐：内核拥有「我真实能兑现什么」的真相，编排层只做
 * registry 枚举、项目配置叠加和稳定的 API 形状转换。新增内核只需要把自己的
 * `permissionCapabilities` 放进 AgentKernel，不再修改一张平行的手工清单。
 */
import type {
  AgentKernel,
  KernelPermissionCapabilities,
  PermissionMode,
} from '@forgeax/agent-runtime';
import { listAvailableKernels } from './resolve-kernel';
import {
  DEFAULT_KERNEL_PERMISSION_MODE,
  readKernelPermissions,
} from './permission-config';

/** 一个内核的权限能力面(给 UI 渲染下拉用)。 */
export interface KernelPermissionCap extends KernelPermissionCapabilities {
  /** 内核 id(= providerOverride / 路由用的那个 id)。 */
  readonly id: string;
  /** 用户配过的 standing 档位;未配 → undefined(UI 显示「跟随默认」)。 */
  readonly configured?: PermissionMode;
}

/** 全内核默认档(UI 提示「默认 = 危险方式/全权限」用)。 */
export { DEFAULT_KERNEL_PERMISSION_MODE };

/**
 * 列出已注册内核的权限能力 + 已配档位。
 *
 * `kernels` 只用于测试/宿主注入；生产默认走同一个 AgentKernel registry，避免
 * catalog 再持有一份内核 id 清单。没有声明权限面的内核不出现在设置页，避免
 * UI 暗示一个实际不存在的旋钮。
 */
export function listKernelPermissionCaps(
  projectRoot?: string,
  kernels: readonly AgentKernel[] = listAvailableKernels(),
): KernelPermissionCap[] {
  const { perKernel } = readKernelPermissions(projectRoot);
  return kernels.flatMap((kernel) => {
    const capability = kernel.permissionCapabilities;
    if (!capability) return [];
    const configured = perKernel[kernel.id];
    return [{
      id: kernel.id,
      ...capability,
      ...(configured ? { configured } : {}),
    }];
  });
}
