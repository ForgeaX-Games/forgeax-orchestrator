import { describe, expect, test } from "bun:test";

import { EventBus } from "../src/core/event-bus";
import { Scheduler } from "../src/core/scheduler";
import type { BaseAgent } from "../src/core/base-agent";
import type { AgentNode, AgentTreeAPI } from "../src/core/types";

const rootNode: AgentNode = {
  path: "root",
  display: "root",
  depth: 1,
  fullId: "root#1",
};

const tree: AgentTreeAPI = {
  sid: "sid-test",
  get: (path) => (path === rootNode.path ? rootNode : undefined),
  getByFullId: (fullId) => (fullId === rootNode.fullId ? rootNode : undefined),
  findByDisplay: (display) => {
    if (display === rootNode.display) return rootNode;
    throw new Error(`unknown display: ${display}`);
  },
  parent: () => undefined,
  children: () => [],
  list: () => [rootNode],
  getWritablePaths: () => [],
  onChange: () => () => undefined,
};

function createDrainingAgent(): {
  agent: BaseAgent;
  stopCalls: () => number;
  resolveSettled: () => void;
} {
  let stops = 0;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const agent = {
    agentPath: "root",
    signal: new AbortController().signal,
    initKits: async () => undefined,
    run: async () => undefined,
    stop: () => {
      stops += 1;
    },
    shutdown: async () => undefined,
    get settled() {
      return settled;
    },
  } as unknown as BaseAgent;

  return { agent, stopCalls: () => stops, resolveSettled };
}

describe("Scheduler.interruptAndDrain", () => {
  test("stop 后会等待目标 agent 的 settled resolve", async () => {
    const { agent, stopCalls, resolveSettled } = createDrainingAgent();
    const scheduler = new Scheduler({
      sid: "sid-test",
      eventBus: new EventBus(),
      tree,
      agentFactory: async () => agent,
    });

    await scheduler.attachAgent("root");
    const drained = scheduler.interruptAndDrain("root");
    let completed = false;
    void drained.then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(stopCalls()).toBe(1);
    expect(completed).toBe(false);

    resolveSettled();
    await drained;
    expect(completed).toBe(true);
  });
});
