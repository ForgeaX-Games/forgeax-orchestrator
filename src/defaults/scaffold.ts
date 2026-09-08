/** 首次运行 scaffolding —— 补齐 `~/.forgeax/key/models.json`。
 *
 *  llm_key.json 已退役（2026-05）：所有 API 凭证从 $ROOT/.env 读取，路由由
 *  src/llm/auto-resolver.ts 按 model id 模式 + .env 自动决定。
 *
 *  约束：
 *  - 只补缺，不覆盖：用户改过的 models.json 永远不动。
 *  - 默认模型目录作为模块数据嵌入构建产物，standalone 二进制不依赖源码路径。
 *  - agent.json 不走 copy 路径 —— 由 SessionManager.create / spawn_subagent 把
 *    AGENT_DEFAULTS 与调用方参数 deep-merge 后写盘。 */

import { mkdir, writeFile } from "node:fs/promises";
import type { PathManagerAPI } from "../fs/types";
import defaultModels from "./models.json";

const DEFAULT_MODELS_JSON = `${JSON.stringify(defaultModels, null, 2)}\n`;

export interface ScaffoldResult {
  /** 实际 copy 过去的相对文件名集合（已存在的不计）。 */
  created: string[];
}

export async function ensureUserDirDefaults(pm: PathManagerAPI): Promise<ScaffoldResult> {
  const keyDir = pm.user().keyDir();
  await mkdir(keyDir, { recursive: true });

  const created: string[] = [];

  const targets: Array<{ name: string; contents: string; dst: string }> = [
    { name: "models.json", contents: DEFAULT_MODELS_JSON, dst: pm.user().modelsFile() },
  ];

  for (const t of targets) {
    try {
      await writeFile(t.dst, t.contents, { flag: "wx" });
      created.push(t.name);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }

  return { created };
}
