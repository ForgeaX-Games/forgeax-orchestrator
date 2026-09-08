import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Event } from "../src/core/types";
import type { Session } from "../src/core/session";
import { KitToolLoader } from "../src/kits/tool-loader";
import { createOrGetFSWatcher } from "../src/fs/watcher";

// Plan §9 烟雾测试：create → publish → ledger 落盘 → close → open → replay.
// 本轮 kits / tools / directives / model 全没接，没法跑真正的 LLM 回路；
// 但 Session 的 EventBus → 每 agent ledger 持久化是 plumbing 层最关键的口子，
// 必须在再叠加任何东西前就被锁住。

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-e2e-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

/** Create a session, then close it, scaffold a root agent.json on disk, and
 *  re-open. Re-open triggers AgentTree.init() → _scanInitial which sees the
 *  agent.json synchronously — no reliance on chokidar event delivery. */
async function createSessionWithRoot(
  sm: ReturnType<typeof initSessionManager>,
  opts: { displayName: string },
): Promise<Session> {
  // PR2: the session's home + cwd come from the injected SessionLayout (no
  // defaultDir). The agent's cwd = layout.sessionWorkDir(sid).
  const pm = getPathManager();
  const initial = await sm.create(opts);
  const sid = initial.sid;
  await sm.close(sid);
  const layer = pm.session(sid).agent("root");
  mkdirSync(layer.root(), { recursive: true });
  writeFileSync(layer.agentJson(), "{}\n", "utf-8");
  return sm.open(sid);
}

