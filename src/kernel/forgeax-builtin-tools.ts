/**
 * forgeax-builtin-tools —— forgeax-core 原生内核路径下「编排层声明的内置 forgeax 工具」
 * 的宿主侧执行实现。
 *
 * `compose-turn-request.ts` 把内置工具 schema 暴露给模型；forgeax-core 不经过
 * cc/cbc/codex 使用的 MCP stdio server，因此需要在宿主侧提供同一批执行实现。
 *
 * memory 与 MCP asset 共同复用 `soul/layered-memory-runtime.mjs` 这份 plain-Node
 * SSOT，感知接地复用 `perception-registry`。`host-tool-bridge` 与
 * `:sid/kernel-tool` 两个 host 工具执行口都在信任闸放行后、executeTool 前调用本模块。
 *
 * cc/cbc/codex 内核仍在 `.mjs` 中本地执行这些工具，不会桥回 `:sid/kernel-tool`；
 * 本模块只对 forgeax-core 路径生效。工具 schema 仍须与 MCP server 同步。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Event } from '../core/types';
import type { LayeredMemoryRef } from '../soul/types';
import { soulMemoryRoot, searchMemory, classifyAndWrite } from '../soul';
import { registerPerception } from '../api/lib/perception-registry';
import {
  uiInvokeTimeoutMs,
  getUiAction,
  isUiActionRuntimeAvailable,
  isFirstClassUiToolName,
  resolveFirstClassUiTool,
} from '../api/lib/ui-manifest-registry';
import { getHostTool, getHostUiAction, type HostToolRunCtx } from '../orchestration-seams';
import { catalogGet } from './action-catalog';
import { findVisibleDoor } from './action-door';
import { getSurfaceSnapshot, shellLivePages, multiPageHint } from '../api/bus';
import { getBuiltinHeadlessUiAction } from './ui-headless-actions';
import { walkDoorInstead, DoorWalkDispatched } from './door-reroute';
import { NPC_TOOL_CONTRACTS } from '@forgeax/types/npc-tools';

/** 仅需 publish 的最小事件发布口（EventBus、绑定 bus、测试桩均可满足）。 */
export interface EventPublisher {
  publish(event: Event, emitterId?: string): void;
}

/** 内置 forgeax 工具名集合，与 compose-turn-request 和 MCP server 的声明对齐。
 * 游戏语义工具已迁至产品壳，经 HostToolSpec seam 注入。 */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'echo',
  'memory_search',
  'remember',
  'soul_create',
  'npc_wire',
  'ui_snapshot',
  'ui_invoke',
  'ui_screenshot',
]);

