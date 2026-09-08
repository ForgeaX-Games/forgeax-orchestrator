import { describe, expect, test } from "bun:test";
import modelsCommand from "../builtin/commands/models";
import type { CallContext } from "../src/commands/types";

function commandContext(session: unknown): CallContext {
  return {
    sm: {
      open: async () => session,
    },
    paths: {},
  } as unknown as CallContext;
}

describe("commands/models runtime contract", () => {
  test("get keeps an unmaterialized persona pending rather than staged", async () => {
    const ctx = commandContext({
      tree: {
        resolve: () => null,
      },
    });

    const result = await modelsCommand.query?.(
      "get_agent_model",
      ["sid-1", "mochi"],
      ctx,
    ) as Record<string, unknown>;

    expect(result).toEqual({
      sid: "sid-1",
      agentPath: "mochi",
      selected: null,
      chain: [],
      raw: null,
      pending: true,
    });
    expect(result.staged).toBeUndefined();
    expect(result.appliesAt).toBeUndefined();
  });

  test("get exposes the next RuntimeConfig revision and its apply boundary", async () => {
    const instance = {
      instanceId: "agt_1",
      lifetime: "resident",
      runtimeConfig: {
        current: () => ({
          revision: "cfg_current",
          value: { models: { model: ["old-model"] } },
        }),
        next: () => ({
          revision: "cfg_next",
          value: { models: { model: ["new-model", "fallback-model"] } },
        }),
      },
    };
    const ctx = commandContext({
      tree: {
        resolve: () => instance,
        addressOf: () => "root",
      },
    });

    const result = await modelsCommand.query?.(
      "get_agent_model",
      ["sid-1", "root"],
      ctx,
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      sid: "sid-1",
      agentPath: "root",
      instanceId: "agt_1",
      lifetime: "resident",
      selected: "new-model",
      chain: ["new-model", "fallback-model"],
      pending: false,
      staged: true,
      appliesAt: "next-turn",
      revision: "cfg_next",
    });
  });

  test("set stages an ephemeral config without a resident file or restart result", async () => {
    let staged:
      | { instanceId: string; revision: string; model: string[] }
      | undefined;
    const instance = {
      instanceId: "eph_1",
      lifetime: "ephemeral",
      runtimeConfig: {
        next: () => ({
          revision: "cfg_current",
          value: { models: { temperature: 0.4 } },
        }),
      },
    };
    const ctx = commandContext({
      tree: {
        resolve: () => instance,
        addressOf: () => "root/agents/helper#eph_1",
      },
      stageRuntimeConfig: async (
        instanceId: string,
        next: { revision: string; value: { models?: { model?: string[] } } },
      ) => {
        staged = {
          instanceId,
          revision: next.revision,
          model: [...(next.value.models?.model ?? [])],
        };
      },
    });

    const result = await modelsCommand.execute?.(
      "set_agent_models",
      ["sid-1", "eph_1", "new-model", "fallback-model"],
      ctx,
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      sid: "sid-1",
      agentPath: "root/agents/helper#eph_1",
      instanceId: "eph_1",
      lifetime: "ephemeral",
      models: { model: ["new-model", "fallback-model"] },
      selected: "new-model",
      staged: true,
      appliesAt: "next-turn",
      agentJsonFile: null,
    });
    const revision = result.revision;
    expect(typeof revision).toBe("string");
    if (typeof revision !== "string") {
      throw new Error("set_agent_models must return a string revision");
    }
    expect(result).not.toHaveProperty("restarted");
    expect(staged).toEqual({
      instanceId: "eph_1",
      revision,
      model: ["new-model", "fallback-model"],
    });
  });
});
