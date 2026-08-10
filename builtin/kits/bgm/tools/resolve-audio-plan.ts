/** Resolve a batch SFX Audio Plan through the wb-bgm plugin.
 *
 * This is intentionally a thin native-agent forwarder. Search and selection
 * stay in the plugin so native and subprocess agents use the same logic.
 */

import type { ToolDefinition } from "../../../../src/core/types";
import { RESOLVE_AUDIO_PLAN_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...RESOLVE_AUDIO_PLAN_SPEC,
  async execute(args) {
    const result = await callTool({
      toolId: "resolve-audio-plan",
      args,
      caller: { kind: "ai" },
    });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
