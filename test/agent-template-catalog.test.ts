import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentTemplateCatalog,
  resolveTemplateTrust,
} from "../src/agents/agent-template-catalog";
import { FileSystemTemplateSource } from "../src/agents/filesystem-template-source";
import { MemoryTemplateSource } from "../src/agents/memory-template-source";
import { resolveAgentComposition } from "../src/agents/resolved-agent-composition";

describe("AgentTemplateCatalog", () => {
  test("filesystem/memory 是注册介质，scope 与 lifetime 保持正交", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-template-"));
    try {
      mkdirSync(join(root, "persona"), { recursive: true });
      writeFileSync(
        join(root, "agent.json"),
        JSON.stringify({
          // Template content cannot override registration trust.
          trustTier: "imported",
          models: { model: "codex" },
          maxIterations: 7,
        }),
      );
      writeFileSync(join(root, "persona", "identity.md"), "filesystem persona\n");

      const catalog = new AgentTemplateCatalog();
      const fsRef = catalog.register({
        entryId: "router",
        source: new FileSystemTemplateSource({
          sourceId: "resident:sid-1",
          root,
        }),
        scope: { kind: "session", sid: "sid-1" },
        registrationLifetime: "session",
        trust: "own",
        provenance: { adapter: "resident-scanner" },
        revisionPolicy: { kind: "explicit" },
      });
      const memoryRef = catalog.register({
        entryId: "tester",
        source: new MemoryTemplateSource({
          sourceId: "runtime-test",
          templates: {
            tester: {
              definition: { id: "tester", displayName: "Tester" },
              runtimeConfigDefaults: { models: { model: "codex" } },
              resources: {
                persona: { kind: "inline", text: "memory persona" },
                skills: [],
                kits: [],
                memorySeeds: [],
              },
            },
          },
        }),
        scope: { kind: "session", sid: "sid-1" },
        registrationLifetime: "process",
        trust: "own",
        provenance: { adapter: "test" },
        revisionPolicy: { kind: "immutable" },
      });

      const fsTemplate = await catalog.resolve(fsRef);
      const memoryTemplate = await catalog.resolve(memoryRef);
      expect(fsTemplate.resources.templateRoot).toBe(realpathSync(root));
      expect(fsTemplate.runtimeConfigDefaults.models?.model).toBe("codex");
      expect(memoryTemplate.resources.persona).toEqual({
        kind: "inline",
        text: "memory persona",
      });
      expect(fsTemplate.configuration).not.toHaveProperty("trustTier");
      expect(catalog.get(fsRef)?.scope).toEqual({ kind: "session", sid: "sid-1" });
      expect(catalog.get(memoryRef)?.registrationLifetime).toBe("process");
      expect(resolveTemplateTrust(catalog, fsRef)).toBe("own");
      expect(resolveTemplateTrust(catalog, "tpl_missing")).toBe("imported");
      expect(fsRef).toMatch(/^tpl_[a-f0-9]{32}$/);
      expect(Object.isFrozen(memoryTemplate)).toBe(true);
      expect(Object.isFrozen(memoryTemplate.resources)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("同一 source+entry 注册幂等，不允许模板引用裸路径", () => {
    const catalog = new AgentTemplateCatalog();
    const source = new MemoryTemplateSource({
      sourceId: "source-1",
      templates: {
        tester: {
          definition: { id: "tester" },
          runtimeConfigDefaults: {},
          resources: { skills: [], kits: [], memorySeeds: [] },
        },
      },
    });
    const registration = {
      entryId: "tester",
      source,
      scope: { kind: "session" as const, sid: "sid-1" },
      registrationLifetime: "session" as const,
      trust: "own" as const,
      provenance: { adapter: "test" },
      revisionPolicy: { kind: "immutable" as const },
    };
    expect(catalog.register(registration)).toBe(catalog.register(registration));
    expect(() => catalog.resolve("/tmp/tester" as never)).toThrow(
      "unknown templateRef",
    );
  });

  test("FrozenTemplate 固化 persona/skill/memory 字节，坏 revision 不覆盖 LKG", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-template-snapshot-"));
    try {
      const personaFile = join(root, "persona", "identity.md");
      const skillFile = join(root, "skills", "plan", "SKILL.md");
      const memoryFile = join(root, "memory", "notes.md");
      mkdirSync(join(root, "persona"), { recursive: true });
      mkdirSync(join(root, "skills", "plan"), { recursive: true });
      mkdirSync(join(root, "memory"), { recursive: true });
      writeFileSync(
        join(root, "agent.json"),
        JSON.stringify({ personaFile: "persona/identity.md" }),
      );
      writeFileSync(personaFile, "PERSONA-V1\n");
      writeFileSync(skillFile, "---\nname: plan\n---\nSKILL-V1\n");
      writeFileSync(memoryFile, "MEMORY-V1\n");

      const catalog = new AgentTemplateCatalog();
      const templateRef = catalog.register({
        entryId: "snapshot-agent",
        source: new FileSystemTemplateSource({
          sourceId: "snapshot-test",
          root,
        }),
        scope: { kind: "session", sid: "sid-1" },
        registrationLifetime: "session",
        trust: "own",
        provenance: { adapter: "test" },
        revisionPolicy: { kind: "capability-watch" },
      });

      const v1 = await catalog.resolve(templateRef);
      writeFileSync(personaFile, "PERSONA-V2\n");
      writeFileSync(skillFile, "---\nname: plan\n---\nSKILL-V2\n");
      writeFileSync(memoryFile, "MEMORY-V2\n");
      const v2 = await catalog.resolve(templateRef);

      const v1Composition = await resolveAgentComposition({
        agentId: "snapshot-agent",
        projectRoot: root,
        template: v1,
      });
      const v2Composition = await resolveAgentComposition({
        agentId: "snapshot-agent",
        projectRoot: root,
        template: v2,
      });
      expect(v1Composition.persona).toContain("PERSONA-V1");
      expect(v1Composition.persona).toContain("SKILL-V1");
      expect(v1Composition.persona).toContain("MEMORY-V1");
      expect(v1Composition.persona).not.toContain("V2");
      expect(v2Composition.persona).toContain("PERSONA-V2");
      expect(v2Composition.persona).toContain("SKILL-V2");
      expect(v2Composition.persona).toContain("MEMORY-V2");
      expect(v2.execution.revision).not.toBe(v1.execution.revision);

      rmSync(personaFile);
      await expect(catalog.resolve(templateRef)).rejects.toThrow(
        "configured personaFile is not a readable file",
      );
      expect(
        (
          await resolveAgentComposition({
            agentId: "snapshot-agent",
            projectRoot: root,
            template: v2,
          })
        ).persona,
      ).toContain("PERSONA-V2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
