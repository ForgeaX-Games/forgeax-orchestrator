// @desc Command module: models — 模型 catalog + per-agent 模型选择查询 / 写入
//
// 路线：agent.json::models.model 是 LLM fallback 链（`string | string[] | null`，
// resolve-models 顺序消费）。本模块把它作为 commands 系统的唯一入口：
//
//   list_models        args[0]?=kernelId(providerId)                          hasQuery
//   get_agent_model    args[0]=sid, args[1]=agentPath                          hasQuery
//   set_agent_models   args[0]=sid, args[1]=agentPath, args[2..]=model…        hasExecute
//
// 模型目录内核化(2026-07):本层**零内核知识**。
//   - 有 providerId → `kernel/model-catalog.ts:resolveKernelModelCatalog`
//     (回退链 env → kernel.listModels → last-known → static → none,
//     经 agent-runtime registry 查内核,加新内核不改本文件)。
//   - 无 providerId → gateway 目录(`lib/llm-gateway/gateway-catalog.ts`,
//     disk models.json ∩ LiteLLM live,同一实现也被 forgeax-core adapter 复用)。
// hidden 集(models-hidden.json)在本层对两路统一标注。
//
// 设计要点：
// - 永远以**数组形态**对外暴露（chain）；同时给一个 `selected = chain[0] ?? null`，
//   让 UI 只想拿下一回合模型时不必判断 string / array / 缺省。
// - 运行时实例的 RuntimeConfigBinding 是 live truth；更新在 turn boundary 生效，
//   不重建 AgentInstance，也不触发 agent.json watcher。
// - resident 同步持久化其 author config，供下次 Session bootstrap 使用；
//   ephemeral 只更新内存，不把 template source 当运行实体。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "../../src/commands/types";
import { loadGatewayCatalog } from "../../src/lib/llm-gateway/gateway-catalog";
import { resolveKernelModelCatalog, invalidateModelCatalogCache } from "../../src/kernel/model-catalog";
import { invalidateLiveCatalogCache } from "../../src/lib/llm-gateway/live-catalog";
import { stableHash } from "../../src/runtime/freeze";

interface ReadModelArgs {
  sid: string;
  agentPath: string;
}

function parseAgentArgs(name: string, args: string[]): ReadModelArgs {
  const sid = (args[0] ?? "").trim();
  const agentPath = (args[1] ?? "").trim();
  if (!sid) throw new Error(`${name}: args[0] (sid) required`);
  if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
  return { sid, agentPath };
}

/** Read raw agent.json from disk —— **不**经 AGENT_DEFAULTS deep-merge，让 caller
 *  能区分「用户没配 models 字段」（chain=[]、raw=null）与「显式空 chain」
 *  （chain=[]、raw=[]）。 */
function readAgentJsonRaw(file: string, cmd: string): Record<string, unknown> {
  if (!existsSync(file)) {
    throw new Error(`${cmd}: agent.json missing at ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${cmd}: agent.json parse failed: ${(err as Error).message}`);
  }
}

/** 把 RuntimeConfig models.model 三种形态（string | string[] | null/缺省）
 *  归一成 fallback chain string[]，并算出下一回合首选模型（chain[0]）。 */
function normalizeModel(raw: unknown): { chain: string[]; selected: string | null } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { chain: [trimmed], selected: trimmed } : { chain: [], selected: null };
  }
  if (Array.isArray(raw)) {
    const chain = raw
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
    return { chain, selected: chain[0] ?? null };
  }
  return { chain: [], selected: null };
}

/** Read `~/.forgeax/key/models-hidden.json` —— { hidden: string[] } or [],
 *  treated as the set of ids the user has hidden from the picker dropdown.
 *  Missing file / parse failure → empty set (everything visible by default). */
function loadHiddenSet(ctx: { paths: { user(): { modelsHiddenFile(): string } } }): Set<string> {
  const file = ctx.paths.user().modelsHiddenFile();
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { hidden?: unknown } | string[];
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw.hidden) ? raw.hidden : [];
    return new Set(arr.filter((x): x is string => typeof x === "string" && x.length > 0));
  } catch {
    return new Set();
  }
}

