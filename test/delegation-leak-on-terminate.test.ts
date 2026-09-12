/** delegation-leak-on-terminate —— `Session.delegations` 在 target 终止（shutdown /
 *  restart / remove）时的清理回归。
 *
 *  根因：`_bindDelegationCallback` 原来只在 target 发出 `hook:turnEnd` 时才
 *  `delegations.delete(target)`。若 target 在完成这一轮之前就被
 *  shutdown/restart/remove（或 crash），`hook:turnEnd` 永远不会为它触发 ——
 *  entry 永久滞留，之后任何委托到同一 target 都会被
 *  `delegationGuard` 的 "target busy" 检查永久拦截。
 *
 *  修复：`Scheduler` 的 `onAgentDetached` 钩子（doShutdown/doRestart/doRemove/
 *  crash-cleanup 四条终止路径共用）现在也调用 `Session._resolveDelegation`，
 *  和 `hook:turnEnd` 观察者共享同一条清理+回馈消息逻辑。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getPathManager, initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Event, AgentContext } from "../src/core/types";
import type { Session } from "../src/core/session";
import type { RegisteredResidentDefinition } from "../src/agents/resident-template-adapter";
import delegateTool, { delegationGuard } from "../builtin/kits/agent_manage/tools/delegate_to_subagent";
import {
  registerKernel,
  unregisterKernel,
  type AgentKernel,
  type KernelCapabilities,
  type TurnRequest,
} from "@forgeax/agent-runtime";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-deleg-leak-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

async function createSessionWithRoot(
  sm: ReturnType<typeof initSessionManager>,
  opts: { displayName: string },
  teammate?: string,
): Promise<Session> {
  const pm = getPathManager();
  const initial = await sm.create(opts);
  const sid = initial.sid;
  await sm.close(sid);
  const layer = pm.session(sid).agent("root");
  mkdirSync(layer.root(), { recursive: true });
  writeFileSync(layer.agentJson(), "{}\n", "utf-8");
  if (teammate) {
    const teammateLayer = pm.session(sid).agent(teammate);
    mkdirSync(teammateLayer.root(), { recursive: true });
    writeFileSync(teammateLayer.agentJson(), "{}\n", "utf-8");
  }
  return sm.open(sid);
}

/** Seed a pending delegation as if `delegate_to_subagent` had just fired one
 *  targeting "root", from a delegator that isn't part of this tree (its
 *  identity doesn't matter — EventBus.route() no-ops on an unregistered
 *  target queue, only the observer-visible "message" event matters here). */
function seedPendingDelegation(session: Session): void {
  session.delegations.set("root", {
    delegator: "someone-else",
    brief: "帮我看看这个 bug",
    ts: Date.now(),
  });
}

function captureMessages(session: Session): { messages: Event[]; dispose: () => void } {
  const messages: Event[] = [];
  const dispose = session.eventBus.observe((event) => {
    if (event.type === "message") messages.push(event);
  });
  return { messages, dispose };
}

/** 同上，但额外预先在磁盘上 scaffold 一个 teammate，供「真实走 delegate_to_subagent
 *  工具调用」的场景测试使用（不手工 seed delegations，走生产代码路径）。 */
async function createSessionWithRootAndTeammate(
  sm: ReturnType<typeof initSessionManager>,
  opts: { displayName: string },
  teammate: string,
): Promise<Session> {
  return createSessionWithRoot(sm, opts, teammate);
}

async function getRootCtx(session: Session): Promise<AgentContext> {
  const root = await session.initializeAgentHost("root");
  return root.agentContext;
}

