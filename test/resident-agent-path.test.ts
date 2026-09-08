import { describe, expect, test } from "bun:test";
import {
  deriveResidentInstanceId,
  ResidentPathCodec,
} from "../src/fs/resident-agent-path";

describe("ResidentPathCodec", () => {
  const codec = new ResidentPathCodec();

  test("在物理嵌套中插入结构 agents 段，但逻辑树不暴露它", () => {
    expect(codec.toPhysicalRelativePath("router")).toBe("router");
    expect(codec.toPhysicalRelativePath("router/reviewer/fact-check")).toBe(
      "router/agents/reviewer/agents/fact-check",
    );
    expect(
      codec.fromPhysicalRelativePath(
        "router/agents/reviewer/agents/fact-check",
      ),
    ).toBe("router/reviewer/fact-check");
  });

  test("physical → logical → physical 可 round-trip", () => {
    const physical = "forge/agents/tester/agents/verifier";
    expect(
      codec.toPhysicalRelativePath(codec.fromPhysicalRelativePath(physical)),
    ).toBe(physical);
  });

  test("拒绝空路径、穿越、反斜杠和保留结构名", () => {
    for (const invalid of [
      "",
      ".",
      "..",
      "../forge",
      "/forge",
      "forge//tester",
      "forge\\tester",
      "forge/agents",
      "agents/forge",
    ]) {
      expect(() => codec.normalizeLogicalPath(invalid)).toThrow();
    }
  });

  test("resident instanceId 对 sid+逻辑路径稳定，rename 形成新身份", () => {
    const first = deriveResidentInstanceId("sid-1", "router/reviewer");
    expect(deriveResidentInstanceId("sid-1", "router/reviewer")).toBe(first);
    expect(deriveResidentInstanceId("sid-1", "router/renamed")).not.toBe(first);
    expect(deriveResidentInstanceId("sid-2", "router/reviewer")).not.toBe(first);
    expect(first).toMatch(/^res_[a-f0-9]{32}$/);
  });
});
