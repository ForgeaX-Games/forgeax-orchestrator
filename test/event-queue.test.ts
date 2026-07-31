/** event-queue —— MAX_EVENTS=50 溢出淘汰的 required/best-effort 豁免回归。
 *
 *  根因：旧 `push()` 溢出时无条件 `queue.shift()` 丢最旧一条，不区分事件重要性。
 *  委托完成回调（`Session._resolveDelegation` 投给 delegator 的 "message" 事件）
 *  和 delegator 队列里的普通 UI/tool 消息共享同一条淘汰队列 —— 目标 agent 排队
 *  积压到 50 条以上时，回调本身可能被无差别淘汰，delegator 永远不知道委托完成。
 *
 *  修复：`push()` 溢出时只挑最旧的 best-effort 事件淘汰；若已排队的全是
 *  required，拒绝的是新来的这一条（不淘汰任何已排队的 required 事件）。默认
 *  durability（未显式指定）= best-effort，行为与改前逐字节一致。 */

import { describe, expect, test } from "bun:test";
import { EventQueue } from "../src/core/event-queue";
import type { Event } from "../src/core/types";

function makeEvent(
  ts: number,
  overrides: Partial<Event> = {},
): Event {
  return {
    source: "test",
    type: "message",
    payload: { content: String(ts) },
    ts,
    handoff: "silent",
    ...overrides,
  } as Event;
}

describe("EventQueue — MAX_EVENTS overflow eviction durability", () => {
  test("回归：全部 best-effort（未指定 durability）时，溢出仍 FIFO 丢最旧一条", () => {
    const q = new EventQueue();
    for (let i = 0; i < 50; i++) q.push(makeEvent(i));
    expect(q.pending()).toBe(50);

    q.push(makeEvent(50));
    expect(q.pending()).toBe(50);

    const remaining = q.drain().map((e) => e.ts);
    // 最旧的 ts=0 被丢弃，ts=1..50 保留。
    expect(remaining).not.toContain(0);
    expect(remaining).toContain(50);
    expect(remaining.length).toBe(50);
  });

  test("required 事件在溢出淘汰中被豁免：淘汰只挑最旧的 best-effort", () => {
    const q = new EventQueue();
    // 最旧的一条标 required —— 不该被淘汰。
    q.push(makeEvent(0, { durability: "required" }));
    for (let i = 1; i < 50; i++) q.push(makeEvent(i));
    expect(q.pending()).toBe(50);

    q.push(makeEvent(50));
    expect(q.pending()).toBe(50);

    const remaining = q.drain().map((e) => e.ts);
    // required 的 ts=0 保留；次旧的 best-effort ts=1 被淘汰。
    expect(remaining).toContain(0);
    expect(remaining).not.toContain(1);
    expect(remaining).toContain(50);
  });

  test("队列全是 required 时，拒绝的是新来的 best-effort 事件本身，不淘汰任何已排队的 required", () => {
    const q = new EventQueue();
    for (let i = 0; i < 50; i++) q.push(makeEvent(i, { durability: "required" }));
    expect(q.pending()).toBe(50);

    q.push(makeEvent(999));
    expect(q.pending()).toBe(50);

    const remaining = q.drain().map((e) => e.ts);
    expect(remaining).not.toContain(999);
    for (let i = 0; i < 50; i++) expect(remaining).toContain(i);
  });

  test("队列全是 required 时，新来的事件即使自己也标 required 一样被拒绝", () => {
    const q = new EventQueue();
    for (let i = 0; i < 50; i++) q.push(makeEvent(i, { durability: "required" }));

    q.push(makeEvent(999, { durability: "required" }));
    expect(q.pending()).toBe(50);

    const remaining = q.drain().map((e) => e.ts);
    expect(remaining).not.toContain(999);
  });
});
