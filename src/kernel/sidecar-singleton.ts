/**
 * ensureSidecar —— server 侧懒启 + 连接 ring-0 `agent-host`(singleton)。
 *
 * 默认试连已有实例;连不上 → `Bun.spawn` agent-host(随 server 生命周期;agent-host 自身单例,
 * 重复 spawn 安全)→ 重试连接。`FORGEAX_AGENT_HOST_EXTERNAL_ONLY=1|true` 时只重试外部实例，
 * 不会自行 spawn。缓存 client;连接失效下次重连。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveRuntimeLaunch } from '../lib/node-spawn';
import { SidecarClient, defaultSockPath } from './sidecar-client';

/** sidecar(agent-host)serve 入口:经**包解析**定位(发布后跨包仍成立),
 *  monorepo 源码态回退到相对路径(发包前过渡)。耦合从「硬编码兄弟路径」收敛到
 *  「`@forgeax/agent-host` 包依赖 + `./serve` 导出」——见 package.json。 */
function resolveAgentHostMain(): string {
  const override = process.env.FORGEAX_AGENT_HOST_ENTRY?.trim();
  if (override) return resolve(override);
  try {
    return fileURLToPath(import.meta.resolve('@forgeax/agent-host/serve'));
  } catch {
    return resolve(import.meta.dirname, '../../../agent-host/src/main.ts');
  }
}
const AGENT_HOST_MAIN = resolveAgentHostMain();

let cached: SidecarClient | null = null;
let proc: ChildProcess | null = null;

/** `ChildProcess.killed` only records whether `.kill()` was called; it stays
 * false after a child exits by itself.  Use the exit fields when deciding
 * whether a tracked agent-host can still satisfy the next request. */
export function isTrackedSidecarAlive(
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'> | null,
): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

async function tryConnect(): Promise<SidecarClient | null> {
  try {
    const c = await SidecarClient.connect(defaultSockPath(), 1000);
    await c.ping();
    return c;
  } catch {
    return null;
  }
}

function externalOnlyMode(): boolean {
  const value = process.env.FORGEAX_AGENT_HOST_EXTERNAL_ONLY;
  return value === '1' || value === 'true';
}

export type RestartSidecarOutcome =
  | { restarted: true; restartRequired: false }
  | { restarted: false; restartRequired: true; warning: string };

const EXTERNAL_RESTART_WARNING =
  'Credentials saved, but the external agent-host was not restarted; restart the owning launcher to apply them.';

function spawnTimeoutMs(): number {
  const v = Number(process.env.FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

async function connectUntil(deadline: number): Promise<SidecarClient | null> {
  while (Date.now() < deadline) {
    const c = await tryConnect();
    if (c) return c;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function ensureSidecar(): Promise<SidecarClient> {
  if (cached) {
    try { await cached.ping(); return cached; } catch { cached = null; }
  }
  // 1) 已有实例?
  const existing = await tryConnect();
  if (existing) { cached = existing; return cached; }

  const timeoutMs = spawnTimeoutMs();
  if (externalOnlyMode()) {
    const external = await connectUntil(Date.now() + timeoutMs);
    if (external) { cached = external; return cached; }
    throw new Error(`external agent-host sidecar not reachable within ${timeoutMs}ms`);
  }

  // 2) 懒启 agent-host(共享 server 的 env,含 FORGEAX_AGENT_HOST_SOCK)。
  if (!isTrackedSidecarAlive(proc)) {
    const launch = resolveRuntimeLaunch(AGENT_HOST_MAIN);
    const child = spawn(launch.cmd, launch.args, {
      env: process.env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    proc = child;
    child.once('exit', () => {
      if (proc === child) proc = null;
    });
  }

  // 3) 重试连接。窗口默认 30s(env `FORGEAX_AGENT_HOST_SPAWN_TIMEOUT_MS` 可覆盖):Windows 上
  //    首次 `Bun.spawn` 冷启(bun 启动 + 转译 + 杀软实时扫描 + reclaimSocket 对陈旧 socket 的探测)
  //    常超过旧的 8s 硬上限 → 误报 "not reachable after spawn"(进程其实仍在启动)。
  const c = await connectUntil(Date.now() + timeoutMs);
  if (c) { cached = c; return cached; }
  throw new Error('sidecar (agent-host) not reachable after spawn');
}

/**
 * 重启 sidecar —— 让它**重读进程 env 里的凭据**。cred-vault(agent-host 侧)在发 scoped token
 * 时才现取 `process.env.ANTHROPIC_API_KEY`、转发时现取 `ANTHROPIC_BASE_URL`,但那是 sidecar
 * **子进程 spawn 时冻结的 env 快照**——server 经 `PUT /api/settings/env` 的 live-apply 只改到
 * server 自己的 `process.env`,到不了已在跑的 sidecar。故设置页改了 LLM 凭据后必须让 sidecar
 * 真正退出重生:下次 `ensureSidecar()` 会用**当前** server 进程 env(已含新凭据)spawn 新实例。
 *
 * owned 模式步骤:请运行中的 sidecar `shutdown` → 等旧 socket 消失(避免下次 ensureSidecar
 * 抢在退出窗口里重连回旧冻结实例)→ 清空 singleton + 杀本进程句柄。external-only 模式不
 * 触碰外部 host,只清空本地 client 并返回 restartRequired。best-effort:连不上/已退出都视作
 * 前置已满足。
 */
export async function restartSidecar(): Promise<RestartSidecarOutcome> {
  if (externalOnlyMode()) {
    // The externally managed host belongs to its launcher, not this server.
    // Drop only this process's connection so settings can be saved without
    // taking down every client sharing the host.
    try { cached?.close(); } catch { /* ignore */ }
    cached = null;
    return { restarted: false, restartRequired: true, warning: EXTERNAL_RESTART_WARNING };
  }

  const client = cached ?? (await tryConnect());
  if (client) {
    try { await client.shutdown(); } catch { /* 已在退出 / 连不上 */ }
    try { client.close(); } catch { /* ignore */ }
  }
  cached = null;
  try { proc?.kill(); } catch { /* ignore */ }
  proc = null;
  // 等旧实例真正放掉 socket(优雅 shutdown 会 unlink);win32 命名管道无文件表征 → 跳过,
  // 靠下次 ensureSidecar 的 tryConnect+ping 失败来触发重 spawn。最多等 ~3s。
  if (process.platform !== 'win32') {
    const sockPath = defaultSockPath();
    for (let i = 0; i < 30; i++) {
      if (!existsSync(sockPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { restarted: true, restartRequired: false };
}

/** 测试/关停用。 */
export function resetSidecarSingleton(): void {
  try { cached?.close(); } catch { /* ignore */ }
  cached = null;
  try { proc?.kill(); } catch { /* ignore */ }
  proc = null;
}
