/** Structured BGM retrieval.
 *
 * The implementation and the 181-track tag catalog live in the marketplace
 * wb-bgm plugin. This builtin only exposes the host tool to native agents.
 */

import type { ToolDefinition } from "../../../../src/core/types";
import { SEARCH_BGM_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...SEARCH_BGM_SPEC,
  async execute(args) {
    const result = await callTool({
      toolId: "search-bgm",
      args,
      caller: { kind: "ai" },
    });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
