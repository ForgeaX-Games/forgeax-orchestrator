/**
 * Deterministic offline enumeration for all per-instance EventStores in a
 * Session. It never infers liveness from history and never includes global
 * events in instance/usage scans.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ResidentPathCodec } from "../fs/resident-agent-path";
import { validateRuntimeEventsRoot } from "./session-event-paths";

export interface PersistedInstanceEventStore {
  readonly kind: "resident" | "ephemeral";
  readonly ownerId: string;
  readonly storeId: string;
  readonly eventsDir: string;
  readonly blobsDir: string;
}

export function readRuntimeEventsRoot(sessionRoot: string): string {
  const configFile = join(sessionRoot, "session.json");
  let configured = "runtime-events";
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8")) as {
      runtimeEventsRoot?: unknown;
    };
    if (typeof parsed.runtimeEventsRoot === "string") {
      configured = parsed.runtimeEventsRoot;
    }
  } catch {
    // Legacy Session: use the default runtime-events root.
  }
  return validateRuntimeEventsRoot(configured);
}

export function listPersistedInstanceEventStores(
  rawSessionRoot: string,
): readonly PersistedInstanceEventStore[] {
  const sessionRoot = resolve(rawSessionRoot);
  if (!existsSync(sessionRoot)) return [];
  const stores: PersistedInstanceEventStore[] = [];
  const codec = new ResidentPathCodec();
  const agentsRoot = join(sessionRoot, "agents");

  const walkResidents = (physicalParent: string, logicalParent?: string) => {
    for (const name of safeDirectoryNames(physicalParent)) {
      const agentRoot = join(physicalParent, name);
      const logicalPath = logicalParent ? `${logicalParent}/${name}` : name;
      const eventsDir = join(agentRoot, "events");
      if (existsSync(eventsDir) && isContained(sessionRoot, eventsDir)) {
        const canonicalLogicalPath = codec.normalizeLogicalPath(logicalPath);
        stores.push({
          kind: "resident",
          ownerId: canonicalLogicalPath,
          storeId: `resident:${canonicalLogicalPath}`,
          eventsDir,
          blobsDir: join(eventsDir, "blobs"),
        });
      }
      walkResidents(join(agentRoot, "agents"), logicalPath);
    }
  };
  walkResidents(agentsRoot);

  let runtimeEventsRoot: string;
  try {
    runtimeEventsRoot = readRuntimeEventsRoot(sessionRoot);
  } catch {
    return Object.freeze(stores.sort(compareStores));
  }
  const ephemeralRoot = join(sessionRoot, runtimeEventsRoot, "ephemeral");
  for (const instanceId of safeDirectoryNames(ephemeralRoot)) {
    const eventsDir = join(ephemeralRoot, instanceId);
    if (!isContained(sessionRoot, eventsDir)) continue;
    stores.push({
      kind: "ephemeral",
      ownerId: instanceId,
      storeId: `ephemeral:${instanceId}`,
      eventsDir,
      blobsDir: join(eventsDir, "blobs"),
    });
  }
  return Object.freeze(stores.sort(compareStores));
}

export function listSessionGlobalEventFiles(rawSessionRoot: string): readonly string[] {
  const sessionRoot = resolve(rawSessionRoot);
  if (!existsSync(sessionRoot)) return [];
  const files: string[] = [];
  try {
    const runtimeRoot = readRuntimeEventsRoot(sessionRoot);
    const current = join(sessionRoot, runtimeRoot, "global-events.jsonl");
    if (existsSync(current) && isContained(sessionRoot, current)) files.push(current);
  } catch {
    // Invalid config is ignored by offline compatibility readers.
  }
  const legacy = join(sessionRoot, "global-events.jsonl");
  if (existsSync(legacy)) files.push(legacy);
  return Object.freeze([...new Set(files)]);
}

export function listEventShards(eventsDir: string): readonly string[] {
  const shards: Array<{ index: number; path: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(eventsDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const match = /^events-(\d+)\.jsonl$/.exec(name);
    if (!match) continue;
    shards.push({ index: Number(match[1]), path: join(eventsDir, name) });
  }
  shards.sort((a, b) => a.index - b.index);
  return Object.freeze(shards.map((shard) => shard.path));
}

function safeDirectoryNames(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!name || name.startsWith(".")) return false;
    try {
      const stat = lstatSync(join(dir, name));
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }).sort();
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function compareStores(
  a: PersistedInstanceEventStore,
  b: PersistedInstanceEventStore,
): number {
  return a.storeId.localeCompare(b.storeId);
}
