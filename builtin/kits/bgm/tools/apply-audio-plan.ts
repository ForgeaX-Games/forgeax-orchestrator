/** Apply resolved SFX items through the wb-bgm plugin.
 *
 * The plugin performs manifest inspection, idempotent downloads and cue-map
 * updates internally; agents do not need a separate list/attach sequence.
 */

import type { ToolDefinition } from "../../../../src/core/types";
import { APPLY_AUDIO_PLAN_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";
import { callTool } from "../../../../src/tools/registry";

const tool: ToolDefinition = {
  ...APPLY_AUDIO_PLAN_SPEC,
  async execute(args) {
    const result = await callTool({
      toolId: "apply-audio-plan",
      args,
      caller: { kind: "ai" },
    });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(result.result, null, 2);
  },
};

export default tool;
