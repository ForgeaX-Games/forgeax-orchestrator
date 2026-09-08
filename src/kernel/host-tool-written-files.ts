/**
 * Host-owned write evidence for kit/plugin tools executed by the host.
 *
 * Native write/edit tools are attributed from tool-call arguments. Opaque kit
 * tools write through their own process and only return JSON, so a disk diff
 * alone must not become an artifact (human edits during the round stay out).
 *
 * This module records file-activity only after the host actually ran the kit
 * tool. It never reads a model-emitted tool result. Plugin bridges stringify
 * the host `callTool` payload, so a top-level JSON object string is still a
 * host result — nested strings and model-shaped envelopes are not parsed.
 * Claimed paths are admitted only when they resolve inside the session-bound
 * game and exist on disk.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileActivityRecord } from "../ledger/file-activity-ledger";
import { getPathManager } from "../fs/path-manager";

const MAX_PATHS = 32;
const MAX_HASH_BYTES = 1024 * 1024;
const MAX_JSON_CHARS = 256_000;

const WRITE_KEYS = ["assetPath", "outputPath", "writtenPath"] as const;
const LIST_KEYS = ["files", "changedFiles", "fileManifest"] as const;
const ENTRY_PATH_KEYS = ["assetPath", "outputPath", "writtenPath", "path", "file", "filePath", "file_path"] as const;
const MARKER_KEYS = ["change", "op", "action", "kind"] as const;
const WRITE_MARKERS = new Set([
  "new", "write", "written", "add", "added", "create", "created",
  "edit", "edited", "modify", "modified", "update", "updated",
  "delete", "deleted", "del", "remove", "removed",
  "rename", "renamed", "patch", "patched",
]);

export interface HostToolWriteSession {
  config?: { defaultDir?: string };
  fileActivity?: { append(record: FileActivityRecord): void };
  eventBus?: {
    publish(event: {
      type: string;
      ts: number;
      source: string;
      payload: Record<string, unknown>;
    }, emitterId?: string): void;
  };
}

/** Absolute game-contained files named by a host-executed kit result. */
export function extractHostWrittenPaths(result: unknown, gameDir: string): string[] {
  const joinRoot = resolve(gameDir);
  if (!existsSync(joinRoot)) return [];
  const realRoot = resolvedDir(joinRoot) ?? joinRoot;
  const claimed: string[] = [];
  collectClaimedPaths(coerceHostResult(result), claimed);
  const unique = new Set<string>();
  const admitted: string[] = [];
  for (const candidate of claimed) {
    if (admitted.length >= MAX_PATHS) break;
    const absolute = admitPath(candidate, joinRoot, realRoot);
    if (!absolute || unique.has(absolute)) continue;
    unique.add(absolute);
    admitted.push(absolute);
  }
  return admitted;
}

export function recordSessionHostToolWrites(
  session: HostToolWriteSession,
  opts: { result: unknown; agentPath: string; toolCallId?: string; gameSlug?: string },
): string[] {
  try {
    const slug = opts.gameSlug?.trim() || session.config?.defaultDir?.trim();
    if (!slug || !session.fileActivity) return [];
    const gameDir = getPathManager().user().gameDir(slug);
    const paths = extractHostWrittenPaths(opts.result, gameDir);
    if (paths.length === 0) return [];
    const ts = Date.now();
    for (const path of paths) {
      const hash = hashFile(path);
      const record: FileActivityRecord = {
        ts,
        agentPath: opts.agentPath,
        op: "write",
        path,
        ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
        phase: "applied",
        ...(hash ? { hash } : {}),
      };
      session.fileActivity.append(record);
      try {
        session.eventBus?.publish(
          {
            type: "file-activity:done",
            ts,
            source: `agent:${opts.agentPath}`,
            payload: record as unknown as Record<string, unknown>,
          },
          opts.agentPath,
        );
      } catch {
        /* UI notify must never fail the tool. */
      }
    }
    return paths;
  } catch {
    return [];
  }
}

function collectClaimedPaths(result: unknown, out: string[]): void {
  const object = asObject(result);
  if (!object || isFailedResult(object)) return;
  collectWriteKeys(object, out);
  const manifest = asObject(object.manifest);
  if (manifest) collectWriteKeys(manifest, out);
  for (const key of LIST_KEYS) {
    collectList(object[key], out);
    if (manifest) collectList(manifest[key], out);
  }
}

function collectWriteKeys(object: Record<string, unknown>, out: string[]): void {
  for (const key of WRITE_KEYS) pushString(object[key], out);
}

function isFailedResult(object: Record<string, unknown>): boolean {
  if (object.ok === false) return true;
  return "error" in object && object.ok !== true;
}

function collectList(value: unknown, out: string[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    // Bare strings are listings, not writes. A host write list must name a
    // path *and* carry a write marker so a reader-shaped result cannot
    // attribute a file that already existed on disk.
    if (typeof item === "string") continue;
    const object = asObject(item);
    if (!object || !hasWriteMarker(object)) continue;
    for (const key of ENTRY_PATH_KEYS) pushString(object[key], out);
  }
}

function hasWriteMarker(object: Record<string, unknown>): boolean {
  for (const key of MARKER_KEYS) {
    const value = object[key];
    if (typeof value === "string" && WRITE_MARKERS.has(value.toLowerCase())) return true;
  }
  return false;
}

/** Host plugin tools stringify `callTool` results. Parse only a top-level
 *  object; never walk nested strings or arrays of mixed content. */
function coerceHostResult(result: unknown): unknown {
  if (typeof result === "string") return parseJsonObject(result) ?? result;
  if (Array.isArray(result) && result.length === 1) {
    const part = asObject(result[0]);
    if (part?.type === "text" && typeof part.text === "string") {
      return parseJsonObject(part.text) ?? result;
    }
  }
  return result;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text || text.length > MAX_JSON_CHARS || text[0] !== "{") return null;
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function pushString(value: unknown, out: string[]): void {
  if (typeof value === "string" && value.trim()) out.push(value.trim());
}

function admitPath(candidate: string, joinRoot: string, realRoot: string): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  const raw = candidate.replace(/^file:\/\//, "");
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(joinRoot, raw);
  if (!existsSync(absolute)) return null;
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return null;
  }
  let realTarget = absolute;
  if (stat.isSymbolicLink()) {
    try { realTarget = realpathSync(absolute); } catch { return null; }
  } else {
    try { realTarget = realpathSync(absolute); } catch { realTarget = absolute; }
  }
  if (!contained(realRoot, realTarget)) return null;
  try {
    if (!statSync(realTarget).isFile()) return null;
  } catch {
    return null;
  }
  return absolute;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolvedDir(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return existsSync(dir) ? resolve(dir) : null;
  }
}

function hashFile(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_HASH_BYTES) return undefined;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
