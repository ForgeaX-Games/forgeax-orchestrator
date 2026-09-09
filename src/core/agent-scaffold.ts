/** Resident definition authoring helper.
 *
 * Writing a directory is configuration authoring only: it never mutates the
 * live RuntimeTree by itself. Bootstrap scans these definitions in bulk;
 * trusted runtime materialization must explicitly continue through
 * TemplateCatalog + AgentRegistrar after this helper persists the definition.
 * Custom code behavior remains an AgentKernel concern.
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { getPathManager } from "../fs/path-manager";
import { deepMerge } from "../utils/deep-merge";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import { resolveExternalAgentTemplate } from "../agents/loader";
import { sameResidentResource, snapshotResidentResources } from "../agents/resident-resources";
import { COORDINATOR_TOOL_GRANTS } from "../agents/tool-grants";
import type { AgentJson } from "./types";

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface AgentScaffoldOpts {
  /** Legacy caller hint; runtime templates derive lifecycle from registration. */
  agentType?: "conscious" | "script";
  /** 写到 agent.json 的额外字段，deep-merge 进默认模板，已有文件不覆盖。 */
  overrides?: Partial<AgentJson>;
}

// ─── 校验 ────────────────────────────────────────────────────────────────────

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Agent 文件夹名（单段，不带 `/`）。 */
export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/** Agent 逻辑路径形如 `name(/agents/name)*`，对应物理路径
 *  `<agentsRoot>/name(/agents/name)*`。每个偶数位是 agent 名，奇数位必须是
 *  字面量 "agents"。空串 / 多余分隔符都拒。 */
export function isValidAgentPath(p: string): boolean {
  if (!p) return false;
  const segs = p.split("/");
  if (segs.length % 2 === 0) return false;
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 0) {
      if (!isValidAgentName(segs[i])) return false;
    } else {
      if (segs[i] !== "agents") return false;
    }
  }
  return true;
}

// ─── Scaffold 主入口 ─────────────────────────────────────────────────────────

/** 在 `<sid>/agents/<path>/` 下补齐 agent 文件（idempotent）。
 *
 *  - 物理路径不存在 → 创建（递归）。
 *  - `agent.json` 不存在 → 写默认模板 + overrides 合并。
 *  - 已存在的文件**不动**（包括 agent.json，所以反复调安全）。
 *
 *  ⚠️ 不要在这里建 events/ledger 或 blobs —— EventLedger.append() 第一次写盘
 *      时自己 mkdir 兜底，scaffold 不抢这条职责（避免 race + 减少冗余 IO）。
 */
export async function ensureAgentScaffold(
  sid: string,
  agentPath: string,
  opts: AgentScaffoldOpts = {},
): Promise<{ scaffolded: boolean }> {
  if (!isValidAgentPath(agentPath)) {
    throw new Error(
      `[agent-scaffold] invalid agent path '${agentPath}' (must match name(/agents/name)*)`,
    );
  }

  const layer = getPathManager().session(sid).agent(agentPath);
  let scaffolded = false;

  await mkdir(layer.root(), { recursive: true });

  // 1) agent.json
  if (!existsSync(layer.agentJson())) {
    const base = AGENT_DEFAULTS as unknown as AgentJson;
    // 单一收口:host-tools allow 从 agent 的 manifest/persona 派生(SSOT),在这里
    // 注入——而不是让每个建 session 的调用方各自记得传。此前只有 sessions.ts
    // bootstrap / delegate 这几条路注入,别的路(reload 新建 session、裸 mkdir
    // watcher、messages 首建)漏注 → 该 agent 的 host_tool_bridge allow 为空,
    // 连 gen3d:* / team:* 都不下发给内核(codebuddy/cc/codex),模型「看不到工具」。
    // 收口到唯一的 scaffolder 后,任何路建出的 agent 都拿到默认 allow。
    // 调用方显式传了 host-tools allow → 尊重之(不覆盖);否则按 manifest 补默认。
    let overrides = opts.overrides;
    const callerAllow = (overrides as { kits?: { config?: { ['host-tools']?: { allow?: unknown } } } } | undefined)
      ?.kits?.config?.['host-tools']?.allow;
    if (!callerAllow) {
      const agentName = agentPath.split("/").pop() ?? agentPath;
      try {
        const persona = await resolveExternalAgentTemplate(agentName);
        if (persona?.tools && persona.tools.length > 0) {
          overrides = deepMerge(
            { kits: { config: { "host-tools": { allow: persona.tools } } } },
            (overrides ?? {}) as unknown as Record<string, unknown>,
          ) as unknown as Partial<AgentJson>;
        }
      } catch {
        /* best-effort: persona 解析失败不挡 scaffold(退化为空 allow,与旧行为一致) */
      }
    }
    const merged = overrides
      ? (deepMerge(
          base as unknown as Record<string, unknown>,
          overrides as unknown as Record<string, unknown>,
        ) as unknown as AgentJson)
      : base;
    const external = await resolveExternalAgentTemplate(agentPath.split("/").at(-1)!).catch(() => null);
    // Capture new-resident identity before replacing installed paths. Once the
    // persona is local, bootstrap must not infer authority from its leaf name.
    if (external && merged.personaFile && sameResidentResource(layer.root(), merged.personaFile, external.personaPath)) {
      if (merged.trustTier === undefined) merged.trustTier = external.trustTier;
      if (external.source === "brand" && merged.toolGrants === undefined) {
        merged.toolGrants = structuredClone(COORDINATOR_TOOL_GRANTS);
      }
    }
    const portable = external
      ? await snapshotResidentResources(layer.root(), merged, external)
      : merged;
    const temporary = `${layer.agentJson()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(portable, null, 2) + "\n", { encoding: "utf-8", flag: "wx" });
      // Publish complete bytes without replacing another concurrent creator.
      // Both files are in the same directory/filesystem.
      await link(temporary, layer.agentJson());
      scaffolded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return { scaffolded };
}