/** 该工具是否由宿主侧内置实现，不需要查询 agent kit。 */
export function isForgeaxBuiltinTool(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

export interface UiActionNotFoundResult {
  status: 'rejected';
  code: 'not_found';
  reason: string;
}

function notFoundUiAction(actionId: string): UiActionNotFoundResult {
  return {
    status: 'rejected',
    code: 'not_found',
    reason: `action ${JSON.stringify(actionId)} not in server ActionCatalog`,
  };
}

/** Catalog existence preflight shared by direct builtin execution and both host dispatchers. */
export function uiActionCatalogRejection(actionId: unknown): UiActionNotFoundResult | undefined {
  const id = typeof actionId === 'string' ? actionId : '';
  return catalogGet(id) ? undefined : notFoundUiAction(id);
}

export interface UiToolDispatchPreflight {
  name: string;
  args: unknown;
  rejection?: UiActionNotFoundResult;
}

/** Normalize ui_act_* to ui_invoke and reject catalog misses before any trust policy runs. */
export function preflightUiToolDispatch(
  name: string,
  args: unknown,
  sid: string,
): UiToolDispatchPreflight {
  const normalizedArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const firstClass = resolveFirstClassUiTool(sid, name);
  if (firstClass) {
    return {
      name: 'ui_invoke',
      args: { actionId: firstClass.actionId, args: normalizedArgs },
    };
  }
  if (isFirstClassUiToolName(name)) {
    return { name, args: normalizedArgs, rejection: notFoundUiAction(name) };
  }
  if (name === 'ui_invoke') {
    const rejection = uiActionCatalogRejection(normalizedArgs.actionId);
    return { name, args: normalizedArgs, ...(rejection ? { rejection } : {}) };
  }
  return { name, args };
}

/** 感知/UI 往返的 query kind。 */
export type PerceptionKind = 'world' | 'frame' | 'ui_snapshot' | 'ui_invoke' | 'ui_screenshot';

/** 内置工具执行上下文（显式输入，保持 Pipeline Isolation）。 */
export interface BuiltinToolCtx {
  /** 工作区根目录（游戏与 soul 的解析基准）。 */
  projectRoot: string;
  /** soul 记忆库所属 agent；决定 `.forgeax/souls/<agentId>/memory`。 */
  agentId: string;
  /** 当前游戏 slug；game-bound 记忆按此隔离。 */
  game?: string;
  /** 感知工具使用的会话总线；缺省时 fail-soft 为 unavailable。 */
  eventBus?: EventPublisher;
  /** 会话 id，用于 UI lease、runtime binding 与 catalog projection。 */
  sid?: string;
  /** 本轮工具调用 id —— 透传给 HostToolRunCtx,让产品壳的旁账能连回主账本。 */
  callId?: string;
  /** MCP shim 自铸的这一次宿主执行 id —— 租用内核路径上旁账唯一能连的键。 */
  toolExecutionId?: string;
}

const PERCEPTION_TIMEOUT_MS = 8_000;
/** ui_invoke 默认超时。 */
const UI_INVOKE_TIMEOUT_MS = 10_000;
/** ui_screenshot 涉及 DOM 序列化与栅格化，使用更宽的超时。 */
const UI_SCREENSHOT_TIMEOUT_MS = 15_000;

function memoryRef(ctx: BuiltinToolCtx): LayeredMemoryRef {
  return { root: soulMemoryRoot(ctx.projectRoot, ctx.agentId), ...(ctx.game ? { game: ctx.game } : {}) };
}

/** 将内置工具上下文适配为 seam 工具使用的 HostToolRunCtx。 */
/** ui_invoke 的门注解 —— 长在能力实现层,谁调 runForgeaxBuiltinTool 都被盖到。
 *  此前挂在 /:sid/perception-query 路由里,而 ui_invoke 的真实链路(MCP shim →
 *  kernel-tool → 本函数的进程内 perceptionQuery)从不经过那条路由 —— "没门的能力
 *  必须明说"这条硬约束等于从未装上(2026-08-05 终审 P0)。 */
export function annotateUiInvokeResult(out: unknown, actionId: string, actionArgs: unknown): unknown {
  if (!out || typeof out !== 'object' || Array.isArray(out) || !actionId) return out;
  try {
    const menubar = getSurfaceSnapshot('host.menubar') as { menus?: unknown } | null;
    const sidebar = getSurfaceSnapshot('host.sidebar') as { entries?: Array<{ id?: unknown; label?: unknown }> } | null;
    const door = findVisibleDoor(
      { menus: menubar?.menus ?? null, rail: sidebar?.entries ?? null, fact: catalogGet(actionId)?.door },
      actionId,
      actionArgs,
    );
    const pages = shellLivePages();
    return {
      ...(out as Record<string, unknown>),
      door,
      ...(pages > 1 ? { multiplePages: multiPageHint(pages) } : {}),
    };
  } catch {
    return out; // 注解失败不拦执行结果 —— 但绝不伪造 door
  }
}

export function hostToolRunCtx(ctx: BuiltinToolCtx): HostToolRunCtx {
  return {
    ...(ctx.sid ? { sid: ctx.sid } : {}),
    agentId: ctx.agentId,
    projectRoot: ctx.projectRoot,
    ...(ctx.game ? { game: ctx.game } : {}),
    ...(ctx.callId ? { callId: ctx.callId } : {}),
    // 有值才带键:缺失时消费方按"这行连不上"处理,伪造一个会让它连到错的地方。
    ...(ctx.toolExecutionId ? { toolExecutionId: ctx.toolExecutionId } : {}),
    perception: (kind, query) => perceptionQuery(ctx, kind, query),
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseModelPreference(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    const model = value.trim();
    return model || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const models = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return models.length ? models : undefined;
}

/** Create or update only the managed files in a project-owned native soul pack. */
function soulCreate(ctx: BuiltinToolCtx, args: Record<string, unknown> | undefined): unknown {
  const parsed = NPC_TOOL_CONTRACTS.soul_create.input.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `soul_create: invalid input: ${parsed.error.message}` };
  const { soulId, name, identity } = parsed.data;

  const soulRoot = resolve(ctx.projectRoot, '.forgeax', 'souls-builtin');
  const dir = resolve(soulRoot, soulId);
  if (!isPathInside(soulRoot, dir)) return { ok: false, error: 'soul_create: soul path escapes project root' };

  const identityPath = join(dir, 'persona', 'identity.md');
  const manifestPath = join(dir, 'manifest.json');
  const agentPath = join(dir, 'agent.json');
  const existed = existsSync(dir);
  mkdirSync(join(dir, 'persona'), { recursive: true });

  const manifest = readJsonObject(manifestPath);
  const agent = readJsonObject(agentPath);
  const requestedModel = parseModelPreference(parsed.data.models ?? parsed.data.model);
  const existingModels = agent.models && typeof agent.models === 'object' && !Array.isArray(agent.models)
    ? agent.models as Record<string, unknown>
    : {};
  const models = requestedModel === undefined && Object.keys(existingModels).length === 0
    ? undefined
    : requestedModel === undefined
      ? existingModels
      : { ...existingModels, model: requestedModel };

  writeFileSync(identityPath, `# ${name}\n\n${identity}\n`);
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, id: soulId, name, version: 1 }, null, 2)}\n`);
  const managedAgent = {
    ...agent,
    id: soulId,
    name,
    personaFile: './persona/identity.md',
    ...(models ? { models } : {}),
  };
  writeFileSync(agentPath, `${JSON.stringify(managedAgent, null, 2)}\n`);

  return {
    ok: true,
    created: !existed,
    soulId,
    path: `.forgeax/souls-builtin/${soulId}`,
    changedPaths: [
      `.forgeax/souls-builtin/${soulId}/persona/identity.md`,
      `.forgeax/souls-builtin/${soulId}/manifest.json`,
      `.forgeax/souls-builtin/${soulId}/agent.json`,
    ],
  };
}

function appendAdoptionLedger(
  ctx: BuiltinToolCtx,
  stage: 'validation' | 'execution',
  status: 'success' | 'failure',
  detail: Record<string, unknown>,
): void {
  try {
    const path = resolve(ctx.projectRoot, '.forgeax', 'adoption-ledger.jsonl');
    mkdirSync(join(ctx.projectRoot, '.forgeax'), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), tool: detail.tool ?? 'npc_wire', stage, status, ...detail })}\n`);
  } catch {
    // Adoption diagnostics must never make the tool itself fail.
  }
}

