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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager, getSessionManager } from "../src/core/session-manager";
import { transcribeKernelTurn } from "../src/kernel/transcribe-turn";

let userRoot: string;

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
  test("轮序递增、工具名回填、时间戳来源如实标注 —— 账本要能当训练数据切分", async () => {
    // 2026-08-05:这三样此前是硬编码 —— `turn: 1` 三处字面量(每轮都记第 1 轮,
    // 账本按轮切不开)、toolResult 的 `name: ""`(工具名丢失)、`durationMs: 0`
    // (这里根本没测量,写 0 是假值)。另:本函数在整轮结束后**批量**写入,
    // 所有 ts 都是转录时刻而非事件时刻(实测 52 事件挤进 12 毫秒),故如实标 tsSource。
    const session = await getSessionManager().create({ displayName: "t" });
    const agentId = "forge";
    const turn = (message: string) =>
      transcribeKernelTurn(session, agentId, {
        message,
        asstText: "ok",
        thinkingText: "",
        stopReason: "end_turn",
        model: "gpt-5.6-sol",
        toolEvents: [
          { kind: "call", callId: "c1", name: "editor_ui_browse", args: { verb: "look" } },
          { kind: "result", callId: "c1", ok: true, result: { ok: true } },
        ],
      });

    turn("第一轮");
    turn("第二轮");
    turn("第三轮");

    const events = await session.getOrCreateLedger(agentId).readAllEvents();
    const turns = (type: string) =>
      events.filter((e) => e.type === type).map((e) => (e.payload as { turn?: number }).turn);
    expect(turns("hook:turnStart")).toEqual([1, 2, 3]);
    expect(turns("hook:assistantMessage")).toEqual([1, 2, 3]);
    expect(turns("hook:turnEnd")).toEqual([1, 2, 3]);

    // 工具名按 callId 回填,不再是空串
    const results = events.filter((e) => e.type === "hook:toolResult");
    expect(results.map((e) => (e.payload as { name?: string }).name)).toEqual([
      "editor_ui_browse", "editor_ui_browse", "editor_ui_browse",
    ]);
    // 未测量的耗时宁可缺字段也不写假 0
    expect((results[0]!.payload as { durationMs?: number }).durationMs).toBeUndefined();
    // 每条都标注时间戳来源 —— 消费方据此知道真实时序要去内核 rollout 取
    for (const e of events) {
      expect((e.payload as { tsSource?: string }).tsSource).toBe("transcription");
    }
  });

  test("工具返回体里嵌套 {type:'user_input'} 不会虚增轮序 —— 子串判据的坑", async () => {
    // 2026-08-05 终审实测:计数曾用 `line.includes('\"user_input\"')`,而 agent
    // **回读自己的轨迹账本**时返回体里就全是这种对象(序列化后不被转义),
    // 实测轮序从 [1,2] 变成 [1,3]。而回读账本正是本项目沉淀 skill 的目标场景。
    const session = await getSessionManager().create({ displayName: "t" });
    const agentId = "forge";
    transcribeKernelTurn(session, agentId, {
      message: "第一轮", asstText: "a", thinkingText: "", stopReason: "end_turn", model: "m",
      toolEvents: [
        { kind: "call", callId: "c1", name: "read_ledger", args: {} },
        { kind: "result", callId: "c1", ok: true,
          result: { events: [{ type: "user_input", content: "x" }, { type: "user_input", content: "y" }] } },
      ],
    });

    await resetSessionManager();
    initSessionManager(initPathManager({ userRoot }));
    const revived = await getSessionManager().open(session.sid);
    transcribeKernelTurn(revived, agentId, {
      message: "第二轮", asstText: "a", thinkingText: "", stopReason: "end_turn", model: "m", toolEvents: [],
    });

    const events = await revived.getOrCreateLedger(agentId).readAllEvents();
    expect(events.filter((e) => e.type === "hook:turnStart").map((e) => (e.payload as { turn?: number }).turn))
      .toEqual([1, 2]);
  });

  test("轮序跨 ledger 重建存活 —— 进程重启后不从 1 重来", async () => {
    // 计数器同步维护在 EventLedger 内,并在 _initShardIndex 从当前分片重建,
    // 所以重启(= 新建 ledger 实例读同一盘)后轮序继续往下走,不回退。
    const session = await getSessionManager().create({ displayName: "t" });
    const agentId = "forge";
    const rec = {
      message: "m", asstText: "a", thinkingText: "", stopReason: "end_turn" as const,
      model: "gpt-5.6-sol", toolEvents: [],
    };
    transcribeKernelTurn(session, agentId, { ...rec });
    transcribeKernelTurn(session, agentId, { ...rec });

    // 丢掉内存态,像重启一样从盘上重建
    await resetSessionManager();
    const pm2 = initPathManager({ userRoot });
    initSessionManager(pm2);
    const revived = await getSessionManager().open(session.sid);
    transcribeKernelTurn(revived, agentId, { ...rec });

    const events = await revived.getOrCreateLedger(agentId).readAllEvents();
    expect(events.filter((e) => e.type === "hook:turnStart").map((e) => (e.payload as { turn?: number }).turn))
      .toEqual([1, 2, 3]);
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
    expect((result?.payload as { ok?: boolean })?.ok).toBe(true);

    // ★ key 修复证据:绝不落到 root(旧 depth-1 启发式的去处)。
    const rootLedger = await session.getOrCreateLedger("root").readAllEvents();
    expect(rootLedger).toHaveLength(0);
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
