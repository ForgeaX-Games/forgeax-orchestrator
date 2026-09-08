/**
 * Native tool-result -> canonical history projection.
 *
 * Kernel events deliberately keep their faithful `result` for UI/audit. This
 * module is the small, pure boundary that turns that untrusted value into the
 * internal LLMMessage/ContentPart contract used by ContextWindow. It never
 * emits provider-shaped blocks, logs raw values, or rewrites tool-call input.
 */

import type { ContentPart } from "../core/types";
import { sanitizeMediaPart } from "../context-window/media-normalizer";
import type { LLMMessage } from "../llm/types";
import { normalizeContent } from "../message/modality";

/** Keep a single history result bounded before it reaches a ledger/model. */
export const MAX_CANONICAL_TOOL_RESULT_BYTES = 256 * 1024;

/** Stable, path-free failure text. Do not add dynamic ids, paths, or errors. */
export const TOOL_RESULT_MARKERS = Object.freeze({
  missingCorrelation: "[tool result unavailable: missing call correlation]",
  malformed: "[tool result unavailable: malformed result]",
  invalidMedia: "[tool result unavailable: invalid media]",
  pathBacked: "[tool result unavailable: path-backed content omitted]",
  oversized: "[tool result unavailable: result exceeded history budget]",
  unserializable: "[tool result unavailable: unserializable result]",
});

type ProjectionFailure = keyof typeof TOOL_RESULT_MARKERS;

export interface ToolResultProjectionInput {
  result?: unknown;
  callId?: unknown;
  toolName?: unknown;
  ok: boolean;
  /** Retained for call sites that have an error, but never copied into a
   * marker: UI/audit already owns the faithful error field. */
  error?: unknown;
  ts?: number;
}

export interface ToolCallProjectionInput {
  callId?: unknown;
  toolName?: unknown;
  args?: unknown;
  ts?: number;
}

interface ProjectedContent {
  content: ContentPart[];
  failure?: ProjectionFailure;
}

const CONTENT_PART_TYPES = new Set([
  "text",
  "text_file",
  "file",
  "image",
  "video",
  "audio",
  "image_file",
  "video_file",
  "audio_file",
]);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SENSITIVE_KEYS = new Set(["path", "filePath", "filepath", "dataUrl", "base64", "base64Data"]);
const REDACTED_VALUE = "[redacted]";
const PATH_REDACTED_VALUE = "[path omitted]";
const MAX_IDENTIFIER_CHARS = 512;
const HOST_PATH_RE = /(?:^|[\s"'(])(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s"'()]+/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDENTIFIER_CHARS) return undefined;
  return trimmed;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function markerContent(failure: ProjectionFailure): ContentPart[] {
  return normalizeContent(TOOL_RESULT_MARKERS[failure]);
}

function withTimestamp(message: LLMMessage, ts: unknown): LLMMessage {
  return typeof ts === "number" && Number.isFinite(ts) ? { ...message, ts } : message;
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function pathFreeText(value: string): string {
  return HOST_PATH_RE.test(value) ? PATH_REDACTED_VALUE : value;
}

function looksLikeDataUrl(value: string): boolean {
  return /^data:[^,]+,/.test(value);
}

function looksLikeLargeBase64(value: string): boolean {
  return value.length >= 64 && value.length % 4 === 0 && BASE64_RE.test(value);
}

/** JSON is useful for legacy object results, but sensitive path/base64 values
 * must not become model-visible history text or marker diagnostics. */
function safeJsonStringify(value: unknown): { value: string } | { failure: ProjectionFailure } {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (key, current) => {
      if (typeof current === "string") {
        if (SENSITIVE_KEYS.has(key) || HOST_PATH_RE.test(current) || looksLikeDataUrl(current)) {
          return REDACTED_VALUE;
        }
        if ((key === "data" || key === "encoded") && looksLikeLargeBase64(current)) {
          return REDACTED_VALUE;
        }
      }
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[circular result]";
        seen.add(current);
      }
      return current;
    });
    if (typeof serialized !== "string") return { failure: "malformed" };
    return { value: serialized };
  } catch {
    return { failure: "unserializable" };
  }
}

function projectJsonResult(result: unknown): ProjectedContent {
  const serialized = safeJsonStringify(result);
  if ("failure" in serialized) return { content: markerContent(serialized.failure), failure: serialized.failure };
  if (byteLength(serialized.value) > MAX_CANONICAL_TOOL_RESULT_BYTES) {
    return { content: markerContent("oversized"), failure: "oversized" };
  }
  return { content: normalizeContent(serialized.value) };
}

function isPotentialContentPartArray(value: unknown[]): boolean {
  return value.length > 0 && value.some((part) => isRecord(part) && typeof part.type === "string");
}

function safePartName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_IDENTIFIER_CHARS) return undefined;
  // A name is display metadata, not a place to carry a path.
  return value.includes("/") || value.includes("\\") ? undefined : value;
}

