/**
 * Host-side media normalization for the rented MCP bridge.
 *
 * File ContentParts belong to the host/container boundary. Resolve them here,
 * where the existing media-storage/sandboxFs contract is available, before a
 * result is serialized to the standalone MCP child. The child must not guess
 * whether a path is a host path or a container-view path.
 */

import { open } from "node:fs/promises";
import type { ContentPart } from "../../core/types";
import { sandboxFs } from "../../sandbox/fs-bridge";
import { sniffMediaMime } from "../../llm/media-mime-sniff";

/** Keep one host image from becoming an unbounded MCP/provider payload. */
export const MAX_MCP_IMAGE_BYTES = 5 * 1024 * 1024;
/** Keep generated/attached audio bounded before it reaches an MCP provider. */
export const MAX_MCP_AUDIO_BYTES = 10 * 1024 * 1024;

const SUPPORTED_MCP_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const SUPPORTED_MCP_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/mp4",
]);

type ImageFilePart = Extract<ContentPart, { type: "image_file" }>;
type AudioFilePart = Extract<ContentPart, { type: "audio_file" }>;

function textPart(text: unknown): ContentPart {
  return { type: "text", text: String(text) };
}

function fallback(path: unknown, reason: string): ContentPart {
  const label = typeof path === "string" && path ? path : "<missing path>";
  return textPart(`image_file unavailable (${reason}): ${label}`);
}

function audioFallback(path: unknown, reason: string): ContentPart {
  const label = typeof path === "string" && path ? path : "<missing path>";
  return textPart(`audio_file unavailable (${reason}): ${label}`);
}

function canonicalMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg";
  if (normalized === "image/x-png") return "image/png";
  return normalized;
}

function checkedImageMime(bytes: Buffer, declaredMime: string): string | undefined {
  const declared = canonicalMime(declaredMime);
  const sniffed = sniffMediaMime(bytes);
  if (!sniffed || !SUPPORTED_MCP_IMAGE_MIMES.has(sniffed)) return undefined;
  if (canonicalMime(sniffed) !== declared) return undefined;
  return sniffed;
}

function canonicalAudioMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  if (normalized === "audio/mp3") return "audio/mpeg";
  if (normalized === "audio/x-wav" || normalized === "audio/wave") return "audio/wav";
  return normalized;
}

function checkedAudioMime(bytes: Buffer, declaredMime: string): string | undefined {
  const declared = canonicalAudioMime(declaredMime);
  const sniffed = sniffMediaMime(bytes);
  if (!sniffed || !SUPPORTED_MCP_AUDIO_MIMES.has(sniffed)) return undefined;
  if (canonicalAudioMime(sniffed) !== declared) return undefined;
  return sniffed;
}

/** Read a host-owned path without allocating more than the protocol limit. */
async function readHostBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    if (before.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);

    // Read one byte beyond the limit so a file that grows after stat() is not
    // silently truncated into an apparently valid image.
    const capacity = Math.min(Number(before.size), maxBytes + 1);
    const bytes = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    const after = await handle.stat();
    if (after.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readImageFile(part: ImageFilePart): Promise<ContentPart> {
  const path = typeof part.path === "string" ? part.path : "";
  if (!path) return fallback(path, "path missing");

  try {
    // This is deliberately the same boundary used by llm/media-storage.ts:
    // only an explicit false means host fs; default/true uses the container
    // view. The MCP child never makes this choice itself.
    const bytes = part.inContainer === false
      ? await readHostBytes(path, MAX_MCP_IMAGE_BYTES)
      : Buffer.from(await sandboxFs.readBinary(path, MAX_MCP_IMAGE_BYTES + 1));
    if (bytes.length > MAX_MCP_IMAGE_BYTES) {
      return fallback(path, `larger than ${MAX_MCP_IMAGE_BYTES} bytes`);
    }
    const mimeType = checkedImageMime(bytes, part.mimeType);
    if (!mimeType) return fallback(path, "MIME does not match image bytes");
    return { type: "image", data: bytes.toString("base64"), mimeType };
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    return fallback(path, message.startsWith("ENOENT") ? "read failed" : message);
  }
}

async function readAudioFile(part: AudioFilePart): Promise<ContentPart> {
  const path = typeof part.path === "string" ? part.path : "";
  if (!path) return audioFallback(path, "path missing");

  try {
    // Keep the same host/container ownership boundary as image_file. The MCP
    // child never guesses whether a path is host-owned or container-visible.
    const bytes = part.inContainer === false
      ? await readHostBytes(path, MAX_MCP_AUDIO_BYTES)
      : Buffer.from(await sandboxFs.readBinary(path, MAX_MCP_AUDIO_BYTES + 1));
    if (bytes.length > MAX_MCP_AUDIO_BYTES) {
      return audioFallback(path, `larger than ${MAX_MCP_AUDIO_BYTES} bytes`);
    }
    const mimeType = checkedAudioMime(bytes, part.mimeType);
    if (!mimeType) return audioFallback(path, "MIME does not match audio bytes");
    return { type: "audio", data: bytes.toString("base64"), mimeType };
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    return audioFallback(path, message.startsWith("ENOENT") ? "read failed" : message);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const allowed = new Set(["type", ...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Runtime discriminator matching the public ContentPart union, not any object with a `type`. */
export function isStrictContentPart(value: unknown): value is ContentPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (typeof part.type !== "string") return false;
  switch (part.type) {
    case "text":
      return typeof part.text === "string" && hasOnlyKeys(part, ["text"], []);
    case "image":
    case "video":
    case "audio":
      return typeof part.data === "string"
        && typeof part.mimeType === "string"
        && hasOnlyKeys(part, ["data", "mimeType"], ["name"])
        && (part.name === undefined || typeof part.name === "string");
    case "text_file":
    case "file":
    case "image_file":
    case "video_file":
    case "audio_file":
      return typeof part.path === "string"
        && typeof part.mimeType === "string"
        && hasOnlyKeys(part, ["path", "mimeType"], ["inContainer"])
        && (part.inContainer === undefined || typeof part.inContainer === "boolean");
    default:
      return false;
  }
}

function isStrictContentPartArray(value: unknown): value is ContentPart[] {
  // An empty array is ambiguous ordinary JSON and must remain one text value.
  return Array.isArray(value) && value.length > 0 && value.every(isStrictContentPart);
}

async function normalizePart(part: ContentPart): Promise<ContentPart> {
  if (part.type === "image_file") return readImageFile(part);
  if (part.type === "audio_file") return readAudioFile(part);
  return part;
}

async function normalizeParts(parts: ContentPart[]): Promise<ContentPart[]> {
  return Promise.all(parts.map(normalizePart));
}

/**
 * Normalize only an explicit MCP-content response. Ordinary JSON is returned
 * unchanged so the caller's existing JSON/text semantics remain untouched.
 * Legacy ui_screenshot JSON strings are normalized only when their parsed
 * value is a real non-empty ContentPart[]; arbitrary JSON strings stay strings.
 */
export async function normalizeHostToolResultForMcp(result: unknown): Promise<unknown> {
  if (isStrictContentPartArray(result)) return normalizeParts(result);
  if (isStrictContentPart(result)) return normalizePart(result);
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result) as unknown;
      if (isStrictContentPartArray(parsed)) return JSON.stringify(await normalizeParts(parsed));
    } catch {
      // Keep ordinary text and malformed JSON unchanged.
    }
  }
  return result;
}
