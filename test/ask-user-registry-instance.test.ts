import { describe, expect, test } from "bun:test";
import {
  registerAsk,
  resolveAsk,
} from "../src/core/ask-user-registry";

describe("ask_user instance identity", () => {
  test("同一路径的不同 runtimeEpoch 不会被旧回复串答", async () => {
    const oldAsk = registerAsk({
      sid: "sid-1",
      agentPath: "root",
      instanceId: "resident-root",
      runtimeEpochId: "epoch-old",
    }, 0);
    const newAsk = registerAsk({
      sid: "sid-1",
      agentPath: "root",
      instanceId: "resident-root",
      runtimeEpochId: "epoch-new",
    }, 0);

    expect(resolveAsk("sid-1", "root", ["stale"], {
      instanceId: "resident-root",
      runtimeEpochId: "epoch-missing",
    })).toBe(false);
    expect(resolveAsk("sid-1", "root", ["new"], {
      instanceId: "resident-root",
      runtimeEpochId: "epoch-new",
    })).toBe(true);
    expect(await newAsk.promise).toEqual(["new"]);

    expect(resolveAsk("sid-1", "root", ["old"], {
      instanceId: "resident-root",
      runtimeEpochId: "epoch-old",
    })).toBe(true);
    expect(await oldAsk.promise).toEqual(["old"]);
  });

  test("旧前端只传 agentPath 时仅在 Session 内唯一 pending 才兼容解析", async () => {
    const left = registerAsk({
      sid: "sid-legacy",
      agentPath: "eph-left",
      instanceId: "eph-left",
      runtimeEpochId: "epoch-left",
    }, 0);
    const right = registerAsk({
      sid: "sid-legacy",
      agentPath: "eph-right",
      instanceId: "eph-right",
      runtimeEpochId: "epoch-right",
    }, 0);
    expect(resolveAsk("sid-legacy", "missing-tab-agent", ["ambiguous"])).toBe(false);
    expect(resolveAsk("sid-legacy", "eph-left", ["left"])).toBe(true);
    expect(await left.promise).toEqual(["left"]);
    expect(resolveAsk("sid-legacy", "missing-tab-agent", ["right"])).toBe(true);
    expect(await right.promise).toEqual(["right"]);
  });
});
