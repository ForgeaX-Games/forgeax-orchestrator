// @desc 内核 turn 转录进 host-owned 账本 —— 多内核通用历史 + 刷新不丢失的回归锁。
//
// 核心目标回归:claude-code 等内核每轮经编排层转录进 per-agent 账本,账本 key 必须 =
// UI 重放用的同一个 agentId(此前 /api/cli/chat 用 `display===agentId / depth===1`
// 启发式解析,会落到别的节点 → 历史写错 key、刷新即"消失")。本测试锁:
//   1. transcribeKernelTurn 把一轮(user + 工具往返 + assistant)写进 `agentId` 的账本;
//   2. 形状对齐 native 路径(user_input / hook:turnStart / toolCall / toolResult /
//      assistantMessage(llmMessage) / hook:turnEnd) → replay 能还原;
//   3. **不**写到 root / depth-1 节点(证 key 修复:按传入 agentId,非启发式)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager, getSessionManager } from "../src/core/session-manager";
import { transcribeKernelTurn } from "../src/kernel/transcribe-turn";
import { ContextWindow } from "../src/context-window/context-window";
import { llmMessagesToTurnHistory } from "../src/kernel/llm-history";
import {
  appliedKernelMutationRecords,
  captureKernelMutationIntents,
} from "../src/kernel/kernel-file-activity";

let userRoot: string;
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-transcribe-"));
  resetPathManager();
  await resetSessionManager();
  const pm = initPathManager({ userRoot });
  initSessionManager(pm);
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

