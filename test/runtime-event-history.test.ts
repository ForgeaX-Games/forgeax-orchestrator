import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/event-bus";
import type { Event } from "../src/core/types";
import type { PathManagerAPI } from "../src/fs/types";
import { recoverAbandonedEphemeralHistories } from "../src/ledger/ephemeral-history-recovery";
import { EventStore } from "../src/ledger/event-store";
import { SessionEventPaths } from "../src/ledger/session-event-paths";
import { replaySessionEvents } from "../src/observatory/ledger-replay";

function store(
  paths: SessionEventPaths,
  ownerInstanceId: string,
  runtimeEpochId: string,
  relativeDir: string,
) {
  const binding = {
    ownerInstanceId,
    runtimeEpochId,
    storeId: `store:${ownerInstanceId}`,
    locator: { relativeDir },
  };
  return new EventStore(binding, paths.resolve(binding.locator));
}

describe("runtime event history", () => {
  test("同一 bus event 投影到多个实例时 eventId 不变，Session replay 只返回一次", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-history-projection-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(
        join(root, "session.json"),
        JSON.stringify({ runtimeEventsRoot: "runtime-events" }),
      );
      const paths = new SessionEventPaths(root);
      const left = store(paths, "resident-left", "epoch-left", "agents/left/events");
      const right = store(paths, "resident-right", "epoch-right", "agents/right/events");
      const bus = new EventBus();
      const event: Event = {
        source: "agent:left",
        type: "message",
        payload: { content: "shared fact" },
        to: "right",
        handoff: "turn" as const,
        ts: 10,
      };
      bus.publish(event, "left");
      left.ledger.append(event, "left");
      right.ledger.append(event, "left");

      const leftEvent = (await left.readAllEvents())[0]!;
      const rightEvent = (await right.readAllEvents())[0]!;
      expect(leftEvent.eventId).toBe(event.eventId);
      expect(rightEvent.eventId).toBe(event.eventId);
      expect(leftEvent.owner).not.toEqual(rightEvent.owner);

      const fakePaths = {
        session: () => ({ root: () => root }),
      } as unknown as PathManagerAPI;
      const replayed = await replaySessionEvents("sid-1", fakePaths);
      expect(replayed.filter((row) => row.eventId === event.eventId)).toHaveLength(1);
      left.dispose();
      right.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("进程重启只封口 abandoned ephemeral history，不恢复 live 节点", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgeax-history-recovery-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(
        join(root, "session.json"),
        JSON.stringify({ runtimeEventsRoot: "runtime-events" }),
      );
      const paths = new SessionEventPaths(root);
      const ephemeral = store(
        paths,
        "eph_abandoned",
        "epoch-old",
        "runtime-events/ephemeral/eph_abandoned",
      );
      await ephemeral.append({
        eventId: "registered-1",
        type: "agent.registered",
        source: "runtime",
        ts: 1,
        agentInstanceId: "eph_abandoned",
        runtimeEpochId: "epoch-old",
        payload: {},
      }, "required");
      await ephemeral.flush();
      ephemeral.dispose();

      expect(
        await recoverAbandonedEphemeralHistories("sid-1", root),
      ).toEqual(["eph_abandoned"]);
      expect(
        await recoverAbandonedEphemeralHistories("sid-1", root),
      ).toEqual([]);

      const recovered = store(
        paths,
        "eph_abandoned",
        "epoch-old",
        "runtime-events/ephemeral/eph_abandoned",
      );
      const events = await recovered.readAllEvents();
      expect(
        events.filter((event) => event.type === "agent.aborted_by_restart"),
      ).toHaveLength(1);
      recovered.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
