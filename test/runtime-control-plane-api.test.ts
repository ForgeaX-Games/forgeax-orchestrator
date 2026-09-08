import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initSessionManager,
  resetSessionManager,
} from "../src/core/session-manager";
import {
  getPathManager,
  initPathManager,
  resetPathManager,
} from "../src/fs/path-manager";
import { createSessionsRouter } from "../src/api/sessions";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(join(tmpdir(), "forgeax-runtime-api-"));
  resetPathManager();
  await resetSessionManager();
  initPathManager({ userRoot });
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

describe("runtime control plane API", () => {
  test("创建 ephemeral 不启动 turn；显式消息完成后只保留历史", async () => {
    const pm = getPathManager();
    const sm = initSessionManager(pm);
    const session = await sm.create({
      displayName: "runtime-api",
      prepareResidentDefinitions: (sid) => {
        const root = pm.session(sid).agent("root");
        mkdirSync(root.root(), { recursive: true });
        writeFileSync(root.agentJson(), JSON.stringify({ id: "root" }) + "\n");
      },
    });
    const resident = session.runtimeTree.findResident("root")!;
    const app = new Hono().route("/api/sessions", createSessionsRouter());

    const treeResponse = await app.request(
      `/api/sessions/${session.sid}/runtime-tree`,
    );
    expect(treeResponse.status).toBe(200);
    const initialTree = await treeResponse.json() as {
      agents: Array<{ instanceId: string; lifetime: string }>;
    };
    expect(initialTree.agents).toEqual([
      expect.objectContaining({
        instanceId: resident.instanceId,
        lifetime: "resident",
      }),
    ]);

    const registerResponse = await app.request(
      `/api/sessions/${session.sid}/agent-templates`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          medium: "memory",
          sourceId: "test:runtime-api",
          entryId: "cute-worker",
          template: {
            definition: { id: "cute-worker", displayName: "Cute Worker" },
            runtimeConfigDefaults: {},
            resources: { skills: [], kits: [], memorySeeds: [] },
          },
        }),
      },
    );
    expect(registerResponse.status).toBe(200);
    const registered = await registerResponse.json() as { templateRef: string };
    expect(registered.templateRef.startsWith("tpl_")).toBe(true);

    const rawPathSpawn = await app.request(
      `/api/sessions/${session.sid}/ephemeral-agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: userRoot, input: "forbidden raw path" }),
      },
    );
    expect(rawPathSpawn.status).toBe(400);

    const implicitInput = await app.request(
      `/api/sessions/${session.sid}/ephemeral-agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateRef: registered.templateRef,
          input: "must not be accepted by create",
        }),
      },
    );
    expect(implicitInput.status).toBe(400);
    expect(await implicitInput.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("does not accept input"),
    }));

    const spawnResponse = await app.request(
      `/api/sessions/${session.sid}/ephemeral-agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateRef: registered.templateRef,
          parentInstanceId: resident.instanceId,
          runtimeConfigPatch: { timezone: "Asia/Hong_Kong" },
        }),
      },
    );
    expect(spawnResponse.status).toBe(202);
    const spawned = await spawnResponse.json() as { instanceId: string };
    expect(spawned.instanceId.startsWith("eph_")).toBe(true);
    expect(session.runtimeTree.get(spawned.instanceId)?.state).toBe("idle");
    const createdStore = session.supervisor.getEventStore(spawned.instanceId)!;
    expect((await createdStore.readAllEvents()).map((event) => event.type)).toEqual([
      "agent.registered",
    ]);
    await Bun.sleep(5);
    expect(session.runtimeTree.get(spawned.instanceId)?.state).toBe("idle");

    const messageResponse = await app.request(
      `/api/sessions/${session.sid}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: spawned.instanceId,
          type: "agent_command",
          content: "run list_subagents",
          payload: { toolName: "list_subagents", args: {} },
        }),
      },
    );
    expect(messageResponse.status).toBe(200);

    await waitUntil(() => !session.runtimeTree.get(spawned.instanceId));
    expect(session.runtimeTree.list().map((agent) => agent.instanceId)).toEqual([
      resident.instanceId,
    ]);
    expect(
      existsSync(join(
        session.paths.root(),
        "runtime-state",
        "agents",
        spawned.instanceId,
      )),
    ).toBe(false);

    const historyFile = join(
      session.paths.root(),
      "runtime-events",
      "ephemeral",
      spawned.instanceId,
      "events-1.jsonl",
    );
    expect(existsSync(historyFile)).toBe(true);
    const historyEvents = readFileSync(historyFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        payload?: { llmMessage?: { content?: unknown } };
      });
    const eventTypes = historyEvents.map((event) => event.type);
    expect(eventTypes.filter((type) => type === "hook:turnStart")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "hook:turnEnd")).toHaveLength(1);
    expect(eventTypes).toContain("agent.registered");
    expect(eventTypes).toContain("agent_command");
    expect(eventTypes).toContain("inbound_message");
    expect(JSON.stringify(
      historyEvents.find((event) => event.type === "inbound_message")?.payload?.llmMessage,
    )).toContain("list_subagents");
    expect(eventTypes).toContain("agent.completed");
    expect(eventTypes).toContain("agent.disposed");
  });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(10);
  }
}
