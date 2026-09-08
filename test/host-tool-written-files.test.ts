import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileActivityRecord } from "../src/ledger/file-activity-ledger";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import {
  extractHostWrittenPaths,
  recordSessionHostToolWrites,
} from "../src/kernel/host-tool-written-files";

const roots: string[] = [];

afterEach(() => {
  resetPathManager();
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempGame(): { root: string; gameDir: string } {
  const root = mkdtempSync(join(tmpdir(), "host-written-"));
  roots.push(root);
  const gameDir = join(root, "game");
  mkdirSync(join(gameDir, "assets", "3d"), { recursive: true });
  return { root, gameDir };
}

describe("extractHostWrittenPaths", () => {
  test("admits manifest.assetPath inside the bound game", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      { ok: true, manifest: { assetPath: "assets/3d/hero.glb" } },
      gameDir,
    )).toEqual([file]);
  });

  test("admits files[].path from a write list", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      { files: [{ path: "assets/3d/hero.glb", change: "new" }] },
      gameDir,
    )).toEqual([file]);
  });

  test("ignores files[] entries that look like a directory listing", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "src.ts");
    writeFileSync(file, "code");
    expect(extractHostWrittenPaths(
      { files: [{ path: "src.ts" }, "src.ts"] },
      gameDir,
    )).toEqual([]);
  });

  test("parses a host-serialized JSON object result", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    const payload = JSON.stringify(
      { ok: true, manifest: { assetPath: "assets/3d/hero.glb" } },
      null,
      2,
    );
    expect(extractHostWrittenPaths(payload, gameDir)).toEqual([file]);
  });

  test("parses a single host text content part", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      [{ type: "text", text: JSON.stringify({ assetPath: "assets/3d/hero.glb" }) }],
      gameDir,
    )).toEqual([file]);
  });

  test("rejects a host error envelope even when it names a path", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      JSON.stringify({ error: "failed", code: "x", assetPath: "assets/3d/hero.glb" }),
      gameDir,
    )).toEqual([]);
  });

  test("ignores a top-level path field from a reader-shaped result", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "src.ts");
    writeFileSync(file, "code");
    expect(extractHostWrittenPaths({ path: "src.ts" }, gameDir)).toEqual([]);
  });

  test("rejects a result that explicitly failed", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      { ok: false, assetPath: "assets/3d/hero.glb" },
      gameDir,
    )).toEqual([]);
  });

  test("rejects relative escape even when the file exists", () => {
    const { root, gameDir } = tempGame();
    const secret = join(root, "secret.glb");
    writeFileSync(secret, "nope");
    expect(extractHostWrittenPaths({ assetPath: "../secret.glb" }, gameDir)).toEqual([]);
  });

  test("rejects an absolute path outside the game", () => {
    const { root, gameDir } = tempGame();
    const secret = join(root, "outside.glb");
    writeFileSync(secret, "nope");
    expect(extractHostWrittenPaths({ assetPath: secret }, gameDir)).toEqual([]);
  });

  test("rejects a claimed path that is not on disk", () => {
    const { gameDir } = tempGame();
    expect(extractHostWrittenPaths(
      { assetPath: "assets/3d/missing.glb" },
      gameDir,
    )).toEqual([]);
  });

  test("rejects a symlink that escapes the game", () => {
    const { root, gameDir } = tempGame();
    const secret = join(root, "secret.glb");
    writeFileSync(secret, "nope");
    const link = join(gameDir, "assets", "3d", "link.glb");
    symlinkSync(secret, link);
    expect(extractHostWrittenPaths({ assetPath: "assets/3d/link.glb" }, gameDir)).toEqual([]);
  });

  test("does not walk arbitrary nested objects", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      { nested: { assetPath: "assets/3d/hero.glb" } },
      gameDir,
    )).toEqual([]);
  });

  test("does not parse a JSON string nested in a field", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "assets", "3d", "hero.glb");
    writeFileSync(file, "glb");
    expect(extractHostWrittenPaths(
      { payload: JSON.stringify({ assetPath: "assets/3d/hero.glb" }) },
      gameDir,
    )).toEqual([]);
  });

  test("ignores a bare changedFiles string list", () => {
    const { gameDir } = tempGame();
    const file = join(gameDir, "src.ts");
    writeFileSync(file, "code");
    expect(extractHostWrittenPaths({ changedFiles: ["src.ts"] }, gameDir)).toEqual([]);
  });

  test("caps admitted files", () => {
    const { gameDir } = tempGame();
    mkdirSync(join(gameDir, "many"), { recursive: true });
    const files = Array.from({ length: 40 }, (_, i) => {
      const path = join(gameDir, "many", `${i}.txt`);
      writeFileSync(path, String(i));
      return { path: `many/${i}.txt`, change: "new" };
    });
    expect(extractHostWrittenPaths({ changedFiles: files }, gameDir)).toHaveLength(32);
  });
});

describe("recordSessionHostToolWrites", () => {
  test("appends applied file-activity for a host-executed kit result", () => {
    const { root } = tempGame();
    initPathManager({ userRoot: root, projectRoot: root });
    mkdirSync(join(root, ".forgeax", "games", "demo", "assets", "3d"), { recursive: true });
    writeFileSync(join(root, ".forgeax", "games", "demo", "assets", "3d", "hero.glb"), "glb");
    const records: FileActivityRecord[] = [];
    const published: unknown[] = [];
    const written = recordSessionHostToolWrites(
      {
        config: { defaultDir: "demo" },
        fileActivity: { append: (record) => records.push(record) },
        eventBus: { publish: (event) => published.push(event) },
      },
      {
        result: { ok: true, assetPath: "assets/3d/hero.glb" },
        agentPath: "agent",
        toolCallId: "call-1",
        gameSlug: "demo",
      },
    );
    expect(written).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.phase).toBe("applied");
    expect(records[0]?.op).toBe("write");
    expect(records[0]?.toolCallId).toBe("call-1");
    expect(records[0]?.path).toContain("hero.glb");
    expect(published).toHaveLength(1);
  });

  test("no-ops when the session has no file-activity ledger", () => {
    const { root } = tempGame();
    initPathManager({ userRoot: root, projectRoot: root });
    expect(recordSessionHostToolWrites(
      { config: { defaultDir: "demo" } },
      { result: { assetPath: "assets/3d/hero.glb" }, agentPath: "forge" },
    )).toEqual([]);
  });
});
