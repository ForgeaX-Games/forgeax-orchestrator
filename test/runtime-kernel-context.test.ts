import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerKernel,
  unregisterKernel,
  type AgentKernel,
  type KernelCapabilities,
  type TurnRequest,
} from "@forgeax/agent-runtime";
import { createSessionsRouter } from "../src/api/sessions";
import { createCliRouter } from "../src/api/cli/chat";
import {
  initSessionManager,
  resetSessionManager,
} from "../src/core/session-manager";
import {
  getPathManager,
  initPathManager,
  resetPathManager,
} from "../src/fs/path-manager";

const DEFAULT_KERNEL = "runtime-context-default-test";
const OVERRIDE_KERNEL = "runtime-context-override-test";
const capabilities: KernelCapabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  midTurnInject: false,
  forkExtract: false,
};

let userRoot: string;
let previousKernelImpl: string | undefined;
let previousKernelMode: string | undefined;
let defaultRequests: TurnRequest[];
let overrideRequests: TurnRequest[];

function recordingKernel(id: string, requests: TurnRequest[]): AgentKernel {
  return {
    id,
    capabilities,
    async *runTurn(req) {
      requests.push(structuredClone(req));
      yield {
        kind: "message.delta",
        role: "assistant",
        text: `answer-${requests.length}`,
      };
      yield {
        kind: "turn.usage",
        inputTokens: 1,
        outputTokens: 1,
      };
      yield { kind: "turn.done", reason: "stop" };
    },
    openHandle() {
      return {
        async setPermissionMode() {},
        async setModel() {},
        async interrupt() {},
        async cancel() {},
      };
    },
    async probe() {
      return { ok: true, kernelId: id };
    },
  };
}

beforeEach(async () => {
  userRoot = mkdtempSync(join(tmpdir(), "forgeax-runtime-context-"));
  defaultRequests = [];
  overrideRequests = [];
  previousKernelImpl = process.env.FORGEAX_KERNEL_IMPL;
  previousKernelMode = process.env.FORGEAX_KERNEL;
  process.env.FORGEAX_KERNEL_IMPL = DEFAULT_KERNEL;
  process.env.FORGEAX_KERNEL = "kernel";
  unregisterKernel(DEFAULT_KERNEL);
  unregisterKernel(OVERRIDE_KERNEL);
  registerKernel(recordingKernel(DEFAULT_KERNEL, defaultRequests));
  registerKernel(recordingKernel(OVERRIDE_KERNEL, overrideRequests));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  unregisterKernel(DEFAULT_KERNEL);
  unregisterKernel(OVERRIDE_KERNEL);
  if (previousKernelImpl === undefined) {
    delete process.env.FORGEAX_KERNEL_IMPL;
  } else {
    process.env.FORGEAX_KERNEL_IMPL = previousKernelImpl;
  }
  if (previousKernelMode === undefined) {
    delete process.env.FORGEAX_KERNEL;
  } else {
    process.env.FORGEAX_KERNEL = previousKernelMode;
  }
  rmSync(userRoot, { recursive: true, force: true });
});

