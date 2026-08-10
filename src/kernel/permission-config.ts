/**
 * 内核权限姿态 —— 默认档 + 项目级 standing 配置的持久化 SSOT。
 *
 * 中立轴 `PermissionMode`('gated'|'autoEdits'|'planning'|'unrestricted')住在
 * `@forgeax/agent-runtime` 契约里,本文件**只消费不扩展**(契约保持干净)。
 *
 * 分工(避免与各 profile 重复持有权限知识):
 *  - 本文件:中立默认档({@link DEFAULT_KERNEL_PERMISSION_MODE})+ 落盘配置读写 + 纯 clamp。
 *  - 各 `*-profile.ts`:该内核**能兑现的档位**(`*_SUPPORTED_PERMISSION_MODES`)与方言翻译。
 *    每个内核的权限控制点就是它自己的 profile 文件,改一处即改该内核全部放行姿态。
 *  - `permission-catalog.ts`:把上面两者汇总给 API/UI(单向 profile → catalog,无环)。
 *
 * 落盘 `<projectRoot>/.forgeax/kernel-permissions.json`,形态 `{ perKernel }`;
 * 形状与读写口径对齐 `soul/memory-config.ts`(同为「设置页写、运行时读」的项目级配置)。
 *
 * Boundary(HOST 层):node: + @forgeax/{agent-runtime,platform-io}。
 */
import type { PermissionMode } from '@forgeax/agent-runtime';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * 全内核默认放行姿态 —— **改默认只改这一行**。
 *
 * `unrestricted` = 基线全放行(危险方式启动):不卡 per-tool 审批。这是安全的,因为
 * 收窄面在上层且**对放行档免疫**——已实测(cc 源码 `utils/permissions/permissions.ts`):
 * deny 规则 / 内容级 ask / `.git`·`.claude` safetyCheck 都在 bypass 短路**之前**求值,
 * PreToolUse hook 更在整条权限管道之前跑。故 `permissions.deny` + hook-gate 在全权限
 * 默认下仍然拦得住;默认放行只是把「基线」抬高,不是把闸拆掉。
 *
 * 各内核若表达不了本档,由其 profile 的 supported 列表 clamp 到最近可兑现档(见 clampMode)。
 */
export const DEFAULT_KERNEL_PERMISSION_MODE: PermissionMode = 'unrestricted';

/**
 * 原生内核 forgeax-core 能兑现的档位:四档全支持。
 *
 * 它不是 spawn 期 argv,而是把 `TurnRequest.permissionMode` 经 unix-socket 送进 sidecar,
 * 由 sidecar 的权限 engine 兑现(其枚举正好是 default/acceptEdits/plan/bypassPermissions)。
 * 声明放在本文件而非某个 `*-profile.ts`:原生内核没有「方言 profile」这一层。
 */
export const CORE_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = [
  'gated',
  'autoEdits',
  'planning',
  'unrestricted',
];

/** forgeax-core 默认档 —— 派生自全内核默认,不独立持值。 */
export const CORE_DEFAULT_PERMISSION_MODE: PermissionMode = DEFAULT_KERNEL_PERMISSION_MODE;

/** 中立轴全集。用于外部 JSON 入口(PUT body / 磁盘读回)的 fail-fast 净化。 */
const NEUTRAL_MODES: readonly PermissionMode[] = ['gated', 'autoEdits', 'planning', 'unrestricted'];

/** 某内核的 standing 档位覆盖(设置页写入);缺键 = 未设置 = 走该内核默认。 */
export interface KernelPermissionConfig {
  perKernel: Record<string, PermissionMode>;
}

export function defaultKernelPermissionConfig(): KernelPermissionConfig {
  return { perKernel: {} };
}

function cfgPath(projectRoot: string): string {
  return resolve(projectRoot, '.forgeax', 'kernel-permissions.json');
}

/** 净化 perKernel:只保留中立轴上的合法档位。
 *
 *  非法值(手改 JSON、旧档位改名、前端传错)必须在此剔除而非放行 —— 一旦漏到
 *  `req.permissionMode`,方言翻译会拿到 undefined 分支或 argv 里出现非法值,
 *  表现为内核启动失败或**静默降级成未知姿态**。宁可退回默认档(可预期)。 */
export function coercePerKernelModes(raw: unknown): Record<string, PermissionMode> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, PermissionMode> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && NEUTRAL_MODES.includes(v as PermissionMode)) {
      out[k] = v as PermissionMode;
    }
  }
  return out;
}

/** 读 standing 配置;不存在/损坏 → 空覆盖(即全部走各内核默认)。 */
export function readKernelPermissions(
  projectRoot: string = defaultProjectRoot(),
): KernelPermissionConfig {
  try {
    const p = cfgPath(projectRoot);
    if (!existsSync(p)) return defaultKernelPermissionConfig();
    const j = JSON.parse(readFileSync(p, 'utf-8')) as Partial<KernelPermissionConfig>;
    return { perKernel: coercePerKernelModes(j.perKernel) };
  } catch {
    return defaultKernelPermissionConfig();
  }
}

/** 写 standing 配置。 */
export function writeKernelPermissions(
  cfg: KernelPermissionConfig,
  projectRoot: string = defaultProjectRoot(),
): void {
  const p = cfgPath(projectRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ perKernel: cfg.perKernel }, null, 2));
}

/** 某内核的 standing 档位;未设置 → undefined(交由内核 profile 默认兜底)。 */
export function standingModeFor(
  kernelId: string,
  projectRoot: string = defaultProjectRoot(),
): PermissionMode | undefined {
  return readKernelPermissions(projectRoot).perKernel[kernelId];
}

/**
 * 放行强度排序(小 = 更严)。用于把越界档往**紧**的方向收敛。
 *   planning     只读,连编辑都不给 —— 对「改动」最严
 *   gated        逐项审批
 *   autoEdits    编辑自动放行,其余仍受限
 *   unrestricted 基线全放行
 */
const LOOSENESS: Record<PermissionMode, number> = {
  planning: 0,
  gated: 1,
  autoEdits: 2,
  unrestricted: 3,
};

/**
 * 把中立档位收敛到某内核**真能兑现**的档位。
 *
 * 纯函数(supported 由调用方从 profile 取,故本文件不 import 任何 profile)。
 *
 * **收敛方向必须往紧**:请求一个更严但该内核给不出的档(codex 的 `planning`),
 * 只能退到「不比它更松的最近档」;没有这种档时退到 supported 里**最严**的一档 ——
 * 绝不能退到默认档,因为默认档是 `unrestricted`,那等于「你要只读、我给你全权限」。
 * 越界不静默:返回 `downgraded`,调用方负责出声。
 */
export function clampMode(
  mode: PermissionMode,
  supported: readonly PermissionMode[],
  _fallback?: PermissionMode,
): { mode: PermissionMode; downgraded: boolean } {
  if (supported.includes(mode)) return { mode, downgraded: false };
  if (supported.length === 0) return { mode, downgraded: false };
  const want = LOOSENESS[mode];
  const byStrictness = [...supported].sort((a, b) => LOOSENESS[a] - LOOSENESS[b]);
  // 不比请求更松的最近档;没有则取最严的一档。
  const notLooser = byStrictness.filter((m) => LOOSENESS[m] <= want);
  const safe = notLooser.length ? notLooser[notLooser.length - 1]! : byStrictness[0]!;
  return { mode: safe, downgraded: true };
}
