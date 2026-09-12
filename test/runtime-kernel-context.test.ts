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
      if (req.input.text === "compact lifecycle") {
        for (const phase of ["started", "completed"] as const) {
          yield { kind: "stored-event", payload: {
            type: "compaction.status", ts: Date.now(),
            payload: { id: "compact-1", phase, count: 1, summary: "PRIVATE", durationMs: 12 },
          } };
        }
        yield { kind: "stored-event", payload: {
          type: "compaction.post", ts: Date.now(), payload: { summary: "PRIVATE" },
        } };
      }
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
  test("public compaction lifecycle reaches the session ledger without private content", async () => {
    const pm = getPathManager();
    const session = await initSessionManager(pm).create({
      displayName: "public-compaction",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        mkdirSync(root.root(), { recursive: true });
        writeFileSync(root.agentJson(), JSON.stringify({ id: "root", kernelId: DEFAULT_KERNEL }));
      },
    });
    await session.enqueueAgent("root", {
      source: "user", type: "user_input", payload: { content: "compact lifecycle" },
      to: "root", handoff: "turn", ts: Date.now(),
    });
    const events = await session.getOrCreateLedger("root").readAllEvents();
    const statuses = events.filter((event) => event.type === "compaction.status");
    expect(statuses.map((event) => event.payload?.phase)).toEqual(["started", "completed"]);
    expect(statuses[1]?.payload).toMatchObject({ id: "compact-1", phase: "completed", count: 1, durationMs: 12 });
    expect(JSON.stringify(statuses)).not.toContain("PRIVATE");
  });

  test("configured model windows reach requests without unrelated model configuration", async () => {
    const pm = getPathManager();
    mkdirSync(join(pm.user().modelsFile(), ".."), { recursive: true });
    writeFileSync(pm.user().modelsFile(), JSON.stringify({
      "model-primary": { contextWindow: 512000, maxOutput: 12000, customField: "DO-NOT-FORWARD" },
      "model-child": { contextWindow: 64000 },
      "model-invalid": { contextWindow: -1 },
      "model-fraction": { contextWindow: 123.5 },
      "model-string": { contextWindow: "999999" },
      "model-empty": {},
    }));
    const session = await initSessionManager(pm).create({
      displayName: "model-windows",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        mkdirSync(root.root(), { recursive: true });
        writeFileSync(root.agentJson(), JSON.stringify({ id: "root", kernelId: DEFAULT_KERNEL }));
      },
    });
    await session.enqueueAgent("root", {
      source: "user", type: "user_input", payload: { content: "hello", model: "model-primary" },
      to: "root", handoff: "turn", ts: Date.now(),
    });
    const request = defaultRequests[0]!;
    const windows = 'modelContextWindows' in request ? request.modelContextWindows : undefined;
    expect(windows).toEqual({ "model-primary": 512000, "model-child": 64000 });
    expect(JSON.stringify(windows)).not.toContain("DO-NOT-FORWARD");
  });

  test("resident iteration ceiling reaches each kernel request and follows turn-boundary updates", async () => {
    const pm = getPathManager();
    const session = await initSessionManager(pm).create({
      displayName: "resident-budget",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        mkdirSync(root.root(), { recursive: true });
        writeFileSync(root.agentJson(), JSON.stringify({
          id: "root", kernelId: DEFAULT_KERNEL, maxIterations: 200,
        }));
      },
    });
    const send = () => session.enqueueAgent("root", {
      source: "user", type: "user_input", payload: { content: "hello" },
      to: "root", handoff: "turn", ts: Date.now(),
    });
    await send();
    expect(defaultRequests[0]?.budget.maxTurns).toBe(200);
    expect(defaultRequests[0]).not.toHaveProperty('modelContextWindows');
    const instance = session.tree.resolve("root")!;
    instance.runtimeConfig.stage({
      revision: "budget-update",
      value: { ...instance.runtimeConfig.current().value, maxIterations: 7 },
    });
    await send();
    expect(defaultRequests[1]?.budget.maxTurns).toBe(7);
  });

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

  test("teammate completion continues the recipient kernel and model until the next user selection", async () => {
    const pm = getPathManager();
    const session = await initSessionManager(pm).create({
      displayName: "continuation-route",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        mkdirSync(root.root(), { recursive: true });
        writeFileSync(root.agentJson(), JSON.stringify({
          id: "root", kernelId: DEFAULT_KERNEL, models: { model: ["default-model"] },
        }));
      },
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const baseKernel = recordingKernel(OVERRIDE_KERNEL, overrideRequests);
    registerKernel({ ...baseKernel, async *runTurn(req, signal) {
      if (req.input.text === "delegate work") { entered(); await blocked; }
      yield* baseKernel.runTurn(req, signal);
    } });
    const app = new Hono().route("/api/sessions", createSessionsRouter());
    const response = await app.request(`/api/sessions/${session.sid}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "root", content: "delegate work",
        providerOverride: OVERRIDE_KERNEL, payload: { model: "selected-model" } }),
    });
    expect(response.status).toBe(200);
    const root = session.runtimeTree.findResident("root")!;
    // Hold the user turn so two teammate callbacks must coalesce, matching
    // the reported failure rather than testing only an isolated message.
    await started;
    const firstCallback = session.supervisor.enqueue(root.instanceId, {
      source: "agent", type: "message", payload: { content: "teammate finished", fromAgent: "helper" },
      to: "root", handoff: "turn", durability: "required", ts: Date.now(),
    });
    const secondCallback = session.supervisor.enqueue(root.instanceId, {
      source: "agent", type: "message", payload: { content: "audio finished", fromAgent: "audio" },
      to: "root", handoff: "turn", durability: "required", ts: Date.now(),
    });
    release();
    await Promise.all([firstCallback, secondCallback]);
    expect(defaultRequests).toHaveLength(0);
    expect(overrideRequests).toHaveLength(2);
    expect(overrideRequests[1]?.input.text).toContain("audio finished");
    expect(overrideRequests[1]?.model).toBe("selected-model");
    expect(overrideRequests[1]?.input.text).toContain("teammate finished");

    // Recreate the capability host to exercise persisted WAL recovery rather
    // than relying only on the in-memory selection from the previous turn.
    await session.supervisor.getController(root.instanceId)!.turnExecutor.dispose!();
    await session.supervisor.enqueue(root.instanceId, {
      source: "agent", type: "user_input", payload: { content: "completion after restore" },
      to: "root", handoff: "turn", durability: "required", ts: Date.now(),
    });
    expect(overrideRequests).toHaveLength(3);
    expect(overrideRequests[2]?.model).toBe("selected-model");
    expect(defaultRequests).toHaveLength(0);

    // A subsequent user turn without an override uses the configured default;
    // the old override must not become an immutable session-wide preference.
    await session.supervisor.enqueue(root.instanceId, {
      source: "user", type: "user_input", payload: { content: "use configured route" },
      to: "root", handoff: "turn", durability: "required", ts: Date.now(),
    });
    await session.supervisor.enqueue(root.instanceId, {
      source: "agent", type: "message", payload: { content: "second completion" },
      to: "root", handoff: "turn", durability: "required", ts: Date.now(),
    });
    expect(overrideRequests).toHaveLength(3);
    expect(defaultRequests).toHaveLength(2);
    expect(defaultRequests[1]?.model).toBe("default-model");
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
