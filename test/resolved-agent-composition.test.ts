import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentComposition } from "../src/agents/resolved-agent-composition";
import type { FrozenAgentTemplate } from "../src/agents/template-types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ResolvedAgentComposition", () => {
  test("live template 是唯一基础来源，template persona/skill/memory 各只组合一次", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "forgeax-composition-"));
    roots.push(projectRoot);
    const template = frozenTemplate("template-only", {
      persona: { kind: "inline", text: "UNIQUE-TEMPLATE-PERSONA" },
      skills: [{
        id: "plan",
        source: {
          kind: "inline",
          text: "---\ndescription: plan\n---\nUNIQUE-TEMPLATE-SKILL",
        },
        description: "plan",
        executor: "prompt",
      }],
      kits: [],
      memorySeeds: [{
        kind: "inline",
        text: "UNIQUE-TEMPLATE-MEMORY",
      }],
    });

    const composition = await resolveAgentComposition({
      agentId: "template-only",
      projectRoot,
      template,
      kitSystemBlocks: [
        {
          name: "stable-kit",
          text: "<stable-kit>UNIQUE-STABLE-KIT-SLOT</stable-kit>",
          cacheHint: "stable",
          priority: 20,
        },
        {
          name: "dynamic-kit",
          text: "<dynamic-kit>UNIQUE-DYNAMIC-KIT-SLOT</dynamic-kit>",
          cacheHint: "dynamic",
          priority: 20,
        },
      ],
    });

    expect(count(composition.persona, "UNIQUE-TEMPLATE-PERSONA")).toBe(1);
    expect(count(composition.persona, "UNIQUE-TEMPLATE-SKILL")).toBe(1);
    expect(count(composition.persona, "UNIQUE-TEMPLATE-MEMORY")).toBe(1);
    expect(count(composition.persona, "UNIQUE-STABLE-KIT-SLOT")).toBe(1);
    expect(count(composition.persona, "UNIQUE-DYNAMIC-KIT-SLOT")).toBe(0);
    expect(count(composition.dynamicPrompt ?? "", "UNIQUE-DYNAMIC-KIT-SLOT")).toBe(1);
    expect(composition.tools).toHaveLength(0);
    expect(composition.persona).toContain(
      "Executable ts/py skill invocation is unavailable in this runtime.",
    );
  });

  test.each([
    [200, 200], [7, 7], [undefined, undefined], [0, undefined],
    [-1, undefined], [1.5, undefined], [NaN, undefined],
    [Infinity, undefined], [Number.MAX_SAFE_INTEGER + 1, undefined],
  ])("maps resident maxIterations %s to kernel maxTurns %s", async (maxIterations, expected) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "forgeax-budget-"));
    roots.push(projectRoot);
    const template = {
      ...frozenTemplate("budget-agent", { skills: [], kits: [], memorySeeds: [] }),
      runtimeConfigDefaults: { maxIterations },
    };
    const composition = await resolveAgentComposition({ agentId: "budget-agent", projectRoot, template });
    expect(composition.budget?.maxTurns).toBe(expected);
    if (expected === undefined) expect(composition.budget).toBeUndefined();
  });

  test("current runtime config overrides the template ceiling", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "forgeax-budget-runtime-"));
    roots.push(projectRoot);
    const template = {
      ...frozenTemplate("budget-agent", { skills: [], kits: [], memorySeeds: [] }),
      runtimeConfigDefaults: { maxIterations: 200 },
    };
    const composition = await resolveAgentComposition({
      agentId: "budget-agent", projectRoot, template,
      runtimeConfig: { maxIterations: 7 },
    });
    expect(composition.budget).toEqual({ maxTurns: 7 });
  });

  test.each([
    [{ maxBudgetUsd: 1.5 }, { maxTurns: 200, maxBudgetUsd: 1.5 }],
    [{ maxTurns: 3, maxBudgetUsd: 1.5 }, { maxTurns: 3, maxBudgetUsd: 1.5 }],
    [{ maxTurns: 0, maxBudgetUsd: 1.5 }, { maxTurns: 200, maxBudgetUsd: 1.5 }],
  ])("native budget overlays only valid declared fields: %j", async (budget, expected) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "forgeax-budget-soul-"));
    roots.push(projectRoot);
    const pack = join(projectRoot, ".forgeax", "souls-imported", "budget-agent");
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({ budget }));
    const template = {
      ...frozenTemplate("budget-agent", { skills: [], kits: [], memorySeeds: [] }),
      runtimeConfigDefaults: { maxIterations: 200 },
    };
    const composition = await resolveAgentComposition({ agentId: "budget-agent", projectRoot, template });
    expect(composition.budget).toEqual(expected);
  });

  test("native soul-pack 仅在真实命中时作为 overlay，保留既有 policy/budget/tools", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "forgeax-composition-soul-"));
    roots.push(projectRoot);
    const pack = join(
      projectRoot,
      ".forgeax",
      "souls-imported",
      "overlay-agent",
    );
    mkdirSync(join(pack, "persona"), { recursive: true });
    mkdirSync(join(pack, "tools"), { recursive: true });
    mkdirSync(join(pack, "memory", "traits"), { recursive: true });
    writeFileSync(
      join(pack, "persona", "identity.md"),
      "UNIQUE-NATIVE-SOUL-PERSONA\n",
      "utf8",
    );
    writeFileSync(
      join(pack, "tools", "native.json"),
      JSON.stringify({
        name: "native_declared_tool",
        description: "native declaration",
        inputSchema: { type: "object" },
      }),
      "utf8",
    );
    writeFileSync(
      join(pack, "memory", "traits", "tone.md"),
      "UNIQUE-NATIVE-SOUL-MEMORY\n",
      "utf8",
    );
    writeFileSync(
      join(pack, "manifest.json"),
      JSON.stringify({
        systemPrompt: { mode: "replace" },
        tools: { deny: ["Bash"] },
        budget: { maxTurns: 3, maxBudgetUsd: 1.5 },
      }),
      "utf8",
    );
    const template = frozenTemplate("overlay-agent", {
      persona: { kind: "inline", text: "UNIQUE-BASE-TEMPLATE-PERSONA" },
      skills: [],
      kits: [],
      memorySeeds: [],
    });

    const composition = await resolveAgentComposition({
      agentId: "overlay-agent",
      projectRoot,
      template,
    });

    expect(count(composition.persona, "UNIQUE-BASE-TEMPLATE-PERSONA")).toBe(1);
    expect(count(composition.persona, "UNIQUE-NATIVE-SOUL-PERSONA")).toBe(1);
    expect(count(composition.persona, "UNIQUE-NATIVE-SOUL-MEMORY")).toBe(1);
    expect(composition.promptMode).toBe("replace");
    expect(composition.toolPolicy).toEqual({ deny: ["Bash"] });
    expect(composition.budget).toEqual({ maxTurns: 3, maxBudgetUsd: 1.5 });
    expect(
      composition.tools.some((tool) => tool.name === "native_declared_tool"),
    ).toBe(true);
  });
});

function frozenTemplate(
  id: string,
  resources: FrozenAgentTemplate["resources"],
): FrozenAgentTemplate {
  return {
    templateRef: `tpl_${id}`,
    definitionRevision: "def_test",
    definition: { id },
    runtimeConfigDefaults: {},
    resources,
    execution: {
      revision: "exec_test",
      ...(resources.persona ? { persona: resources.persona } : {}),
      skills: resources.skills,
      kits: resources.kits,
    },
  };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
