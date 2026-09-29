import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createCliRouter } from "../src/api/cli/chat";
import {
  getPathManager,
  initPathManager,
  resetPathManager,
} from "../src/fs/path-manager";
import {
  getSessionManager,
  initSessionManager,
  resetSessionManager,
} from "../src/core/session-manager";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: Hono;
let userRoot: string;
let projectRoot: string;
let prevKernel: string | undefined;

beforeEach(async () => {
  prevKernel = process.env.FORGEAX_KERNEL;
  process.env.FORGEAX_KERNEL = "kernel";
  userRoot = mkdtempSync(join(tmpdir(), "forgeax-cli-warm-user-"));
  projectRoot = mkdtempSync(join(tmpdir(), "forgeax-cli-warm-project-"));
  initPathManager({ userRoot, projectRoot });
  initSessionManager(getPathManager());
  app = new Hono().route("/api/cli", createCliRouter());
});

afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  if (prevKernel === undefined) delete process.env.FORGEAX_KERNEL;
  else process.env.FORGEAX_KERNEL = prevKernel;
});

describe("POST /api/cli/warm", () => {
  test("returns 200 noop for cursor-agent (no prewarm hook)", async () => {
    const session = await getSessionManager().create({
      displayName: "warm-cursor",
    });
    const res = await app.request("/api/cli/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sid,
        agentId: "forge",
        providerOverride: "cursor-agent",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.noop).toBe(true);
    expect(body.providerId).toBe("cursor-agent");
  });

  test("returns 400 when sessionId is missing", async () => {
    const res = await app.request("/api/cli/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerOverride: "cursor-agent" }),
    });
    expect(res.status).toBe(400);
  });
});
