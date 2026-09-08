import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResidentDefinitionStore } from "../src/agents/resident-definition-store";
import {
  AgentTemplateCatalog,
  resolveTemplateTrust,
} from "../src/agents/agent-template-catalog";
import { registerResidentDefinitions } from "../src/agents/resident-template-adapter";

describe("ResidentDefinitionStore", () => {
  test("一次扫描得到规范 resident 逻辑树，不产生 agents 伪节点", () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-residents-"));
    try {
      mkdirSync(join(root, "router", "agents", "reviewer", "agents", "fact-check"), {
        recursive: true,
      });
      mkdirSync(join(root, "router", "events"), { recursive: true });
      mkdirSync(join(root, "router", "kits", "demo"), { recursive: true });
      writeFileSync(join(root, "router", "agent.json"), "{}\n");

      const store = ResidentDefinitionStore.scan("sid-1", root);
      expect(store.list().map((x) => x.logicalPath)).toEqual([
        "router",
        "router/reviewer",
        "router/reviewer/fact-check",
      ]);
      expect(store.list().some((x) => x.logicalPath.split("/").includes("agents"))).toBe(false);
      expect(store.get("router/reviewer")?.parentLogicalPath).toBe("router");
      expect(store.childrenOf("router").map((x) => x.logicalPath)).toEqual([
        "router/reviewer",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("扫描结果是内存快照，后续目录变化不会隐式改变", () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-residents-stable-"));
    try {
      mkdirSync(join(root, "router"), { recursive: true });
      const snapshot = ResidentDefinitionStore.scan("sid-1", root);

      mkdirSync(join(root, "router", "agents", "late-child"), { recursive: true });
      expect(snapshot.list().map((x) => x.logicalPath)).toEqual(["router"]);
      expect(
        ResidentDefinitionStore.scan("sid-1", root)
          .list()
          .map((x) => x.logicalPath),
      ).toEqual(["router", "router/late-child"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resident adapter 统一注册 templateRef 并产出 bootstrap FileSystemLocator", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-resident-adapter-"));
    try {
      mkdirSync(join(root, "router"), { recursive: true });
      writeFileSync(
        join(root, "router", "agent.json"),
        JSON.stringify({ models: { model: "codex" } }),
      );
      const store = ResidentDefinitionStore.scan("sid-1", root);
      const catalog = new AgentTemplateCatalog();
      const prepared = await registerResidentDefinitions(catalog, store);

      expect(prepared).toHaveLength(1);
      expect(prepared[0]?.definition.logicalPath).toBe("router");
      expect(prepared[0]?.locator.medium).toBe("filesystem");
      expect(prepared[0]?.locator.expectedSourceRevision).toMatch(/^def_/);
      expect((await catalog.resolve(prepared[0]!.templateRef)).definition.id).toBe(
        "router",
      );
      expect(resolveTemplateTrust(catalog, prepared[0]!.templateRef)).toBe("own");
      expect(
        JSON.parse(readFileSync(join(root, "router", "agent.json"), "utf8"))
          .trustTier,
      ).toBe("own");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resident adapter 恢复持久化 trust，且不把 imported 提升为 own", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-resident-trust-"));
    try {
      mkdirSync(join(root, "reviewer"), { recursive: true });
      writeFileSync(
        join(root, "reviewer", "agent.json"),
        JSON.stringify({ trustTier: "imported" }),
      );
      const store = ResidentDefinitionStore.scan("sid-1", root);
      const catalog = new AgentTemplateCatalog();
      const [prepared] = await registerResidentDefinitions(catalog, store);

      expect(resolveTemplateTrust(catalog, prepared!.templateRef)).toBe("imported");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