function testKernel(
  kernelId: string,
  runTurn: AgentKernel["runTurn"],
): AgentKernel {
  const capabilities: KernelCapabilities = {
    streaming: true,
    thinking: false,
    toolCalls: false,
    midTurnInject: false,
    forkExtract: false,
  };
  return {
    id: kernelId,
    capabilities,
    runTurn,
    openHandle() {
      return {
        async setPermissionMode() {},
        async setModel() {},
        async interrupt() {},
        async cancel() {},
      };
    },
    async probe() {
      return { ok: true, kernelId };
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function abortableGate(signal: AbortSignal, gate: Promise<void>): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

async function createRuntimeSession(
  sm: ReturnType<typeof initSessionManager>,
  kernelId: string,
  agents: readonly string[],
): Promise<Session> {
  const pm = getPathManager();
  return sm.create({
    displayName: `delegation-runtime-${agents.join("-")}`,
    prepareResidentDefinitions: (sid) => {
      for (const agentId of agents) {
        const layer = pm.session(sid).agent(agentId);
        mkdirSync(layer.root(), { recursive: true });
        writeFileSync(
          layer.agentJson(),
          JSON.stringify({ id: agentId, kernelId }) + "\n",
          "utf8",
        );
      }
    },
  });
}

/** Register a real memory-backed resident whose first host initialization must
 * fail in BaseKitLoader.buildSources. The invalid non-directory SourceRef is
 * intentional: it exercises KernelTurnExecutor's pre-host turn-end fallback,
 * not a model/kernel failure after RuntimeAgentHost has entered a turn. */
async function registerInitFailingResident(
  session: Session,
  kernelId: string,
  agentId = "broken-resident",
): Promise<void> {
  const templateRef = session.registerMemoryTemplate({
    sourceId: `test:${agentId}:init-failure`,
    entryId: agentId,
    template: {
      definition: { id: agentId, kernelId },
      runtimeConfigDefaults: {},
      resources: {
        skills: [],
        kits: [{ id: "invalid-kit", source: { kind: "inline", text: "not a directory" } }],
        memorySeeds: [],
      },
    },
  });
  const template = await session.templateCatalog.resolve(templateRef);
  const locator = session.memoryTemplates.register(template);
  const templateRoot = resolve(userRoot, agentId);
  mkdirSync(templateRoot, { recursive: true });
  const prepared: RegisteredResidentDefinition = {
    definition: {
      identity: { sid: session.sid, logicalPath: agentId, instanceId: `resident-${agentId}` },
      logicalPath: agentId,
      parentLogicalPath: null,
      templateRoot,
    },
    templateRef,
    // RuntimeSupervisor resolves this locator through MemoryTemplateRegistry;
    // the resident adapter's production type is filesystem-only, so this test
    // keeps the registration seam explicit without changing production code.
    locator: locator as unknown as RegisteredResidentDefinition["locator"],
  };
  await session.supervisor.registerResident(prepared, null);
}

function assertDelegationIdentity(
  payload: Record<string, unknown>,
  info: {
    delegationId?: string;
    sourceEventId?: string;
    turnId?: string;
    targetInstanceId?: string;
    targetRuntimeEpochId?: string;
  },
): void {
  expect(payload.delegationId).toBe(info.delegationId);
  expect(payload.sourceEventId).toBe(info.sourceEventId);
  expect(payload.turnId).toBe(info.turnId);
  expect(payload.agentInstanceId).toBe(info.targetInstanceId);
  expect(payload.runtimeEpochId).toBe(info.targetRuntimeEpochId);
}

describe("delegation registry leak on target termination", () => {
  test("controlAgent('shutdown', target) 清理该 target 的 pending delegation 并回馈「取消」消息", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "leak-shutdown" });
    await session.scheduler.attachAgent("root");

    seedPendingDelegation(session);
    const { messages, dispose } = captureMessages(session);

    await session.scheduler.controlAgent("shutdown", "root");

    expect(session.delegations.has("root")).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe("someone-else");
    const content = (messages[0]?.payload as { content?: string }).content ?? "";
    expect(content).toContain("取消");
    expect(content).toContain("帮我看看这个 bug");

    dispose();
    await sm.close(session.sid);
  });

  test("controlAgent('restart', target) 同样清理旧实例的 pending delegation（丢弃 in-flight 委托）", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "leak-restart" });
    await session.scheduler.attachAgent("root");

    seedPendingDelegation(session);
    const { messages, dispose } = captureMessages(session);

    await session.scheduler.controlAgent("restart", "root");

    expect(session.delegations.has("root")).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe("someone-else");

    dispose();
    await sm.close(session.sid);
  });

  test("controlAgent('remove', target) 同样清理 pending delegation", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "leak-remove" });
    await session.scheduler.attachAgent("root");

    seedPendingDelegation(session);
    const { messages, dispose } = captureMessages(session);

    await session.scheduler.controlAgent("remove", "root");

    expect(session.delegations.has("root")).toBe(false);
    expect(messages).toHaveLength(1);

    dispose();
    await sm.close(session.sid);
  });

  test("清理后 target 不再永久 busy —— delegationGuard 允许对同一 target 发起新委托", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "leak-unblock" });
    await session.scheduler.attachAgent("root");

    seedPendingDelegation(session);
    expect(session.delegations.has("root")).toBe(true); // guard would block here (target busy)

    await session.scheduler.controlAgent("shutdown", "root");

    const { delegationGuard } = await import(
      "../builtin/kits/agent_manage/tools/delegate_to_subagent"
    );
    const result = delegationGuard({
      delegations: session.delegations,
      delegator: "forge",
      target: "root",
    });
    expect(result.block).toBe(false);

    await sm.close(session.sid);
  });

  test("真实 RuntimeSupervisor 完成路径投递「完成」消息并清理", async () => {
    const kernelId = "delegation-leak-normal-kernel";
    const kernel = testKernel(kernelId, async function* (request: TurnRequest) {
      yield {
        kind: "message.delta",
        role: "assistant",
        text: request.input.text.includes("正常完成") ? "正常完成结果" : "root callback handled",
      };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    try {
      const session = await sm.create({
        displayName: "leak-normal",
        prepareResidentDefinitions: (sid) => {
          for (const agentId of ["root", "mochi"]) {
            const layer = pm.session(sid).agent(agentId);
            mkdirSync(layer.root(), { recursive: true });
            writeFileSync(layer.agentJson(), JSON.stringify({ id: agentId, kernelId }) + "\n", "utf8");
          }
        },
      });
      const ctx = await getRootCtx(session);
      const { messages, dispose } = captureMessages(session);

      const out = await delegateTool.execute({ agent: "mochi", message: "正常完成" }, ctx);
      expect(String(out)).toMatch(/Delegated to mochi/);
      await waitUntil(() => !session.delegations.has("mochi"));

      expect(messages.some((message) => {
        const content = (message.payload as { content?: string }).content ?? "";
        return message.to === "root" && content.includes("完成") && message.durability === "required";
      })).toBe(true);
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });
});

describe("delegation registry leak on target termination — 真实 delegate_to_subagent 场景", () => {
  test("root 真实委托给 mochi 后 shutdown mochi：mochi 真的从运行态移除，且委托不泄漏、可再次委托", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRootAndTeammate(sm, { displayName: "leak-real-shutdown" }, "mochi");
    const ctx = await getRootCtx(session);
    await session.scheduler.attachAgent("mochi");

    const { messages, dispose } = captureMessages(session);

    // 不手工 seed delegations —— 走生产代码路径：真实调用 delegate_to_subagent。
    const out = await delegateTool.execute({ agent: "mochi", message: "帮我看看这个 bug" }, ctx);
    expect(String(out)).toMatch(/Delegated to mochi/);
    expect(session.delegations.has("mochi")).toBe(true);
    const teammate = session.runtimeTree.findResident("mochi");
    expect(teammate).toBeDefined();
    expect(session.supervisor.getController(teammate!.instanceId)).toBeDefined();

    await session.supervisor.removeResidentSubtree(teammate!.instanceId);

    // 1) mochi 真的停下了 —— 不再是 Scheduler 运行态里的实例（不是只清了 delegations）。
    expect(session.runtimeTree.findResident("mochi")).toBeUndefined();
    // 2) pending delegation 不再泄漏。
    expect(session.delegations.has("mochi")).toBe(false);
    // 3) root 收到「取消」回馈，不会永久卡在等 mochi 的假设里。
    const cancelMsg = messages.find((m) => m.to === "root");
    expect(cancelMsg).toBeTruthy();
    const content = (cancelMsg?.payload as { content?: string }).content ?? "";
    expect(content).toContain("取消");
    // 4) delegationGuard 不再因为「target busy」永久拦截对 mochi 的新委托。
    const guard = delegationGuard({ delegations: session.delegations, delegator: "root", target: "mochi" });
    expect(guard.block).toBe(false);

    dispose();
    await sm.close(session.sid);
  });
});

