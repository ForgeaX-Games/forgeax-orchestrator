import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import agentCommand from "../builtin/commands/agent_command";
import { resolvePermission } from "../src/core/permission-registry";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Session } from "../src/core/session";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(join(tmpdir(), "forgeax-agent-command-policy-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

async function createSession(opts: {
  readonly hidden?: boolean;
  readonly trustTier?: "own" | "imported";
}): Promise<Session> {
  const pm = getPathManager();
  const sm = initSessionManager(pm);
  return sm.create({
    displayName: "agent-command-policy",
    prepareResidentDefinitions: (sid) => {
      const root = pm.session(sid).agent("root");
      const tools = join(root.resourceDir("kits"), "policy", "tools");
      mkdirSync(tools, { recursive: true });
      const kits = opts.hidden ? { disable: ["policy/tools/hidden_command"] } : {};
      writeFileSync(
        root.agentJson(),
        JSON.stringify({ id: "root", trustTier: opts.trustTier ?? "own", kits }) + "\n",
        "utf8",
      );
      writeFileSync(
        join(tools, "hidden_command.ts"),
        `import { writeFileSync } from "node:fs";
         export default {
           description: "hidden command",
           input_schema: { type: "object", properties: {} },
           async execute(_args, ctx) {
             writeFileSync(ctx.runtimeStateRoot + "/marker", "hidden");
             return "hidden-ran";
           },
         };\n`,
        "utf8",
      );
      writeFileSync(
        join(tools, "danger_command.ts"),
        `import { writeFileSync } from "node:fs";
         export default {
           description: "danger command",
           input_schema: { type: "object", properties: {} },
           async execute(_args, ctx) {
             writeFileSync(ctx.runtimeStateRoot + "/marker", "danger");
             return "danger-ran";
           },
         };\n`,
        "utf8",
      );
    },
  });
}

function commandEvent(toolName: string): {
  source: "user";
  type: "agent_command";
  payload: { toolName: string; args: Record<string, unknown> };
  to: string;
  handoff: "turn";
  ts: number;
} {
  return {
    source: "user",
    type: "agent_command",
    payload: { toolName, args: {} },
    to: "root",
    handoff: "turn",
    ts: Date.now(),
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

describe("runtime agent_command policy boundary", () => {
  test("hidden tools are absent from discovery and cannot execute through the full registry", async () => {
    const session = await createSession({ hidden: true });
    const root = await session.initializeAgentHost("root");
    const discovered = await agentCommand.query!(
      "list_agent_tools",
      [session.sid, "root"],
      { sm: initSessionManager(getPathManager()), paths: getPathManager() },
    ) as { tools: Array<{ name: string }> };
    expect(discovered.tools.map((tool) => tool.name)).not.toContain("policy/tools/hidden_command");

    const calls: string[] = [];
    session.eventBus.observe((event) => {
      if (event.type === "hook:toolCall") calls.push("tool-call");
    });
    await expect(session.enqueueAgent("root", commandEvent("policy/tools/hidden_command")))
      .rejects.toThrow(/not available in the current context/);
    expect(calls).toEqual([]);
    expect(existsSync(join(root.agentContext.runtimeStateRoot, "marker"))).toBe(false);
  });

  test("approval denial for an imported dangerous command produces no tool call or tool side effect", async () => {
    const session = await createSession({ trustTier: "imported" });
    const root = await session.initializeAgentHost("root");
    let reqId: string | undefined;
    let toolCalls = 0;
    session.eventBus.observe((event) => {
      if (event.type === "permission:request") {
        reqId = (event.payload as { reqId?: string }).reqId;
      }
      if (event.type === "hook:toolCall") toolCalls += 1;
    });

    const execution = session.enqueueAgent("root", commandEvent("policy/tools/danger_command"));
    const approvalRequest = await waitFor(() => reqId);
    expect(resolvePermission(approvalRequest, false)).toBe(true);
    await expect(execution).rejects.toThrow(/denied by user/);
    expect(toolCalls).toBe(0);
    expect(existsSync(join(root.agentContext.runtimeStateRoot, "marker"))).toBe(false);
  });
});
