import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentTemplateCatalog } from "../src/agents/agent-template-catalog";
import { MemoryTemplateSource } from "../src/agents/memory-template-source";
import { ResidentDefinitionStore } from "../src/agents/resident-definition-store";
import { registerResidentDefinitions } from "../src/agents/resident-template-adapter";
import { SessionEventPaths } from "../src/ledger/session-event-paths";
import { AgentRegistrar } from "../src/runtime/agent-registrar";
import type {
  AgentTurnExecutor,
  AgentTurnResult,
} from "../src/runtime/agent-runtime-controller";
import { MemoryTemplateRegistry } from "../src/runtime/agent-template-locator";
import { EphemeralAgentSpawner } from "../src/runtime/ephemeral-agent-spawner";
import { RuntimeSupervisor } from "../src/runtime/runtime-supervisor";
import { RuntimeTree } from "../src/runtime/runtime-tree";
import type { AgentInstance } from "../src/runtime/types";

interface PendingTurn {
  readonly resolve: (result: AgentTurnResult) => void;
  readonly reject: (error: unknown) => void;
}

function deferredExecutors() {
  const pending = new Map<string, PendingTurn>();
  const factory = (instance: AgentInstance): AgentTurnExecutor => ({
    execute: async (_instance, _input, _bindings, signal) =>
      new Promise<AgentTurnResult>((resolve, reject) => {
        pending.set(instance.instanceId, { resolve, reject });
        signal.addEventListener("abort", () => {
          reject(new Error(String(signal.reason ?? "cancelled")));
        }, { once: true });
      }),
  });
  return { pending, factory };
}

function makeHarness(
  root: string,
  executorFactory: (instance: AgentInstance) => AgentTurnExecutor,
) {
  mkdirSync(join(root, "agents"), { recursive: true });
  const catalog = new AgentTemplateCatalog();
  const memoryTemplates = new MemoryTemplateRegistry();
  const tree = new RuntimeTree("sid-1");
  const eventPaths = new SessionEventPaths(root);
  const registrar = new AgentRegistrar(
    "sid-1",
    catalog,
    memoryTemplates,
    tree,
    eventPaths,
    executorFactory,
  );
  const spawner = new EphemeralAgentSpawner(
    catalog,
    memoryTemplates,
    registrar,
    root,
  );
  const supervisor = new RuntimeSupervisor({
    sid: "sid-1",
    workspaceRoot: root,
    tree,
    registrar,
    spawner,
    memoryTemplates,
    removeRuntimeState: (instanceId) =>
      eventPaths.removeRuntimeState(instanceId),
  });
  return {
    catalog,
    memoryTemplates,
    tree,
    registrar,
    supervisor,
  };
}

function registerMemoryTemplate(
  catalog: AgentTemplateCatalog,
  id: string,
): string {
  return catalog.register({
    entryId: id,
    source: new MemoryTemplateSource({
      sourceId: `tests:${id}`,
      templates: {
        [id]: {
          definition: { id, displayName: id },
          runtimeConfigDefaults: {},
          resources: { skills: [], kits: [], memorySeeds: [] },
        },
      },
    }),
    scope: { kind: "session", sid: "sid-1" },
    registrationLifetime: "session",
    trust: "own",
    provenance: { adapter: "runtime-supervisor-test" },
    revisionPolicy: { kind: "immutable" },
  });
}

