// @desc Statically linked builtin command modules for compiled desktop runtimes.
//
// Development keeps using runner.ts's filesystem scanner so command modules can
// be edited and reloaded independently. A compiled single-file server cannot
// import the original TypeScript command directory at runtime, so desktop-prod
// opts into this registry instead. Keeping the imports in the same module graph
// also preserves shared kernel and agent-runtime singleton state.

import agentCommand from "../../builtin/commands/agent_command";
import agents from "../../builtin/commands/agents";
import compact from "../../builtin/commands/compact";
import history from "../../builtin/commands/history";
import inspectTools from "../../builtin/commands/inspect_tools";
import models from "../../builtin/commands/models";
import ping from "../../builtin/commands/ping";
import upload from "../../builtin/commands/upload";
import type { CommandModule } from "./types";

export interface StaticBuiltinCommand {
  file: string;
  mod: CommandModule;
}

export const STATIC_BUILTIN_COMMANDS: readonly StaticBuiltinCommand[] = [
  { file: "agent_command.ts", mod: agentCommand },
  { file: "agents.ts", mod: agents },
  { file: "compact.ts", mod: compact },
  { file: "history.ts", mod: history },
  { file: "inspect_tools.ts", mod: inspectTools },
  { file: "models.ts", mod: models },
  { file: "ping.ts", mod: ping },
  { file: "upload.ts", mod: upload },
];