function projectContentParts(rawParts: unknown[]): ProjectedContent {
  const parts: ContentPart[] = [];
  for (const raw of rawParts) {
    if (!isRecord(raw) || typeof raw.type !== "string" || !CONTENT_PART_TYPES.has(raw.type)) {
      return { content: markerContent("malformed"), failure: "malformed" };
    }

    switch (raw.type) {
      case "text": {
        if (typeof raw.text !== "string") return { content: markerContent("malformed"), failure: "malformed" };
        parts.push({ type: "text", text: pathFreeText(raw.text) });
        break;
      }
      case "image":
      case "video":
      case "audio": {
        if (typeof raw.data !== "string" || typeof raw.mimeType !== "string" || !raw.mimeType.includes("/")) {
          return { content: markerContent("invalidMedia"), failure: "invalidMedia" };
        }
        if (!BASE64_RE.test(raw.data) || raw.data.length % 4 !== 0) {
          return { content: markerContent("invalidMedia"), failure: "invalidMedia" };
        }
        if (byteLength(raw.data) > MAX_CANONICAL_TOOL_RESULT_BYTES) {
          return { content: markerContent("oversized"), failure: "oversized" };
        }
        const part: Extract<ContentPart, { type: "image" | "video" | "audio" }> = {
          type: raw.type,
          data: raw.data,
          mimeType: raw.mimeType,
          ...(safePartName(raw.name) ? { name: safePartName(raw.name) } : {}),
        };
        // Reuse the existing magic-byte guard. The returned corruption text
        // is intentionally not copied; history uses one fixed marker.
        if (sanitizeMediaPart(part).type === "text") {
          return { content: markerContent("invalidMedia"), failure: "invalidMedia" };
        }
        parts.push(part);
        break;
      }
      case "text_file":
      case "file":
      case "image_file":
      case "video_file":
      case "audio_file": {
        // A raw tool result must never turn a host path into model-visible
        // history. The tool may retain it in payload.result for audit; the
        // canonical projection is deliberately fail-closed.
        return { content: markerContent("pathBacked"), failure: "pathBacked" };
      }
    }
  }

  const serialized = safeJsonStringify(parts);
  if ("failure" in serialized) return { content: markerContent(serialized.failure), failure: serialized.failure };
  if (byteLength(serialized.value) > MAX_CANONICAL_TOOL_RESULT_BYTES) {
    return { content: markerContent("oversized"), failure: "oversized" };
  }
  return { content: normalizeContent(parts) };
}

function projectDataUrlResult(result: Record<string, unknown>): ProjectedContent | undefined {
  if (typeof result.dataUrl !== "string") return undefined;
  const match = /^data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(result.dataUrl);
  if (!match) return { content: markerContent("invalidMedia"), failure: "invalidMedia" };
  return projectContentParts([{ type: "image", data: match[2], mimeType: match[1] }]);
}

function projectRawContent(result: unknown, toolName: string | undefined): ProjectedContent {
  if (result === undefined) return { content: markerContent("malformed"), failure: "malformed" };
  if (typeof result === "string") {
    if (byteLength(result) > MAX_CANONICAL_TOOL_RESULT_BYTES) {
      return { content: markerContent("oversized"), failure: "oversized" };
    }
    return { content: normalizeContent(pathFreeText(result)) };
  }
  if (Array.isArray(result)) {
    return isPotentialContentPartArray(result) ? projectContentParts(result) : projectJsonResult(result);
  }
  if (isRecord(result) && typeof result.type === "string") {
    // Recognize the internal single-part form used by some native tools. An
    // unknown `type` is rejected instead of echoing a provider-shaped block.
    return CONTENT_PART_TYPES.has(result.type)
      ? projectContentParts([result])
      : { content: markerContent("malformed"), failure: "malformed" };
  }
  if (toolName === "ui_screenshot" && isRecord(result)) {
    const dataUrl = projectDataUrlResult(result);
    if (dataUrl) return dataUrl;
  }
  return projectJsonResult(result);
}

/** Project a kernel tool result into the internal canonical tool message. */
export function projectToolResultMessage(input: ToolResultProjectionInput): LLMMessage {
  const callId = asIdentifier(input.callId);
  const toolName = asIdentifier(input.toolName);
  const correlationOk = !!callId && !!toolName;
  const projected = correlationOk
    ? projectRawContent(input.result, toolName)
    : { content: markerContent("missingCorrelation"), failure: "missingCorrelation" as const };

  const resultLooksLikeError = isRecord(input.result) && "error" in input.result;
  return withTimestamp({
    role: "tool",
    content: projected.content,
    ...(callId ? { toolCallId: callId } : {}),
    ...(toolName ? { toolName } : {}),
    toolStatus: input.ok && !projected.failure && !resultLooksLikeError ? "completed" : "failed",
  }, input.ts);
}

/** Project a kernel tool call without touching its input/arguments tree. */
export function projectToolCallMessage(input: ToolCallProjectionInput): LLMMessage {
  const callId = asIdentifier(input.callId);
  const toolName = asIdentifier(input.toolName);
  if (!callId || !toolName || !isRecord(input.args)) {
    return withTimestamp({
      role: "assistant",
      content: markerContent("missingCorrelation"),
    }, input.ts);
  }
  return withTimestamp({
    role: "assistant",
    content: [],
    toolCalls: [{ id: callId, name: toolName, arguments: input.args }],
  }, input.ts);
}