function npcWire(ctx: BuiltinToolCtx, args: Record<string, unknown> | undefined): unknown {
  const parsed = NPC_TOOL_CONTRACTS.npc_wire.input.safeParse(args ?? {});
  if (!parsed.success) {
    const result = {
      ok: false,
      code: 'invalid_input',
      hint: 'Provide game, npcId, soulId, and at least one canonical affordance.',
      expected: 'NpcWireInput',
      actual: parsed.error.issues,
    };
    appendAdoptionLedger(ctx, 'validation', 'failure', { tool: 'npc_wire', error: result });
    return result;
  }
  const hostTool = getHostTool('npc_wire');
  if (!hostTool?.run) {
    const result = {
      ok: false,
      code: 'host_unavailable',
      hint: 'Start the Studio host and retry npc_wire.',
      expected: 'npc_wire host tool seam',
    };
    appendAdoptionLedger(ctx, 'execution', 'failure', { tool: 'npc_wire', error: result });
    return result;
  }
  try {
    const result = hostTool.run(parsed.data, hostToolRunCtx(ctx));
    const value = result instanceof Promise ? undefined : result;
    if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
      const raw = value as { error?: unknown };
      const failure = {
        ok: false,
        code: 'wire_failed',
        hint: typeof raw.error === 'string' ? raw.error : 'Host rejected npc_wire.',
        expected: 'writable game NPC adapter',
        actual: value,
      };
      appendAdoptionLedger(ctx, 'execution', 'failure', { tool: 'npc_wire', error: failure });
      return failure;
    }
    if (result instanceof Promise) {
      return result.then((resolved) => {
        const ok = !(resolved && typeof resolved === 'object' && (resolved as { ok?: unknown }).ok === false);
        appendAdoptionLedger(ctx, 'execution', ok ? 'success' : 'failure', { tool: 'npc_wire', result: resolved });
        return resolved;
      });
    }
    appendAdoptionLedger(ctx, 'execution', 'success', { tool: 'npc_wire', result });
    return result;
  } catch (error) {
    const failure = {
      ok: false,
      code: 'wire_failed',
      hint: error instanceof Error ? error.message : String(error),
      expected: 'writable game NPC adapter',
    };
    appendAdoptionLedger(ctx, 'execution', 'failure', { tool: 'npc_wire', error: failure });
    return failure;
  }
}

