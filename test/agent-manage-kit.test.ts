/** agent_manage kit — delegate_to_subagent + list_subagents + roster slot.
 *
 *  Builds a real Session, scaffolds root + a fake teammate "mochi" on disk,
 *  attaches them, then calls the kit's tools straight from their default
 *  exports against root's agentContext. We bypass the plugin registry's
 *  persona resolver by pre-scaffolding the teammate so the existence path
 *  exercises only the bus.emit branch — the auto-scaffold branch is what
 *  the live e2e test in /tmp/forgeax-server.log already validates against
 *  the real marketplace persona pool.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Session } from "../src/core/session";
import type { Event, AgentContext } from "../src/core/types";
import {
  registerKernel,
  unregisterKernel,
  type AgentKernel,
  type KernelCapabilities,
  type TurnRequest,
} from "@forgeax/agent-runtime";
import {
  _resetSnapshotForTests,
  _setSnapshotForTests,
  getExtensionSnapshot,
} from "../src/extensions/registry";

import delegateTool from "../builtin/kits/agent_manage/tools/delegate_to_subagent";
import listTool from "../builtin/kits/agent_manage/tools/list_subagents";
import rosterSlot, { buildRoster } from "../builtin/kits/agent_manage/slots/subagent_roster";
import { createSessionsRouter } from '../src/api/sessions';
import { hostToolSurfaceForAgent, hostToolSpecsForAgent } from '../src/api/lib/host-tools-for-agent';
import { visibleAgentManagementToolsForAgent } from '../src/kits/agent-management-visibility';
import { buildSoulForkComposeInput } from '../src/soul/fork-extract';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-am-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
  _resetSnapshotForTests();
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  _resetSnapshotForTests();
  resetOrchestrationSeams();
  rmSync(userRoot, { recursive: true, force: true });
});

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

async function createSessionWithRootAndTeammate(displayName: string, slug: string, teammate?: string): Promise<Session> {
  const pm = getPathManager();
  const gameDir = pm.user().gameDir(slug);
  mkdirSync(gameDir, { recursive: true });

  const sm = initSessionManager(pm);
  const initial = await sm.create({ displayName });
  const sid = initial.sid;
  await sm.close(sid);

  // root scaffold
  const rootLayer = pm.session(sid).agent("root");
  mkdirSync(rootLayer.root(), { recursive: true });
  writeFileSync(rootLayer.agentJson(), "{}\n", "utf-8");

  // optional teammate scaffold (so tree.get(teammate) is truthy without
  // hitting plugin registry / marketplace persona resolution).
  if (teammate) {
    const tlayer = pm.session(sid).agent(teammate);
    mkdirSync(tlayer.root(), { recursive: true });
    writeFileSync(tlayer.agentJson(), "{}\n", "utf-8");
  }

  return sm.open(sid);
}

async function getRootCtx(session: Session): Promise<AgentContext> {
  const root = await session.initializeAgentHost("root");
  if (!root) throw new Error("root agent failed to attach");
  return root.agentContext;
}

describe("agent_manage kit — delegate_to_subagent", () => {
  test("rejects empty agent argument", async () => {
    const session = await createSessionWithRootAndTeammate("dele-empty", "dg1");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "", message: "hi" }, ctx);
    expect(String(out)).toMatch(/missing 'agent'/);
  });

  test("rejects empty message argument", async () => {
    const session = await createSessionWithRootAndTeammate("dele-empty-msg", "dg2");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "mochi", message: "" }, ctx);
    expect(String(out)).toMatch(/missing 'message'/);
  });

  test("nested runtime address is valid syntax but must resolve to a live Agent", async () => {
    const session = await createSessionWithRootAndTeammate("dele-bad", "dg3");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "foo/bar", message: "hi" }, ctx);
    expect(String(out)).toMatch(/no agent registered/);
  });

  test("rejects self-delegation", async () => {
    const session = await createSessionWithRootAndTeammate("dele-self", "dg4");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "root", message: "hi" }, ctx);
    expect(String(out)).toMatch(/cannot delegate to self/);
  });

  test("rejects unknown agent (no plugin / marketplace match)", async () => {
    const session = await createSessionWithRootAndTeammate("dele-unknown", "dg5");
    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute(
      { agent: "nobody-here-12345", message: "hi" },
      ctx,
    );
    expect(String(out)).toMatch(/no agent registered/);
  });

  test("submits a user_input event to an existing teammate", async () => {
    const session = await createSessionWithRootAndTeammate("dele-ok", "dg6", "mochi");
    const ctx = await getRootCtx(session);

    // This is the message-shape unit test. The real Controller/Kernel delivery
    // and completion callback are covered by the end-to-end test below.
    const routed: Event[] = [];
    const runtime = {
      ...ctx.runtime!,
      sendToAgent: async (_agentAddress: string, input: unknown) => {
        routed.push(input as Event);
      },
    };
    try {
      const out = await delegateTool.execute(
        { agent: "mochi", message: "请帮我写一个故事" },
        { ...ctx, runtime } as AgentContext,
      );
      expect(String(out)).toMatch(/Delegated to mochi/);
      expect(routed).toHaveLength(1);
      const ev = routed[0]!;
      expect(ev.type).toBe("user_input");
      expect(ev.handoff).toBe("turn");
      expect(ev.to).toBe("mochi");
      expect(ev.payload.content).toBe("请帮我写一个故事");
      expect(ev.payload.delegatedBy).toBe("root");
    } finally {
      session.delegations.delete("mochi");
    }
  });

  test('CLI bridge advertises and executes the existing agent-management kit handlers', async () => {
    const session = await createSessionWithRootAndTeammate('cli-delegate', 'dg-cli', 'mochi');
    const ctx = await getRootCtx(session);
    // Desktop kit assets are bundled independently from the host graph. Poison
    // the registry copies to model that packaging boundary: HTTP execution must
    // use the canonical host-graph handlers, not state captured by the asset.
    ctx.tools.register('packaged/list_subagents', {
      ...listTool,
      async execute() {
        throw new Error('packaged registry copy must not execute');
      },
    });
    ctx.tools.register('packaged/delegate_to_subagent', {
      ...delegateTool,
      async execute() {
        throw new Error('SessionManager not initialized — packaged registry copy');
      },
    });
    // This is the exact spec written into the rented-kernel fxt MCP bridge.
    expect(hostToolSpecsForAgent(session.sid, 'root')).toContainEqual(expect.objectContaining({
      name: 'delegate_to_subagent',
      inputSchema: delegateTool.input_schema,
    }));
    expect(hostToolSpecsForAgent(session.sid, 'root')).toContainEqual(expect.objectContaining({
      name: 'list_subagents',
      inputSchema: listTool.input_schema,
    }));

    const routed: Event[] = [];
    const unsub = session.eventBus.observe((entry) => {
      if (entry.to === 'mochi') routed.push(entry);
    });
    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });
    try {
      const app = new Hono().route('/api/sessions', createSessionsRouter());
      const listResponse = await app.request(`/api/sessions/${session.sid}/kernel-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentPath: 'root',
          toolName: 'list_subagents',
          args: {},
        }),
      });
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { ok: boolean; result?: unknown; error?: string };
      expect(listBody.ok).toBe(true);
      expect(String(listBody.result)).toContain('mochi');

      const response = await app.request(`/api/sessions/${session.sid}/kernel-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentPath: 'root',
          toolName: 'delegate_to_subagent',
          args: { agent: 'mochi', message: 'review this through the CLI bridge' },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; result?: unknown; error?: string };
      expect(body.ok).toBe(true);
      expect(String(body.result)).toContain('Delegated to mochi');
      await flushMicrotasks();
      expect(routed.some((entry) => entry.payload.content === 'review this through the CLI bridge')).toBe(true);
    } finally {
      unsub();
    }
  });

  test('HTTP direct agent-management execution requires builtin opt-in', async () => {
    const session = await createSessionWithRootAndTeammate('cli-delegate-opt-in', 'dg-cli-opt-in', 'mochi');
    const app = new Hono().route('/api/sessions', createSessionsRouter());
    initOrchestrationSeams({});

    for (const toolName of ['list_subagents', 'delegate_to_subagent']) {
      const response = await app.request(`/api/sessions/${session.sid}/kernel-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentPath: 'root',
          toolName,
          args: toolName === 'delegate_to_subagent'
            ? { agent: 'mochi', message: 'must not execute' }
            : {},
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: expect.stringMatching(/builtin tool not enabled/i),
      });
    }
  });

  test('does not advertise agent-management tools without a session or readable config', () => {
    const names = ['delegate_to_subagent', 'list_subagents'];
    for (const name of names) {
      expect(hostToolSpecsForAgent(undefined, 'root')).not.toContainEqual(expect.objectContaining({ name }));
      expect(hostToolSpecsForAgent('missing-session', 'root')).not.toContainEqual(expect.objectContaining({ name }));
    }
  });

  test('keeps host and fork visibility fail-closed for missing, unreadable, and malformed config', async () => {
    const session = await createSessionWithRootAndTeammate('visibility-fail-closed', 'dg-visibility-fail-closed');
    const agentJson = getPathManager().session(session.sid).agent('root').agentJson();
    const cases = [
      { name: 'missing', prepare: () => {} },
      { name: 'unreadable', prepare: () => mkdirSync(agentJson) },
      { name: 'malformed JSON', prepare: () => writeFileSync(agentJson, '{\n', 'utf-8') },
      { name: 'malformed kits field', prepare: () => writeFileSync(agentJson, '{"kits": []}\n', 'utf-8') },
    ];

    for (const scenario of cases) {
      rmSync(agentJson, { recursive: true, force: true });
      scenario.prepare();

      const host = hostToolSurfaceForAgent(session.sid, 'root');
      const fork = buildSoulForkComposeInput(
        { sid: session.sid, agentPath: 'root', instanceId: 'root-instance' },
        {} as AgentKernel,
      ).visibleAgentManagementTools;

      expect(host.specs).toEqual([]);
      expect(host.visibleAgentManagementTools).toEqual([]);
      expect(visibleAgentManagementToolsForAgent(session.sid, 'root')).toEqual(host.visibleAgentManagementTools);
      expect(fork).toEqual(host.visibleAgentManagementTools);
    }
  });

  test('matches native kit visibility for whole-kit and tool-level agent_manage disables', async () => {
    const names = ['delegate_to_subagent', 'list_subagents'] as const;
    const session = await createSessionWithRootAndTeammate('cli-delegate-disabled', 'dg-cli-disabled', 'mochi');
    const rootLayer = getPathManager().session(session.sid).agent('root');
    const app = new Hono().route('/api/sessions', createSessionsRouter());
    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });

    for (const scenario of [
      { disable: ['#agent_manage'], hidden: names },
      { disable: ['delegate_to_subagent'], hidden: ['delegate_to_subagent'] },
      { disable: ['agent_manage/tools/list_subagents'], hidden: ['list_subagents'] },
      { disable: ['agent_manage/tools/*'], hidden: names },
    ] as const) {
      writeFileSync(rootLayer.agentJson(), JSON.stringify({ kits: { disable: scenario.disable } }), 'utf-8');
      const hidden = new Set<string>(scenario.hidden);
      const host = hostToolSurfaceForAgent(session.sid, 'root');
      for (const name of names) {
        const advertised = host.specs
          .some((tool) => tool.name === name);
        expect(advertised).toBe(!hidden.has(name));
      }
      expect(buildSoulForkComposeInput(
        { sid: session.sid, agentPath: 'root', instanceId: 'root-instance' },
        {} as AgentKernel,
      ).visibleAgentManagementTools).toEqual(host.visibleAgentManagementTools);

      for (const toolName of scenario.hidden) {
        const response = await app.request(`/api/sessions/${session.sid}/kernel-tool`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentPath: 'root', toolName, args: {} }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: false,
          error: expect.stringMatching(/Unknown tool|not available/i),
        });
      }
    }

    const audit = readFileSync(join(getPathManager().session(session.sid).root(), 'kernel-tool-audit.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; allow: boolean; ok?: boolean });
    for (const name of names) {
      expect(audit).toContainEqual(expect.objectContaining({ tool: name, allow: true, ok: false }));
    }
  });

  test('native REST ingress preserves an explicit null clear', async () => {
    const session = await createSessionWithRootAndTeammate('summon-clear', 'dg-summon-clear');
    const received: Event[] = [];
    const unsub = session.eventBus.observe((entry) => {
      if (entry.type === 'user_input') received.push(entry);
    });
    try {
      const app = new Hono().route('/api/sessions', createSessionsRouter());
      const response = await app.request(`/api/sessions/${session.sid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'clear specialist', to: 'root', payload: { summonAgentId: null } }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { ok: boolean }).ok).toBe(true);
      await flushMicrotasks();
      expect(received.some((entry) => entry.payload.summonAgentId === null)).toBe(true);
    } finally {
      unsub();
    }
  });

  test("newly scaffolded teammate inherits the delegator's selected model", async () => {
    const personaPath = join(userRoot, "mochi-persona.md");
    writeFileSync(personaPath, "# Mochi\n", "utf-8");
    const current = getExtensionSnapshot();
    _setSnapshotForTests({
      ...current,
      kinds: {
        ...current.kinds,
        agents: [{
          extensionId: "@test/mochi",
          origin: "user",
          definition: {
            id: "mochi",
            role: "tester",
            card: { name: { en: "Mochi" }, color: "#fff", avatar: "M" },
            personaFile: "./mochi-persona.md",
            defaultLang: "en",
            multiInstance: false,
          },
          personaPath,
        }],
      },
    });

    const session = await createSessionWithRootAndTeammate("delegate-model", "dg-model");
    const rootLayer = getPathManager().session(session.sid).agent("root");
    writeFileSync(rootLayer.agentJson(), JSON.stringify({ models: { model: ["fable-5"] } }), "utf-8");
    // RuntimeTree freezes each resident's template at session open. Refresh it
    // after changing the fixture so the delegator's in-memory selected model
    // is the same value a real set_agent_models turn would stage.
    await session.reloadRuntime();

    const ctx = await getRootCtx(session);
    const out = await delegateTool.execute({ agent: "mochi", message: "test inheritance" }, ctx);
    expect(String(out)).toMatch(/Delegated to mochi/);
    const teammateConfig = JSON.parse(
      readFileSync(getPathManager().session(session.sid).agent("mochi").agentJson(), "utf-8"),
    ) as { models?: { model?: string[] } };
    expect(teammateConfig.models?.model).toEqual(["fable-5"]);
  });

  test("template delegation explicitly creates first, then sends one request", async () => {
    const session = await createSessionWithRootAndTeammate("dele-template", "dg7");
    const ctx = await getRootCtx(session);
    const calls: Array<{ kind: "create" | "send"; value: unknown }> = [];
    const runtime = {
      ...ctx.runtime!,
      listTemplates: () => [{
        templateRef: "tpl_test_worker",
        entryId: "test-worker",
      }],
      listChildren: () => [],
      createChild: async (templateRef: string) => {
        calls.push({ kind: "create", value: templateRef });
        return { instanceId: "eph_test_worker" };
      },
      sendToAgent: async (instanceId: string, input: unknown) => {
        calls.push({ kind: "send", value: { instanceId, input } });
      },
    };

    const out = await delegateTool.execute(
      {
        templateRef: "tpl_test_worker",
        message: "显式请求",
      },
      { ...ctx, runtime } as AgentContext,
    );

    expect(String(out)).toContain("eph_test_worker");
    expect(calls.map((call) => call.kind)).toEqual(["create", "send"]);
    expect(calls[0]!.value).toBe("tpl_test_worker");
    expect(calls[1]!.value).toEqual(expect.objectContaining({
      instanceId: "eph_test_worker",
      input: expect.objectContaining({
        type: "user_input",
        payload: expect.objectContaining({ content: "显式请求" }),
      }),
    }));
  });

  test("concurrent template delegations reserve at most eight session slots", async () => {
    const session = await createSessionWithRootAndTeammate("dele-concurrent", "dg-concurrent");
    const ctx = await getRootCtx(session);
    let createCalls = 0;
    const releaseCreate: Array<() => void> = [];
    const runtime = {
      ...ctx.runtime!,
      listTemplates: () => [{ templateRef: "tpl_concurrent", entryId: "worker" }],
      listChildren: () => [],
      createChild: async () => {
        const instanceId = `eph_concurrent_${++createCalls}`;
        await new Promise<void>((resolve) => releaseCreate.push(resolve));
        return { instanceId };
      },
      sendToAgent: async () => {},
    };

    const attempts = Array.from({ length: 9 }, (_, i) => delegateTool.execute(
      { templateRef: "tpl_concurrent", message: `concurrent ${i}` },
      { ...ctx, runtime } as AgentContext,
    ));
    const deadline = Date.now() + 1_000;
    while (createCalls < 8) {
      if (Date.now() > deadline) throw new Error(`only ${createCalls} createChild calls reached`);
      await Bun.sleep(1);
    }
    expect(createCalls).toBe(8);
    expect(session.delegations.size).toBe(8);

    for (const release of releaseCreate) release();
    const results = await Promise.all(attempts);
    expect(results.filter((result) => String(result).includes("Delegated to ephemeral child"))).toHaveLength(8);
    expect(results.filter((result) => String(result).includes("too many concurrent delegations"))).toHaveLength(1);
    expect(session.delegations.size).toBe(8);
    session.delegations.clear();
  });

  test("template create failure releases its reservation", async () => {
    const session = await createSessionWithRootAndTeammate("dele-create-fail", "dg-create-fail");
    const ctx = await getRootCtx(session);
    let calls = 0;
    const runtime = {
      ...ctx.runtime!,
      listTemplates: () => [{ templateRef: "tpl_create_fail", entryId: "worker" }],
      listChildren: () => [],
      createChild: async () => {
        calls += 1;
        if (calls === 1) throw new Error("create failed");
        return { instanceId: "eph_after_create_failure" };
      },
      sendToAgent: async () => {},
    };

    await expect(delegateTool.execute(
      { templateRef: "tpl_create_fail", message: "first" },
      { ...ctx, runtime } as AgentContext,
    )).rejects.toThrow("create failed");
    expect(session.delegations.size).toBe(0);
    await expect(delegateTool.execute(
      { templateRef: "tpl_create_fail", message: "second" },
      { ...ctx, runtime } as AgentContext,
    )).resolves.toMatch(/Delegated to ephemeral child/);
    expect(session.delegations.size).toBe(1);
    session.delegations.clear();
  });

  test("delivery rejection rolls back the pending delegation", async () => {
    const session = await createSessionWithRootAndTeammate(
      "dele-rejected",
      "dg8",
      "mochi",
    );
    const ctx = await getRootCtx(session);
    const runtime = {
      ...ctx.runtime!,
      sendToAgent: async () => {
        throw new Error("target rejected delivery");
      },
    };

    await expect(
      delegateTool.execute(
        { agent: "mochi", message: "不会被接受的任务" },
        { ...ctx, runtime } as AgentContext,
      ),
    ).rejects.toThrow("target rejected delivery");
    expect(session.delegations.has("mochi")).toBe(false);
  });

  test("child turn completion relays its result and starts the parent next turn", async () => {
    const kernelId = "delegation-e2e-test";
    const requests: TurnRequest[] = [];
    let childStartedResolve!: () => void;
    let releaseChild!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      childStartedResolve = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const capabilities: KernelCapabilities = {
      streaming: true,
      thinking: false,
      toolCalls: false,
      midTurnInject: false,
      forkExtract: false,
    };
    const kernel: AgentKernel = {
      id: kernelId,
      capabilities,
      async *runTurn(request) {
        requests.push(structuredClone(request));
        if (request.input.text.includes("检查委派闭环")) {
          childStartedResolve();
          await childGate;
          yield {
            kind: "message.delta",
            role: "assistant",
            text: "子 Agent 已完成闭环检查",
          };
        } else {
          yield {
            kind: "message.delta",
            role: "assistant",
            text: "父 Agent 已收到子 Agent 结果",
          };
        }
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
        return { ok: true, kernelId };
      },
    };

    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await sm.create({
        displayName: "delegation-e2e",
        prepareResidentDefinitions: (sid) => {
          const root = pm.session(sid).agent("root");
          mkdirSync(root.root(), { recursive: true });
          writeFileSync(
            root.agentJson(),
            `${JSON.stringify({
              id: "root",
              kernelId,
              models: { model: ["delegation-test-model"] },
            })}\n`,
          );
        },
      });
      const root = session.runtimeTree.findResident("root")!;
      const ctx = await getRootCtx(session);
      const templateRef = session.registerMemoryTemplate({
        sourceId: "test:delegation-e2e",
        entryId: "worker",
        template: {
          definition: { id: "worker", kernelId },
          runtimeConfigDefaults: {
            models: { model: ["delegation-test-model"] },
          },
          resources: {
            skills: [],
            kits: [],
            memorySeeds: [],
          },
        },
      });

      const delegated = delegateTool.execute(
        {
          templateRef,
          message: "检查委派闭环",
        },
        ctx,
      );
      await childStarted;
      const ack = await delegated;
      expect(String(ack)).toContain("Delegated to ephemeral child");

      const [child] = session.runtimeTree.childrenOf(root.instanceId);
      expect(child).toBeDefined();
      expect(session.delegations.has(child!.instanceId)).toBe(true);

      releaseChild();
      const deadline = Date.now() + 2_000;
      while (
        requests.length < 2 ||
        session.runtimeTree.get(child!.instanceId) ||
        session.runtimeTree.get(root.instanceId)?.state !== "idle"
      ) {
        if (Date.now() > deadline) {
          throw new Error("delegation callback did not finish the parent turn");
        }
        await Bun.sleep(5);
      }

      expect(requests).toHaveLength(2);
      expect(requests[0]!.input.text).toContain("检查委派闭环");
      expect(requests[1]!.input.text).toContain("子 Agent 已完成闭环检查");
      expect(session.delegations.has(child!.instanceId)).toBe(false);
      expect(session.runtimeTree.get(child!.instanceId)).toBeUndefined();
      expect(session.runtimeTree.get(root.instanceId)?.state).toBe("idle");
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });

  test("resident teammate completion relays its result and remains available", async () => {
    const kernelId = "resident-delegation-e2e-test";
    const requests: TurnRequest[] = [];
    let teammateStartedResolve!: () => void;
    let releaseTeammate!: () => void;
    const teammateStarted = new Promise<void>((resolve) => {
      teammateStartedResolve = resolve;
    });
    const teammateGate = new Promise<void>((resolve) => {
      releaseTeammate = resolve;
    });
    const kernel: AgentKernel = {
      id: kernelId,
      capabilities: {
        streaming: true,
        thinking: false,
        toolCalls: false,
        midTurnInject: false,
        forkExtract: false,
      },
      async *runTurn(request) {
        requests.push(structuredClone(request));
        if (request.input.text.includes("检查 resident 委派闭环")) {
          teammateStartedResolve();
          await teammateGate;
          yield {
            kind: "message.delta",
            role: "assistant",
            text: "常驻子 Agent 已完成闭环检查",
          };
        } else {
          yield {
            kind: "message.delta",
            role: "assistant",
            text: "父 Agent 已收到常驻子 Agent 结果",
          };
        }
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
        return { ok: true, kernelId };
      },
    };

    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const pm = getPathManager();
      const sm = initSessionManager(pm);
      const session = await sm.create({
        displayName: "resident-delegation-e2e",
        prepareResidentDefinitions: (sid) => {
          for (const agentId of ["root", "mochi"]) {
            const layer = pm.session(sid).agent(agentId);
            mkdirSync(layer.root(), { recursive: true });
            writeFileSync(
              layer.agentJson(),
              `${JSON.stringify({
                id: agentId,
                kernelId,
                models: { model: ["delegation-test-model"] },
              })}\n`,
            );
          }
        },
      });
      const ctx = await getRootCtx(session);
      const root = session.runtimeTree.findResident("root")!;
      const teammate = session.runtimeTree.findResident("mochi")!;

      const delegated = delegateTool.execute(
        {
          agent: "mochi",
          message: "检查 resident 委派闭环",
        },
        ctx,
      );
      await teammateStarted;
      const ack = await delegated;
      expect(String(ack)).toContain("Delegated to mochi");
      expect(session.delegations.has("mochi")).toBe(true);

      releaseTeammate();
      const deadline = Date.now() + 2_000;
      while (
        requests.length < 2 ||
        session.delegations.has("mochi") ||
        session.runtimeTree.get(teammate.instanceId)?.state !== "idle" ||
        session.runtimeTree.get(root.instanceId)?.state !== "idle"
      ) {
        if (Date.now() > deadline) {
          throw new Error("resident delegation callback did not finish");
        }
        await Bun.sleep(5);
      }

      expect(requests).toHaveLength(2);
      expect(requests[0]!.input.text).toContain("检查 resident 委派闭环");
      expect(requests[1]!.input.text).toContain("常驻子 Agent 已完成闭环检查");
      expect(session.runtimeTree.get(teammate.instanceId)).toBe(teammate);
      expect(teammate.lifetime).toBe("resident");
      expect(teammate.state).toBe("idle");
      expect(root.state).toBe("idle");
      await sm.close(session.sid);
    } finally {
      unregisterKernel(kernelId);
    }
  });
});

describe("agent_manage kit — list_subagents", () => {
  test("input_schema is empty object (no args)", () => {
    expect(listTool.input_schema.type).toBe("object");
    expect(listTool.input_schema.properties).toEqual({});
  });

  test("lists active teammate, filters self", async () => {
    const session = await createSessionWithRootAndTeammate("list-ok", "ls1", "mochi");
    const ctx = await getRootCtx(session);
    const out = await listTool.execute({}, ctx);
    const text = String(out);
    // mochi appears (active or spawn-on-demand depending on plugin discovery).
    expect(text.includes("mochi")).toBe(true);
    // root never appears in its own roster.
    expect(text.match(/^- root\b/m)).toBeNull();
  });
});

describe("agent_manage kit — subagent_roster slot", () => {
  test("buildRoster filters self", async () => {
    const session = await createSessionWithRootAndTeammate("roster-self", "rs1", "mochi");
    const ctx = await getRootCtx(session);
    const rows = buildRoster(ctx);
    expect(rows.find((r) => r.id === "root")).toBeUndefined();
  });

  test("buildRoster marks tree-resident teammate as active", async () => {
    const session = await createSessionWithRootAndTeammate("roster-active", "rs2", "mochi");
    const ctx = await getRootCtx(session);
    const rows = buildRoster(ctx);
    const m = rows.find((r) => r.id === "mochi");
    expect(m).toBeDefined();
    expect(m!.active).toBe(true);
  });

  test("slot renders teammate header + delegate hint", async () => {
    const session = await createSessionWithRootAndTeammate("roster-render", "rs3", "mochi");
    const ctx = await getRootCtx(session);
    const slot = rosterSlot(ctx);
    expect(slot.name).toBe("subagent_roster");
    expect(slot.cacheHint).toBe("dynamic");
    const body = typeof slot.content === "function" ? slot.content() : slot.content;
    expect(body).toMatch(/# Teammates/);
    expect(body).toMatch(/delegate_to_subagent/);
    expect(body).toMatch(/mochi/);
  });

  test("slot prints empty placeholder when no teammates exist", async () => {
    // No teammate scaffolded — the only registered plugin agents are
    // whatever the plugin registry resolved at import time. The "active"
    // count from tree-resident agents (excluding root) is 0. Plugin agents
    // may still surface; assert only on the active section being absent.
    const session = await createSessionWithRootAndTeammate("roster-empty", "rs4");
    const ctx = await getRootCtx(session);
    const rows = buildRoster(ctx);
    const activeRows = rows.filter((r) => r.active);
    expect(activeRows.length).toBe(0);
  });
});
