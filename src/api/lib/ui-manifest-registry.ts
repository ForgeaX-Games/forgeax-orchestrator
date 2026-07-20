/** ui-manifest-registry —— UI 语义操作层(产品 AI 化 P0)的两个进程内中枢:
 *
 *  1. **ActionCatalog 的 per-sid runtime projection**:server ActionCatalog 是声明、权限、
 *     surface 与 first-class exposure 的权威。UI manifest 只能把 catalog 已知 id 绑定到
 *     当前 sid 的在线 executor;未知 id 丢弃,冲突字段由 catalog 纠偏。
 *
 *  2. **UI surface lease**:多标签同 sid 时,「最后获焦的 tab」持有 lease 才是 manifest
 *     的权威来源 + ui_* 感知往返的应答方(声明与执行方必须是同一个 surface,否则
 *     A tab 持 lease 执行、B tab 推声明会出现权限声明与实际行为分离)。获焦即 acquire
 *     (displace 语义:焦点是客户端真值,后来者取代),心跳续期,TTL 过期视为无主。
 *
 *  模块级 Map(单进程 Bun 安全)。重启只丢 runtime binding,不丢 server catalog;
 *  UI 重连后重推 manifest 恢复在线执行能力。
 */
import { randomUUID } from 'node:crypto';
import {
  catalogFirstClass,
  catalogGet,
  type ActionCatalogEntry,
} from '../../kernel/action-catalog';
import type { Capability } from '../../kernel/trust-gate';

/** manifest 里一条 action 的声明(可序列化子集;函数永不过 wire)。 */
export interface UiActionDecl {
  id: string;
  title: string;
  description?: string;
  inputSchema?: unknown;
  capability: Capability;
  surface?: 'ui' | 'server' | 'both';
  /** 预期执行时长(ms);ui_invoke 往返超时据此放宽(clamp 后),缺省走通道默认。 */
  timeoutMs?: number;
  /** P1-9 一等工具化:标 true 的 action 派生独立 ToolSpec(`ui_act_<id>`)下发模型,
   *  免一次 snapshot 发现往返;执行/权限仍反解回 ui_invoke 同一条路。 */
  firstClass?: boolean;
}

/** lease TTL:心跳按 TTL/2 续期;过期视为无主(任何 tab 可 acquire)。 */
export const UI_LEASE_TTL_MS = 30_000;

/** manifest 尺寸护栏(防失控 payload 撑爆内存)。超限截断,fail-soft。 */
const MAX_ACTIONS_PER_SID = 500;

interface SidUiState {
  lease?: { leaseId: string; clientId: string; expiresAt: number };
  /** Catalog ids with an executor binding in the manifest accepted for manifestLeaseId. */
  actions: Set<string>;
  manifestLeaseId?: string;
  manifestTs: number;
}

const states = new Map<string, SidUiState>();

function stateFor(sid: string): SidUiState {
  let s = states.get(sid);
  if (!s) {
    s = { actions: new Set(), manifestTs: 0 };
    states.set(sid, s);
  }
  return s;
}

// ─── lease ──────────────────────────────────────────────────────────────────

/** 获取/续期 lease。displace 语义:焦点是客户端真值,「最后获焦 tab」调用即取代
 *  前任(同 clientId 续期保持 leaseId 稳定,便于客户端持有)。 */
export function acquireUiLease(sid: string, clientId: string): { leaseId: string; ttlMs: number } {
  const s = stateFor(sid);
  const now = Date.now();
  if (s.lease && s.lease.clientId === clientId && s.lease.expiresAt > now) {
    s.lease.expiresAt = now + UI_LEASE_TTL_MS; // 心跳续期,leaseId 不变
    return { leaseId: s.lease.leaseId, ttlMs: UI_LEASE_TTL_MS };
  }
  const leaseId = randomUUID();
  s.lease = { leaseId, clientId, expiresAt: now + UI_LEASE_TTL_MS };
  return { leaseId, ttlMs: UI_LEASE_TTL_MS };
}

/** 校验 leaseId 当前有效(存在、匹配、未过期)。manifest 写入与 ui_* 感知回灌都以此把关。 */
export function validateUiLease(sid: string, leaseId: unknown): boolean {
  if (typeof leaseId !== 'string' || !leaseId) return false;
  const s = states.get(sid);
  return !!s?.lease && s.lease.leaseId === leaseId && s.lease.expiresAt > Date.now();
}

// ─── manifest ───────────────────────────────────────────────────────────────

function catalogProjection(entry: ActionCatalogEntry): UiActionDecl {
  return Object.freeze({
    id: entry.id,
    title: entry.title,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.schema !== undefined ? { inputSchema: entry.schema } : {}),
    capability: entry.capability as Capability,
    ...(entry.surface !== undefined ? { surface: entry.surface } : {}),
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.firstClass !== undefined ? { firstClass: entry.firstClass } : {}),
  });
}

function auditProjection(sid: string, actionId: string, detail: string): void {
  console.warn(`[ui-manifest] sid=${JSON.stringify(sid)} action=${JSON.stringify(actionId)} ${detail}`);
}

function printable(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Bind one client manifest row to a catalog id. Client declaration fields never become authority. */
function sanitizeDecl(sid: string, raw: unknown): UiActionDecl | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return null;
  const entry = catalogGet(id);
  if (!entry) {
    auditProjection(sid, id.slice(0, 200), 'dropped: id not in server ActionCatalog');
    return null;
  }
  if (Object.hasOwn(o, 'capability') && o.capability !== entry.capability) {
    auditProjection(
      sid,
      id,
      `corrected capability received=${printable(o.capability)} authoritative=${printable(entry.capability)}`,
    );
  }
  if (Object.hasOwn(o, 'surface') && o.surface !== entry.surface) {
    auditProjection(
      sid,
      id,
      `corrected surface received=${printable(o.surface)} authoritative=${printable(entry.surface)}`,
    );
  }
  return catalogProjection(entry);
}

