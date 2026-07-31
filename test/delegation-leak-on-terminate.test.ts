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
import delegateTool, { delegationGuard } from "../builtin/kits/agent_manage/tools/delegate_to_subagent";

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
): Promise<Session> {
  const pm = getPathManager();
  const initial = await sm.create(opts);
  const sid = initial.sid;
  await sm.close(sid);
  const layer = pm.session(sid).agent("root");
  mkdirSync(layer.root(), { recursive: true });
  writeFileSync(layer.agentJson(), "{}\n", "utf-8");
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
  const session = await createSessionWithRoot(sm, opts);
  const pm = getPathManager();
  const tlayer = pm.session(session.sid).agent(teammate);
  mkdirSync(tlayer.root(), { recursive: true });
  writeFileSync(tlayer.agentJson(), "{}\n", "utf-8");
  return session;
}

async function getRootCtx(session: Session): Promise<AgentContext> {
  await session.scheduler.attachAgent("root");
  const root = session.scheduler.getAgent("root");
  if (!root) throw new Error("root agent failed to attach");
  return root.agentContext;
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

  test("正常完成路径不受影响：hook:turnEnd 仍投递「完成」消息并清理", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "leak-normal" });
    await session.scheduler.attachAgent("root");

    seedPendingDelegation(session);
    const { messages, dispose } = captureMessages(session);

    session.eventBus.emit(
      { source: "agent:root", type: "hook:turnEnd", payload: {}, ts: Date.now() },
      "root",
    );

    expect(session.delegations.has("root")).toBe(false);
    expect(messages).toHaveLength(1);
    const content = (messages[0]?.payload as { content?: string }).content ?? "";
    expect(content).toContain("完成");
    // durability: "required" — 委托完成回调不能和 delegator 队列里的普通消息
    // 共享同一条 EventQueue FIFO 淘汰，见 event-queue.test.ts。
    expect(messages[0]?.durability).toBe("required");

    dispose();
    await sm.close(session.sid);
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
    expect(session.scheduler.getAgent("mochi")).not.toBeNull(); // mochi 此刻是运行中的实例

    await session.scheduler.controlAgent("shutdown", "mochi");

    // 1) mochi 真的停下了 —— 不再是 Scheduler 运行态里的实例（不是只清了 delegations）。
    expect(session.scheduler.getAgent("mochi")).toBeNull();
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