describe("Session E2E — bus → ledger → reopen → replay", () => {
  test("user_input emitted on bus 落到 root agent ledger，关掉 session 再 open 还能 replay 出来", async () => {
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);

    const session = await createSessionWithRoot(sm, {
      displayName: "smoke",
      });

    // 直接通过 bus 模拟「用户喂一句话给 root」—— 这条 routed event
    // 应该被 _bindLedgerPersistence 捕到，并落到 root 的 ledger 里。
    const userEvent: Event = {
      source: "user",
      type: "user_input",
      payload: { content: "hello" },
      to: "root",
      handoff: "turn",
      ts: Date.now(),
    };
    session.eventBus.emit(userEvent);

    // 持久化 deferred 到 microtask；等一拍。
    await flushMicrotasks();

    // 关 session（不删盘）。
    await sm.close(session.sid);

    // 重新 open —— 不应触发 LLM，只 hydrate 内存态。
    const reopened = await sm.open(session.sid);
    expect(reopened.sid).toBe(session.sid);

    const ledger = reopened.getOrCreateLedger("root");
    const events = await ledger.readAllEvents();

    const userInputs = events.filter((e) => e.type === "user_input");
    expect(userInputs.length).toBe(1);
    const first = userInputs[0];
    if (!first) throw new Error("unreachable");
    expect(first.payload?.content).toBe("hello");

    await sm.close(reopened.sid);
  });

  test("stream:* 事件不落 ledger（per ref _bindEventBus 行为）", async () => {
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "no-stream" });

    session.eventBus.emit({
      source: "agent:root",
      type: "stream:assistant_chunk",
      payload: { content: "abc" },
      to: "root",
      ts: Date.now(),
    });
    // 也喂一条非 stream 事件作 sentinel，确认 observer 在跑。
    session.eventBus.emit({
      source: "agent:root",
      type: "assistant_response",
      payload: { content: "done" },
      to: "root",
      ts: Date.now(),
    });
    await flushMicrotasks();

    const events = await session.getOrCreateLedger("root").readAllEvents();
    expect(events.some((e) => e.type === "assistant_response")).toBe(true);
    expect(events.some((e) => e.type.startsWith("stream:"))).toBe(false);

    await sm.close(session.sid);
  });

  test("Session 初始化后裸 mkdir 不会重构 live RuntimeTree", async () => {
    // 文件证明 resident 身份，内存证明当前存在。初始化扫描完成后，普通目录
    // 变化不会绕过 RuntimeSupervisor 注册一个新运行实例。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "scaffold" });

    const ioriDir = pm.session(session.sid).agent("root/agents/iori").root();
    mkdirSync(ioriDir, { recursive: true });

    expect(session.tree.get("root/agents/iori")).toBeUndefined();
    expect(session.tree.get("root/iori")).toBeUndefined();
    const list = session.tree.list().map((n) => n.path).sort();
    expect(list).toEqual(["root"]);

    await sm.close(session.sid);
  });

  test("显式 reload 才重读 resident 配置，保留稳定 instanceId 并换 runtimeEpoch", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "reload" });
    const original = session.runtimeTree.findResident("root");
    expect(original).toBeDefined();

    const child = pm.session(session.sid).agent("root/agents/child");
    mkdirSync(child.root(), { recursive: true });
    writeFileSync(child.agentJson(), JSON.stringify({ id: "child" }) + "\n");

    // 配置文件只证明下一次构建的身份；当前内存树不会被 watcher 改写。
    expect(session.runtimeTree.findResident("root/child")).toBeUndefined();
    await session.reloadRuntime();

    const reloadedRoot = session.runtimeTree.findResident("root");
    const reloadedChild = session.runtimeTree.findResident("root/child");
    expect(reloadedRoot?.instanceId).toBe(original?.instanceId);
    expect(reloadedRoot?.runtimeEpochId).not.toBe(original?.runtimeEpochId);
    expect(reloadedChild).toBeDefined();
    expect(reloadedChild?.parentInstanceId).toBe(reloadedRoot?.instanceId);
    expect(session.tree.list().map((node) => node.path)).toEqual([
      "root",
      "root/child",
    ]);

    await sm.close(session.sid);
  });

  test("删除 resident 根会先移除统一内存子树，再递归删除配置并注销模板", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const initial = await sm.create({
      displayName: "resident-delete",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        const child = pm.session(sid).agent("root/agents/child");
        mkdirSync(root.root(), { recursive: true });
        mkdirSync(child.root(), { recursive: true });
        writeFileSync(root.agentJson(), JSON.stringify({ id: "root" }) + "\n");
        writeFileSync(child.agentJson(), JSON.stringify({ id: "child" }) + "\n");
      },
    });
    const rootInstance = initial.runtimeTree.findResident("root");
    const childInstance = initial.runtimeTree.findResident("root/child");
    expect(rootInstance).toBeDefined();
    expect(childInstance).toBeDefined();

    const rootConfig = pm.session(initial.sid).agent("root").root();
    const result = await initial.deleteResident("root");
    expect(result.ok).toBe(true);
    expect(initial.runtimeTree.size).toBe(0);
    expect(existsSync(rootConfig)).toBe(false);
    expect(initial.templateCatalog.get(rootInstance!.templateRef)).toBeUndefined();
    expect(initial.templateCatalog.get(childInstance!.templateRef)).toBeUndefined();

    await sm.close(initial.sid);
  });

  test("reload barrier 取消并回收 ephemeral，再原位重建 resident epoch", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "reload-barrier" });
    const originalResident = session.runtimeTree.findResident("root")!;
    const slowPackage = join(userRoot, "external-kits", "slow");
    mkdirSync(join(slowPackage, "tools"), { recursive: true });
    writeFileSync(
      join(slowPackage, "tools", "wait.ts"),
      `export default {
        description: "wait until cancelled",
        input_schema: { type: "object", properties: {} },
        async execute(_args, ctx) {
          return new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("cancelled by reload")), { once: true });
          });
        },
      };\n`,
    );
    const templateRef = session.registerMemoryTemplate({
      sourceId: "test:reload-barrier",
      entryId: "slow-worker",
      template: {
        definition: { id: "slow-worker" },
        runtimeConfigDefaults: {},
        resources: {
          skills: [],
          kits: [{
            id: "slow",
            source: { kind: "directory", path: slowPackage },
          }],
          memorySeeds: [],
        },
      },
    });
    const handle = await session.spawnEphemeral({
      parentInstanceId: originalResident.instanceId,
      templateRef,
    });
    const turn = session.enqueueAgent(handle.instanceId, {
      source: "test",
      type: "agent_command",
      payload: { toolName: "wait", args: {} },
      to: handle.instanceId,
      handoff: "turn",
      ts: Date.now(),
    });
    const runningDeadline = Date.now() + 2_000;
    while (session.runtimeTree.get(handle.instanceId)?.state !== "running") {
      if (Date.now() > runningDeadline) {
        throw new Error("ephemeral did not enter running state");
      }
      await Bun.sleep(2);
    }

    const turnSettled = turn.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await session.reloadRuntime();
    const turnResult = await turnSettled;
    expect(turnResult.ok).toBe(false);
    expect(String("error" in turnResult ? turnResult.error : "")).toContain(
      "Session resident tree reloaded",
    );
    expect((await handle.wait()).status).toBe("cancelled");
    expect(session.runtimeTree.get(handle.instanceId)).toBeUndefined();
    const reloaded = session.runtimeTree.findResident("root")!;
    expect(reloaded.instanceId).toBe(originalResident.instanceId);
    expect(reloaded.runtimeEpochId).not.toBe(originalResident.runtimeEpochId);

    await sm.close(session.sid);
  });

  test("kits 子系统接通 RuntimeAgentHost：agent-local kits/<kit>/tools/<file>.ts → toolRegistry 出 tool", async () => {
    // B1.1-B1.9 烟雾：base-loader 真扫盘 + tool-loader createInstance +
    // RuntimeAgentHost 初始化 Kit，并由 execution snapshot 暴露工具。
    // builtin / user / session 三层留空，只塞 agent-local 一份 echo tool —— visibility
    // 走 "layer === agent → 永远 visible" 分支，不依赖 kits.user/session 开关。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "kit" });

    // Drop a valid tool kit under root agent's `kits/demo/tools/echo.ts`.
    const rootLayer = pm.session(session.sid).agent("root");
    const echoToolPath = join(rootLayer.resourceDir("kits"), "demo", "tools", "echo.ts");
    mkdirSync(join(rootLayer.resourceDir("kits"), "demo", "tools"), { recursive: true });
    writeFileSync(
      echoToolPath,
      `export default {
        description: "echo input verbatim",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
        async execute(args) { return String(args.text ?? ""); },
      };\n`,
      "utf-8",
    );

    // Trigger attachAgent — which calls initKits internally now.
    const agent = await session.initializeAgentHost("root");
    expect(agent).not.toBeNull();
    const tools = agent!.agentContext.tools.list();
    expect(tools.length).toBeGreaterThan(0);
    // tool name is qualified: "demo/tools/echo" (LLM-side mapping to bare
    // happens in AgentRuntimeController's turn loop, not in registry).
    const echo = tools.find((t) => t.name === "demo/tools/echo");
    expect(echo).toBeDefined();
    expect(typeof echo!.execute).toBe("function");

    await sm.close(session.sid);
  });

  test("纯内存模板可以引用自定义目录 Kit，不依赖 agent 配置目录", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "memory-kit" });
    const externalPackage = join(userRoot, "external-kits", "cute");
    mkdirSync(join(externalPackage, "tools"), { recursive: true });
    writeFileSync(
      join(externalPackage, "tools", "wave.ts"),
      `export default {
        description: "wave from external memory template",
        input_schema: { type: "object", properties: {} },
        async execute() { return "hello-from-memory-kit"; },
      };\n`,
      "utf-8",
    );
    const templateRef = session.registerMemoryTemplate({
      sourceId: "test:memory-kit",
      entryId: "cute-worker",
      template: {
        definition: { id: "cute-worker" },
        runtimeConfigDefaults: {},
        resources: {
          skills: [],
          kits: [{
            id: "cute",
            source: { kind: "directory", path: externalPackage },
          }],
          memorySeeds: [],
        },
      },
    });
    const snapshot = await session.templateCatalog.resolve(templateRef);
    expect(snapshot.resources.templateRoot).toBeUndefined();

    // 复用一个已初始化 Host 的非生命周期服务，只替换模板捕获的 Kit
    // SourceRef；loader 不需要也不会反向寻找一个运行实例目录。
    const residentHost = await session.initializeAgentHost("root");
    const loader = new KitToolLoader();
    const tools = await loader.load({
      ...residentHost.agentContext,
      instanceId: "eph-memory-kit",
      runtimeEpochId: "epoch-memory-kit",
      runtimeStateRoot: join(session.paths.root(), "runtime-state", "agents", "eph-memory-kit"),
      templateRoot: undefined,
      kitSources: snapshot.execution.kits,
      runtimeManaged: true,
    });
    const wave = tools.get("cute/tools/wave");
    expect(wave).toBeDefined();
    await expect(
      wave!.execute({}, residentHost.agentContext),
    ).resolves.toBe("hello-from-memory-kit");

    await sm.close(session.sid);
  });

  test("kits 热更新 polling 路径（flushReloads）：attach 前就已存在 → 改内容 → registry 看到新版本", async () => {
    // 先把 tool 文件落盘，再 attach（让 initKits 时直接把 v1 装进
    // registry），之后改内容再 flushReloads，单独锁住 MODIFY 路径。
    // watcher-disabled 的 ADD / DELETE 与 turn 边界由下一个 test 覆盖。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "hot1" });

    const rootLayer = pm.session(session.sid).agent("root");
    const kitToolsDir = join(rootLayer.resourceDir("kits"), "hot", "tools");
    mkdirSync(kitToolsDir, { recursive: true });
    const toolPath = join(kitToolsDir, "ping.ts");
    writeFileSync(
      toolPath,
      `export default {
        description: "v1",
        input_schema: { type: "object", properties: {} },
        async execute() { return "pong-v1"; },
      };\n`,
      "utf-8",
    );

    const agent = await session.initializeAgentHost("root");
    const v1 = agent.agentContext.tools.list().find((t) => t.name === "hot/tools/ping");
    expect(v1).toBeDefined();
    expect(v1!.description).toBe("v1");

    const baselineTriggered = await session.kitReloadCoordinator.flushReloads();
    expect(baselineTriggered).toBe(false);

    writeFileSync(
      toolPath,
      `export default {
        description: "v2",
        input_schema: { type: "object", properties: {} },
        async execute() { return "pong-v2"; },
      };\n`,
      "utf-8",
    );
    const triggered = await session.kitReloadCoordinator.flushReloads();
    expect(triggered).toBe(true);
    const v2 = agent.agentContext.tools.list().find((t) => t.name === "hot/tools/ping");
    expect(v2).toBeDefined();
    expect(v2!.description).toBe("v2");

    expect(await session.kitReloadCoordinator.flushReloads()).toBe(false);

    const acceptedRevision = session.runtimeTree.findResident("root")!
      .execution.current().revision;
    writeFileSync(toolPath, "export default { this is invalid TypeScript", "utf-8");
    await expect(
      session.kitReloadCoordinator.flushReloads(),
    ).rejects.toThrow("last-known-good");
    const stillV2 = agent.agentContext.tools.list()
      .find((tool) => tool.name === "hot/tools/ping");
    expect(stillV2?.description).toBe("v2");
    expect(
      session.runtimeTree.findResident("root")!.execution.current().revision,
    ).toBe(acceptedRevision);

    await sm.close(session.sid);
  });

  test("统一 Kernel turn-end polling：watcher 漏事件仍下一 turn 生效，坏 revision 不污染已完成 turn", async () => {
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "hot-turn-boundary" });
    const rootLayer = pm.session(session.sid).agent("root");
    const kitToolsDir = join(rootLayer.resourceDir("kits"), "hot", "tools");
    mkdirSync(kitToolsDir, { recursive: true });
    const toolPath = join(kitToolsDir, "ping.ts");
    const writeTool = (version: string) => {
      writeFileSync(
        toolPath,
        `export default {
          description: "${version}",
          input_schema: { type: "object", properties: {} },
          async execute() { return "pong-${version}"; },
        };\n`,
        "utf-8",
      );
    };
    const command = (toolName = "hot/tools/ping"): Event => ({
      source: "user",
      type: "agent_command",
      payload: { toolName, args: {} },
      to: "root",
      handoff: "turn",
      ts: Date.now(),
    });

    writeTool("v1");
    await session.initializeAgentHost("root");
    const instance = session.runtimeTree.findResident("root")!;

    // Deliberately remove the per-template watcher: this test must prove the
    // unified turn-end polling seam itself, not win through fs.watch.
    createOrGetFSWatcher().unregisterOwner(
      `kit-source-revision:${session.sid}:${instance.instanceId}`,
    );

    writeTool("v2");
    const transition = await session.enqueueAgent("root", command());
    expect(transition.output).toBe("pong-v1");

    const nextTurn = await session.enqueueAgent("root", command());
    expect(nextTurn.output).toBe("pong-v2");
    const acceptedRevision = instance.execution.current().revision;

    writeFileSync(
      toolPath,
      "export default { this is invalid TypeScript",
      "utf-8",
    );
    const invalidTransition = await session.enqueueAgent("root", command());
    expect(invalidTransition.output).toBe("pong-v2");
    expect(instance.execution.current().revision).toBe(acceptedRevision);

    writeTool("v3");
    const recoveryTransition = await session.enqueueAgent("root", command());
    expect(recoveryTransition.output).toBe("pong-v2");
    const recovered = await session.enqueueAgent("root", command());
    expect(recovered.output).toBe("pong-v3");

    const addedPath = join(kitToolsDir, "added.ts");
    writeFileSync(
      addedPath,
      `export default {
        description: "added",
        input_schema: { type: "object", properties: {} },
        async execute() { return "pong-added"; },
      };\n`,
      "utf-8",
    );
    const addTransition = await session.enqueueAgent("root", command());
    expect(addTransition.output).toBe("pong-v3");
    const added = await session.enqueueAgent(
      "root",
      command("hot/tools/added"),
    );
    expect(added.output).toBe("pong-added");

    rmSync(addedPath);
    const deleteTransition = await session.enqueueAgent(
      "root",
      command("hot/tools/added"),
    );
    expect(deleteTransition.output).toBe("pong-added");
    const removed = await session.enqueueAgent(
      "root",
      command("hot/tools/added"),
    );
    expect(removed.output).toEqual({
      error: "Unknown tool: hot/tools/added",
    });
    expect(instance.instanceId).toBe(
      session.runtimeTree.findResident("root")!.instanceId,
    );

    await sm.close(session.sid);
  });

  test("logger 系统：ref 全量恢复（console bridge + per-Session 落盘 + ALS tag）", async () => {
    // A4 烟雾，对齐 agenteam-os-ref：
    //   1. SessionManager 构造 → setGlobalLogger（router 的 fallback 槽位）+
    //      attachConsoleEventEmitter（dispatcher 路由到 agent inbox）；
    //      sid 缺失时 console.* 落 <userRoot>/debug.log
    //   2. Session 构造 → <sid>/logs/{debug,latest}.log 文件存在，业务代码
    //      主动调 session.logger.* 直写
    //   3. ALS scope：`runWithAgentScope("root", () => console.warn(...))`
    //      触发的行 tag 是 `[root]`，不是 `[system]`
    //   4. INFO+ 同步落 latest.log
    //   5. SessionManager.shutdown() 反注册 router + close 全部 logger 后
    //      流稳定（dispose 不丢最后一行）
    //
    // sid 路由（用户钉死，2026-05-20）的核心不变量在下一个 test "logger 路由：..." 锁。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const { runWithAgentScope } = await import("../src/core/logger");
    const sm = initSessionManager(pm);
    expect(sm.logger).toBeDefined();

    const session = await createSessionWithRoot(sm, { displayName: "log" });
    const layer = pm.session(session.sid);

    // 业务代码直接调 session.logger.info（runtime plumbing 路径）
    session.logger.info("root", undefined, "session-up");

    // console.* 进 SM.logger（user-level）；ALS 包过 → tag 带 agentId
    runWithAgentScope("root", () => {
      console.warn("boot warning from root");
    });
    // 无 ALS scope → tag fallback 到 "system"（DEFAULT_LOG_CONTEXT）
    console.log("plain log no scope");

    await sm.logger.flush();
    await session.logger.flush();

    expect(existsSync(pm.user().debugLogFile())).toBe(true);
    expect(existsSync(layer.debugLogFile())).toBe(true);
    expect(existsSync(layer.latestLogFile())).toBe(true);

    // 关 session（per-Session logger close）—— SM 单例 + console bridge 仍活
    await sm.close(session.sid);

    const userDebug = readFileSync(pm.user().debugLogFile(), "utf-8");
    expect(userDebug).toContain("boot warning from root");
    expect(userDebug).toContain("[root]");          // ALS 拿到 agentId
    expect(userDebug).toContain("plain log no scope");
    expect(userDebug).toContain("[system]");        // 无 scope fallback

    const debugLog = readFileSync(layer.debugLogFile(), "utf-8");
    const latestLog = readFileSync(layer.latestLogFile(), "utf-8");
    expect(debugLog).toContain("session-up");
    expect(debugLog).toContain("[root]");
    expect(latestLog).toContain("session-up");      // INFO+ 双写
  });

  test("logger 路由：console.* 按 ALS sid 分流到 session / global", async () => {
    // 核心不变量（2026-05-20 钉死）：
    //   - runWithSession(sid) 内 console.* → 只进 <sid>/logs/{debug,latest}.log
    //   - 无 sid scope 的 console.* → 只进 <userRoot>/debug.log
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const { runWithSession } = await import("../src/core/logger");
    const sm = initSessionManager(pm);
    const s = await sm.create({ displayName: "R" });

    runWithSession(s.sid, () => console.warn("from-session"));
    console.log("from-global");

    // sm.close 触发 stream.end() —— 让 lazy WriteStream 落盘后再读。
    await sm.close(s.sid);

    const user = readFileSync(pm.user().debugLogFile(), "utf-8");
    const session = readFileSync(pm.session(s.sid).debugLogFile(), "utf-8");

    expect(session).toContain("from-session");
    expect(session).not.toContain("from-global");
    expect(user).toContain("from-global");
    expect(user).not.toContain("from-session");
  });

  test("LRU 纯末位淘汰：超出 maxSessions 即软 close 最旧 sid", async () => {
    // Session 不再持 client attach 计数，LRU 决策完全按位次。被踢的 sid 在下一次
    // open() 时会从盘上 hydrate 回来（变成一个新的内存实例）。
    const pm = (await import("../src/fs/path-manager")).getPathManager();
    const sm = initSessionManager(pm, { maxSessions: 1 });

    const a = await sm.create({ displayName: "a" });
    const aSid = a.sid;
    // 即使有 cli 在订阅 eventBus，也不影响淘汰决策 —— 订阅状态由外层（如 WsHub）自管。
    const unsubscribe = a.eventBus.observe(() => {});

    await sm.create({ displayName: "b" });

    // a 已经被 LRU 软 close；reopen 会从盘 hydrate 出新实例
    const aReopen = await sm.open(aSid);
    expect(aReopen).not.toBe(a);
    expect(aReopen.sid).toBe(aSid);

    unsubscribe();
    await sm.close(aSid);
  });

  test("AC-02 full-chain cwd: injected layout.sessionWorkDir → agent boots → ctx.cwd === that dir", async () => {
    // PR2: cwd no longer comes from a stored defaultDir; it comes from the
    // injected SessionLayout. Inject a layout whose sessionWorkDir is a real
    // game dir and assert the booted agent's ctx.cwd equals it.
    const { initPathManager, getPathManager } = await import("../src/fs/path-manager");
    const { FlatSessionLayout } = await import("../src/fs/session-layout");
    const sessionsRoot = join(userRoot, "sessions");
    const gameDir = join(userRoot, "games", "test-game");
    mkdirSync(gameDir, { recursive: true });
    initPathManager({ userRoot, layout: new FlatSessionLayout(sessionsRoot, gameDir) });
    const pm = getPathManager();
    const sm = initSessionManager(pm);

    const session = await createSessionWithRoot(sm, { displayName: "cwd-test" });

    const agent = await session.initializeAgentHost("root");
    expect(agent).not.toBeNull();
    const ctx = agent!.agentContext;

    // AC-02: agentContext.cwd IS the injected sessionWorkDir (absolute).
    expect(ctx.cwd).toBe(gameDir);
    // AC-03 / AC-04 (fs-bridge view): fs.resolve('.') === cwd.
    expect(ctx.fs.resolve(".")).toBe(ctx.cwd);

    await sm.close(session.sid);
  });
});