describe("delegate_to_subagent runtime contract", () => {
  test.each(["root", "mochi"])("explicit stop of %s cancels delegated work without waking its owner", async (stoppedAddress) => {
    const kernelId = "delegation-user-stop-kernel";
    let runs = 0;
    registerKernel(testKernel(kernelId, async function* (_request, signal) {
      runs++;
      await abortableGate(signal, new Promise<void>(() => {}));
      yield { kind: "turn.done", reason: "stop" };
    }));
    const sm = initSessionManager(getPathManager());
    try {
      const session = await createRuntimeSession(sm, kernelId, ["root", "mochi"]);
      const ctx = await getRootCtx(session);
      const { messages, dispose } = captureMessages(session);
      await delegateTool.execute({ agent: "mochi", message: "work until stopped" }, ctx);
      await waitUntil(() => runs === 1);
      session.stopRuntime(stoppedAddress, "user stopped");
      await waitUntil(() => !session.delegations.has("mochi"));
      const target = session.tree.resolve("mochi")!;
      await session.supervisor.getController(target.instanceId)!.waitForQuiescence();
      const root = session.tree.resolve("root")!;
      await session.supervisor.getController(root.instanceId)!.waitForQuiescence();
      expect(runs).toBe(1);
      expect(messages.find((event) => event.to === "root")).toMatchObject({ handoff: "silent", durability: "required" });
      expect(session.delegations.size).toBe(0);
      dispose();
      await sm.close(session.sid);
    } finally { unregisterKernel(kernelId); }
  });

  test("real resident init failure emits the full identity callback, clears busy, and leaves the resident usable", async () => {
    const kernelId = "delegation-contract-resident-init-failure-kernel";
    const kernel = testKernel(kernelId, async function* () {
      yield { kind: "message.delta", role: "assistant", text: "resident still works" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const sm = initSessionManager(getPathManager());
      const session = await createRuntimeSession(sm, kernelId, ["root"]);
      await registerInitFailingResident(session, kernelId);
      const ctx = await getRootCtx(session);
      const { messages, dispose } = captureMessages(session);
      const turnEnds: Event[] = [];
      const disposeTurnEnds = session.eventBus.observe((event, emitterId) => {
        if (emitterId === "broken-resident" && event.type === "hook:turnEnd") {
          turnEnds.push(event);
        }
      });

      const out = await delegateTool.execute({ agent: "broken-resident", message: "resident init failure" }, ctx);
      expect(String(out)).toMatch(/Delegated to broken-resident/);
      const info = session.delegations.get("broken-resident")!;
      await waitUntil(() => !session.delegations.has("broken-resident"));

      const target = session.runtimeTree.findResident("broken-resident");
      expect(target).toBeDefined();
      await session.supervisor.getController(target!.instanceId)!.waitForQuiescence();
      expect(target?.state).toBe("idle");
      expect(turnEnds).toHaveLength(1);
      const failure = turnEnds[0]!.payload as Record<string, unknown>;
      assertDelegationIdentity(failure, info);
      expect(turnEnds[0]!.eventId).toBeDefined();
      expect(turnEnds[0]!.eventId).not.toBe(info.sourceEventId);
      expect(failure.aborted).toBe(false);
      expect(String(failure.error)).toContain("requires a directory SourceRef");
      expect(messages.some((message) => {
        const payload = message.payload as Record<string, unknown>;
        return message.to === "root" &&
          message.durability === "required" &&
          String(payload.content).includes("失败") &&
          String(payload.content).includes("requires a directory SourceRef");
      })).toBe(true);
      expect(delegationGuard({
        delegations: session.delegations,
        delegator: "root",
        target: "broken-resident",
      }).block).toBe(false);

      // The failed init must not leave the resident controller holding a
      // rejected initialization promise. A second accepted delivery should
      // reach the same failure callback and release its new busy reservation.
      const retry = await delegateTool.execute({
        agent: "broken-resident",
        message: "resident init retry",
      }, ctx);
      expect(String(retry)).toMatch(/Delegated to broken-resident/);
      const retryInfo = session.delegations.get("broken-resident")!;
      await waitUntil(() => !session.delegations.has("broken-resident"));
      expect(turnEnds).toHaveLength(2);
      const retryFailure = turnEnds[1]!.payload as Record<string, unknown>;
      // Read the exact second reservation before it is consumed by the
      // callback: the two callbacks must be independently correlated.
      assertDelegationIdentity(retryFailure, retryInfo);
      expect(retryFailure.delegationId).not.toBe(info.delegationId);
      expect(retryFailure.sourceEventId).not.toBe(info.sourceEventId);
      expect(retryFailure.turnId).not.toBe(info.turnId);

      // A failed resident initialization must not poison the session's other
      // resident controller; the normal resident can still complete a turn.
      await session.enqueueAgent("root", {
        source: "test",
        type: "user_input",
        payload: { content: "after resident init failure" },
        to: "root",
        handoff: "turn",
        ts: Date.now(),
      });
      expect(session.runtimeTree.findResident("root")?.state).toBe("idle");

      disposeTurnEnds();
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("real ephemeral init failure emits full identity failure callback before child cleanup", async () => {
    const kernelId = "delegation-contract-ephemeral-init-failure-kernel";
    const kernel = testKernel(kernelId, async function* () {
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const sm = initSessionManager(getPathManager());
      const session = await createRuntimeSession(sm, kernelId, ["root"]);
      const templateRef = session.registerMemoryTemplate({
        sourceId: "test:delegation-contract-ephemeral-init-failure",
        entryId: "broken-ephemeral",
        template: {
          definition: { id: "broken-ephemeral", kernelId },
          runtimeConfigDefaults: {},
          resources: {
            skills: [],
            kits: [{ id: "invalid-kit", source: { kind: "inline", text: "not a directory" } }],
            memorySeeds: [],
          },
        },
      });
      const ctx = await getRootCtx(session);
      const { messages, dispose } = captureMessages(session);
      const turnEnds: Event[] = [];
      const disposeTurnEnds = session.eventBus.observe((event, emitterId) => {
        if (emitterId?.startsWith("eph_") && event.type === "hook:turnEnd") {
          turnEnds.push(event);
        }
      });

      const out = await delegateTool.execute({ templateRef, message: "ephemeral init failure" }, ctx);
      expect(String(out)).toMatch(/Delegated to ephemeral child/);
      const childId = [...session.runtimeTree.list()]
        .find((instance) => instance.lifetime === "ephemeral")?.instanceId;
      expect(childId).toBeDefined();
      const info = session.delegations.get(childId!)!;
      await waitUntil(() => session.delegations.size === 0 && session.runtimeTree.size === 1);

      expect(turnEnds).toHaveLength(1);
      const failure = turnEnds[0]!.payload as Record<string, unknown>;
      assertDelegationIdentity(failure, info);
      expect(failure.aborted).toBe(false);
      expect(String(failure.error)).toContain("requires a directory SourceRef");
      expect(messages.some((message) => {
        const payload = message.payload as Record<string, unknown>;
        return message.to === "root" &&
          message.durability === "required" &&
          String(payload.content).includes("失败") &&
          String(payload.content).includes("requires a directory SourceRef");
      })).toBe(true);
      expect(session.runtimeTree.get(childId!)).toBeUndefined();
      expect(session.delegations.has(childId!)).toBe(false);

      disposeTurnEnds();
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("真实 target busy 在第二次 delivery 前拦截，第一次完成后解除 busy", async () => {
    const kernelId = "delegation-contract-busy-kernel";
    const targetStarted = deferred();
    const releaseTarget = deferred();
    const kernel = testKernel(kernelId, async function* (request: TurnRequest, signal) {
      if (request.input.text === "busy target") {
        targetStarted.release();
        await abortableGate(signal, releaseTarget.promise);
      }
      yield { kind: "message.delta", role: "assistant", text: "busy target done" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await createRuntimeSession(sm, kernelId, ["root", "mochi"]);
      const ctx = await getRootCtx(session);

      const first = delegateTool.execute({ agent: "mochi", message: "busy target" }, ctx);
      await targetStarted.promise;
      expect(String(await first)).toMatch(/Delegated to mochi/);
      expect(session.delegations.has("mochi")).toBe(true);

      const second = await delegateTool.execute({ agent: "mochi", message: "must be blocked" }, ctx);
      expect(String(second)).toMatch(/target busy/);
      expect(session.delegations.size).toBe(1);

      releaseTarget.release();
      await waitUntil(() =>
        !session.delegations.has("mochi") &&
        session.runtimeTree.findResident("mochi")?.state === "idle",
      );
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("真实 RuntimeSupervisor children enforce the session-wide concurrent delegation cap", async () => {
    const kernelId = "delegation-contract-concurrent-kernel";
    const targetStarted = deferred();
    const releaseTargets = deferred();
    let startedCount = 0;
    const kernel = testKernel(kernelId, async function* (request: TurnRequest, signal) {
      startedCount += 1;
      if (request.input.text.startsWith("concurrent child ")) {
        if (startedCount === 8) targetStarted.release();
        await abortableGate(signal, releaseTargets.promise);
      }
      yield { kind: "message.delta", role: "assistant", text: "concurrent child done" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await createRuntimeSession(sm, kernelId, ["root"]);
      const ctx = await getRootCtx(session);
      const templateRef = session.registerMemoryTemplate({
        sourceId: "test:delegation-contract-concurrent",
        entryId: "worker",
        template: {
          definition: { id: "worker", kernelId },
          runtimeConfigDefaults: { models: { model: ["delegation-test-model"] } },
          resources: { skills: [], kits: [], memorySeeds: [] },
        },
      });

      for (let i = 0; i < 8; i++) {
        const out = await delegateTool.execute({
          templateRef,
          message: `concurrent child ${i}`,
        }, ctx);
        expect(String(out)).toMatch(/Delegated to ephemeral child/);
      }
      await targetStarted.promise;
      expect(session.delegations.size).toBe(8);
      expect(session.runtimeTree.childrenOf(session.runtimeTree.findResident("root")!.instanceId))
        .toHaveLength(8);

      const blocked = await delegateTool.execute({ templateRef, message: "ninth child" }, ctx);
      expect(String(blocked)).toMatch(/too many concurrent child Agents/);
      expect(session.delegations.size).toBe(8);

      releaseTargets.release();
      await waitUntil(() => session.delegations.size === 0 && session.runtimeTree.size === 1);
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("真实 target failure emits a matching identity and relays failure before ephemeral cleanup", async () => {
    const kernelId = "delegation-contract-failure-kernel";
    const kernel = testKernel(kernelId, async function* (request: TurnRequest) {
      if (request.input.text === "fail target") throw new Error("worker failed");
      yield { kind: "message.delta", role: "assistant", text: "parent handled failure" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await createRuntimeSession(sm, kernelId, ["root"]);
      const ctx = await getRootCtx(session);
      const templateRef = session.registerMemoryTemplate({
        sourceId: "test:delegation-contract-failure",
        entryId: "worker",
        template: {
          definition: { id: "worker", kernelId },
          runtimeConfigDefaults: {},
          resources: { skills: [], kits: [], memorySeeds: [] },
        },
      });
      const { messages, dispose } = captureMessages(session);

      const out = await delegateTool.execute({ templateRef, message: "fail target" }, ctx);
      expect(String(out)).toMatch(/Delegated to ephemeral child/);
      await waitUntil(() => session.delegations.size === 0 && session.runtimeTree.size === 1);
      expect(messages.some((message) => {
        const content = (message.payload as { content?: string }).content ?? "";
        return message.to === "root" && content.includes("失败") && content.includes("worker failed");
      })).toBe(true);
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("真实 target cancellation cleans the pending delegation and ephemeral RuntimeTree node", async () => {
    const kernelId = "delegation-contract-cancel-kernel";
    const targetStarted = deferred();
    const neverRelease = deferred();
    const kernel = testKernel(kernelId, async function* (request: TurnRequest, signal) {
      targetStarted.release();
      if (request.input.text === "cancel target") {
        await abortableGate(signal, neverRelease.promise);
      }
      yield { kind: "message.delta", role: "assistant", text: "cancelled target" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await createRuntimeSession(sm, kernelId, ["root"]);
      const ctx = await getRootCtx(session);
      const templateRef = session.registerMemoryTemplate({
        sourceId: "test:delegation-contract-cancel",
        entryId: "worker",
        template: {
          definition: { id: "worker", kernelId },
          runtimeConfigDefaults: {},
          resources: { skills: [], kits: [], memorySeeds: [] },
        },
      });
      const { messages, dispose } = captureMessages(session);

      await delegateTool.execute({ templateRef, message: "cancel target" }, ctx);
      await targetStarted.promise;
      const root = session.runtimeTree.findResident("root")!;
      const [child] = session.runtimeTree.childrenOf(root.instanceId);
      expect(child).toBeDefined();
      await session.supervisor.cancel(child!.instanceId, "test cancellation");

      await waitUntil(() => session.delegations.size === 0 && session.runtimeTree.size === 1);
      expect(messages.some((message) => {
        const content = (message.payload as { content?: string }).content ?? "";
        return message.to === "root" && content.includes("取消");
      })).toBe(true);
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("真实 resident target removal emits cleanup through RuntimeTree removal", async () => {
    const kernelId = "delegation-contract-removal-kernel";
    const targetStarted = deferred();
    const neverRelease = deferred();
    const kernel = testKernel(kernelId, async function* (request: TurnRequest, signal) {
      targetStarted.release();
      if (request.input.text === "remove target") {
        await abortableGate(signal, neverRelease.promise);
      }
      yield { kind: "message.delta", role: "assistant", text: "removed target" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await createRuntimeSession(sm, kernelId, ["root", "mochi"]);
      const ctx = await getRootCtx(session);
      const teammate = session.runtimeTree.findResident("mochi")!;
      const { messages, dispose } = captureMessages(session);

      await delegateTool.execute({ agent: "mochi", message: "remove target" }, ctx);
      await targetStarted.promise;
      await session.supervisor.removeResidentSubtree(teammate.instanceId);

      expect(session.runtimeTree.get(teammate.instanceId)).toBeUndefined();
      expect(session.runtimeTree.findResident("mochi")).toBeUndefined();
      expect(session.delegations.size).toBe(0);
      expect(messages.some((message) => {
        const content = (message.payload as { content?: string }).content ?? "";
        return message.to === "root" && content.includes("取消");
      })).toBe(true);
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("any mismatch in the strict five-part delivery identity never completes a real pending delegation", async () => {
    const kernelId = "delegation-contract-identity-kernel";
    const targetStarted = deferred();
    const releaseTarget = deferred();
    const kernel = testKernel(kernelId, async function* (request: TurnRequest, signal) {
      targetStarted.release();
      if (request.input.text === "identity mismatch") {
        await abortableGate(signal, releaseTarget.promise);
      }
      yield { kind: "message.delta", role: "assistant", text: "identity-valid result" };
      yield { kind: "turn.done", reason: "stop" };
    });
    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await createRuntimeSession(sm, kernelId, ["root", "mochi"]);
      const ctx = await getRootCtx(session);
      const { messages, dispose } = captureMessages(session);

      await delegateTool.execute({ agent: "mochi", message: "identity mismatch" }, ctx);
      await targetStarted.promise;
      const info = session.delegations.get("mochi")!;
      const identity = {
        delegationId: info.delegationId,
        sourceEventId: info.sourceEventId,
        turnId: info.turnId,
        agentInstanceId: info.targetInstanceId,
        runtimeEpochId: info.targetRuntimeEpochId,
      };
      for (const field of Object.keys(identity) as Array<keyof typeof identity>) {
        session.eventBus.publish({
          source: "agent:mochi",
          type: "hook:turnEnd",
          payload: {
            ...identity,
            [field]: `wrong-${field}`,
          },
          ts: Date.now(),
        }, "mochi");
        expect(session.delegations.has("mochi")).toBe(true);
        expect(messages.filter((message) => message.to === "root")).toHaveLength(0);
      }

      releaseTarget.release();
      await waitUntil(() => !session.delegations.has("mochi"));
      expect(messages.some((message) => {
        const content = (message.payload as { content?: string }).content ?? "";
        return message.to === "root" && content.includes("完成") && content.includes("identity-valid result");
      })).toBe(true);
      dispose();
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });
});
