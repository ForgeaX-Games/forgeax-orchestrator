/** Structured SFX search shadow path.
 *
 * The implementation lives in the marketplace wb-bgm plugin. This builtin
 * forwarder exposes the same host tool to native agents without duplicating
 * search logic.
 */

import type { ToolDefinition } from "../../../../src/core/types";
import { SEARCH_AUDIO_V2_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...SEARCH_AUDIO_V2_SPEC,
  // Compatibility forwarder only. SFX agents use resolve-audio-plan.
  condition: () => false,
  async execute(args) {
    const result = await callTool({
      toolId: "search-audio-v2",
      args,
      caller: { kind: "ai" },
    });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
