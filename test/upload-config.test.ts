// Unit tests for upload config + namespace resolution.
//
// The shared repo + shared write token are now injected by the product shell
// through the orchestration seam (getUploadDefaults), not baked into this base.
// Tests install a fake seam via initOrchestrationSeams and reset it afterwards.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeNamespace,
  loadUploadConfig,
  resolveNamespace,
  resolvePlanContext,
  uploadStateFile,
  UploadConfigError,
} from "../src/upload/config";
import {
  initOrchestrationSeams,
  resetOrchestrationSeams,
} from "../src/orchestration-seams";

const FAKE_SHARED_TOKEN = "fake-shared-token-xyz";
const FAKE_SHARED_REPO = "FakeOrg/Fake-Data";

/** Install the product-shell-injected upload defaults, mirroring what the shell
 *  does at boot via createForgeaxApp({ uploadDefaults }). */
function injectSharedDefaults() {
  initOrchestrationSeams({ uploadDefaults: { repo: FAKE_SHARED_REPO, token: FAKE_SHARED_TOKEN, branch: "main" } });
}

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "fg-cfg-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetOrchestrationSeams();
});

describe("namespace", () => {
  test("default form is <slug>-<sha256[:12]> with >=12 hex", () => {
    const ns = computeNamespace(projectRoot, { FORGEAX_UPLOAD_NAMESPACE: "" } as any);
    const hashPart = ns.split("-").pop()!;
    expect(hashPart).toMatch(/^[0-9a-f]{12}$/);
  });
  test("explicit FORGEAX_UPLOAD_NAMESPACE overrides", () => {
    const ns = computeNamespace(projectRoot, { FORGEAX_UPLOAD_NAMESPACE: "My Team!!" } as any);
    expect(ns).toBe("my-team");
  });
  test("stable + persisted once, read back verbatim", () => {
    const ns1 = resolveNamespace(projectRoot, {} as any);
    expect(existsSync(uploadStateFile(projectRoot))).toBe(true);
    const ns2 = resolveNamespace(projectRoot, {} as any);
    expect(ns2).toBe(ns1);
    const stored = JSON.parse(readFileSync(uploadStateFile(projectRoot), "utf8"));
    expect(stored.namespace).toBe(ns1);
    expect(stored.version).toBe(1);
    // upload.json holds ONLY the namespace identity (no token, no lastUpload mirror)
    expect(Object.keys(stored).sort()).toEqual(["namespace", "version"]);
  });
  test("different project roots → different namespaces (hash differs)", () => {
    const other = mkdtempSync(join(tmpdir(), "fg-cfg2-"));
    const a = computeNamespace(projectRoot, {} as any);
    const b = computeNamespace(other, {} as any);
    expect(a).not.toBe(b);
    rmSync(other, { recursive: true, force: true });
  });
});

describe("loadUploadConfig", () => {
  test("no env token → falls back to the product-shell-injected shared default", () => {
    // The shell injects a shared token so upload works out of the box;
    // FORGEAX_UPLOAD_GITHUB_TOKEN overrides it when non-empty.
    injectSharedDefaults();
    const cfg = loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r" } as any });
    expect(cfg.token).toBe(FAKE_SHARED_TOKEN);
    expect(cfg.token.length).toBeGreaterThan(0);
  });
  test("env token overrides the injected default", () => {
    injectSharedDefaults();
    const cfg = loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r", FORGEAX_UPLOAD_GITHUB_TOKEN: "mine" } as any });
    expect(cfg.token).toBe("mine");
  });
  test("no seam + no env token → unconfigured (empty token), no baked secret in base", () => {
    // Standalone/base build with nothing injected: the base carries no credential.
    const cfg = loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r" } as any });
    expect(cfg.token).toBe("");
  });
  test("invalid repo format → UploadConfigError(no-repo); missing env repo falls back to injected default", () => {
    injectSharedDefaults();
    // No env repo → injected shared repo applies, no error.
    const viaDefault = loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_GITHUB_TOKEN: "tok" } as any });
    expect(viaDefault.repo).toBe(FAKE_SHARED_REPO);
    try {
      loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_GITHUB_TOKEN: "tok", FORGEAX_UPLOAD_REPO: "not-a-repo" } as any });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UploadConfigError).kind).toBe("no-repo");
    }
  });
  test("no seam + no env repo → UploadConfigError(no-repo)", () => {
    try {
      loadUploadConfig({ projectRoot, env: {} as any });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UploadConfigError).kind).toBe("no-repo");
    }
  });
  test("valid config resolves (all via env, no seam needed)", () => {
    const cfg = loadUploadConfig({
      projectRoot,
      env: { FORGEAX_UPLOAD_GITHUB_TOKEN: "tok", FORGEAX_UPLOAD_REPO: "owner/repo", FORGEAX_UPLOAD_BRANCH: "dev" } as any,
    });
    expect(cfg.repo).toBe("owner/repo");
    expect(cfg.branch).toBe("dev");
    expect(cfg.token).toBe("tok");
    expect(cfg.sourceRoot).toBe(join(projectRoot, ".forgeax"));
    expect(cfg.namespace).toMatch(/[0-9a-f]{12}$/);
  });
});

describe("resolvePlanContext", () => {
  test("tokenConfigured reports effective credential availability", () => {
    injectSharedDefaults();
    const ctx = resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r" } as any });
    expect(ctx.tokenConfigured).toBe(true);
    const ctx2 = resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r", FORGEAX_UPLOAD_GITHUB_TOKEN: "tok" } as any });
    expect(ctx2.tokenConfigured).toBe(true);
  });
  test("no seam + no env token → tokenConfigured false", () => {
    const ctx = resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r" } as any });
    expect(ctx.tokenConfigured).toBe(false);
  });
  test("injected default repo applies when env empty; invalid format still throws", () => {
    injectSharedDefaults();
    expect(resolvePlanContext({ projectRoot, env: {} as any }).repo).toBe(FAKE_SHARED_REPO);
    expect(() => resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "not-a-repo" } as any })).toThrow();
  });
});