function remember(ctx: BuiltinToolCtx, args: Record<string, unknown> | undefined): unknown {
  const text = String(args?.text ?? '').trim();
  if (!text) return { ok: false, error: 'remember: empty text' };
  const kind = args?.kind === 'general' || args?.kind === 'game' ? (args.kind as 'general' | 'game') : undefined;
  if (kind === 'game' && !ctx.game) return { ok: false, error: 'remember: game-bound memory needs an active game' };
  const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
  const written = classifyAndWrite(memoryRef(ctx), [{ text, ...(kind ? { kind } : {}), ...(title ? { title } : {}) }]);
  if (!written.length) return { ok: false, error: 'remember: nothing written (no active game for game-bound memory)' };
  const w = written[0]!;
  return { ok: true, tier: w.tier, ...(w.game ? { game: w.game } : {}), file: w.file };
}

/** 感知取数往返：发布 perception:query，由前端回传真实值并解开 Promise；
 * 超时 fail-soft 为 unavailable。UI 回灌额外受 lease 约束。 */
async function perceptionQuery(
  ctx: BuiltinToolCtx,
  kind: PerceptionKind,
  query?: unknown,
  timeoutMs: number = PERCEPTION_TIMEOUT_MS,
): Promise<unknown> {
  if (!ctx.eventBus) return { unavailable: true, reason: 'no event bus' };
  const isUiKind = kind === 'ui_snapshot' || kind === 'ui_invoke' || kind === 'ui_screenshot';
  if (isUiKind && !ctx.sid) return { unavailable: true, reason: 'no session id for ui bridge' };
  const reqId = randomUUID();
  ctx.eventBus.publish(
    {
      type: 'perception:query',
      ts: Date.now(),
      source: `agent:${ctx.agentId}`,
      payload: { reqId, kind, query: query ?? null, agent: ctx.agentId },
    },
    ctx.agentId,
  );
  const handle = registerPerception(reqId, timeoutMs, isUiKind && ctx.sid ? { requireLease: { sid: ctx.sid } } : {});
  try {
    return await handle.promise;
  } finally {
    handle.dispose();
  }
}

