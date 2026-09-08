/**
 * kernelEnabled —— sessions/cli 主对话是否走**内核 + sidecar 整套栈**。
 *
 * **ship-gate 已翻:全局默认 = 内核 + sidecar**(sidecar 经 `sidecarEnabled()` 耦合默认同开)。
 *
 * NOTE (runtime refactor 2026-07): Session 主对话路径 (`RuntimeAgentHost` /
 * `runKernelTurn`) 已是 kernel-only。`FORGEAX_KERNEL=cli` / `.forgeax/use-cli`
 * 仍影响 **CLI bridge / rented provider** 与部分测试夹具,但不再把
 * `POST /:sid/messages` 送回已删除的 in-process `runAgentLoop` /
 * ConsciousAgent。需要旧 in-process 行为时只能改代码/回退版本,不能靠这个 env。
 *
 * 历史逃生开关(仍被本函数识别,供 CLI/测试消费):
 * `FORGEAX_KERNEL=cli`(或 `=off`)/ `FORGEAX_NO_KERNEL=1` /
 * `<projectRoot>/.forgeax/use-cli` 文件(部署级)。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';

export function kernelEnabled(projectRoot?: string): boolean {
  const k = (process.env.FORGEAX_KERNEL ?? '').trim();
  if (k === 'cli' || k === 'off' || process.env.FORGEAX_NO_KERNEL === '1') return false; // 显式逃生 → 旧路径
  if (k === 'kernel') return true; // 显式开
  try {
    // ship-gate 已翻:**全局默认 = 内核 + sidecar**。部署级逃生回旧路径:放 `.forgeax/use-cli`。
    if (existsSync(resolve(projectRoot ?? defaultProjectRoot(), '.forgeax/use-cli'))) return false;
  } catch {
    /* ignore */
  }
  return true; // 默认走内核(三闸已通;多模态图片输入当前为 UI 占位非实流,不构成回归)
}

/** sidecar 是否启用(与内核耦合,默认 ON;`FORGEAX_SIDECAR=off` 逃生回内核直 spawn)。 */
export function sidecarEnabled(): boolean {
  return (process.env.FORGEAX_SIDECAR ?? '').trim() !== 'off';
}

/** True only when both the kernel stack and its sidecar are enabled. */
export function kernelStackGuarded(projectRoot?: string): boolean {
  return kernelEnabled(projectRoot) && sidecarEnabled();
}