describe("runtime kernel context", () => {
  test("persona、skill、Kit plugin/tool/slot 与 command 在默认和覆盖 Kernel 间共享", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await sm.create({
      displayName: "runtime-shared-capabilities",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        const kit = join(root.resourceDir("kits"), "shared");
        mkdirSync(join(root.root(), "persona"), { recursive: true });
        mkdirSync(join(root.root(), "skills", "shared-skill"), {
          recursive: true,
        });
        mkdirSync(join(kit, "tools"), { recursive: true });
        mkdirSync(join(kit, "plugins"), { recursive: true });
        mkdirSync(join(kit, "slots"), { recursive: true });
        writeFileSync(
          root.agentJson(),
          JSON.stringify({ id: "root", kernelId: DEFAULT_KERNEL }) + "\n",
        );
        writeFileSync(
          join(root.root(), "persona", "identity.md"),
          "UNIQUE-SHARED-PERSONA",
        );
        writeFileSync(
          join(root.root(), "skills", "shared-skill", "SKILL.md"),
          "UNIQUE-SHARED-SKILL",
        );
        writeFileSync(
          join(kit, "tools", "echo.ts"),
          `export default {
            description: "shared static tool",
            input_schema: { type: "object", properties: {} },
            async execute() { return "static-ok"; },
          };\n`,
        );
        writeFileSync(
          join(kit, "plugins", "dynamic.ts"),
          `export default function (ctx) {
            const key = "shared-plugin/tools/dynamic";
            return {
              start() {
                ctx.tools.register(key, {
                  name: key,
                  description: "shared plugin tool",
                  input_schema: { type: "object", properties: {} },
                  async execute() { return "plugin-command-ok"; },
                });
              },
              stop() { ctx.tools.release(key); },
            };
          }\n`,
        );
        writeFileSync(
          join(kit, "slots", "stable.ts"),
          `export default function () {
            return {
              name: "shared_stable",
              description: "shared stable slot",
              priority: 20,
              cacheHint: "stable",
              version: 1,
              content: "UNIQUE-SHARED-SLOT",
            };
          }\n`,
        );
      },
    });
    const app = new Hono().route("/api/sessions", createSessionsRouter());

    for (const [content, providerOverride] of [
      ["default kernel", undefined],
      ["override kernel", OVERRIDE_KERNEL],
    ] as const) {
      const response = await app.request(
        `/api/sessions/${session.sid}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "root", content, providerOverride }),
        },
      );
      expect(response.status).toBe(200);
    }
    await waitUntil(
      () => defaultRequests.length === 1 && overrideRequests.length === 1,
    );

    const fromDefault = defaultRequests[0]!;
    const fromOverride = overrideRequests[0]!;
    expect(fromDefault.systemPrompt.persona).toContain(
      "UNIQUE-SHARED-PERSONA",
    );
    expect(fromDefault.systemPrompt.persona).toContain(
      "UNIQUE-SHARED-SKILL",
    );
    expect(fromDefault.systemPrompt.persona).toContain(
      "UNIQUE-SHARED-SLOT",
    );
    // The capability composition is shared, but dynamicSuffix is turn-local:
    // each request carries its own history cursor and must not be byte-for-byte
    // identical across the two independent turns.
    expect(fromDefault.systemPrompt.charter).toBe(
      fromOverride.systemPrompt.charter,
    );
    expect(fromDefault.systemPrompt.persona).toBe(
      fromOverride.systemPrompt.persona,
    );
    expect(fromDefault.systemPrompt.dynamicSuffix).toContain(
      "<subagent_roster>",
    );
    expect(fromOverride.systemPrompt.dynamicSuffix).toContain(
      "<subagent_roster>",
    );
    expect(fromDefault.tools).toEqual(fromOverride.tools);
    expect(fromDefault.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["echo", "dynamic"]),
    );

    const command = await session.enqueueAgent("root", {
      source: "user",
      type: "agent_command",
      payload: { toolName: "shared-plugin/tools/dynamic", args: {} },
      to: "root",
      handoff: "turn",
      ts: Date.now(),
    });
    expect(command.output).toBe("plugin-command-ok");
  });

  test("Kit slots 经唯一 ResolvedAgentComposition 进入稳定与动态 prompt", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await sm.create({
      displayName: "runtime-kit-slots",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        const slots = join(root.resourceDir("kits"), "custom-context", "slots");
        mkdirSync(slots, { recursive: true });
        writeFileSync(
          root.agentJson(),
          JSON.stringify({ id: "root", kernelId: DEFAULT_KERNEL }) + "\n",
        );
        writeFileSync(
          join(slots, "stable.ts"),
          `export default function () {
            return {
              name: "custom_stable",
              description: "stable test slot",
              priority: 20,
              cacheHint: "stable",
              version: 1,
              content: "UNIQUE-RUNTIME-STABLE-SLOT",
            };
          }\n`,
        );
        writeFileSync(
          join(slots, "dynamic.ts"),
          `export default function () {
            return {
              name: "custom_dynamic",
              description: "dynamic test slot",
              priority: 20,
              cacheHint: "dynamic",
              version: 1,
              content: "UNIQUE-RUNTIME-DYNAMIC-SLOT",
            };
          }\n`,
        );
      },
    });
    const app = new Hono().route("/api/sessions", createSessionsRouter());

    const response = await app.request(
      `/api/sessions/${session.sid}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "root", content: "slot smoke" }),
      },
    );
    expect(response.status).toBe(200);
    await waitUntil(() => defaultRequests.length === 1);

    const request = defaultRequests[0]!;
    expect(
      occurrences(request.systemPrompt.persona ?? "", "UNIQUE-RUNTIME-STABLE-SLOT"),
    ).toBe(1);
    expect(
      occurrences(request.systemPrompt.dynamicSuffix ?? "", "UNIQUE-RUNTIME-DYNAMIC-SLOT"),
    ).toBe(1);
    expect(request.systemPrompt.persona).not.toContain(
      "UNIQUE-RUNTIME-DYNAMIC-SLOT",
    );
    expect(request.systemPrompt.dynamicSuffix).not.toContain(
      "UNIQUE-RUNTIME-STABLE-SLOT",
    );
  });

  test("per-turn Kernel override 仍经过 Runtime，并把 pinned model 与前轮上下文交给 Kernel", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await sm.create({
      displayName: "runtime-context",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        mkdirSync(root.root(), { recursive: true });
        writeFileSync(
          root.agentJson(),
          JSON.stringify({
            id: "root",
            kernelId: DEFAULT_KERNEL,
            models: { model: ["model-old"] },
          }) + "\n",
        );
      },
    });
    const resident = session.runtimeTree.findResident("root")!;
    await session.stageRuntimeConfig(resident.instanceId, {
      revision: "cfg_model_next",
      value: { models: { model: ["model-next"] } },
    });
    const app = new Hono()
      .route("/api/sessions", createSessionsRouter())
      .route("/api/cli", createCliRouter());

    const first = await app.request(
      `/api/sessions/${session.sid}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: "root",
          content: "记住口令是 blue-orchid",
          providerOverride: OVERRIDE_KERNEL,
        }),
      },
    );
    expect(first.status).toBe(200);
    const firstAccepted = await first.json() as { msgId?: string };
    await waitUntil(() => overrideRequests.length === 1);

    const second = await app.request(
      `/api/sessions/${session.sid}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: "root",
          content: "上一轮的口令是什么？",
          payload: { kernelId: OVERRIDE_KERNEL },
        }),
      },
    );
    expect(second.status).toBe(200);
    await waitUntil(() => overrideRequests.length === 2);

    expect(defaultRequests).toHaveLength(0);
    expect(overrideRequests[0]?.model).toBe("model-next");
    expect(overrideRequests[1]?.context?.throughTurnId).toBe(
      firstAccepted.msgId,
    );
    const history = overrideRequests[1]?.history ?? [];
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: "记住口令是 blue-orchid",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "answer-1",
      }),
    ]));
    expect(
      history.filter((message) =>
        message.role === "user" &&
        message.content === "上一轮的口令是什么？"
      ),
    ).toHaveLength(0);

    const eventTypes = (await session.getOrCreateLedger("root").readAllEvents())
      .map((event) => event.type);
    expect(eventTypes.filter((type) => type === "inbound_message")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "hook:assistantMessage")).toHaveLength(2);

    const cli = await app.request("/api/cli/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sid,
        agentId: "root",
        message: "再回答一次口令",
        providerOverride: OVERRIDE_KERNEL,
        callId: "cli-runtime-turn",
      }),
    });
    expect(cli.status).toBe(200);
    const sse = await cli.text();
    expect(sse).toContain("event: token");
    expect(sse).toContain("answer-3");
    expect(sse).toContain("event: done");
    expect(overrideRequests).toHaveLength(3);
    expect(overrideRequests[2]?.context?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "记住口令是 blue-orchid",
        }),
      ]),
    );
  });
});

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}
