import type { ToolDefinition } from "../../../../src/core/types";
import { VERIFY_AUDIO_PROJECT_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...VERIFY_AUDIO_PROJECT_SPEC,
  async execute(args) {
    const result = await callTool({ toolId: "verify-audio-project", args, caller: { kind: "ai" } });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
