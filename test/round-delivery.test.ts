import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoundDeliveryEnricher,
  type RoundDeliverySession,
} from "../src/checkpoint/round-delivery";
import { SnapshotStore } from "../src/checkpoint/snapshot-store";
import type { StoredEvent } from "../src/ledger/types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RoundDeliveryEnricher", () => {
  it("reports a positive base-to-current +2/-0 edit and is stable on retry", async () => {
    const fixture = await makeFixture("one\n");
    const file = join(fixture.gameDir, "src", "main.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "one\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "one\ntwo\nthree\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(
      toolEvent(110, "Edit", { file_path: file }),
      {
        type: "hook:turnEnd",
        ts: 120,
        source: "agent:forge",
        emitterId: "forge",
        payload: { usage: { costUsd: 0.25 } },
      },
    );

    const enricher = fixture.enricher();
    const first = await enricher.enrich(
      { outcome: "implemented" },
      fixture.context,
    );
    const second = await enricher.enrich(
      { outcome: "implemented" },
      fixture.context,
    );

    expect(first.files).toEqual([
      {
        path: "src/main.ts",
        change: "edit",
        insertions: 2,
        deletions: 0,
        binary: false,
      },
    ]);
    expect(first.meta.unattributedCount).toBe(0);
    expect(first.meta.durationMs).toBe(10);
    expect(first.meta.agents).toEqual(["forge"]);
    expect(first.meta.costUsd).toBe(0.25);
    expect(first).toEqual(second);
  });

  it("maps new and deleted files in the forward direction", async () => {
    const fixture = await makeFixture("old\n");
    const oldFile = join(fixture.gameDir, "old.txt");
    const newFile = join(fixture.gameDir, "new.txt");
    await writeFile(oldFile, "old\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await rm(oldFile);
    await writeFile(newFile, "new\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(
      toolEvent(110, "Write", { file_path: newFile }),
      toolEvent(111, "delete_file", { path: oldFile }),
    );

    const summary = await fixture.enricher().enrich(
      { outcome: "replaced" },
      fixture.context,
    );

    expect(summary.files.map((file) => [file.path, file.change])).toEqual([
      ["old.txt", "del"],
      ["new.txt", "new"],
    ]);
  });

  it("excludes a human-only disk edit and counts it as unattributed", async () => {
    const fixture = await makeFixture("base\n");
    const agentFile = join(fixture.gameDir, "agent.ts");
    const humanFile = join(fixture.gameDir, "human.ts");
    await writeFile(agentFile, "base\n");
    await writeFile(humanFile, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(agentFile, "agent\n");
    await writeFile(humanFile, "human\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(toolEvent(110, "Edit", { file_path: agentFile }));

    const summary = await fixture.enricher().enrich(
      { outcome: "edited" },
      fixture.context,
    );

    expect(summary.files.map((file) => file.path)).toEqual(["agent.ts"]);
    expect(summary.meta.unattributedCount).toBe(1);
  });

  it("attributes a project-root-relative tool path, the form kernels actually send", async () => {
    // Every kernel runs with cwd = the project root, so the model's file_path is
    // project-root relative — in production `.forgeax/games/<slug>/src/x.ts`,
    // here `game/src/main.ts`. Resolving it against gameDir double-prefixed the
    // slug and the intersection with the disk diff came back empty.
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "main.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "one\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "one\ntwo\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(toolEvent(110, "Edit", { file_path: "game/src/main.ts" }));

    const summary = await fixture.enricher().enrich({ outcome: "edited" }, fixture.context);

    expect(summary.files.map((f) => f.path)).toEqual(["src/main.ts"]);
    expect(summary.meta.unattributedCount).toBe(0);
  });

  it("counts a single-line new file as +1, not +2", async () => {
    // A trailing newline terminates the last line; counting it as its own line
    // inflated every added/deleted file by one.
    const fixture = await makeFixture("base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    const file = join(fixture.gameDir, "note.md");
    await writeFile(file, "round3 ok\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(toolEvent(110, "Write", { file_path: "game/note.md" }));

    const summary = await fixture.enricher().enrich({ outcome: "wrote" }, fixture.context);

    expect(summary.files).toEqual([
      { path: "note.md", change: "new", insertions: 1, deletions: 0, binary: false },
    ]);
  });

  it("leaves a tool write that landed outside the game unattributed", async () => {
    // `src/note.md` resolves under the project root, not the game — a real
    // change, but not a game deliverable, so it must not borrow the game's
    // same-named file from the disk diff.
    const fixture = await makeFixture("base\n");
    const gameFile = join(fixture.gameDir, "src", "note.md");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(gameFile, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(gameFile, "human edit\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(toolEvent(110, "Write", { file_path: "src/note.md" }));

    const summary = await fixture.enricher().enrich({ outcome: "wrote" }, fixture.context);

    expect(summary.files).toEqual([]);
    expect(summary.meta.unattributedCount).toBe(1);
  });

  it("fails soft when the session has no checkpoint anchor", async () => {
    const fixture = await makeFixture("base\n");
    const summary = await fixture.enricher().enrich(
      { outcome: "no anchor" },
      fixture.context,
    );

    expect(summary.files).toEqual([]);
    expect(summary.meta).toEqual({
      durationMs: 0,
      agents: [],
      derivedUnavailable: true,
      unattributedCount: 0,
    });
  });

  it("fails soft when taking the current snapshot fails", async () => {
    const fixture = await makeFixture("base\n");
    await fixture.anchor("manifest-that-does-not-exist");
    const summary = await new RoundDeliveryEnricher({
      resolveSession: async () => fixture.session,
      resolveGame: () => ({
        gameDir: fixture.gameDir,
        store: {
          loadManifest: () => ({ id: "base", ts: 0, files: {} }),
          diffSince: async () => {
            throw new Error("disk snapshot failed");
          },
        } as unknown as SnapshotStore,
      }),
      now: () => 200,
    }).enrich({ outcome: "snapshot failed" }, fixture.context);

    expect(summary.files).toEqual([]);
    expect(summary.meta.derivedUnavailable).toBe(true);
  });

  it("derives a stable independent artifact only for a marked final settle", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "main.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "base\nchanged\n");
    await fixture.protocolAnchor(base.id);
    fixture.ledger.events.push({
      type: "hook:toolCall",
      ts: 110,
      source: "agent:forge",
      emitterId: "forge",
      history: { eventId: "call-1", turnId: "turn-1" },
      payload: { name: "Edit", args: { file_path: file } },
    });
    fixture.ledger.events.push({
      type: "hook:toolResult",
      ts: 115,
      source: "agent:forge",
      emitterId: "forge",
      history: { eventId: "result-1", turnId: "turn-1" },
      payload: {
        name: "deliver_summary",
        result: {
          ok: true,
          summary: {
            outcome: "Implemented the requested change",
            tests: [{ name: "unit", pass: true }],
            next: ["Run the browser check"],
            build: "v1",
            files: [],
            meta: { durationMs: 1, agents: ["forge"] },
          },
        },
      },
    });

    const context = {
      ...fixture.context,
      turnId: "turn-1",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    };
    const first = await fixture.enricher().resolveTurn(context);
    const second = await fixture.enricher().resolveTurn(context);

    expect(first.resolution.kind).toBe("summary");
    if (first.resolution.kind === "summary") {
      expect(first.resolution.summary.files.map((entry) => entry.path)).toEqual(["src/main.ts"]);
      expect(first.resolution.summary.status).toBe("complete");
      expect(first.resolution.summary.semantic).toEqual({
        outcome: "Implemented the requested change",
        tests: [{ name: "unit", pass: true }],
        next: ["Run the browser check"],
        build: "v1",
      });
    }
    expect(first.artifactId).toBe(second.artifactId);
    expect(second).toEqual(first);
  });

  it("reports touched files as unavailable when the final checkpoint manifest is missing", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "missing-manifest.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "written after checkpoint failure\n");
    await fixture.protocolAnchor(null);
    fixture.ledger.events.push(toolEvent(110, "Write", { file_path: file }));

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "missing-manifest-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("unavailable");
    if (result.resolution.kind === "unavailable") {
      expect(result.resolution.reason).toContain("manifest");
      expect(result.resolution.reliableCandidatePaths).toEqual(["src/missing-manifest.ts"]);
      expect(result.resolution.summary?.files).toEqual([]);
      expect(result.resolution.summary?.status).toBe("unavailable");
    }
  });

  it("returns no_change for a legacy checkpoint instead of guessing an artifact", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "main.ts");
    await writeFile(file, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "changed\n");
    await fixture.anchor(base.id);
    fixture.ledger.events.push(toolEvent(110, "Edit", { file_path: file }));

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "legacy-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });
    expect(result.resolution).toEqual({ kind: "no_change" });
  });

  it("attributes an opaque tool through a host-owned manifest delta", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "opaque.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "opaque\n");
    await fixture.protocolAnchor(base.id);
    fixture.ledger.events.push({
      type: "hook:toolResult",
      ts: 115,
      source: "agent:forge",
      emitterId: "forge",
      history: { eventId: "opaque-result", turnId: "opaque-turn" },
      payload: {
        name: "shell",
        hostOwned: true,
        fileManifest: [{ path: "game/src/opaque.ts", change: "edit" }],
      },
    });

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "opaque-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("summary");
    if (result.resolution.kind === "summary") {
      expect(result.resolution.summary.files.map((entry) => entry.path)).toEqual(["src/opaque.ts"]);
      expect(result.resolution.summary.status).toBe("complete");
    }
  });

  it("does not trust a model-only manifest claim", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "untrusted.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "model claim\n");
    await fixture.protocolAnchor(base.id);
    fixture.ledger.events.push({
      type: "hook:toolResult",
      ts: 115,
      source: "agent:forge",
      emitterId: "forge",
      history: { eventId: "untrusted-result", turnId: "untrusted-turn" },
      payload: {
        name: "shell",
        fileManifest: ["game/src/untrusted.ts"],
      },
    });

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "untrusted-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("unavailable");
    if (result.resolution.kind === "unavailable") {
      expect(result.resolution.reason).toContain("attributed");
      expect(result.resolution.reliableCandidatePaths).toEqual([]);
    }
  });

  it("uses file-activity as the attribution source when a CLI turn has no tool WAL", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "cli.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "agent\n");
    await fixture.protocolAnchor(base.id);
    fixture.activity.push({
      ts: 110,
      agentPath: "forge",
      op: "write",
      path: file,
      turnId: "cli-turn",
      hash: sha256("agent\n"),
    });

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "cli-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("summary");
    if (result.resolution.kind === "summary") {
      expect(result.resolution.summary.files.map((entry) => entry.path)).toEqual(["src/cli.ts"]);
      expect(result.resolution.summary.status).toBe("complete");
    }
  });

  it("creates an artifact for a confirmed project file outside the active game", async () => {
    const fixture = await makeFixture("base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await fixture.protocolAnchor(base.id);
    const docsDir = join(fixture.context.projectRoot, "docs");
    const file = join(docsDir, "validation.md");
    await mkdir(docsDir, { recursive: true });
    await writeFile(file, "validated\n");
    fixture.activity.push({
      ts: 110,
      agentPath: "forge",
      op: "write",
      path: file,
      isCreate: true,
      turnId: "project-file-turn",
      hash: sha256("validated\n"),
    });

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "project-file-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("summary");
    if (result.resolution.kind === "summary") {
      expect(result.resolution.summary.files).toEqual([
        { path: "docs/validation.md", change: "new", insertions: 0, deletions: 0, binary: false },
      ]);
      expect(result.resolution.summary.status).toBe("complete");
    }
  });

  it("reports an external project rename as a deletion plus a creation", async () => {
    const fixture = await makeFixture("base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await fixture.protocolAnchor(base.id);
    const docsDir = join(fixture.context.projectRoot, "docs");
    const oldFile = join(docsDir, "before.md");
    const newFile = join(docsDir, "after.md");
    await mkdir(docsDir, { recursive: true });
    await writeFile(newFile, "renamed\n");
    fixture.activity.push({
      ts: 110,
      agentPath: "forge",
      op: "rename",
      path: newFile,
      fromPath: oldFile,
      isCreate: true,
      turnId: "project-rename-turn",
      hash: sha256("renamed\n"),
    });

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "project-rename-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("summary");
    if (result.resolution.kind === "summary") {
      expect(result.resolution.summary.files).toEqual([
        { path: "docs/after.md", change: "new", insertions: 0, deletions: 0, binary: false },
        { path: "docs/before.md", change: "del", insertions: 0, deletions: 0, binary: false },
      ]);
    }
  });

  it("ignores an external CLI mutation intent that never reached an applied result", async () => {
    const fixture = await makeFixture("base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await fixture.protocolAnchor(base.id);
    const file = join(fixture.context.projectRoot, "docs", "failed.md");
    fixture.activity.push({
      ts: 110,
      agentPath: "forge",
      op: "patch",
      path: file,
      isCreate: true,
      phase: "intent",
      turnId: "failed-project-file-turn",
    });

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "failed-project-file-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("no_change");
  });

  it("does not attribute a same-path edit after an external concurrent change", async () => {
    const fixture = await makeFixture("base\n");
    const file = join(fixture.gameDir, "src", "conflict.ts");
    await mkdir(join(fixture.gameDir, "src"), { recursive: true });
    await writeFile(file, "base\n");
    const base = await fixture.store.snapshot(fixture.gameDir);
    await writeFile(file, "agent\n");
    await fixture.protocolAnchor(base.id);
    fixture.activity.push({
      ts: 110,
      agentPath: "forge",
      op: "write",
      path: file,
      hash: sha256("agent\n"),
      turnId: "conflict-turn",
    });
    await writeFile(file, "human-after-agent\n");

    const result = await fixture.enricher().resolveTurn({
      ...fixture.context,
      turnId: "conflict-turn",
      checkpointMsgId: "msg-1",
      startedAt: 100,
      settledAt: 120,
    });

    expect(result.resolution.kind).toBe("unavailable");
    if (result.resolution.kind === "unavailable") {
      expect(result.resolution.reason).toContain("concurrently");
      expect(result.resolution.reliableCandidatePaths).toEqual(["src/conflict.ts"]);
    }
  });
});

interface Fixture {
  gameDir: string;
  store: SnapshotStore;
  ledger: { events: StoredEvent[] };
  context: { sid: string; agentId: string; projectRoot: string; game: string };
  session: RoundDeliverySession;
  activity: Array<{
    ts: number;
    agentPath: string;
    op: string;
    path: string;
    fromPath?: string;
    hash?: string;
    isCreate?: boolean;
    phase?: "intent" | "applied";
    turnId?: string;
  }>;
  anchor(manifestId: string): Promise<void>;
  protocolAnchor(manifestId: string | null): Promise<void>;
  enricher(): RoundDeliveryEnricher;
}

async function makeFixture(initialContent: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forgeax-round-delivery-"));
  roots.push(root);
  const gameDir = join(root, "game");
  const sessionRoot = join(root, "session");
  await mkdir(gameDir, { recursive: true });
  await mkdir(sessionRoot, { recursive: true });
  const store = new SnapshotStore(join(root, "checkpoints"));
  const ledger = { events: [] as StoredEvent[] };
  const activity: Fixture["activity"] = [];
  const sid = "sid-round-delivery";
  const session: RoundDeliverySession = {
    sid,
    config: { defaultDir: "game" },
    paths: { root: () => sessionRoot },
    ledgers: new Map([["forge", { readAllEvents: async () => ledger.events }]]),
    tree: { list: () => [{ path: "forge" }] },
    getOrCreateLedger: () => ({ readAllEvents: async () => ledger.events }),
    fileActivity: { query: () => activity },
  };
  const context = {
    sid,
    agentId: "forge",
    projectRoot: root,
    game: "game",
  };

  // Keep the helper's initial content available to callers without making it
  // part of the session anchor setup.
  await writeFile(join(gameDir, ".fixture"), initialContent);

  return {
    gameDir,
    store,
    ledger,
    activity,
    session,
    context,
    async anchor(manifestId: string) {
      await writeFile(
        join(sessionRoot, "checkpoints.jsonl"),
        JSON.stringify({ kind: "message", msgId: "msg-1", ts: 100, manifestId }) + "\n",
      );
    },
    async protocolAnchor(manifestId: string | null) {
      await writeFile(
        join(sessionRoot, "checkpoints.jsonl"),
        JSON.stringify({
          kind: "message",
          msgId: "msg-1",
          ts: 100,
          manifestId,
          artifactResolutionExpected: true,
          schemaVersion: 2,
        }) + "\n",
      );
    },
    enricher() {
      return new RoundDeliveryEnricher({
        resolveSession: async () => session,
        resolveGame: () => ({ gameDir, store }),
        now: () => 200,
      });
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolEvent(ts: number, name: string, args: Record<string, unknown>): StoredEvent {
  return {
    type: "hook:toolCall",
    ts,
    source: "agent:forge",
    emitterId: "forge",
    payload: { name, args },
  };
}