/** 写入 runtime manifest projection(整表替换,幂等)。**必须持有效 lease**以绑定执行方。
 *  返回 accepted/dropped 计数供 UI 侧自检。 */
export function setUiManifest(
  sid: string,
  rawActions: unknown,
  leaseId: unknown,
): { ok: boolean; reason?: string; accepted?: number; dropped?: number } {
  if (!validateUiLease(sid, leaseId)) return { ok: false, reason: 'invalid-or-expired-lease' };
  if (!Array.isArray(rawActions)) return { ok: false, reason: 'actions must be an array' };
  const s = stateFor(sid);
  const next = new Set<string>();
  let dropped = 0;
  for (const raw of rawActions.slice(0, MAX_ACTIONS_PER_SID)) {
    const decl = sanitizeDecl(sid, raw);
    if (decl) next.add(decl.id);
    else dropped++;
  }
  const truncated = Math.max(0, rawActions.length - MAX_ACTIONS_PER_SID);
  if (truncated > 0) {
    auditProjection(sid, '*', `dropped ${truncated} row(s): manifest exceeds ${MAX_ACTIONS_PER_SID}-action limit`);
  }
  dropped += truncated;
  s.actions = next;
  s.manifestLeaseId = leaseId as string;
  s.manifestTs = Date.now();
  return { ok: true, accepted: next.size, dropped };
}

/** Catalog declaration query. Runtime manifest state cannot add, remove, or rewrite declarations. */
export function getUiAction(sid: string | undefined, actionId: unknown): UiActionDecl | undefined {
  if (!sid || typeof actionId !== 'string' || !actionId) return undefined;
  const entry = catalogGet(actionId);
  return entry ? catalogProjection(entry) : undefined;
}

/** Whether the current live lease has a UI executor binding for this catalog action. */
export function isUiActionRuntimeAvailable(sid: string | undefined, actionId: unknown): boolean {
  if (!sid || typeof actionId !== 'string') return false;
  const entry = catalogGet(actionId);
  if (!entry || entry.surface === 'server') return false;
  const s = states.get(sid);
  if (!s?.lease || s.lease.expiresAt <= Date.now()) return false;
  return s.manifestLeaseId === s.lease.leaseId && s.actions.has(actionId);
}

/** ui_invoke 往返超时:action 声明了 timeoutMs 则用之(clamp 到 [1s, 30s]),否则通道默认。 */
export function uiInvokeTimeoutMs(sid: string | undefined, actionId: unknown, defaultMs: number): number {
  const decl = getUiAction(sid, actionId);
  if (!decl?.timeoutMs) return defaultMs;
  return Math.min(30_000, Math.max(1_000, decl.timeoutMs));
}

// ─── P1-9 一等工具化:firstClass action ⇄ ui_act_* 工具名 ──────────────────

const FIRST_CLASS_PREFIX = 'ui_act_';
/** 一等工具数量上限(防长尾 manifest 撑爆 prompt 工具区;超出的仍走 snapshot 发现式)。 */
const MAX_FIRST_CLASS_TOOLS = 24;

function firstClassToolName(actionId: string): string {
  return FIRST_CLASS_PREFIX + actionId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

export function isFirstClassUiToolName(toolName: string): boolean {
  return toolName.startsWith(FIRST_CLASS_PREFIX);
}

function exposedFirstClassEntries(): ActionCatalogEntry[] {
  const out: ActionCatalogEntry[] = [];
  const taken = new Set<string>();
  for (const entry of catalogFirstClass()) {
    if (out.length >= MAX_FIRST_CLASS_TOOLS) break;
    const name = firstClassToolName(entry.id);
    if (taken.has(name)) continue;
    taken.add(name);
    out.push(entry);
  }
  return out;
}

/** Catalog 里标 firstClass 的 action → 派生中立 ToolSpec(下发模型)。
 *  名字冲突(不同 id 消毒后同名)后到者跳过;description 带上 ui_invoke 同款结果语义。 */
export function firstClassUiToolSpecs(
  sid: string | undefined,
): Array<{ name: string; description: string; inputSchema: unknown }> {
  if (!sid) return [];
  const out: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  for (const entry of exposedFirstClassEntries()) {
    out.push({
      name: firstClassToolName(entry.id),
      description:
        `[UI action] ${entry.title}. ${entry.description ?? ''} ` +
        `Executes on the connected UI surface; result semantics match ui_invoke ` +
        `({ status: completed|accepted|rejected, reason?, stateDigest? } — on 'accepted' do NOT wait or retry, ` +
        `confirm later via ui_snapshot).`,
      inputSchema: entry.schema ?? { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 反解一等工具名 → actionId(两个 host 工具执行口在信任闸**之前**翻译回 ui_invoke,
 *  使权限/审计/执行全程只认识 ui_invoke 一条路)。非 ui_act_* / 查不到 → undefined。 */
export function resolveFirstClassUiTool(sid: string | undefined, toolName: string): { actionId: string } | undefined {
  if (!sid || !isFirstClassUiToolName(toolName)) return undefined;
  for (const entry of exposedFirstClassEntries()) {
    if (firstClassToolName(entry.id) === toolName) return { actionId: entry.id };
  }
  return undefined;
}

/** session dispose 时清理(lease + manifest 都不跨会话残留)。 */
export function clearUiStateForSession(sid: string): void {
  states.delete(sid);
}
