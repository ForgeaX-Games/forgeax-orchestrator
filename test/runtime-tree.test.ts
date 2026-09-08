import { describe, expect, test } from "bun:test";
import { RuntimeTree } from "../src/runtime/runtime-tree";
import type { AgentInstance } from "../src/runtime/types";
import { RuntimeConfigBinding } from "../src/runtime/runtime-config";
import { AgentExecutionBinding } from "../src/runtime/agent-execution";

function instance(
  instanceId: string,
  parentInstanceId: string | null,
  lifetime: "resident" | "ephemeral" = "ephemeral",
): AgentInstance {
  return {
    sid: "sid-1",
    instanceId,
    runtimeEpochId: `epoch-${instanceId}`,
    templateRef: `tpl-${instanceId}`,
    parentInstanceId,
    lifetime,
    ...(lifetime === "resident" ? { residentPath: instanceId } : {}),
    template: {
      templateRef: `tpl-${instanceId}`,
      definitionRevision: "def-1",
      definition: { id: instanceId },
      runtimeConfigDefaults: {},
      resources: { skills: [], kits: [], memorySeeds: [] },
      execution: { revision: "exec-1", skills: [], kits: [] },
    },
    runtime: {
      workspaceRoot: "/tmp/work",
      runtimeStateRoot: `/tmp/session/runtime-state/agents/${instanceId}`,
      runtimeStateRef: `state-${instanceId}`,
    },
    runtimeConfig: new RuntimeConfigBinding({ revision: "cfg-1", value: {} }),
    execution: new AgentExecutionBinding({
      revision: "exec-1",
      skills: [],
      kits: [],
    }),
    events: {
      ownerInstanceId: instanceId,
      runtimeEpochId: `epoch-${instanceId}`,
      storeId: `store-${instanceId}`,
      locator: { relativeDir: `events/${instanceId}` },
    },
    createdAt: 1,
    state: "registered",
  };
}

describe("RuntimeTree", () => {
  test("resident/ephemeral 组成同一棵树，按 instanceId 隔离同模板节点", () => {
    const tree = new RuntimeTree("sid-1");
    tree.insert(instance("router", null, "resident"));
    tree.insert(instance("eph-a", "router"));
    tree.insert(instance("eph-b", "router"));
    tree.insert(instance("eph-child", "eph-a"));

    expect(tree.childrenOf("router").map((node) => node.instanceId)).toEqual([
      "eph-a",
      "eph-b",
    ]);
    expect(tree.parentOf("eph-child")?.instanceId).toBe("eph-a");
    expect(tree.list().map((node) => node.instanceId)).toEqual([
      "router",
      "eph-a",
      "eph-child",
      "eph-b",
    ]);
  });

  test("移除子树 bottom-up，不提升孩子", () => {
    const tree = new RuntimeTree("sid-1");
    tree.insert(instance("router", null, "resident"));
    tree.insert(instance("eph-a", "router"));
    tree.insert(instance("eph-child", "eph-a"));

    expect(tree.removeSubtree("eph-a").map((node) => node.instanceId)).toEqual([
      "eph-child",
      "eph-a",
    ]);
    expect(tree.get("eph-child")).toBeUndefined();
    expect(tree.childrenOf("router")).toEqual([]);
  });

  test("拒绝未知 parent、重复 id 与跨 Session 节点", () => {
    const tree = new RuntimeTree("sid-1");
    expect(() => tree.insert(instance("child", "missing"))).toThrow("parent");
    expect(() => tree.insert(instance("self", "self"))).toThrow("self-parent");
    tree.insert(instance("router", null, "resident"));
    expect(() => tree.insert(instance("router", null, "resident"))).toThrow(
      "duplicate",
    );
    expect(() => tree.insert({ ...instance("other", null), sid: "sid-2" }))
      .toThrow("session");
  });

  test("update reparent 同步维护 parent 与 children index", () => {
    const tree = new RuntimeTree("sid-1");
    tree.insert(instance("root-a", null, "resident"));
    tree.insert(instance("root-b", null, "resident"));
    tree.insert(instance("child", "root-a"));

    tree.update("child", (node) => {
      (node as { parentInstanceId: string | null }).parentInstanceId = "root-b";
    });

    expect(tree.parentOf("child")?.instanceId).toBe("root-b");
    expect(tree.childrenOf("root-a").map((node) => node.instanceId)).toEqual([]);
    expect(tree.childrenOf("root-b").map((node) => node.instanceId)).toEqual(["child"]);
    expect(tree.depthOf("child")).toBe(2);
  });

  test("update 拒绝把节点 reparent 到自己的 descendant，并回滚 parent", () => {
    const tree = new RuntimeTree("sid-1");
    tree.insert(instance("root", null, "resident"));
    tree.insert(instance("a", "root"));
    tree.insert(instance("b", "a"));

    expect(() => tree.update("a", (node) => {
      (node as { parentInstanceId: string | null }).parentInstanceId = "b";
    })).toThrow(/descendant parent cycle/);
    expect(tree.parentOf("a")?.instanceId).toBe("root");
    expect(tree.childrenOf("root").map((node) => node.instanceId)).toEqual(["a"]);
    expect(tree.childrenOf("a").map((node) => node.instanceId)).toEqual(["b"]);
  });

  test("malformed a↔b topology makes list/depth/parent traversal fail closed", () => {
    const tree = new RuntimeTree("sid-1");
    tree.insert(instance("a", null, "resident"));
    tree.insert(instance("b", "a"));
    (tree.get("a") as { parentInstanceId: string | null }).parentInstanceId = "b";

    expect(() => tree.list()).toThrow(/cycle|index mismatch/);
    expect(() => tree.depthOf("a")).toThrow(/cycle|index mismatch/);
    expect(() => tree.parentOf("a")).toThrow(/cycle|index mismatch/);
  });
});
