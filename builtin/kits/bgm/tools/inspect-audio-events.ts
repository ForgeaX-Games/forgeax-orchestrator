import type { ToolDefinition } from "../../../../src/core/types";
import { INSPECT_AUDIO_EVENTS_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...INSPECT_AUDIO_EVENTS_SPEC,
  async execute(args) {
    const result = await callTool({ toolId: "inspect-audio-events", args, caller: { kind: "ai" } });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