/** 执行内置 forgeax 工具；调用方负责信任闸、审计与错误映射。 */
export async function runForgeaxBuiltinTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: BuiltinToolCtx,
): Promise<unknown> {
  switch (name) {
    case 'echo':
      return { text: `[forgeax_echo] ${String(args?.text ?? '')}` };
    case 'memory_search':
      return searchMemory(memoryRef(ctx), String(args?.query ?? ''));
    case 'remember':
      return remember(ctx, args);
    case 'soul_create':
      return soulCreate(ctx, args);
    case 'npc_wire':
      return npcWire(ctx, args);
    // UI 语义操作层：与 seam 感知工具同构，应答方是 interface 的 ActionRegistry。
    case 'ui_snapshot':
      return perceptionQuery(ctx, 'ui_snapshot', args ?? {});
    case 'ui_screenshot': {
      // 成功截图转换为模型可见的 image ContentPart；失败结果按 JSON 原样透传。
      const out = await perceptionQuery(ctx, 'ui_screenshot', args ?? {}, UI_SCREENSHOT_TIMEOUT_MS);
      if (out && typeof out === 'object' && typeof (out as { dataUrl?: unknown }).dataUrl === 'string') {
        const { dataUrl, ...meta } = out as { dataUrl: string } & Record<string, unknown>;
        const m = /^data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (m) {
          return [
            { type: 'image', data: m[2]!, mimeType: m[1]! },
            { type: 'text', text: JSON.stringify(meta) },
          ];
        }
        return { captured: false, reason: 'surface returned a malformed image data URL', ...meta };
      }
      return out;
    }
    case 'ui_invoke': {
      const actionId = typeof args?.actionId === 'string' ? args.actionId : '';
      const actionArgs = args?.args ?? {};
      const rejection = uiActionCatalogRejection(actionId);
      if (rejection) return rejection;
      // 咽喉收口(2026-08-06,B3):有可见门且语义等价 → 沿人类路径可见执行。此前
      // 改道只装在 /:sid/kernel-tool 路由,原生内核的 host-tool-bridge 整条绕开 ——
      // 无头直调,屏幕什么都不发生。收口挪到能力实现层,与下方门注解同层:谁调
      // runForgeaxBuiltinTool 都被盖到。改道任何异常 → 静默回落原路,原路闸口照常。
      try {
        const rerouted = await walkDoorInstead(
          { actionId, args: actionArgs },
          { runCtx: hostToolRunCtx(ctx) },
        );
        if (rerouted) return rerouted.result;
      } catch (error: unknown) {
        // fail-closed(2026-08-06 外审 MAJOR):此前是无条件 catch 回落。
        // walkDoorInstead 在**派发之后**抛异常(relay 抛、settle 抛、任何意外)时,
        // 回落到下面的无头 perceptionQuery 就是让同一个命令跑第二次。只有能证明
        // 尚未派发的异常才允许回落;派发过的一律作终态。
        const mayHaveDispatched = error instanceof DoorWalkDispatched
          || (typeof error === 'object' && error !== null
            && 'dispatched' in error && (error as { dispatched?: unknown }).dispatched === true);
        if (mayHaveDispatched) {
          return {
            ok: false,
            via: 'editor_ui_browse',
            actionId,
            error: {
              code: 'DOOR_WALK_INDETERMINATE',
              hint: '沿人类路径执行时中途出错,命令**可能已经执行**。不要重试这个动作、'
                + '不要换无头路径再派一次 —— 那会让它跑两次。先 look/verify 核对实际状态再决定。',
            },
          };
        }
      }
      // catalog 已校验 action 存在；UI 侧按声明的 timeoutMs 执行。
      // A live lease + accepted manifest row is only an executor binding. With no binding,
      // cold-start dispatch must not wait for a UI timeout before trying the server surface.
      const out = isUiActionRuntimeAvailable(ctx.sid, actionId)
        ? await perceptionQuery(
            ctx,
            'ui_invoke',
            { actionId, args: args?.args ?? {} },
            uiInvokeTimeoutMs(ctx.sid, actionId, UI_INVOKE_TIMEOUT_MS),
          )
        : { unavailable: true, reason: `no live UI executor binding for action ${JSON.stringify(actionId)}` };
      // UI 不可用时，surface 为 server/both 的 action 可降级到 headless handler。
      if (out && typeof out === 'object' && (out as { unavailable?: unknown }).unavailable === true && actionId) {
        const decl = getUiAction(ctx.sid, actionId);
        if (decl && (decl.surface === 'server' || decl.surface === 'both')) {
          const handler = getHostUiAction(actionId) ?? getBuiltinHeadlessUiAction(actionId);
          if (handler) {
            try {
              const res = await handler.run((args?.args ?? {}) as Record<string, unknown>, hostToolRunCtx(ctx));
              return annotateUiInvokeResult(
                res && typeof res === 'object' ? { ...res, executedVia: 'headless' } : res,
                actionId,
                actionArgs,
              );
            } catch (e) {
              return { status: 'rejected', reason: `headless handler threw: ${(e as Error).message}` };
            }
          }
        }
      }
      return annotateUiInvokeResult(out, actionId, actionArgs);
    }
    default:
      // 防御分支：调用方原则上已通过 isForgeaxBuiltinTool 校验。
      return { error: `not a forgeax builtin tool: ${name}` };
  }
}
