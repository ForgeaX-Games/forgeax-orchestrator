import { describe, expect, test } from "bun:test";
import {
  MAX_CANONICAL_TOOL_RESULT_BYTES,
  projectToolCallMessage,
  projectToolResultMessage,
  TOOL_RESULT_MARKERS,
} from "../src/history/tool-result-projector";
import { eventsToMessages } from "../src/context-window/history-pipeline";
import type { StoredEvent } from "../src/ledger/types";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("native raw tool-result projector", () => {
  test("projects legacy strings and internal ContentPart[] without provider blocks", () => {
    const text = projectToolResultMessage({ callId: "c1", toolName: "echo", ok: true, result: "plain result" });
    expect(text).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      toolName: "echo",
      toolStatus: "completed",
      content: [{ type: "text", text: "plain result" }],
    });

    const image = projectToolResultMessage({
      callId: "c2",
      toolName: "ui_screenshot",
      ok: true,
      result: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
    });
    expect(image.content).toEqual([{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
    const singleImage = projectToolResultMessage({
      callId: "c3",
      toolName: "ui_screenshot",
      ok: true,
      result: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
    });
    expect(singleImage.content).toEqual([{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
    expect(JSON.stringify(image)).not.toContain("image_url");
  });

  test("normalizes ui_screenshot data URL to the internal image ContentPart", () => {
    const projected = projectToolResultMessage({
      callId: "shot-1",
      toolName: "ui_screenshot",
      ok: true,
      result: { dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG}`, width: 800, height: 600 },
    });
    expect(projected.content).toEqual([{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
  });

  test("uses fixed path-free markers for malformed, oversized, and uncorrelated results", () => {
    const malformed = projectToolResultMessage({
      callId: "bad-1",
      toolName: "ui_screenshot",
      ok: true,
      result: [{ type: "image_url", image_url: { url: "/private/secret.png" } }],
    });
    expect(malformed.content).toEqual([{ type: "text", text: TOOL_RESULT_MARKERS.malformed }]);
    expect(malformed.toolStatus).toBe("failed");
    expect(JSON.stringify(malformed)).not.toContain("/private/secret.png");

    const oversized = projectToolResultMessage({
      callId: "big-1",
      toolName: "echo",
      ok: true,
      result: "x".repeat(MAX_CANONICAL_TOOL_RESULT_BYTES + 1),
    });
    expect(oversized.content).toEqual([{ type: "text", text: TOOL_RESULT_MARKERS.oversized }]);
    expect(oversized.toolStatus).toBe("failed");

    const missingCorrelation = projectToolResultMessage({
      callId: "",
      toolName: undefined,
      ok: true,
      result: { path: "/private/secret.txt", value: "hidden" },
    });
    expect(missingCorrelation.content).toEqual([{ type: "text", text: TOOL_RESULT_MARKERS.missingCorrelation }]);
    expect(missingCorrelation.toolStatus).toBe("failed");
    expect(missingCorrelation.toolName).toBeUndefined();
    expect(JSON.stringify(missingCorrelation)).not.toContain("unknown_tool");
    expect(JSON.stringify(missingCorrelation)).not.toContain("/private/secret.txt");
  });

  test("redacts paths from generic object projection and preserves call input exactly", () => {
    const pathPart = projectToolResultMessage({
      callId: "path-1",
      toolName: "read_file",
      ok: true,
      result: { type: "text_file", path: "/private/secret.txt", mimeType: "text/plain" },
    });
    expect(pathPart.content).toEqual([{ type: "text", text: TOOL_RESULT_MARKERS.pathBacked }]);
    expect(pathPart.toolStatus).toBe("failed");
    expect(JSON.stringify(pathPart)).not.toContain("/private/secret.txt");

    const objectResult = projectToolResultMessage({
      callId: "obj-1",
      toolName: "inspect",
      ok: true,
      result: { path: "/private/secret.txt", value: "visible" },
    });
    expect(objectResult.content).toEqual([{ type: "text", text: '{"path":"[redacted]","value":"visible"}' }]);
    expect(JSON.stringify(objectResult)).not.toContain("/private/secret.txt");

    const args = { input: { tool_use: { input: { path: "/private/keep-in-call-input" } } } };
    const call = projectToolCallMessage({ callId: "call-1", toolName: "inspect", args });
    expect(call.toolCalls?.[0]?.arguments).toBe(args);
    expect(call.toolCalls?.[0]?.arguments).toEqual(args);
  });

  test("history-pipeline backfills old hook events and correlates the result by call name", () => {
    const image = { type: "image" as const, data: ONE_PIXEL_PNG, mimeType: "image/png" };
    const events: StoredEvent[] = [
      {
        type: "hook:toolCall",
        ts: 1,
        payload: { callId: "legacy-shot", name: "ui_screenshot", args: { target: "app" } },
      },
      {
        type: "hook:toolResult",
        ts: 2,
        payload: { callId: "legacy-shot", ok: true, result: [image] },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "legacy-shot", name: "ui_screenshot", arguments: { target: "app" } }],
    });
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "legacy-shot",
      toolName: "ui_screenshot",
      toolStatus: "completed",
      content: [image],
    });
  });
});
