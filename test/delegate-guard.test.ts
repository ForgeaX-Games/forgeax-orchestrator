/** delegate-guard — delegationGuard 纯函数单测
 *
 *  覆盖四个场景：
 *  1. target busy（target 已经有一个 pending delegation）→ block
 *  2. 并发超限（delegations.size >= maxConcurrent）→ block
 *  3. 循环委托（delegator 是 target 的子孙，如 "forge/iori" → "forge"）→ block
 *  4. 正常情况（空 map，不同 agent）→ allow
 */

import { describe, expect, test } from "bun:test";
import { delegationGuard } from "../builtin/kits/agent_manage/tools/delegate_to_subagent";
import { RuntimeTree } from "../src/runtime/runtime-tree";
import type { AgentInstance } from "../src/runtime/types";

function runtimeNode(
  instanceId: string,
  parentInstanceId: string | null,
  lifetime: "resident" | "ephemeral",
  residentPath?: string,
): AgentInstance {
  return {
    sid: "sid-guard",
    instanceId,
    runtimeEpochId: `epoch-${instanceId}`,
    templateRef: `template-${instanceId}`,
    parentInstanceId,
    lifetime,
    ...(residentPath ? { residentPath } : {}),
  } as AgentInstance;
}

describe("delegationGuard", () => {
  test("target busy: target already has a pending delegation → block", () => {
    const delegations = new Map<string, { delegator: string }>([
      ["suzu", { delegator: "forge" }],
    ]);
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "suzu",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/target busy/);
  });

  test("too many concurrent: size >= maxConcurrent → block", () => {
    // 填满 8 个 pending（默认 maxConcurrent = 8）
    const delegations = new Map<string, { delegator: string }>(
      Array.from({ length: 8 }, (_, i) => [`agent-${i}`, { delegator: "forge" }]),
    );
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "new-agent", // 新 target，不在 map 里
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/too many concurrent/);
  });

  test("cycle: delegator 'forge/iori' delegating to ancestor 'forge' → block", () => {
    const delegations = new Map<string, { delegator: string }>();
    const result = delegationGuard({
      delegations,
      delegator: "forge/iori",
      target: "forge",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/cycle/);
  });

  test("cycle: delegator === target → block", () => {
    const delegations = new Map<string, { delegator: string }>();
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "forge",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/cycle/);
  });

  test("normal: empty map, different agents → allow", () => {
    const delegations = new Map<string, { delegator: string }>();
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "suzu",
    });
    expect(result.block).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("normal: map has entries for different targets, not over limit → allow", () => {
    const delegations = new Map<string, { delegator: string }>([
      ["suzu", { delegator: "forge" }],
      ["rin", { delegator: "forge" }],
    ]);
    // mochi is a new target, map size=2 < 8
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "mochi",
    });
    expect(result.block).toBe(false);
  });

  test("custom maxConcurrent: size >= custom limit → block", () => {
    const delegations = new Map<string, { delegator: string }>([
      ["suzu", { delegator: "forge" }],
      ["rin", { delegator: "forge" }],
    ]);
    // size=2, maxConcurrent=2 → should block
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "mochi",
      maxConcurrent: 2,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/too many concurrent/);
  });

  test("real RuntimeTree ancestry blocks an ephemeral grandchild delegating to its resident ancestor", () => {
    const tree = new RuntimeTree("sid-guard");
    tree.insert(runtimeNode("resident-root", null, "resident", "root"));
    tree.insert(runtimeNode("ephemeral-child", "resident-root", "ephemeral"));
    tree.insert(runtimeNode("ephemeral-grandchild", "ephemeral-child", "ephemeral"));

    const result = delegationGuard({
      delegations: new Map(),
      delegator: "ephemeral-grandchild",
      target: "root",
      tree,
      delegatorInstanceId: "ephemeral-grandchild",
      targetInstanceId: "resident-root",
    });

    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/cycle detected/);
  });

  test("real instance identity wins over a legacy address prefix", () => {
    const tree = new RuntimeTree("sid-guard");
    tree.insert(runtimeNode("actual-target", null, "resident", "root"));
    tree.insert(runtimeNode("other-root", null, "resident", "other"));
    tree.insert(runtimeNode("other-child", "other-root", "ephemeral"));

    const result = delegationGuard({
      delegations: new Map(),
      delegator: "root/child",
      target: "root",
      tree,
      delegatorInstanceId: "other-child",
      targetInstanceId: "actual-target",
    });

    expect(result.block).toBe(false);
  });

  test("malformed RuntimeTree topology blocks real-identity delegation", () => {
    const tree = new RuntimeTree("sid-guard");
    tree.insert(runtimeNode("a", null, "resident", "a"));
    tree.insert(runtimeNode("b", "a", "ephemeral"));
    tree.insert(runtimeNode("unrelated", null, "resident", "unrelated"));
    (tree.get("a") as { parentInstanceId: string | null }).parentInstanceId = "b";

    const result = delegationGuard({
      delegations: new Map(),
      delegator: "a/child",
      target: "unrelated",
      tree,
      delegatorInstanceId: "b",
      targetInstanceId: "unrelated",
    });

    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/invalid RuntimeTree topology/);
  });
});
