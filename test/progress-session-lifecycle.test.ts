import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { getPathManager, initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import { initOrchestrationSeams, resetOrchestrationSeams } from "../src/orchestration-seams";
import type { ProgressObservation, ProgressPolicy } from "../src/runtime/progress-control";

let root: string;
beforeEach(async () => {
  root = mkdtempSync(resolve(tmpdir(), "forgeax-progress-session-"));
  await resetSessionManager();
  resetPathManager();
  resetOrchestrationSeams();
  initPathManager({ userRoot: root });
});
afterEach(async () => {
  await resetSessionManager();
  resetOrchestrationSeams();
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

async function create(policy?: ProgressPolicy) {
  if (policy) initOrchestrationSeams({ progressPolicyProvider: () => policy });
  const paths = getPathManager();
  const manager = initSessionManager(paths);
  const session = await manager.create({ displayName: "progress fixture" });
  await manager.close(session.sid);
  const agent = paths.session(session.sid).agent("root");
  mkdirSync(agent.root(), { recursive: true });
  writeFileSync(agent.agentJson(), "{}\n");
  return { manager, session: await manager.open(session.sid) };
}

const classifier: ProgressPolicy["classify"] = ({ event }) => event.type === "fixture:progress"
  ? event.payload as unknown as ProgressObservation : undefined;

test("Session ledger restores matching evidence and invalidates changed host inputs", async () => {
  let input = "a";
  const { manager, session } = await create({
    phase: "test", classify: classifier, resolveInputFingerprint: () => input,
  });
  session.eventBus.publish({ source: "fixture", type: "fixture:progress", ts: Date.now(), payload: {
    kind: "progress", inputFingerprint: "a",
    evidence: [{ id: "check", digest: "hash", inputFingerprint: "a", artifact: true }],
  } }, "root");
  expect(session.getProgressSnapshot("root")?.validatedEvidence).toHaveLength(1);
  await manager.close(session.sid);
  const same = await manager.open(session.sid);
  expect(same.getProgressSnapshot("root")?.validatedEvidence).toHaveLength(1);
  await manager.close(session.sid);
  input = "b";
  const changed = await manager.open(session.sid);
  expect(changed.getProgressSnapshot("root")?.validatedEvidence).toHaveLength(0);
  expect(changed.getProgressSnapshot("root")?.completedArtifacts).toHaveLength(1);
});

test("paused Session rejects an actual queued command before host execution", async () => {
  const { manager, session } = await create({ phase: "test", noProgressLimit: 1, classify: classifier });
  session.eventBus.publish({ source: "fixture", type: "fixture:progress", ts: Date.now(), payload: { kind: "work" } }, "root");
  await manager.close(session.sid);
  const reopened = await manager.open(session.sid);
  expect(reopened.getProgressSnapshot("root")?.status).toBe("paused");
  await expect(reopened.enqueueAgent("root", {
    type: "agent_command", payload: { command: "test" }, ts: Date.now(),
  })).rejects.toThrow("explicit continue required");
  expect(reopened.getProgressSnapshot("root")?.status).toBe("paused");
  expect((await reopened.continueProgress("root")).snapshot.status).toBe("waiting");
});

test("policy creation failure rejects Session reopen instead of disabling control", async () => {
  const { manager, session } = await create();
  await manager.close(session.sid);
  initOrchestrationSeams({ progressPolicyProvider: () => { throw new Error("policy unavailable"); } });
  await expect(manager.open(session.sid)).rejects.toThrow("policy unavailable");
});

test("missing policy leaves the Session without progress control", async () => {
  const { session } = await create();
  expect(session.getProgressSnapshot("root")).toBeUndefined();
  await expect(session.continueProgress("root")).rejects.toThrow("not enabled");
});

test("duplicate continue does not change an active Session clock", async () => {
  const { session } = await create({ phase: "test", classify: classifier });
  session.eventBus.publish({ source: "fixture", type: "fixture:progress", ts: Date.now(), payload: { kind: "progress" } }, "root");
  const before = session.getProgressSnapshot("root");
  await session.continueProgress("root");
  expect(session.getProgressSnapshot("root")).toEqual(before);
});

test("classifier failures pause instead of leaving control silently disabled", async () => {
  const { session } = await create({ phase: "test", classify: ({ event }) => {
    if (event.type === "fixture:broken") throw new Error("classifier failed");
    return undefined;
  } });
  session.eventBus.publish({ source: "fixture", type: "fixture:broken", ts: Date.now(), payload: {} }, "root");
  expect(session.getProgressSnapshot("root")?.pauseReason).toBe("policy_error");
  await expect(session.enqueueAgent("root", { type: "agent_command", ts: Date.now(), payload: {} }))
    .rejects.toThrow("explicit continue required");
});

test("a pause raised by turnStart also cancels the command path", async () => {
  const { session } = await create({ phase: "test", noProgressLimit: 1,
    classify: ({ event }) => event.type === "hook:turnStart" ? { kind: "work" } : undefined,
  });
  await expect(session.enqueueAgent("root", {
    type: "agent_command", ts: Date.now(), payload: { command: "fixture-must-not-run" },
  })).rejects.toThrow();
  expect(session.getProgressSnapshot("root")?.pauseReason).toBe("no_progress");
});
