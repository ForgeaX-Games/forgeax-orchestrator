import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { AgentTemplateCatalog } from "../src/agents/agent-template-catalog";
import { MemoryTemplateSource } from "../src/agents/memory-template-source";
import { EventStore } from "../src/ledger/event-store";
import { SessionEventPaths } from "../src/ledger/session-event-paths";
import type {
  InstanceEventBinding,
  ResolvedEventStorePaths,
  StoredEvent,
} from "../src/ledger/types";
import { AgentRegistrar } from "../src/runtime/agent-registrar";
import { MemoryTemplateRegistry } from "../src/runtime/agent-template-locator";
import { RuntimeTree } from "../src/runtime/runtime-tree";

async function memoryLocator(catalog: AgentTemplateCatalog, registry: MemoryTemplateRegistry) {
  const ref = catalog.register({
    entryId: "tester",
    source: new MemoryTemplateSource({
      sourceId: "test-source",
      templates: {
        tester: {
          definition: { id: "tester", displayName: "Tester" },
          runtimeConfigDefaults: { maxIterations: 3 },
          resources: { skills: [], kits: [], memorySeeds: [] },
        },
      },
    }),
    scope: { kind: "session", sid: "sid-1" },
    registrationLifetime: "session",
    trust: "own",
    provenance: { adapter: "test" },
    revisionPolicy: { kind: "immutable" },
  });
  return registry.register(await catalog.resolve(ref));
}

describe("AgentRegistrar", () => {
  test("先 required 写 agent.registered，再原子插入 RuntimeTree", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-registrar-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      const catalog = new AgentTemplateCatalog();
      const memory = new MemoryTemplateRegistry();
      const tree = new RuntimeTree("sid-1");
      const registrar = new AgentRegistrar(
        "sid-1",
        catalog,
        memory,
        tree,
        new SessionEventPaths(root),
        () => ({
          execute: async () => ({ final: true }),
        }),
      );

      const registered = await registrar.register({
        locator: await memoryLocator(catalog, memory),
        lifetime: "ephemeral",
        parentId: null,
        trigger: "runtime",
        runtimeConfigPatch: {
          maxIterations: 9,
          timezone: "Asia/Hong_Kong",
        },
        runtime: {
          workspaceRoot: root,
          runtimeStateRef: "memory:state-1",
        },
      });

      expect(tree.get(registered.instance.instanceId)).toBe(registered.instance);
      const events = await registered.eventStore.readAllEvents();
      expect(events.map((event) => event.type)).toEqual(["agent.registered"]);
      const registeredEvent = events[0];
      if (!registeredEvent) throw new Error("missing agent.registered");
      expect(registeredEvent.runtimeEpochId).toBe(registered.instance.runtimeEpochId);
      expect(registered.instance.runtimeConfig.current().value).toEqual({
        maxIterations: 9,
        timezone: "Asia/Hong_Kong",
      });
      expect(registeredEvent.payload?.runtimeConfigRevision).toBe(
        registered.instance.runtimeConfig.current().revision,
      );
      expect(
        relative(root, registered.eventStore.paths.eventsDir),
      ).toBe(`runtime-events/ephemeral/${registered.instance.instanceId}`);
      await registered.controller.dispose();
      registered.eventStore.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("首条 required append 失败时不产生 live 节点", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-registrar-fail-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      const catalog = new AgentTemplateCatalog();
      const memory = new MemoryTemplateRegistry();
      const tree = new RuntimeTree("sid-1");
      let disposed = false;
      const registrar = new AgentRegistrar(
        "sid-1",
        catalog,
        memory,
        tree,
        new SessionEventPaths(root),
        () => ({ execute: async () => ({ final: true }) }),
        undefined,
        () => ({
          append: async () => {
            throw new Error("disk unavailable");
          },
          dispose: () => {
            disposed = true;
          },
        } as unknown as EventStore),
      );

      await expect(registrar.register({
        locator: await memoryLocator(catalog, memory),
        lifetime: "ephemeral",
        parentId: null,
        trigger: "runtime",
        runtime: { workspaceRoot: root, runtimeStateRef: "memory:state-1" },
      })).rejects.toThrow("disk unavailable");
      expect(tree.size).toBe(0);
      expect(disposed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registered 已写但 Controller 构造失败时补 registration_failed 且不插树", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-registrar-controller-fail-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      const catalog = new AgentTemplateCatalog();
      const memory = new MemoryTemplateRegistry();
      const tree = new RuntimeTree("sid-1");
      const persisted: StoredEvent[] = [];
      const fakeStore = {
        append: async (event: StoredEvent) => {
          persisted.push(event);
        },
        flush: async () => {},
        dispose: () => {},
      } as unknown as EventStore;
      const registrar = new AgentRegistrar(
        "sid-1",
        catalog,
        memory,
        tree,
        new SessionEventPaths(root),
        () => {
          throw new Error("executor construction failed");
        },
        undefined,
        (
          _binding: InstanceEventBinding,
          _paths: ResolvedEventStorePaths,
        ) => fakeStore,
      );

      await expect(registrar.register({
        locator: await memoryLocator(catalog, memory),
        lifetime: "ephemeral",
        parentId: null,
        trigger: "runtime",
        runtime: { workspaceRoot: root, runtimeStateRef: "memory:state-1" },
      })).rejects.toThrow("executor construction failed");
      expect(persisted.map((event) => event.type)).toEqual([
        "agent.registered",
        "agent.registration_failed",
      ]);
      expect(tree.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
