import { describe, expect, test } from "bun:test";
import type { TurnRequest } from "@forgeax/agent-runtime";
import { buildKernelTask } from "../src/kernel/kernel-context";
import { buildCcArgs } from "../src/kernel/cc-profile";
import {
  buildCodexAppServerGlobalArgs,
  buildCodexArgs,
  buildCodexSingleAgentArgs,
} from "../src/kernel/codex-profile";

function request(): TurnRequest {
  return {
    turnId: "turn-2",
    session: { threadId: "thread", agentId: "root" },
    input: { text: "现在的口令是什么？" },
    context: {
      throughTurnId: "turn-1",
      messages: [
        { role: "user", content: "记住口令 blue-orchid" },
        { role: "assistant", content: "记住了" },
      ],
    },
    history: [
      { role: "user", content: "记住口令 blue-orchid" },
      { role: "assistant", content: "记住了" },
    ],
    systemPrompt: { charter: "CHARTER", persona: "" },
    tools: [],
    budget: {},
  };
}

describe("private kernel context bootstrap", () => {
  test.each(['snapshot', 'delta', 'none'])('prepared %s history is supplied only once', (mode) => {
    const req = request();
    req.historyPlan = { mode } as TurnRequest['historyPlan'];
    req.systemPrompt.dynamicSuffix = mode === 'none' ? '' : '# ForgeaX shared session history\nblue-orchid';
    const task = buildKernelTask(req, true);
    expect(task.split('blue-orchid').length - 1).toBe(mode === 'none' ? 0 : 1);
    expect(task).not.toContain('Previous conversation context');
    expect(task).toContain('现在的口令是什么？');
  });

  test("新私有会话把宿主上下文和当前任务一起交给内核", () => {
    const task = buildKernelTask(request(), true);
    expect(task).toContain("Previous conversation context supplied by ForgeaX");
    expect(task).toContain("blue-orchid");
    expect(task).toContain("# Current task");
    expect(task).toContain("现在的口令是什么？");
  });

  test("resume 私有会话只发送当前任务，不重复灌入历史", () => {
    expect(buildKernelTask(request(), false)).toBe("现在的口令是什么？");
  });

  test("the reference agent CLI 仅在 fresh session bootstrap", () => {
    const fresh = buildCcArgs(request(), "/tmp", ["--session-id", "private"], undefined, true);
    const resumed = buildCcArgs(request(), "/tmp", ["--resume", "private"], undefined, false);
    expect(fresh.at(-1)).toContain("blue-orchid");
    expect(resumed.at(-1)).toBe("现在的口令是什么？");
  });

  test("Codex exec 首轮 bootstrap，resume 不重复灌入", () => {
    const fresh = buildCodexArgs(request(), undefined);
    const resumed = buildCodexArgs(request(), "codex-thread");
    expect(fresh.at(-1)).toContain("blue-orchid");
    expect(resumed.at(-1)).not.toContain("blue-orchid");
    expect(resumed.at(-1)).toContain("现在的口令是什么？");
  });

  test("Codex exec 与 resume 默认关闭原生多 Agent 编排", () => {
    const expected = buildCodexSingleAgentArgs();
    const fresh = buildCodexArgs(request(), undefined);
    const resumed = buildCodexArgs(request(), "codex-thread");
    for (const args of [fresh, resumed]) {
      expect(args).toContain("multi_agent");
      expect(args).toContain("multi_agent_v2");
      expect(args).toContain("agents.enabled=false");
      expect(args.slice(args.indexOf("--disable"), args.indexOf("--disable") + expected.length))
        .toEqual(expected);
    }
  });

  test("Codex app-server 使用同一套单 Agent 参数并保留 hook/MCP 参数", () => {
    expect(buildCodexAppServerGlobalArgs(true, ["-c", "mcp_servers.fxt.enabled=true"]))
      .toEqual([
        ...buildCodexSingleAgentArgs(),
        "--dangerously-bypass-hook-trust",
        "-c",
        "mcp_servers.fxt.enabled=true",
      ]);
  });
});
