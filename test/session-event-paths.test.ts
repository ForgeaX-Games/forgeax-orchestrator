import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { SessionEventPaths } from "../src/ledger/session-event-paths";

describe("SessionEventPaths", () => {
  test("resident 保持兼容路径，ephemeral/global 只落冻结 runtimeEventsRoot", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "forgeax-event-root-"));
    try {
      const paths = new SessionEventPaths(sessionRoot, "history/runtime");
      expect(relative(sessionRoot, paths.resolve(paths.resident("router/reviewer")).eventsDir))
        .toBe("agents/router/agents/reviewer/events");
      expect(relative(sessionRoot, paths.resolve(paths.ephemeral("eph_1")).eventsDir))
        .toBe("history/runtime/ephemeral/eph_1");
      expect(relative(sessionRoot, paths.globalFile()))
        .toBe("history/runtime/global-events.jsonl");
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  test("拒绝绝对路径、穿越、保留根和 per-instance override", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "forgeax-event-security-"));
    try {
      for (const root of ["", ".", "..", "../escape", "/tmp/escape", "agents", "logs"]) {
        expect(() => new SessionEventPaths(sessionRoot, root)).toThrow();
      }
      const paths = new SessionEventPaths(sessionRoot, "runtime-events");
      expect(() => paths.resolve({ relativeDir: "../escape" as never })).toThrow();
      expect(() => paths.resolve({ relativeDir: "/tmp/escape" as never })).toThrow();
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  test("拒绝通过 symlink 逃逸 Session", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "forgeax-event-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "forgeax-event-outside-"));
    try {
      symlinkSync(outside, join(sessionRoot, "runtime-events"));
      expect(() => new SessionEventPaths(sessionRoot, "runtime-events")).toThrow(
        "symbolic link",
      );

      rmSync(join(sessionRoot, "runtime-events"), { force: true });
      mkdirSync(join(sessionRoot, "runtime-events"), { recursive: true });
      const paths = new SessionEventPaths(sessionRoot, "runtime-events");
      symlinkSync(outside, join(sessionRoot, "runtime-events", "ephemeral"));
      expect(() => paths.resolve(paths.ephemeral("eph_1"))).toThrow(
        "symbolic link",
      );
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
