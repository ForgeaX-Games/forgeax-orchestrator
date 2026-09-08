import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import defaultModels from "../src/defaults/models.json";
import { ensureUserDirDefaults } from "../src/defaults/scaffold";
import type { PathManagerAPI } from "../src/fs/types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pathManager(root: string): PathManagerAPI {
  const keyDir = join(root, "key");
  return {
    user: () => ({
      keyDir: () => keyDir,
      modelsFile: () => join(keyDir, "models.json"),
    }),
  } as PathManagerAPI;
}

describe("default model scaffolding", () => {
  test("writes the embedded model catalog without a source-tree dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgeax-defaults-"));
    roots.push(root);
    const pm = pathManager(root);

    expect(await ensureUserDirDefaults(pm)).toEqual({ created: ["models.json"] });
    expect(JSON.parse(await readFile(join(root, "key/models.json"), "utf8"))).toEqual(defaultModels);
  });

  test("never overwrites an existing user catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgeax-defaults-"));
    roots.push(root);
    const pm = pathManager(root);
    await ensureUserDirDefaults(pm);
    await writeFile(join(root, "key/models.json"), "{\"custom\":true}\n");

    expect(await ensureUserDirDefaults(pm)).toEqual({ created: [] });
    expect(await readFile(join(root, "key/models.json"), "utf8")).toBe("{\"custom\":true}\n");
  });
});
