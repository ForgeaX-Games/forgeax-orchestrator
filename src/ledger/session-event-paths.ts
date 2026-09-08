import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ResidentPathCodec,
  type ResidentLogicalPath,
} from "../fs/resident-agent-path";
import type {
  EventStoreLocator,
  ResolvedEventStorePaths,
} from "./types";

export type SafeRelativePath = string;

const RESERVED_ROOTS = new Set([
  "agents",
  "logs",
  "session.json",
  "blackboard.json",
  "file-activity.jsonl",
  "global-events.jsonl",
  "checkpoints.jsonl",
  "config",
  "runtime-state",
]);
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Session-scoped event path authority. Callers can choose the Session root
 * once; individual templates, registrations and tools cannot override it.
 */
export class SessionEventPaths {
  readonly runtimeEventsRoot: SafeRelativePath;
  private readonly sessionRoot: string;
  private readonly canonicalSessionRoot: string;
  private readonly codec = new ResidentPathCodec();

  constructor(sessionRoot: string, runtimeEventsRoot = "runtime-events") {
    this.sessionRoot = resolve(sessionRoot);
    if (!existsSync(this.sessionRoot)) {
      throw new Error(`session root does not exist: ${this.sessionRoot}`);
    }
    this.canonicalSessionRoot = realpathSync(this.sessionRoot);
    this.runtimeEventsRoot = validateRuntimeEventsRoot(runtimeEventsRoot);

    const runtimeRoot = join(this.sessionRoot, this.runtimeEventsRoot);
    assertNoSymbolicLinks(this.sessionRoot, runtimeRoot);
    mkdirSync(runtimeRoot, { recursive: true });
    this.assertContained(runtimeRoot);
    const stateRoot = join(this.sessionRoot, "runtime-state", "agents");
    assertNoSymbolicLinks(this.sessionRoot, stateRoot);
    mkdirSync(stateRoot, { recursive: true });
    this.assertContained(stateRoot);
  }

  resident(logicalPath: ResidentLogicalPath): EventStoreLocator {
    return Object.freeze({
      relativeDir: `agents/${this.codec.toPhysicalRelativePath(logicalPath)}/events`,
    });
  }

  ephemeral(instanceId: string): EventStoreLocator {
    if (!SAFE_INSTANCE_ID.test(instanceId)) {
      throw new Error(`invalid AgentInstanceId for event path: ${instanceId}`);
    }
    return Object.freeze({
      relativeDir: `${this.runtimeEventsRoot}/ephemeral/${instanceId}`,
    });
  }

  globalFile(): string {
    const file = join(this.sessionRoot, this.runtimeEventsRoot, "global-events.jsonl");
    assertNoSymbolicLinks(this.sessionRoot, file);
    this.assertContained(file);
    return file;
  }

  runtimeStateRoot(instanceId: string): string {
    if (!SAFE_INSTANCE_ID.test(instanceId)) {
      throw new Error(`invalid AgentInstanceId for runtime state path: ${instanceId}`);
    }
    const root = join(this.sessionRoot, "runtime-state", "agents", instanceId);
    assertNoSymbolicLinks(this.sessionRoot, root);
    this.assertContained(root);
    return root;
  }

  /** Runtime state is not template state. Ephemeral GC removes only this
   * exact, Session-contained instance directory; its EventStore stays durable. */
  removeRuntimeState(instanceId: string): void {
    const root = this.runtimeStateRoot(instanceId);
    rmSync(root, { recursive: true, force: true });
  }

  resolve(locator: EventStoreLocator): ResolvedEventStorePaths {
    const relativeDir = validateStoreRelativeDir(locator.relativeDir);
    const eventsDir = join(this.sessionRoot, relativeDir);
    assertNoSymbolicLinks(this.sessionRoot, eventsDir);
    this.assertContained(eventsDir);
    return Object.freeze({
      eventsDir,
      blobsDir: join(eventsDir, "blobs"),
    });
  }

  private assertContained(candidate: string): void {
    const nearestExisting = nearestExistingAncestor(candidate);
    const canonicalAncestor = realpathSync(nearestExisting);
    const tail = relative(nearestExisting, candidate);
    const canonicalCandidate = resolve(canonicalAncestor, tail);
    const rel = relative(this.canonicalSessionRoot, canonicalCandidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`event path escapes Session root: ${candidate}`);
    }
  }
}

export function validateRuntimeEventsRoot(raw: string): SafeRelativePath {
  const value = validateStoreRelativeDir(raw);
  const first = value.split("/")[0]!;
  if (RESERVED_ROOTS.has(first)) {
    throw new Error(`runtimeEventsRoot conflicts with reserved Session path: ${raw}`);
  }
  return value;
}

function validateStoreRelativeDir(raw: string): SafeRelativePath {
  if (
    !raw ||
    raw === "." ||
    isAbsolute(raw) ||
    raw.includes("\\") ||
    raw.includes("\0")
  ) {
    throw new Error(`event path must be a Session-relative POSIX path: ${JSON.stringify(raw)}`);
  }
  const normalized = normalize(raw).split(sep).join("/");
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`event path may not escape Session: ${JSON.stringify(raw)}`);
  }
  return normalized;
}

function assertNoSymbolicLinks(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`event path escapes Session root: ${candidate}`);
  }
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`event path contains symbolic link: ${current}`);
    }
  }
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) throw new Error(`event path has no existing ancestor: ${path}`);
    current = parent;
  }
  return current;
}
