import { describe, expect, test } from "bun:test";
import { recoverUserTurnRoute } from "../src/runtime/user-turn-route";
import type { Event } from "../src/core/types";

function event(type: string, source: string, payload: Record<string, unknown>, eventId?: string): Event {
  return { type, source, payload, ts: 1, ...(eventId ? { eventId } : {}) };
}

describe("processed user route recovery", () => {
  const history = [
    event("user_input", "user", { kernelId: "codex", model: "selected" }, "user-1"),
    event("inbound_message", "user", { kernelId: "codex", originalType: "user_input", sourceEventId: "user-1" }),
  ];
  test("restores the recipient selection without following teammate or failed continuation routes", () => {
    expect(recoverUserTurnRoute([...history,
      event("hook:turnEnd", "agent:helper", { kernelId: "other" }),
      event("inbound_message", "agent", { kernelId: "forgeax-core" }),
      event("user_input", "user", { kernelId: "queued-next", model: "next" }),
    ])).toEqual({ kernelId: "codex", model: "selected" });
  });
  test("a processed new user selection replaces both route fields", () => {
    expect(recoverUserTurnRoute([...history,
      event("inbound_message", "user", { kernelId: "other", originalType: "user_input" }),
    ])).toEqual({ kernelId: "other", model: undefined });
  });
  test("commands do not replace the model turn selection", () => {
    expect(recoverUserTurnRoute([...history,
      event("inbound_message", "user", { kernelId: "other", originalType: "agent_command" }),
    ])).toEqual({ kernelId: "codex", model: "selected" });
  });
  test("another agent with no user history has no inherited override", () => {
    expect(recoverUserTurnRoute([event("inbound_message", "agent", { kernelId: "other" })])).toBeUndefined();
  });
});