function saveHiddenSet(
  ctx: { paths: { user(): { modelsHiddenFile(): string; keyDir(): string } } },
  set: Set<string>,
): void {
  const file = ctx.paths.user().modelsHiddenFile();
  const dir = ctx.paths.user().keyDir();
  // keyDir is created by ensureUserDirDefaults at boot — but be defensive in
  // case set_model_hidden gets called before any user-dir scaffold runs (e.g.
  // a fresh install where the user never opened Settings → Keys yet).
  try {
    if (!existsSync(dir)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").mkdirSync(dir, { recursive: true });
    }
  } catch { /* mkdir best-effort */ }
  const payload = { hidden: Array.from(set).sort() };
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

/** reasoning 展示启发（纯 presentational —— 目录来源没给 reasoning 元数据时按
 *  id 猜一个,供 picker 图标;真相仍在 spec/内核那边）。 */
function reasoningHeuristic(id: string): boolean {
  return /thinking|reasoning|opus|sonnet|gpt-5|o\d/i.test(id);
}

/** 内核目录 → 线上行形态(与 gateway 行同构:id + 元数据 + hidden)。 */
async function loadKernelCatalog(
  ctx: { paths: { user(): { keyDir(): string; modelsHiddenFile(): string } } },
  providerId: string,
) {
  const catalog = await resolveKernelModelCatalog(providerId, ctx);
  const hidden = loadHiddenSet(ctx);
  const label = catalog.kernelDisplayName ?? providerId;
  return {
    models: catalog.models.map((m) => ({
      input: m.input ?? ["text", "image"],
      reasoning: m.reasoning ?? reasoningHeuristic(m.id),
      ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
      ...(m.label ? { label: m.label } : {}),
      id: m.id,
      source: "driver" as const,
      driverId: providerId,
      driverLabel: label,
      costMetering: "none" as const,
      hidden: hidden.has(m.id),
    })),
    live: { source: "skipped", ids: 0 },
    driver: {
      id: providerId,
      source: catalog.source,
      error: catalog.error,
      ids: catalog.models.length,
      ...(catalog.cached ? { cached: true } : {}),
    },
    hiddenCount: 0,
  };
}

const models: CommandModule = {
  async list() {
    return [
      {
        name: "list_models",
        description: "模型 catalog(args[0]?=kernelId → 内核目录;无参 → gateway 目录 · 实时读盘)",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "get_agent_model",
        description: "查运行时 Agent 的下一回合模型配置（args[0]=sid, args[1]=agentPath 或 instanceId）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "set_agent_models",
        description: "设置 Agent 下一回合模型链；resident 同步保存配置，ephemeral 仅更新内存",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "set_model_hidden",
        description: "把某个模型从 Composer picker dropdown 里隐藏 / 取消隐藏。args[0]=model id, args[1]='1'|'0' (1=hide, 0=show). 写 ~/.forgeax/key/models-hidden.json。",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "list_models") {
      if (args[1] === "--refresh") {
        invalidateModelCatalogCache();
        invalidateLiveCatalogCache();
      }
      const providerId = (args[0] ?? "").trim();
      if (providerId) return await loadKernelCatalog(ctx, providerId);

      const { models: rows, live } = await loadGatewayCatalog(ctx);
      const hidden = loadHiddenSet(ctx);
      return {
        models: rows.map((m) => ({ ...m, hidden: hidden.has(m.id) })),
        live,
        hiddenCount: hidden.size,
      };
    }
    if (name !== "get_agent_model") throw new Error(`No query for: ${name}`);

    const { sid, agentPath } = parseAgentArgs(name, args);
    const session = await ctx.sm.open(sid);
    const instance = session.tree.resolve(agentPath);
    if (!instance) {
      // pending = 尚未物化进 RuntimeTree（extension persona 懒创建前）。
      // 不要与「config staged / next-turn」共用此字段 —— Composer 用它跳过
      // set_agent_models reconcile。
      return { sid, agentPath, selected: null, chain: [], raw: null, pending: true };
    }

    const next = instance.runtimeConfig.next();
    const current = instance.runtimeConfig.current();
    const rawValue = next.value.models?.model ?? null;
    const { chain, selected } = normalizeModel(rawValue);
    const staged = next.revision !== current.revision;

    return {
      sid,
      agentPath: session.tree.addressOf(instance),
      instanceId: instance.instanceId,
      lifetime: instance.lifetime,
      selected,
      chain,
      raw: rawValue,
      // Only "not yet in tree" — staging uses appliesAt / staged below.
      pending: false,
      staged,
      appliesAt: staged ? "next-turn" : "current",
      revision: next.revision,
    };
  },

  async execute(name, args, ctx) {
    if (name === "set_model_hidden") {
      const id = (args[0] ?? "").trim();
      const flag = (args[1] ?? "").trim();
      if (!id) throw new Error(`${name}: args[0] (model id) required`);
      if (flag !== "0" && flag !== "1") {
        throw new Error(`${name}: args[1] must be '1' (hide) or '0' (show), got '${flag}'`);
      }
      const set = loadHiddenSet(ctx);
      const wasHidden = set.has(id);
      if (flag === "1") set.add(id); else set.delete(id);
      saveHiddenSet(ctx, set);
      return {
        id,
        hidden: flag === "1",
        previouslyHidden: wasHidden,
        totalHidden: set.size,
        file: ctx.paths.user().modelsHiddenFile(),
      };
    }
    if (name !== "set_agent_models") throw new Error(`No execute for: ${name}`);

    const { sid, agentPath } = parseAgentArgs(name, args);
    const chain = args.slice(2).map((m) => m.trim()).filter(Boolean);
    if (chain.length === 0) {
      throw new Error(`${name}: at least one model name required (args[2..])`);
    }

    const session = await ctx.sm.open(sid);
    let instance = session.tree.resolve(agentPath);
    if (!instance) {
      // Same lazy-materialization bridge as POST /messages / CLI chat: a
      // simple persona name that isn't live yet can be scaffolded here so
      // Composer can pin a model before the first chat turn.
      if (agentPath.includes("/") || agentPath.includes("#")) {
        throw new Error(`${name}: runtime agent not found: ${agentPath}`);
      }
      try {
        await session.ensureResidentAgent(agentPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${name}: ${message}`);
      }
      instance = session.tree.resolve(agentPath);
      if (!instance) {
        throw new Error(`${name}: runtime agent not found: ${agentPath}`);
      }
    }

    let agentJsonFile: string | null = null;
    if (instance.lifetime === "resident") {
      const templateRoot = instance.template.resources.templateRoot;
      if (!templateRoot) {
        throw new Error(`${name}: resident template root missing: ${agentPath}`);
      }
      agentJsonFile = join(templateRoot, "agent.json");
      const raw = readAgentJsonRaw(agentJsonFile, name);
      const prevModels =
        raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)
          ? (raw.models as Record<string, unknown>)
          : {};
      raw.models = { ...prevModels, model: chain };
      writeFileSync(agentJsonFile, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    }

    const previous = instance.runtimeConfig.next().value;
    const value = Object.freeze({
      ...previous,
      models: Object.freeze({
        ...(previous.models ?? {}),
        model: [...chain],
      }),
    });
    const revision = `cfg_${stableHash(value)}`;
    await session.stageRuntimeConfig(instance.instanceId, { revision, value });

    return {
      sid,
      agentPath: session.tree.addressOf(instance),
      instanceId: instance.instanceId,
      lifetime: instance.lifetime,
      models: { model: chain },
      selected: chain[0],
      staged: true,
      appliesAt: "next-turn",
      revision,
      agentJsonFile,
    };
  },
};

export default models;