describe("transcribeKernelTurn — host-owned, kernel-agnostic ledger", () => {
  test("rented-kernel local file tool yields applied host-owned mutation evidence", () => {
    const path = resolve(userRoot, "project", "docs", "acceptance.md");
    const intents = captureKernelMutationIntents(
      "write_file",
      { file_path: "docs/acceptance.md", content: "ok" },
      resolve(userRoot, "project"),
    );
    expect(intents).toEqual([{ path, op: "write", existedBefore: false }]);

    mkdirSync(resolve(userRoot, "project", "docs"), { recursive: true });
    writeFileSync(path, "ok", "utf8");
    const records = appliedKernelMutationRecords(intents, {
      agentPath: "forge",
      toolCallId: "write-1",
      turnId: "turn-1",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentPath: "forge",
      op: "write",
      path,
      isCreate: true,
      toolCallId: "write-1",
      turnId: "turn-1",
      phase: "applied",
    });
    expect(records[0]?.hash).toHaveLength(64);
  });

  test("captures Codex batched edit_file changes for Artifact derivation", () => {
    const path = resolve(userRoot, "project", "docs", "codex-added.md");
    const intents = captureKernelMutationIntents(
      "edit_file",
      { changes: [{ path, kind: { type: "add" }, diff: "hello" }] },
      resolve(userRoot, "project"),
    );
    expect(intents).toEqual([{ path, op: "edit", existedBefore: false }]);
  });

  test("一轮(user+工具往返+assistant)写进 agentId 账本,形状对齐 replay,且不落 root", async () => {
    const session = await getSessionManager().create({ displayName: "t" });
    const sid = session.sid;
    // agentId 故意取一个**未 scaffold、不在 tree** 的 marketplace persona id ——
    // 复现旧启发式会落到 depth-1(root) 的场景;修复后应写到 "mochi" 自身。
    const agentId = "mochi";

    transcribeKernelTurn(session, agentId, {
      message: "hi there",
      asstText: "hello captain",
      thinkingText: "",
      stopReason: "end_turn",
      model: "claude-opus-4-8",
      toolEvents: [
        { kind: "call", callId: "c1", name: "list_games", args: {} },
        { kind: "result", callId: "c1", ok: true, result: { count: 0, games: [] } },
      ],
    });

    // 读回 agentId 的账本 —— 这正是 UI 刷新后 fetch_session_events(sid, agentId) 走的盘。
    const events = await session.getOrCreateLedger(agentId).readAllEvents();
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "user_input",
      "hook:turnStart",
      "hook:toolCall",
      "hook:toolResult",
      "hook:assistantMessage",
      "hook:turnEnd",
    ]);

    // user 气泡内容
    const user = events.find((e) => e.type === "user_input");
    expect((user?.payload as { content?: string })?.content).toBe("hi there");

    // assistant 经 llmMessage 还原(replay 的 extractLLMMessage 读 llmMessage.content)
    const asst = events.find((e) => e.type === "hook:assistantMessage");
    const llm = (asst?.payload as { llmMessage?: { content?: Array<{ text?: string }> } })?.llmMessage;
    expect(llm?.content?.[0]?.text).toBe("hello captain");

    // 工具往返保真
    const result = events.find((e) => e.type === "hook:toolResult");
    expect((result?.payload as { callId?: string })?.callId).toBe("c1");
    expect((result?.payload as { name?: string })?.name).toBe("list_games");
    expect((result?.payload as { ok?: boolean })?.ok).toBe(true);

    // ★ key 修复证据:绝不落到 root(旧 depth-1 启发式的去处)。
    const rootLedger = await session.getOrCreateLedger("root").readAllEvents();
    expect(rootLedger).toHaveLength(0);
  });

  test("native tool result projects image through ContextWindow into TurnMessage history", async () => {
    const session = await getSessionManager().create({ displayName: "native-tool-history" });
    const image = { type: "image" as const, data: ONE_PIXEL_PNG, mimeType: "image/png" };

    transcribeKernelTurn(session, "forge", {
      message: "capture the current UI",
      asstText: "The screenshot is available.",
      thinkingText: "",
      stopReason: "end_turn",
      providerId: "forgeax-core",
      toolEvents: [
        { kind: "call", callId: "shot-1", name: "ui_screenshot", args: { target: "app" } },
        { kind: "result", callId: "shot-1", ok: true, result: [image] },
      ],
    });

    const ledger = session.getOrCreateLedger("forge");
    const events = await ledger.readAllEvents();
    const call = events.find((event) => event.type === "hook:toolCall");
    const result = events.find((event) => event.type === "hook:toolResult");
    const resultPayload = result?.payload as {
      result?: unknown;
      llmMessage?: {
        role?: string;
        toolCallId?: string;
        toolName?: string;
        content?: Array<{ type?: string; data?: string; mimeType?: string }>;
      };
    };
    expect(resultPayload.result).toEqual([image]);
    expect(resultPayload.llmMessage).toMatchObject({
      role: "tool",
      toolCallId: "shot-1",
      toolName: "ui_screenshot",
      toolStatus: "completed",
      content: [image],
    });
    expect((call?.payload as { llmMessage?: { role?: string; toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown }> } })?.llmMessage).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "shot-1", name: "ui_screenshot", arguments: { target: "app" } }],
    });

    const messages = await new ContextWindow("forge", ledger).buildPrompt();
    const assistant = messages.find((message) => message.role === "assistant" && message.toolCalls?.some((tool) => tool.id === "shot-1"));
    const tool = messages.find((message) => message.role === "tool" && message.toolCallId === "shot-1");
    expect(assistant?.toolCalls).toEqual([{ id: "shot-1", name: "ui_screenshot", arguments: { target: "app" } }]);
    expect(tool?.content).toEqual([image]);

    const history = llmMessagesToTurnHistory(messages);
    expect(history.find((message) => message.role === "assistant")).toMatchObject({
      role: "assistant",
      toolCalls: [{ callId: "shot-1", name: "ui_screenshot", args: { target: "app" } }],
    });
    expect(history.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      callId: "shot-1",
      ok: true,
      result: [image],
    });
  });

  test("legacy text tool result remains visible in native history", async () => {
    const session = await getSessionManager().create({ displayName: "legacy-tool-history" });
    transcribeKernelTurn(session, "forge", {
      message: "run the text tool",
      asstText: "done",
      thinkingText: "",
      stopReason: "end_turn",
      toolEvents: [
        { kind: "call", callId: "text-1", name: "echo", args: { text: "hello" } },
        { kind: "result", callId: "text-1", ok: true, result: "hello from the tool" },
      ],
    });

    const messages = await new ContextWindow("forge", session.getOrCreateLedger("forge")).buildPrompt();
    const tool = messages.find((message) => message.role === "tool" && message.toolCallId === "text-1");
    expect(tool?.content).toEqual([{ type: "text", text: "hello from the tool" }]);
    expect(llmMessagesToTurnHistory(messages)).toContainEqual({
      role: "tool",
      callId: "text-1",
      ok: true,
      result: "hello from the tool",
    });
  });

  test("multiple native calls before results form one assistant tool-call batch", async () => {
    const session = await getSessionManager().create({ displayName: "native-tool-batch" });
    transcribeKernelTurn(session, "forge", {
      message: "inspect both surfaces",
      asstText: "both inspected",
      thinkingText: "",
      stopReason: "end_turn",
      toolEvents: [
        { kind: "call", callId: "c1", name: "ui_snapshot", args: { target: "app" } },
        { kind: "call", callId: "c2", name: "ui_screenshot", args: { target: "app" } },
        { kind: "result", callId: "c1", ok: true, result: "state" },
        { kind: "result", callId: "c2", ok: true, result: "frame" },
      ],
    });

    const messages = await new ContextWindow("forge", session.getOrCreateLedger("forge")).buildPrompt();
    const assistant = messages.find((message) => message.role === "assistant" && message.toolCalls?.some((tool) => tool.id === "c1"));
    expect(assistant?.toolCalls).toEqual([
      { id: "c1", name: "ui_snapshot", arguments: { target: "app" } },
      { id: "c2", name: "ui_screenshot", arguments: { target: "app" } },
    ]);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(llmMessagesToTurnHistory(messages).filter((message) => message.role === "tool")).toEqual([
      { role: "tool", callId: "c1", ok: true, result: "state" },
      { role: "tool", callId: "c2", ok: true, result: "frame" },
    ]);
  });

  test("durable attachment context survives history while visible bubble stays original and base64 is absent", async () => {
    const session = await getSessionManager().create({ displayName: "attachment-history" });
    const path = resolve(userRoot, "sessions", "upload.png");
    // Simulate rented-kernel compose output: notes in contextText, no attachments[].
    transcribeKernelTurn(session, "forge", {
      message: "what is this?",
      contextText: `what is this?\n\n[Attached image: ${path} (image/png, 3B)]`,
      asstText: "an image",
      thinkingText: "",
      stopReason: "end_turn",
      toolEvents: [],
    });
    const events = await session.getOrCreateLedger("forge").readAllEvents();
    const user = events.find((e) => e.type === "user_input");
    const payload = user?.payload as {
      content?: string;
      llmMessage?: { content?: Array<{ text?: string }> };
      attachments?: Array<{ kind?: string; path?: string; mediaType?: string }>;
    };
    expect(payload.content).toBe("what is this?");
    expect(payload.llmMessage?.content?.[0]?.text).toContain(path);
    expect(payload.attachments?.[0]).toEqual({ kind: "image", path, mediaType: "image/png" });
    expect(JSON.stringify(events)).not.toContain("QUJD");
  });

  test("providerId 写进 hook:turnStart + hook:assistantMessage 账本(刷新后还原来源 badge)", async () => {
    const session = await getSessionManager().create({ displayName: "tp" });
    transcribeKernelTurn(session, "forge", {
      message: "hi",
      asstText: "yo",
      thinkingText: "",
      stopReason: "end_turn",
      providerId: "claude-code",
      toolEvents: [],
    });
    const events = await session.getOrCreateLedger("forge").readAllEvents();
    const ts = events.find((e) => e.type === "hook:turnStart");
    const asst = events.find((e) => e.type === "hook:assistantMessage");
    expect((ts?.payload as { providerId?: string })?.providerId).toBe("claude-code");
    expect((asst?.payload as { providerId?: string })?.providerId).toBe("claude-code");
  });

  test("public summary is durable as visible agent_log and never mixed into private thinking", async () => {
    const session = await getSessionManager().create({ displayName: "public-summary" });
    transcribeKernelTurn(session, "forge", {
      message: "build it",
      asstText: "done",
      thinkingText: "private provider reasoning",
      publicSummaryText: "Inspecting the active game.",
      stopReason: "end_turn",
      providerId: "codex",
      toolEvents: [],
    });
    const events = await session.getOrCreateLedger("forge").readAllEvents();
    const progress = events.find((event) => event.type === "agent_log");
    expect(progress?.payload).toMatchObject({
      visibility: "public_summary",
      summary: "Inspecting the active game.",
      providerId: "codex",
    });
    const assistant = events.find((event) => event.type === "hook:assistantMessage");
    const llmMessage = (assistant?.payload as { llmMessage?: { thinking?: string } })?.llmMessage;
    expect(llmMessage?.thinking).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("private provider reasoning");
    expect(JSON.stringify(llmMessage)).not.toContain("Inspecting the active game.");
  });

  test("preserves public process order and the actual kernel start time", async () => {
    const session = await getSessionManager().create({ displayName: "ordered-process" });
    const startedAt = Date.now() - 2_000;
    const result = transcribeKernelTurn(session, "forge", {
      message: "inspect",
      startedAt,
      asstText: "done",
      thinkingText: "",
      publicSummaryText: "Inspecting.",
      stopReason: "end_turn",
      toolEvents: [{ kind: "call", callId: "c1", name: "bash", args: { command: "pwd" } }],
      processEvents: [
        { kind: "assistant_text", text: "I will inspect the project." },
        { kind: "public_summary", text: "Inspecting." },
        { kind: "call", callId: "c1", name: "bash", args: { command: "pwd" } },
      ],
    });
    const events = await session.getOrCreateLedger("forge").readAllEvents();
    expect(events.map((event) => event.type)).toEqual([
      "user_input", "hook:turnStart", "hook:assistantMessage", "agent_log", "hook:toolCall", "hook:assistantMessage", "hook:turnEnd",
    ]);
    const assistantTexts = events
      .filter((event) => event.type === "hook:assistantMessage")
      .map((event) => ((event.payload as { llmMessage?: { content?: Array<{ text?: string }> } }).llmMessage?.content?.[0]?.text));
    expect(assistantTexts).toEqual(["I will inspect the project.", "done"]);
    expect(events[0]?.ts).toBe(startedAt);
    expect(result?.startedAt).toBe(startedAt);
    expect((result?.settledAt ?? startedAt) - startedAt).toBeGreaterThanOrEqual(1_900);
  });

  test("不传 providerId → 账本不带该键(向后兼容,不污染)", async () => {
    const session = await getSessionManager().create({ displayName: "tp2" });
    transcribeKernelTurn(session, "forge", {
      message: "hi",
      asstText: "yo",
      thinkingText: "",
      stopReason: "end_turn",
      toolEvents: [],
    });
    const events = await session.getOrCreateLedger("forge").readAllEvents();
    const ts = events.find((e) => e.type === "hook:turnStart");
    expect((ts?.payload as { providerId?: string })?.providerId).toBeUndefined();
  });

  test("空轮(无文本/思考/工具)不落噪声", async () => {
    const session = await getSessionManager().create({ displayName: "t2" });
    transcribeKernelTurn(session, "forge", {
      message: "ping",
      asstText: "",
      thinkingText: "",
      stopReason: "end_turn",
      toolEvents: [],
    });
    const events = await session.getOrCreateLedger("forge").readAllEvents();
    expect(events).toHaveLength(0);
  });
});
