/** agent-status-broadcast-on-terminate —— 被强制终止（shutdown/restart/remove/
 *  crash）的 agent 自身，也需要收到一条终态广播，否则前端会永久卡在「取消中/
 *  思考中」。
 *
 *  根因：`Session._bindDelegationCallback` / `onAgentDetached` 的既有修复
 *  （delegation-leak-on-terminate.test.ts）只解决了「delegator 学不到 target
 *  已终止」——它给 delegator 发一条 `message`。但前端 Stop 按钮 / "正在思考"
 *  文案完全绑在 target 自己的 `hook:turnEnd`（见 session-stream.ts 的
 *  `setStreaming(sid, emitter, false)`），而这条事件在 target 被强制终止时
 *  和 delegation 泄漏是同一个洞——永远不会为 target 触发。用户实测复现：
 *  subagent 派发任务后立刻点取消，后端正确取消、主 agent 正确收到取消消息，
 *  但 subagent 自己的面板仍显示取消按钮 + "正在思考"。
 *
 *  修复：`onAgentDetached` 里除了 `_resolveDelegation`（通知 delegator），额外
 *  在 `liveTurns.has(agentPath)`（target 确实有未封口的 turn）时，`publish`
 *  一条合成的 `hook:turnEnd { aborted: true, synthesized: true }`，与
 *  `ledger-recovery.ts` 给启动时孤儿 turn 补的事件同形，WS hub 会把它推给所有
 *  正在看这个 agentPath 的前端 tab。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getPathManager, initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Event } from "../src/core/types";
import type { Session } from "../src/core/session";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-status-broadcast-"));
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

function captureTurnEndEvents(
  session: Session,
  agentPath: string,
): { events: Event[]; dispose: () => void } {
  const events: Event[] = [];
  const dispose = session.eventBus.observe((event, emitterId) => {
    if (event.type === "hook:turnEnd" && emitterId === agentPath) events.push(event);
  });
  return { events, dispose };
}

describe("agent 自身终态广播 —— 被强制终止时给前端补一条 turnEnd", () => {
  test("target 有未封口 turn 时，shutdown 会给它自己补一条合成 hook:turnEnd(aborted:true)", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "status-shutdown" });
    await session.scheduler.attachAgent("root");

    // 模拟 root 正在跑一个 turn（前端此刻显示"正在思考" + 取消按钮）。
    session.eventBus.emit(
      { source: "agent:root", type: "hook:turnStart", payload: { turn: 1 }, ts: Date.now() },
      "root",
    );
    expect(session.liveTurns.snapshots().some((s) => s.emitterId === "root")).toBe(true);

    const { events, dispose } = captureTurnEndEvents(session, "root");

    await session.scheduler.controlAgent("shutdown", "root");

    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { aborted?: boolean; synthesized?: boolean };
    expect(payload.aborted).toBe(true);
    expect(payload.synthesized).toBe(true);
    // LiveTurnTracker 自己观察到这条合成事件后也会封口——不会再重复广播。
    expect(session.liveTurns.snapshots().some((s) => s.emitterId === "root")).toBe(false);

    dispose();
    await sm.close(session.sid);
  });

  test("target 没有在途 turn（本来就是 idle）时，shutdown 不会凭空广播 turnEnd", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "status-idle-shutdown" });
    await session.scheduler.attachAgent("root");

    const { events, dispose } = captureTurnEndEvents(session, "root");

    await session.scheduler.controlAgent("shutdown", "root");

    expect(events).toHaveLength(0);

    dispose();
    await sm.close(session.sid);
  });

  test("真实 turnEnd 已经先跑过一次时，不会重复补发合成事件", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await createSessionWithRoot(sm, { displayName: "status-already-ended" });
    await session.scheduler.attachAgent("root");

    session.eventBus.emit(
      { source: "agent:root", type: "hook:turnStart", payload: { turn: 1 }, ts: Date.now() },
      "root",
    );
    // 真实 turnEnd 先到——LiveTurnTracker 已经把这条 turn 从在途表里删掉。
    session.eventBus.emit(
      { source: "agent:root", type: "hook:turnEnd", payload: {}, ts: Date.now() },
      "root",
    );
    expect(session.liveTurns.snapshots().some((s) => s.emitterId === "root")).toBe(false);

    const { events, dispose } = captureTurnEndEvents(session, "root");

    await session.scheduler.controlAgent("shutdown", "root");

    expect(events).toHaveLength(0); // 不重复广播

    dispose();
    await sm.close(session.sid);
  });
});
