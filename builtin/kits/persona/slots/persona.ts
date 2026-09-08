/** persona slot —— 把 agent.json::personaFile 指向的 markdown 注入 prompt。
 *
 *  设计要点：
 *   - sub-agent 在 sessions API 自动 scaffold 时会把 personaFile 写到
 *     `<sid>/agents/<agentPath>/agent.json`，路径来自 Brand pack 或 extension manifest。
 *   - 路径解析顺序：绝对路径 → projectRoot 相对。
 *   - content 用闭包 `() => readFileSync(...)`，hot-edit persona.md 下一轮就生效，
 *     不必重启 ConsciousAgent。读不到（文件 missing / 权限 / 二进制）就静默返回
 *     空串，prompt assembler 会自动跳过空内容 block。
 *   - cacheHint='stable' + STATIC_CORE：persona 描述「我是谁」的 invariant，
 *     和 framework / principle 同档；放进 stable 段保留 LLM prompt-cache 命中。
 */

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { defaultProjectRoot } from '@forgeax/platform-io';

function resolvePersonaPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return existsSync(trimmed) ? trimmed : null;
  const projectAbs = resolve(defaultProjectRoot(), trimmed);
  if (existsSync(projectAbs)) return projectAbs;
  return null;
}

export default function personaSlot(_ctx: AgentContext): ContextSlot | null {
  return {
    name: "persona",
    description:
      "Inject the agent's persona markdown (path lives in agent.json::personaFile). " +
      "Empty / unresolved path → empty content, slot is effectively skipped.",
    priority: SlotPriority.STATIC_CORE,
    cacheHint: "stable",
    version: 1,
    content: () => {
      const aj = _ctx.getAgentJson();
      const raw = (aj.personaFile ?? "").trim();
      if (!raw) return "";
      const abs = resolvePersonaPath(raw);
      if (!abs) return "";
      try {
        const body = readFileSync(abs, "utf-8").trim();
        if (!body) return "";
        return `# Persona\n\n${body}`;
      } catch {
        return "";
      }
    },
    condition: (ctx) => {
      const raw = (ctx.getAgentJson().personaFile ?? "").trim();
      return raw.length > 0;
    },
  };
}
