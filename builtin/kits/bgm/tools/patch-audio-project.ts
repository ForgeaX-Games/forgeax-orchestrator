import type { ToolDefinition } from "../../../../src/core/types";
import { PATCH_AUDIO_PROJECT_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...PATCH_AUDIO_PROJECT_SPEC,
  async execute(args) {
    const result = await callTool({ toolId: "patch-audio-project", args, caller: { kind: "ai" } });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