describe("RuntimeSupervisor", () => {
  test("创建只注册 idle instance；显式 enqueue 后才执行并按实例隔离", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-supervisor-concurrent-"));
    try {
      const executors = deferredExecutors();
      const harness = makeHarness(root, executors.factory);
      const templateRef = registerMemoryTemplate(harness.catalog, "worker");

      const [left, right] = await Promise.all([
        harness.supervisor.spawnEphemeral({
          parentInstanceId: null,
          templateRef,
        }),
        harness.supervisor.spawnEphemeral({
          parentInstanceId: null,
          templateRef,
        }),
      ]);

      expect(left.instanceId).not.toBe(right.instanceId);
      expect(harness.tree.size).toBe(2);
      expect(harness.supervisor.lease.activeCount).toBe(2);
      expect(harness.tree.get(left.instanceId)?.state).toBe("idle");
      expect(harness.tree.get(right.instanceId)?.state).toBe("idle");
      expect(executors.pending.size).toBe(0);
      const leftStore = harness.supervisor.getEventStore(left.instanceId)!;
      const rightStore = harness.supervisor.getEventStore(right.instanceId)!;
      const leftState = join(root, "runtime-state", "agents", left.instanceId);
      mkdirSync(leftState, { recursive: true });
      writeFileSync(join(leftState, "state.json"), "{}");
      expect(leftStore.paths.eventsDir).not.toBe(rightStore.paths.eventsDir);
      expect(harness.memoryTemplates.resolve).toBeDefined();
      expect((await leftStore.readAllEvents()).map((event) => event.type)).toEqual([
        "agent.registered",
      ]);

      const leftTurn = harness.supervisor.enqueue(left.instanceId, { task: "left" });
      const rightTurn = harness.supervisor.enqueue(right.instanceId, { task: "right" });
      await Bun.sleep(1);
      expect(executors.pending.has(left.instanceId)).toBe(true);
      expect(executors.pending.has(right.instanceId)).toBe(true);

      executors.pending.get(left.instanceId)!.resolve({
        final: true,
        output: "left done",
      });
      executors.pending.get(right.instanceId)!.resolve({
        final: true,
        output: "right done",
      });
      await Promise.all([leftTurn, rightTurn]);
      const [leftCompletion, rightCompletion] = await Promise.all([
        left.wait(),
        right.wait(),
      ]);

      expect(leftCompletion.status).toBe("completed");
      expect(rightCompletion.status).toBe("completed");
      expect(harness.tree.size).toBe(0);
      expect(harness.supervisor.lease.canEvict).toBe(true);
      expect(existsSync(leftState)).toBe(false);
      expect((await leftStore.readAllEvents()).map((event) => event.type)).toEqual([
        "agent.registered",
        "agent.completed",
        "agent.disposed",
      ]);
      expect((await rightStore.readAllEvents()).map((event) => event.type)).toEqual([
        "agent.registered",
        "agent.completed",
        "agent.disposed",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("父先 final 时进入 draining，最后孩子释放后自底向上 GC", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-supervisor-gc-"));
    try {
      const executors = deferredExecutors();
      const harness = makeHarness(root, executors.factory);
      const parentTemplate = registerMemoryTemplate(harness.catalog, "parent");
      const childTemplate = registerMemoryTemplate(harness.catalog, "child");
      const removed: string[] = [];
      harness.tree.onChange((change) => {
        if (change.kind === "removed") removed.push(change.instance.instanceId);
      });

      const parent = await harness.supervisor.spawnEphemeral({
        parentInstanceId: null,
        templateRef: parentTemplate,
      });
      const child = await harness.supervisor.spawnEphemeral({
        parentInstanceId: parent.instanceId,
        templateRef: childTemplate,
      });
      const parentTurn = harness.supervisor.enqueue(parent.instanceId, "parent");
      const childTurn = harness.supervisor.enqueue(child.instanceId, "child");
      await Bun.sleep(1);

      executors.pending.get(parent.instanceId)!.resolve({ final: true });
      await parentTurn;
      await Bun.sleep(5);
      expect(harness.tree.get(parent.instanceId)?.state).toBe("draining");
      expect(harness.tree.get(child.instanceId)).toBeDefined();

      executors.pending.get(child.instanceId)!.resolve({ final: true });
      await childTurn;
      await child.wait();
      await parent.wait();
      expect(removed).toEqual([child.instanceId, parent.instanceId]);
      expect(harness.tree.size).toBe(0);
      expect(harness.supervisor.lease.canEvict).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resident final turn 回到 idle，不按 ephemeral 规则释放", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-supervisor-resident-"));
    try {
      mkdirSync(join(root, "agents", "router"), { recursive: true });
      writeFileSync(
        join(root, "agents", "router", "agent.json"),
        JSON.stringify({ id: "router" }),
      );
      const harness = makeHarness(root, () => ({
        execute: async () => ({ final: true, output: "ok" }),
      }));
      const definitions = ResidentDefinitionStore.scan(
        "sid-1",
        join(root, "agents"),
      );
      const prepared = await registerResidentDefinitions(
        harness.catalog,
        definitions,
      );
      const [resident] = await harness.supervisor.bootstrapResidents(prepared);

      await harness.supervisor.getController(resident!.instanceId)!.enqueue("hello");
      await Bun.sleep(5);
      expect(harness.tree.get(resident!.instanceId)?.state).toBe("idle");
      expect(harness.supervisor.size).toBe(1);
      expect(harness.supervisor.lease.canEvict).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("运行期物化 resident 是正式注册路径，保持 idle 且不偷跑 turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-supervisor-runtime-resident-"));
    try {
      mkdirSync(join(root, "agents", "lazy-persona"), { recursive: true });
      writeFileSync(
        join(root, "agents", "lazy-persona", "agent.json"),
        JSON.stringify({ id: "lazy-persona" }),
      );
      let turnCount = 0;
      const harness = makeHarness(root, () => ({
        execute: async () => {
          turnCount += 1;
          return { final: true };
        },
      }));
      const definitions = ResidentDefinitionStore.scan(
        "sid-1",
        join(root, "agents"),
      );
      const [prepared] = await registerResidentDefinitions(
        harness.catalog,
        definitions,
      );
      if (!prepared) throw new Error("missing prepared runtime resident");

      const resident = await harness.supervisor.registerResident(prepared, null);

      expect(resident.lifetime).toBe("resident");
      expect(resident.residentPath).toBe("lazy-persona");
      expect(resident.state).toBe("idle");
      expect(harness.tree.get(resident.instanceId)).toBe(resident);
      expect(turnCount).toBe(0);
      expect(
        (await harness.supervisor.getEventStore(resident.instanceId)!.readAllEvents())
          .map((event) => event.type),
      ).toEqual(["agent.registered"]);
      await harness.supervisor.shutdown("test cleanup");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("未收到消息的 idle ephemeral 可显式 cancel，且从根传播到子树", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-supervisor-cancel-"));
    try {
      const executors = deferredExecutors();
      const harness = makeHarness(root, executors.factory);
      const templateRef = registerMemoryTemplate(harness.catalog, "worker");
      const parent = await harness.supervisor.spawnEphemeral({
        parentInstanceId: null,
        templateRef,
      });
      const child = await harness.supervisor.spawnEphemeral({
        parentInstanceId: parent.instanceId,
        templateRef,
      });
      const parentStore = harness.supervisor.getEventStore(parent.instanceId)!;
      const childStore = harness.supervisor.getEventStore(child.instanceId)!;
      expect(executors.pending.size).toBe(0);
      expect(harness.tree.get(parent.instanceId)?.state).toBe("idle");
      expect(harness.tree.get(child.instanceId)?.state).toBe("idle");

      await parent.cancel("test cancellation");
      expect((await parent.wait()).status).toBe("cancelled");
      expect((await child.wait()).status).toBe("cancelled");
      expect(harness.tree.size).toBe(0);
      for (const store of [parentStore, childStore]) {
        const types = (await store.readAllEvents()).map((event) => event.type);
        expect(types.filter((type) => type === "agent.cancelled")).toHaveLength(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareForSessionMutation 在 cancel+GC 之前捕获 ephemeral 的 EventLedger，供 checkpoint 补写 boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-supervisor-gate-"));
    try {
      const executors = deferredExecutors();
      const harness = makeHarness(root, executors.factory);
      const templateRef = registerMemoryTemplate(harness.catalog, "worker");
      const parent = await harness.supervisor.spawnEphemeral({
        parentInstanceId: null,
        templateRef,
      });
      const child = await harness.supervisor.spawnEphemeral({
        parentInstanceId: parent.instanceId,
        templateRef,
      });
      const parentStore = harness.supervisor.getEventStore(parent.instanceId)!;
      const childStore = harness.supervisor.getEventStore(child.instanceId)!;

      const { release, retiringEphemeralLedgers } =
        await harness.supervisor.prepareForSessionMutation("checkpoint rewind");

      // 门内:两个 idle ephemeral 已经被 cancel+GC,RuntimeTree 里已经找不到它们了——
      // 这正是 checkpoint-manager 原本漏写 boundary 的窗口。
      expect(harness.tree.size).toBe(0);
      expect(retiringEphemeralLedgers).toHaveLength(2);

      // checkpoint-manager 的用法:门已经关上、树里够不着了,靠这份 gate 之前
      // 捕获的 ledger 列表补写 boundary(模拟 appendToAllLedgers 的 extraLedgers)。
      const boundaryEvent = {
        type: "rewind_boundary",
        ts: Date.now(),
        source: "system" as const,
        payload: { boundaryId: "b1" },
      };
      for (const ledger of retiringEphemeralLedgers) {
        ledger.append(boundaryEvent);
      }
      release();

      for (const store of [parentStore, childStore]) {
        const types = (await store.readAllEvents()).map((event) => event.type);
        // boundary 追加在原有历史(registered → cancelled → disposed)之后,
        // 落进同一份 WAL——不是被 GC 顺手清空、也不是另起一份新文件。
        expect(types).toEqual([
          "agent.registered",
          "agent.cancelled",
          "agent.disposed",
          "rewind_boundary",
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
