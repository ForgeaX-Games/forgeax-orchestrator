import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { getPathManager, initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager } from "../src/core/session-manager";
import type { Session } from "../src/core/session";
import type { Event } from "../src/core/types";
import {
  initOrchestrationSeams,
  resetOrchestrationSeams,
  type ArtifactResolver,
} from "../src/orchestration-seams";
import type { ArtifactResolvedPayload } from "@forgeax/types/artifact-summary";

let userRoot: string;

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-artifact-lifecycle-"));
  resetPathManager();
  await resetSessionManager();
  resetOrchestrationSeams();
  initPathManager({ userRoot });
});

afterEach(async () => {
  resetOrchestrationSeams();
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  expect(predicate()).toBe(true);
};

async function createSessionWithRoot(displayName: string): Promise<Session> {
  const pm = getPathManager();
  const sm = initSessionManager(pm);
  const created = await sm.create({ displayName });
  await sm.close(created.sid);
  const root = pm.session(created.sid).agent("root");
  mkdirSync(root.root(), { recursive: true });
  writeFileSync(root.agentJson(), "{}\n", "utf-8");
  return sm.open(created.sid);
}

function artifactFor(context: { sid?: string; turnId: string; agentId: string }): ArtifactResolvedPayload {
  const artifactId = `artifact-${context.turnId}`;
  return {
    schemaVersion: 1,
    artifactId,
    turnId: context.turnId,
    resolution: {
      kind: "summary",
      summary: {
        id: artifactId,
        sid: context.sid ?? "",
        turnId: context.turnId,
        files: [{ path: "src/changed.ts", change: "edit", insertions: 1, deletions: 0 }],
        status: "complete",
        agents: [context.agentId],
      },
    },
  };
}

function publish(session: Session, type: string, payload: Record<string, unknown>, ts = Date.now()): void {
  const event: Event = {
    type,
    source: "agent:root",
    payload,
    ts,
  };
  session.eventBus.publish(event, "root");
}

describe("host-owned artifact lifecycle", () => {
  test("settles once, appends before broadcasting, and ignores duplicate turn-end", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const artifactEvents: Event[] = [];
    const resolver: ArtifactResolver = {
      async resolveTurn(context) {
        contexts.push({ ...context });
        return artifactFor(context);
      },
    };
    initOrchestrationSeams({ artifactResolver: resolver });

    const session = await createSessionWithRoot("artifact-live");
    const dispose = session.eventBus.observe((event, emitterId) => {
      if (event.type === "artifact:resolved" && emitterId === "root") artifactEvents.push(event);
    });
    const startedAt = Date.now();
    publish(session, "hook:turnStart", {
      turnId: "turn-live",
      msgId: "msg-live",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt);
    publish(session, "hook:toolCall", {
      turnId: "turn-live",
      name: "write_file",
      callId: "write-1",
      args: { file_path: "src/changed.ts" },
    }, startedAt + 5);
    publish(session, "hook:turnEnd", {
      turnId: "turn-live",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 25);

    await waitFor(() => contexts.length === 1 && artifactEvents.length === 1);
    publish(session, "hook:turnEnd", {
      turnId: "turn-live",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 30);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      sid: session.sid,
      agentId: "root",
      turnId: "turn-live",
      checkpointMsgId: "msg-live",
      startedAt,
      settledAt: startedAt + 25,
    });
    expect(artifactEvents).toHaveLength(1);
    const ledger = session.getOrCreateLedger("root");
    const persisted = await ledger.readAllEvents();
    const resolved = persisted.filter((event) => event.type === "artifact:resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload?.artifactId).toBe("artifact-turn-live");

    dispose();
    await resetSessionManager();
  });

  test("keeps a turn waiting for the matching Ask result and ignores unrelated results", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    initOrchestrationSeams({
      artifactResolver: {
        async resolveTurn(context) {
          contexts.push({ ...context });
          return artifactFor(context);
        },
      },
    });
    const session = await createSessionWithRoot("artifact-ask");
    const startedAt = Date.now();
    publish(session, "hook:turnStart", {
      turnId: "turn-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt);
    publish(session, "hook:toolCall", {
      turnId: "turn-ask",
      name: "AskUserQuestion",
      callId: "ask-1",
      args: { questions: [{ question: "Pick one" }] },
    }, startedAt + 5);
    // A result for another tool must not clear the Ask wait.
    publish(session, "hook:toolResult", {
      turnId: "turn-ask",
      name: "read_file",
      callId: "read-1",
      ok: true,
      result: "contents",
    }, startedAt + 10);
    publish(session, "hook:turnEnd", {
      turnId: "turn-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 15);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    expect(contexts).toHaveLength(0);

    publish(session, "hook:toolResult", {
      turnId: "turn-ask",
      name: "AskUserQuestion",
      callId: "ask-1",
      ok: true,
      result: { ok: true, questions: [{ questionId: "q1", values: ["A"] }] },
    }, startedAt + 20);
    publish(session, "hook:turnEnd", {
      turnId: "turn-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 30);

    await waitFor(() => contexts.length === 1);
    expect(contexts[0]).toMatchObject({ turnId: "turn-ask", settledAt: startedAt + 30 });
    await resetSessionManager();
  });

  test("settles a CLI permission Ask from its provenance and clears an aborted wait", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    initOrchestrationSeams({
      artifactResolver: {
        async resolveTurn(context) {
          contexts.push({ ...context });
          return artifactFor(context);
        },
      },
    });
    const session = await createSessionWithRoot("artifact-cli-ask");
    const startedAt = Date.now();

    publish(session, "hook:turnStart", {
      turnId: "turn-cli-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt);
    publish(session, "hook:toolCall", {
      turnId: "turn-cli-ask",
      name: "ask_user",
      callId: "cli-ask-1",
      permissionPrompt: true,
      args: { questions: [{ question: "Pick one" }] },
    }, startedAt + 5);
    publish(session, "hook:turnEnd", {
      turnId: "turn-cli-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 10);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    expect(contexts).toHaveLength(0);

    // the reference agent CLI's permission bridge returns a sentence, not the native
    // structured ask_user result. The explicit provenance marker makes this
    // a resolved interaction without parsing provider prose.
    publish(session, "hook:toolResult", {
      turnId: "turn-cli-ask",
      name: "ask_user",
      callId: "cli-ask-1",
      permissionPrompt: true,
      ok: true,
      result: 'Your questions have been answered: "Pick one"="A"',
    }, startedAt + 15);
    publish(session, "hook:turnEnd", {
      turnId: "turn-cli-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 20);
    await waitFor(() => contexts.length === 1);

    publish(session, "hook:turnStart", {
      turnId: "turn-aborted-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 30);
    publish(session, "hook:toolCall", {
      turnId: "turn-aborted-ask",
      name: "AskUserQuestion",
      callId: "aborted-ask-1",
      args: { questions: [{ question: "Pick another" }] },
    }, startedAt + 35);
    publish(session, "hook:turnEnd", {
      turnId: "turn-aborted-ask",
      artifactResolutionExpected: true,
      schemaVersion: 2,
      aborted: true,
    }, startedAt + 40);
    await waitFor(() => contexts.length === 2);

    // A stale unresolved call from the aborted turn must not block the next
    // turn for the same agent.
    publish(session, "hook:turnStart", {
      turnId: "turn-after-abort",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 50);
    publish(session, "hook:turnEnd", {
      turnId: "turn-after-abort",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 60);
    await waitFor(() => contexts.length === 3);
    expect(contexts.map((context) => context.turnId)).toEqual([
      "turn-cli-ask",
      "turn-aborted-ask",
      "turn-after-abort",
    ]);
    await resetSessionManager();
  });

  test("reconciles an unresolved terminal turn after reopen but skips an Ask checkpoint", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    initOrchestrationSeams({
      artifactResolver: {
        async resolveTurn(context) {
          contexts.push({ ...context });
          return artifactFor(context);
        },
      },
    });
    const session = await createSessionWithRoot("artifact-recovery");
    const sid = session.sid;
    const ledger = session.getOrCreateLedger("root");
    const startedAt = Date.now();
    const append = (type: string, payload: Record<string, unknown>, ts: number) => {
      ledger.append({ type, source: "agent:root", payload, ts } as Event, "root", { turnId: "turn-recovery" });
    };
    append("hook:turnStart", {
      turnId: "turn-recovery",
      msgId: "msg-recovery",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt);
    append("hook:turnEnd", {
      turnId: "turn-recovery",
      artifactResolutionExpected: true,
      schemaVersion: 2,
    }, startedAt + 20);
    await resetSessionManager();

    const recovered = await createReopenedSession(sid);
    await waitFor(() => contexts.length === 1);
    const recoveredEvents = await recovered.getOrCreateLedger("root").readAllEvents();
    expect(recoveredEvents.filter((event) => event.type === "artifact:resolved")).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ sid, turnId: "turn-recovery", checkpointMsgId: "msg-recovery" });
    await resetSessionManager();

    // Recreate a second session with only an Ask interaction checkpoint. The
    // startup scan must preserve the waiting state and not invent an artifact.
    resetOrchestrationSeams();
    const waitingContexts: Array<Record<string, unknown>> = [];
    initOrchestrationSeams({
      artifactResolver: {
        async resolveTurn(context) {
          waitingContexts.push({ ...context });
          return artifactFor(context);
        },
      },
    });
    const waiting = await createSessionWithRoot("artifact-recovery-waiting");
    const waitingLedger = waiting.getOrCreateLedger("root");
    const waitingTs = Date.now();
    waitingLedger.append({
      type: "hook:turnStart",
      source: "agent:root",
      ts: waitingTs,
      payload: { turnId: "turn-waiting", artifactResolutionExpected: true, schemaVersion: 2 },
    } as Event, "root", { turnId: "turn-waiting" });
    waitingLedger.append({
      type: "hook:toolCall",
      source: "agent:root",
      ts: waitingTs + 2,
      payload: { turnId: "turn-waiting", name: "ask_user", callId: "ask-waiting", args: {} },
    } as Event, "root", { turnId: "turn-waiting" });
    waitingLedger.append({
      type: "hook:turnEnd",
      source: "agent:root",
      ts: waitingTs + 4,
      payload: { turnId: "turn-waiting", artifactResolutionExpected: true, waitingForInput: true, schemaVersion: 2 },
    } as Event, "root", { turnId: "turn-waiting" });
    await resetSessionManager();

    const reopenedWaiting = await createReopenedSession(waiting.sid);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 40));
    expect(waitingContexts).toHaveLength(0);
    await resetSessionManager();
    void reopenedWaiting;
  });
});

async function createReopenedSession(sid: string): Promise<Session> {
  const sm = initSessionManager(getPathManager());
  return sm.open(sid);
}
