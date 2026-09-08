import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentKernel,
  KernelCapabilities,
} from "@forgeax/agent-runtime";
import { composeTurnRequest } from "../src/kernel/compose-turn-request";
import {
  initSessionManager,
  resetSessionManager,
} from "../src/core/session-manager";
import {
  reloadExtensions,
  _resetSnapshotForTests,
} from "../src/extensions/registry";
import {
  getPathManager,
  initPathManager,
  resetPathManager,
} from "../src/fs/path-manager";

let testRoot: string;
const capabilities: KernelCapabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  midTurnInject: false,
  forkExtract: false,
};
const testKernel: AgentKernel = {
  id: "resident-persona-materialization-test",
  capabilities,
  async *runTurn() {},
  openHandle() {
    throw new Error("unused");
  },
  async probe() {
    return { ok: true, kernelId: "resident-persona-materialization-test" };
  },
};

beforeEach(async () => {
  testRoot = mkdtempSync(resolve(tmpdir(), "forgeax-persona-materialization-"));
  resetPathManager();
  await resetSessionManager();
  _resetSnapshotForTests();
  initPathManager({ userRoot: join(testRoot, "user-root") });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  _resetSnapshotForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("extension persona resident materialization", () => {
  test("首次寻址经 templateRef 正式注册为 resident，而不是只创建配置目录", async () => {
    const extensionRoots = {
      builtin: join(testRoot, "extensions", "builtin"),
      user: join(testRoot, "extensions", "user"),
      project: join(testRoot, "extensions", "project"),
    };
    for (const root of Object.values(extensionRoots)) {
      mkdirSync(root, { recursive: true });
    }
    const extensionDir = join(extensionRoots.user, "agent-poly");
    mkdirSync(extensionDir, { recursive: true });
    const personaPath = join(extensionDir, "PERSONA.md");
    const memoryDir = join(extensionDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(personaPath, "# UNIQUE-POLY-PERSONA\n", "utf-8");
    writeFileSync(
      join(memoryDir, "lesson.zh.md"),
      "UNIQUE-POLY-MEMORY-ZH\n",
      "utf-8",
    );
    writeFileSync(
      join(memoryDir, "lesson.en.md"),
      "UNIQUE-POLY-MEMORY-EN\n",
      "utf-8",
    );
    const skillDir = join(extensionRoots.user, "skill-cute");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(
      skillPath,
      "---\nname: cute\ndescription: Cute prompt skill\n---\nUNIQUE-CUTE-SKILL-BODY\n",
      "utf-8",
    );
    writeFileSync(
      join(skillDir, "forgeax-extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.1.0",
        id: "@forgeax-extension/skill-cute",
        kind: "skill",
        displayName: { zh: "cute" },
        provides: {
          skills: [{ id: "cute", entry: "./SKILL.md", trigger: "/cute" }],
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(extensionDir, "forgeax-extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.1.0",
        id: "@forgeax-extension/agent-poly",
        kind: "agent",
        displayName: { zh: "poly" },
        provides: {
          agent: {
            id: "poly",
            role: "modeling",
            card: {
              name: { zh: "Poly" },
              color: "#56B6C2",
              avatar: "P",
            },
            personaFile: "./PERSONA.md",
            memoryDir: "./memory",
            defaultSkills: [
              {
                source: "plugin",
                pluginId: "@forgeax-extension/skill-cute",
                skillId: "cute",
              },
            ],
          },
        },
      }),
      "utf-8",
    );
    await reloadExtensions({ roots: extensionRoots });

    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await sm.create({
      displayName: "extension-persona-materialization",
    });
    expect(session.runtimeTree.findResident("poly")).toBeUndefined();

    const address = await session.ensureResidentAgent("poly");
    const resident = session.runtimeTree.findResident("poly");
    const agentJsonPath = pm.session(session.sid).agent("poly").agentJson();
    const agentJson = JSON.parse(readFileSync(agentJsonPath, "utf-8")) as {
      personaFile?: string;
      trustTier?: string;
      skillSources?: Array<{
        id: string;
        path: string;
        description?: string;
        executor?: string;
      }>;
    };

    expect(address).toBe("poly");
    expect(resident).toBeDefined();
    expect(resident?.lifetime).toBe("resident");
    expect(resident?.state).toBe("idle");
    expect(resident?.parentInstanceId).toBeNull();
    expect(existsSync(agentJsonPath)).toBe(true);
    expect(agentJson.personaFile).toBe(personaPath);
    expect(agentJson.trustTier).toBe("imported");
    expect(agentJson.skillSources).toEqual([
      {
        id: "cute",
        path: skillPath,
        description: "cute",
        executor: "prompt",
      },
    ]);
    expect(session.templateCatalog.get(resident!.templateRef)).toMatchObject({
      templateRef: resident!.templateRef,
      entryId: "poly",
      locator: {
        medium: "filesystem",
        root: realpathSync(pm.session(session.sid).agent("poly").root()),
      },
      scope: { kind: "session", sid: session.sid },
      registrationLifetime: "session",
      trust: "imported",
      provenance: {
        adapter: "resident-scanner",
        externalId: "poly",
      },
    });
    expect(resident?.template.execution.skills).toEqual([
      expect.objectContaining({
        id: "cute",
        source: {
          kind: "inline",
          text: expect.stringContaining("UNIQUE-CUTE-SKILL-BODY"),
          label: "SKILL.md",
        },
        description: "cute",
        executor: "prompt",
      }),
    ]);

    const request = await composeTurnRequest({
      message: "hello",
      agentId: "poly",
      sessionId: session.sid,
      kernel: testKernel,
    });
    const prompt = request.systemPrompt.persona ?? "";
    expect(countOccurrences(prompt, "UNIQUE-POLY-PERSONA")).toBe(1);
    expect(countOccurrences(prompt, "UNIQUE-CUTE-SKILL-BODY")).toBe(1);
    expect(countOccurrences(prompt, "UNIQUE-POLY-MEMORY-ZH")).toBe(1);
    expect(prompt).not.toContain("UNIQUE-POLY-MEMORY-EN");
    expect(
      request.tools?.filter((tool) => tool.name === "skill_cute"),
    ).toHaveLength(0);
    expect(
      (
        await session.supervisor
          .getEventStore(resident!.instanceId)!
          .readAllEvents()
      ).map((event) => event.type),
    ).toEqual(["agent.registered"]);

    await sm.close(session.sid);
  });

  test("旧 resident 在 bootstrap 边界补齐 default skill SourceRef，Turn 不再依赖名字回查", async () => {
    const extensionRoots = {
      builtin: join(testRoot, "extensions", "builtin"),
      user: join(testRoot, "extensions", "user"),
      project: join(testRoot, "extensions", "project"),
    };
    for (const root of Object.values(extensionRoots)) {
      mkdirSync(root, { recursive: true });
    }
    const skillDir = join(extensionRoots.user, "skill-legacy");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "LEGACY-MIGRATED-SKILL\n", "utf-8");
    writeFileSync(
      join(skillDir, "forgeax-extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.1.0",
        id: "@forgeax-extension/skill-legacy",
        kind: "skill",
        displayName: { zh: "legacy-skill" },
        provides: {
          skills: [{
            id: "legacy-skill",
            entry: "./SKILL.md",
            trigger: "/legacy-skill",
          }],
        },
      }),
      "utf-8",
    );
    const agentDir = join(extensionRoots.user, "agent-legacy");
    mkdirSync(agentDir, { recursive: true });
    const personaPath = join(agentDir, "PERSONA.md");
    writeFileSync(personaPath, "LEGACY-RESIDENT-PERSONA\n", "utf-8");
    writeFileSync(
      join(agentDir, "forgeax-extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.1.0",
        id: "@forgeax-extension/agent-legacy",
        kind: "agent",
        displayName: { zh: "legacy" },
        provides: {
          agent: {
            id: "legacy",
            role: "test",
            card: { name: { zh: "Legacy" }, color: "#fff", avatar: "L" },
            personaFile: "./PERSONA.md",
            defaultSkills: [{
              source: "plugin",
              pluginId: "@forgeax-extension/skill-legacy",
              skillId: "legacy-skill",
            }],
          },
        },
      }),
      "utf-8",
    );
    await reloadExtensions({ roots: extensionRoots });

    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await sm.create({
      displayName: "legacy-resident-template-migration",
      prepareResidentDefinitions: (sid) => {
        const resident = pm.session(sid).agent("legacy");
        mkdirSync(resident.root(), { recursive: true });
        writeFileSync(
          resident.agentJson(),
          `${JSON.stringify({
            id: "legacy",
            personaFile: personaPath,
            trustTier: "imported",
          }, null, 2)}\n`,
          "utf-8",
        );
      },
    });
    const resident = session.runtimeTree.findResident("legacy");
    expect(resident?.template.execution.skills).toEqual([
      expect.objectContaining({
        id: "legacy-skill",
        source: {
          kind: "inline",
          text: "LEGACY-MIGRATED-SKILL\n",
          label: "SKILL.md",
        },
        description: "legacy-skill",
        executor: "prompt",
      }),
    ]);
    const persisted = JSON.parse(
      readFileSync(pm.session(session.sid).agent("legacy").agentJson(), "utf-8"),
    ) as { skillSources?: unknown };
    expect(persisted.skillSources).toEqual([
      {
        id: "legacy-skill",
        path: skillPath,
        description: "legacy-skill",
        executor: "prompt",
      },
    ]);

    const request = await composeTurnRequest({
      message: "hello",
      agentId: "legacy",
      sessionId: session.sid,
      kernel: testKernel,
    });
    expect(countOccurrences(
      request.systemPrompt.persona ?? "",
      "LEGACY-MIGRATED-SKILL",
    )).toBe(1);

    await sm.close(session.sid);
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
