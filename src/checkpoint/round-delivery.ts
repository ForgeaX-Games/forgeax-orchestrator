/**
 * Round delivery enrichment.
 *
 * The model supplies only the human-facing claim. This module derives the
 * machine-owned part from the checkpoint anchor, the current disk, and the
 * per-agent WAL. In particular, a disk diff alone is not an attribution
 * source: files changed by a human during the round stay out of `files`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getPathManager } from "../fs/path-manager";
import { getSessionManager } from "../core/session-manager";
import type { StoredEvent } from "../ledger/types";
import { canonicalToolName } from "../kernel/canonical-tool-name";
import {
  SnapshotStore,
  type DiffStats,
  type FileDiffStat,
  type Manifest,
} from "./snapshot-store";
import type {
  DeliveryContext,
  DeliveryEnricher,
  ArtifactResolver,
  ArtifactTurnContext,
} from "../orchestration-seams";
import type {
  DeliverSummary,
  DeliverSummaryClaim,
} from "@forgeax/types/deliver-summary";
import type {
  ArtifactResolution,
  ArtifactResolvedPayload,
  ArtifactSemantic,
  ArtifactSummary,
} from "@forgeax/types/artifact-summary";

export interface MessageRecord {
  kind: "message";
  msgId: string;
  ts: number;
  manifestId: string | null;
  /** Only records written by the new final-settle protocol are eligible for
   * host-owned artifact reconciliation. Legacy checkpoints remain valid for
   * the rewind/delivery APIs, but must never be guessed into a new artifact. */
  artifactResolutionExpected?: true;
  schemaVersion?: 2;
}

export interface RoundDeliveryLedger {
  readAllEvents(): Promise<StoredEvent[]>;
}

/** Narrow session surface used by the derivation. */
export interface RoundDeliverySession {
  sid: string;
  config: { defaultDir?: string };
  paths: { root(): string };
  ledgers: Map<string, RoundDeliveryLedger>;
  tree: { list(): Array<{ path: string }> };
  getOrCreateLedger(agentPath: string): RoundDeliveryLedger;
  fileActivity?: {
    query(opts?: { agent?: string; limit?: number; sinceTs?: number }): Array<{
      ts: number;
      agentPath: string;
      op: string;
      path: string;
      fromPath?: string;
      hash?: string;
      deleted?: boolean;
      isCreate?: boolean;
      toolCallId?: string;
      turnId?: string;
    }>;
  };
}

export interface RoundDeliveryGame {
  gameDir: string;
  store: SnapshotStore;
}

export interface RoundDeliveryDeps {
  resolveSession?: (sid: string) => Promise<RoundDeliverySession | null>;
  resolveGame?: (
    session: RoundDeliverySession,
    context: DeliveryContext,
  ) => RoundDeliveryGame | null;
  now?: () => number;
}

const MUTATING_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "multi_edit",
  "notebook_edit",
  "apply_patch",
  "patch",
  "delete",
  "delete_file",
  "unlink",
  "remove",
  "rm",
  "rename",
  "rename_file",
  "move",
  "move_file",
]);

const PATH_KEYS = [
  "path",
  "file",
  "filePath",
  "file_path",
  "filename",
  "notebook_path",
  "target",
  "destination",
  "destinationPath",
  "to",
  "toPath",
  "to_path",
  "from",
  "fromPath",
  "from_path",
  "oldPath",
  "old_path",
  "source",
  "sourcePath",
  "source_path",
  "newPath",
  "new_path",
] as const;

/** Read the last valid MessageRecord, rather than assuming the last JSONL row
 * is a message (rewind and overwrite records can follow it). */
export function readLastMessageRecord(indexFile: string): MessageRecord | null {
  let raw: string;
  try {
    raw = readFileSync(indexFile, "utf-8");
  } catch {
    return null;
  }

  let last: MessageRecord | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = parseMessageRecord(JSON.parse(line));
      if (record) last = record;
    } catch {
      /* Ignore a torn or malformed WAL line. */
    }
  }
  return last;
}

/** Read one exact checkpoint record. Matching by msgId is important: the
 * current disk must never be paired with a newer/older user's checkpoint just
 * because another turn completed while this one was being reconciled. */
export function readMessageRecord(indexFile: string, msgId: string): MessageRecord | null {
  let raw: string;
  try {
    raw = readFileSync(indexFile, "utf-8");
  } catch {
    return null;
  }

  let match: MessageRecord | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = parseMessageRecord(JSON.parse(line));
      if (record?.msgId === msgId) match = record;
    } catch {
      /* Ignore a torn or malformed WAL line. */
    }
  }
  return match;
}

/** Resolve the checkpoint immediately before a turn when a provider omitted
 * msgId from hook:turnStart. This is still fail-closed: only the explicit
 * artifact protocol marker is eligible. */
function readLatestExpectedMessageRecord(indexFile: string, beforeTs: number): MessageRecord | null {
  let raw: string;
  try {
    raw = readFileSync(indexFile, "utf-8");
  } catch {
    return null;
  }
  let latest: MessageRecord | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = parseMessageRecord(JSON.parse(line));
      if (
        record?.artifactResolutionExpected === true &&
        record.ts <= beforeTs &&
        (!latest || record.ts >= latest.ts)
      ) {
        latest = record;
      }
    } catch {
      /* Ignore a torn or malformed WAL line. */
    }
  }
  return latest;
}

function parseMessageRecord(value: unknown): MessageRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<MessageRecord>;
  if (
    record.kind !== "message" ||
    typeof record.msgId !== "string" ||
    typeof record.ts !== "number" ||
    (typeof record.manifestId !== "string" && record.manifestId !== null)
  ) return null;
  return {
    kind: "message",
    msgId: record.msgId,
    ts: record.ts,
    manifestId: record.manifestId,
    ...(record.artifactResolutionExpected === true ? { artifactResolutionExpected: true } : {}),
    ...(record.schemaVersion === 2 ? { schemaVersion: 2 } : {}),
  };
}

export class RoundDeliveryEnricher implements DeliveryEnricher, ArtifactResolver {
  private readonly deps: Required<Pick<RoundDeliveryDeps, "resolveSession" | "resolveGame" | "now">>;
  /** De-duplicate concurrent retries without caching a stale round result.
   * A later completed call is deliberately allowed to re-snapshot and replace
   * the previous result, matching the tool's last-call-wins contract. */
  private readonly inFlight = new Map<string, Promise<DeliverSummary>>();

  constructor(deps: RoundDeliveryDeps = {}) {
    this.deps = {
      resolveSession: deps.resolveSession ?? defaultResolveSession,
      resolveGame: deps.resolveGame ?? defaultResolveGame,
      now: deps.now ?? Date.now,
    };
  }

  enrich(claim: DeliverSummaryClaim, context?: DeliveryContext): Promise<DeliverSummary> {
    const sid = context?.sid;
    if (!sid) return Promise.resolve(unavailableSummary(claim));

    const existing = this.inFlight.get(sid);
    if (existing) return existing;

    const work = this.derive(claim, context).finally(() => {
      if (this.inFlight.get(sid) === work) this.inFlight.delete(sid);
    });
    this.inFlight.set(sid, work);
    return work;
  }

  /** Host-owned final-settle derivation used by the independent artifact
   * card. It intentionally does not call `enrich`: the model's semantic
   * deliver_summary claim and the machine-owned file manifest are separate
   * protocols and may arrive in either order. */
  async resolveTurn(context: ArtifactTurnContext): Promise<ArtifactResolvedPayload> {
    const artifactId = stableArtifactId(context.sid ?? "", context.turnId, context.checkpointMsgId);
    const terminal = (resolution: ArtifactResolution): ArtifactResolvedPayload => ({
      schemaVersion: 1,
      artifactId,
      turnId: context.turnId,
      ...(context.checkpointMsgId ? { checkpointMsgId: context.checkpointMsgId } : {}),
      ...(context.anchorSeq !== undefined ? { anchorSeq: context.anchorSeq } : {}),
      resolution,
    });
    const unavailable = (reason: string, reliableCandidatePaths: string[] = []): ArtifactResolvedPayload => {
      const summary: ArtifactSummary = {
        id: artifactId,
        sid: context.sid ?? "",
        turnId: context.turnId,
        ...(context.checkpointMsgId ? { checkpointMsgId: context.checkpointMsgId } : {}),
        files: [],
        status: "unavailable",
        derivedUnavailable: true,
        unavailableReason: reason,
        reliableCandidatePaths,
        agents: [context.agentId],
        durationMs: Math.max(0, context.settledAt - context.startedAt),
      };
      return terminal({ kind: "unavailable", reason, reliableCandidatePaths, summary });
    };

    if (!context.sid || !context.turnId) return terminal({ kind: "no_change" });

    let session: RoundDeliverySession | null;
    try {
      session = await this.deps.resolveSession(context.sid);
    } catch {
      return unavailable("Session state is unavailable");
    }
    if (!session) return unavailable("Session state is unavailable");

    const indexFile = `${session.paths.root()}/checkpoints.jsonl`;
    const record = context.checkpointMsgId
      ? readMessageRecord(indexFile, context.checkpointMsgId)
      : readLatestExpectedMessageRecord(indexFile, context.startedAt);
    // This marker is the compatibility and safety boundary. In particular,
    // old turns must not silently turn a current disk diff into an artifact.
    if (!record?.artifactResolutionExpected) {
      return terminal({ kind: "no_change" });
    }

    let game: RoundDeliveryGame | null;
    try {
      game = this.deps.resolveGame(session, context);
    } catch {
      return unavailable("Game workspace is unavailable");
    }
    if (!game) return unavailable("Game workspace is unavailable");

    // Read the causal evidence before loading the checkpoint manifest. A
    // successful host write can be recorded even when snapshot creation or
    // persistence failed; that case must surface an unavailable artifact with
    // reliable candidate paths instead of disappearing as no_change.
    let events: StoredEvent[] = [];
    try {
      events = await readRoundEvents(
        session,
        record.ts,
        Math.max(record.ts, context.settledAt),
        context.turnId,
      );
    } catch {
      return unavailable("Turn activity is unavailable");
    }
    const activity = readFileActivity(session, context, record.ts, context.settledAt);
    const externalActivity = externalArtifactFilesFromActivity(activity, game.gameDir, context.projectRoot);
    const touched = touchedPathsFromEvents(events, game.gameDir, context.projectRoot);
    for (const path of controlledManifestPathsFromEvents(events, game.gameDir, context.projectRoot)) touched.add(path);
    for (const path of touchedPathsFromActivity(activity, game.gameDir, context.projectRoot)) touched.add(path);

    if (!record.manifestId) {
      if (externalActivity.files.length > 0) {
        return terminal({
          kind: "summary",
          summary: artifactSummaryFromFiles(
            artifactId,
            context,
            record.msgId,
            externalActivity.files,
            externalActivity.conflicts,
            semanticFromEvents(events),
          ),
        });
      }
      return touched.size
        ? unavailable("Checkpoint manifest is unavailable", [...touched].sort())
        : terminal({ kind: "no_change" });
    }

    let roundStart: Manifest | null;
    try {
      roundStart = game.store.loadManifest(record.manifestId);
    } catch {
      return unavailable("Checkpoint manifest is unavailable", [...touched].sort());
    }
    if (!roundStart) return unavailable("Checkpoint manifest is unavailable", [...touched].sort());

    let stats: DiffStats;
    try {
      stats = await game.store.diffSince(game.gameDir, roundStart);
    } catch {
      return unavailable("Workspace diff is unavailable", [...touched].sort());
    }
    if (stats.files.length === 0) {
      if (externalActivity.files.length === 0) return terminal({ kind: "no_change" });
      return terminal({
        kind: "summary",
        summary: artifactSummaryFromFiles(
          artifactId,
          context,
          record.msgId,
          externalActivity.files,
          externalActivity.conflicts,
          semanticFromEvents(events),
        ),
      });
    }
    const candidatePaths = stats.files
      .map((file) => file.path)
      .filter((path) => touched.has(path));
    if (candidatePaths.length === 0 && externalActivity.files.length === 0) {
      return unavailable("Changed files could not be attributed to this turn", [...touched].sort());
    }

    const conflicted = conflictedActivityPaths(activity, stats.files.map((file) => file.path), game.gameDir, context.projectRoot);
    const attributed = stats.files.filter((file) => touched.has(file.path) && !conflicted.has(file.path));
    const unattributedCount = stats.files.length - attributed.length;
    const meta = roundMeta(events, unattributedCount);
    const semantic = semanticFromEvents(events);
    if (attributed.length === 0 && conflicted.size > 0 && externalActivity.files.length === 0) {
      return unavailable("Changed files were modified concurrently", [...conflicted].sort());
    }
    const reliableConflicts = [...conflicted, ...externalActivity.conflicts];
    const summary: ArtifactSummary = {
      id: artifactId,
      sid: context.sid,
      turnId: context.turnId,
      ...(record.msgId ? { checkpointMsgId: record.msgId } : {}),
      files: [...attributed.map(toArtifactFile), ...externalActivity.files],
      status: context.aborted || context.error || unattributedCount > 0 || reliableConflicts.length > 0 ? "partial" : "complete",
      ...(reliableConflicts.length > 0 ? { unavailableReason: "Changed files were modified concurrently", reliableCandidatePaths: reliableConflicts.sort() } : {}),
      ...(unattributedCount > 0 ? { unattributedCount } : {}),
      agents: meta.agents.length ? meta.agents : [context.agentId],
      durationMs: Math.max(0, context.settledAt - context.startedAt),
      ...(semantic ? { semantic } : {}),
    };
    return terminal({ kind: "summary", summary });
  }

  private async derive(
    claim: DeliverSummaryClaim,
    context: DeliveryContext,
  ): Promise<DeliverSummary> {
    const unavailable = () => unavailableSummary(claim);
    let session: RoundDeliverySession | null;
    try {
      session = await this.deps.resolveSession(context.sid!);
    } catch {
      return unavailable();
    }
    if (!session) return unavailable();

    let record: MessageRecord | null;
    try {
      record = readLastMessageRecord(`${session.paths.root()}/checkpoints.jsonl`);
    } catch {
      return unavailable();
    }
    if (!record?.manifestId) return unavailable();

    let game: RoundDeliveryGame | null;
    try {
      game = this.deps.resolveGame(session, context);
    } catch {
      return unavailable();
    }
    if (!game) return unavailable();

    let roundStart: Manifest | null;
    try {
      roundStart = game.store.loadManifest(record.manifestId);
    } catch {
      return unavailable();
    }
    if (!roundStart) return unavailable();

    let stats: DiffStats;
    try {
      // diffSince snapshots the current disk first. This is required because
      // line counts are computed from the CAS blobs, not by walking disk only.
      stats = await game.store.diffSince(game.gameDir, roundStart);
    } catch {
      return unavailable();
    }

    const now = this.deps.now();
    let events: StoredEvent[] = [];
    try {
      events = await readRoundEvents(session, record.ts, now);
    } catch {
      /* The diff remains useful even if WAL replay is unavailable. */
    }
    const touched = touchedPathsFromEvents(events, game.gameDir, context.projectRoot);
    for (const path of controlledManifestPathsFromEvents(events, game.gameDir, context.projectRoot)) touched.add(path);
    const attributed = stats.files.filter((file) => touched.has(file.path));
    const unattributedCount = stats.files.length - attributed.length;
    const meta = roundMeta(events, unattributedCount);

    return {
      ...claim,
      files: attributed.map(toDeliverFile),
      meta,
    };
  }
}

export function createRoundDeliveryEnricher(
  deps: RoundDeliveryDeps = {},
): DeliveryEnricher {
  return new RoundDeliveryEnricher(deps);
}

function unavailableSummary(claim: DeliverSummaryClaim): DeliverSummary {
  return {
    ...claim,
    files: [],
    meta: {
      durationMs: 0,
      agents: [],
      derivedUnavailable: true,
      unattributedCount: 0,
    },
  };
}

async function defaultResolveSession(sid: string): Promise<RoundDeliverySession | null> {
  const manager = getSessionManager();
  return (manager.peek(sid) ?? await manager.open(sid)) as unknown as RoundDeliverySession;
}

function defaultResolveGame(
  session: RoundDeliverySession,
  context: DeliveryContext,
): RoundDeliveryGame | null {
  const slug = session.config.defaultDir ?? context.game;
  if (!slug) return null;
  const user = getPathManager().user();
  return {
    gameDir: user.gameDir(slug),
    store: new SnapshotStore(user.checkpointsDir(slug)),
  };
}

async function readRoundEvents(
  session: RoundDeliverySession,
  startTs: number,
  endTs: number,
  turnId?: string,
): Promise<StoredEvent[]> {
  const paths = new Set<string>(session.ledgers.keys());
  for (const node of session.tree.list()) paths.add(node.path);

  const all: StoredEvent[] = [];
  for (const agentPath of paths) {
    let ledger = session.ledgers.get(agentPath);
    try {
      ledger ??= session.getOrCreateLedger(agentPath);
      all.push(...(await ledger.readAllEvents()).filter((event) => {
        if (event.ts < startTs || event.ts > endTs) return false;
        if (!turnId) return true;
        const payloadTurnId = typeof event.payload?.turnId === "string" ? event.payload.turnId : undefined;
        const eventTurnId = event.history?.turnId ?? payloadTurnId;
        // Tool events from a turn may not carry a turn id in old ledgers; the
        // explicit start/end window remains the compatibility fallback.
        return !eventTurnId || eventTurnId === turnId;
      }));
    } catch {
      /* A damaged agent shard should not prevent disk diff delivery. */
    }
  }
  return all.sort((a, b) => a.ts - b.ts);
}

type FileActivityView = {
  ts: number;
  agentPath: string;
  op: string;
  path: string;
  fromPath?: string;
  hash?: string;
  deleted?: boolean;
  isCreate?: boolean;
  toolCallId?: string;
  turnId?: string;
  phase?: "intent" | "applied";
};

/** Project files outside the active game do not belong to the game's CAS
 * checkpoint, but a host-owned file-activity record is still causal evidence
 * of a real turn mutation. Preserve those writes as independent artifacts so
 * docs/config/project changes cannot disappear merely because no game file was
 * touched. Game files continue to use SnapshotStore for exact line statistics. */
function externalArtifactFilesFromActivity(
  records: FileActivityView[],
  gameDir: string,
  projectRoot: string,
): { files: ArtifactSummary["files"]; conflicts: string[] } {
  const project = resolve(projectRoot);
  const game = resolve(gameDir);
  const latest = new Map<string, FileActivityView>();
  for (const record of records) {
    // CLI bridges publish an intent row before the subprocess mutates disk so
    // live activity UIs can react. Only the post-success applied row is causal
    // evidence for an Artifact; native recorder rows have no phase and remain
    // accepted because they are written after the host-owned operation.
    if (record.phase === "intent") continue;
    const raw = record.path.trim().replace(/^file:\/\//, "");
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(project, raw);
    const projectRelative = relative(project, absolute);
    if (!projectRelative || projectRelative === ".." || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) continue;
    const gameRelative = relative(game, absolute);
    const insideGame = gameRelative && gameRelative !== ".." && !gameRelative.startsWith(`..${sep}`) && !isAbsolute(gameRelative);
    if (insideGame) continue;
    const normalizedPath = sep === "/" ? projectRelative : projectRelative.split(sep).join("/");
    latest.set(normalizedPath, record);

    // A rename is one mutation but two filesystem facts. Preserve the source
    // tombstone as well as the destination so Artifact statistics remain
    // truthful for project files outside the active game's CAS checkpoint.
    if (record.fromPath) {
      const rawFrom = record.fromPath.trim().replace(/^file:\/\//, "");
      const absoluteFrom = isAbsolute(rawFrom) ? resolve(rawFrom) : resolve(project, rawFrom);
      const projectRelativeFrom = relative(project, absoluteFrom);
      const gameRelativeFrom = relative(game, absoluteFrom);
      const sourceInsideProject = projectRelativeFrom
        && projectRelativeFrom !== ".."
        && !projectRelativeFrom.startsWith(`..${sep}`)
        && !isAbsolute(projectRelativeFrom);
      const sourceInsideGame = gameRelativeFrom
        && gameRelativeFrom !== ".."
        && !gameRelativeFrom.startsWith(`..${sep}`)
        && !isAbsolute(gameRelativeFrom);
      if (sourceInsideProject && !sourceInsideGame) {
        const normalizedFrom = sep === "/" ? projectRelativeFrom : projectRelativeFrom.split(sep).join("/");
        latest.set(normalizedFrom, {
          ...record,
          path: absoluteFrom,
          fromPath: undefined,
          hash: undefined,
          isCreate: false,
          deleted: true,
        });
      }
    }
  }

  const files: ArtifactSummary["files"] = [];
  const conflicts: string[] = [];
  for (const [path, record] of latest) {
    const absolute = resolve(project, path);
    if (record.deleted === true) {
      if (existsSync(absolute)) {
        conflicts.push(path);
        continue;
      }
    } else if (record.hash) {
      const currentHash = hashFile(absolute);
      if (!currentHash || currentHash !== record.hash) {
        conflicts.push(path);
        continue;
      }
    }
    files.push({
      path,
      change: record.deleted === true ? "del" : record.isCreate === true ? "new" : "edit",
      insertions: 0,
      deletions: 0,
      binary: false,
    });
  }
  return { files, conflicts };
}

function artifactSummaryFromFiles(
  artifactId: string,
  context: ArtifactTurnContext,
  checkpointMsgId: string | undefined,
  files: ArtifactSummary["files"],
  conflicts: string[],
  semantic: ArtifactSemantic | undefined,
): ArtifactSummary {
  return {
    id: artifactId,
    sid: context.sid ?? "",
    turnId: context.turnId,
    ...(checkpointMsgId ? { checkpointMsgId } : {}),
    files,
    status: context.aborted || context.error || conflicts.length > 0 ? "partial" : "complete",
    ...(conflicts.length > 0 ? {
      unavailableReason: "Changed files were modified concurrently",
      reliableCandidatePaths: [...conflicts].sort(),
    } : {}),
    agents: [context.agentId],
    durationMs: Math.max(0, context.settledAt - context.startedAt),
    ...(semantic ? { semantic } : {}),
  };
}

function readFileActivity(
  session: RoundDeliverySession,
  context: ArtifactTurnContext,
  startTs: number,
  endTs: number,
): FileActivityView[] {
  if (!session.fileActivity) return [];
  try {
    return session.fileActivity.query({ agent: context.agentId, sinceTs: startTs, limit: 1000 })
      .filter((record) => record.ts <= endTs)
      .filter((record) => !record.turnId || record.turnId === context.turnId)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

function touchedPathsFromActivity(
  records: FileActivityView[],
  gameDir: string,
  executionRoot: string,
): Set<string> {
  const paths = new Set<string>();
  for (const record of records) {
    const normalized = normalizeGamePath(record.path, gameDir, executionRoot);
    if (normalized) paths.add(normalized);
    if (record.fromPath) {
      const from = normalizeGamePath(record.fromPath, gameDir, executionRoot);
      if (from) paths.add(from);
    }
  }
  return paths;
}

/** File-activity is an attribution source, not blind proof. When a recorder
 * captured a cheap post-write hash, compare it with the settled workspace. A
 * mismatch means another actor changed the same path after the agent write, so
 * that path must not be presented as a clean agent artifact. */
function conflictedActivityPaths(
  records: FileActivityView[],
  changedPaths: string[],
  gameDir: string,
  executionRoot: string,
): Set<string> {
  const latest = new Map<string, FileActivityView>();
  for (const record of records) {
    const normalized = normalizeGamePath(record.path, gameDir, executionRoot);
    if (normalized) latest.set(normalized, record);
  }
  const conflicts = new Set<string>();
  for (const path of changedPaths) {
    const record = latest.get(path);
    if (!record) continue;
    const absolute = resolve(gameDir, path);
    if (record.deleted === true) {
      if (existsSync(absolute)) conflicts.add(path);
      continue;
    }
    if (!record.hash) continue;
    const currentHash = hashFile(absolute);
    if (!currentHash || currentHash !== record.hash) conflicts.add(path);
  }
  return conflicts;
}

function hashFile(path: string): string | undefined {
  try {
    const content = readFileSync(path);
    if (content.byteLength > 1 * 1024 * 1024) return undefined;
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

function touchedPathsFromEvents(
  events: StoredEvent[],
  gameDir: string,
  executionRoot: string,
): Set<string> {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "hook:toolCall") continue;
    const payload = event.payload ?? {};
    const nested = asRecord(payload.toolCall);
    const rawName =
      stringValue(payload.name) ??
      stringValue(nested?.name);
    if (!rawName || !MUTATING_TOOLS.has(canonicalToolName(rawName))) continue;
    const args = payload.args ?? payload.arguments ?? nested?.arguments;
    for (const candidate of extractPathValues(args, canonicalToolName(rawName))) {
      const normalized = normalizeGamePath(candidate, gameDir, executionRoot);
      if (normalized) paths.add(normalized);
    }
  }
  return paths;
}

/**
 * Opaque shell/MCP/editor tools cannot be attributed from a generic tool
 * argument.  They may opt into the same causal set only through a host-owned
 * manifest delta on the tool-result event.  The explicit marker is important:
 * a model-returned `fileManifest` is data, not proof of a disk write.
 */
function controlledManifestPathsFromEvents(
  events: StoredEvent[],
  gameDir: string,
  executionRoot: string,
): Set<string> {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "hook:toolResult") continue;
    const payload = event.payload ?? {};
    if (payload.hostOwned !== true) continue;
    for (const key of ["fileManifest", "manifestDelta", "changedFiles"] as const) {
      for (const candidate of extractManifestPathValues(payload[key])) {
        const normalized = normalizeGamePath(candidate, gameDir, executionRoot);
        if (normalized) paths.add(normalized);
      }
    }
  }
  return paths;
}

function extractManifestPathValues(value: unknown): string[] {
  const result: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === "string" && current.trim()) {
      result.push(current);
      return;
    }
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const object = current as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      const candidate = object[key];
      if (typeof candidate === "string" && candidate.trim()) result.push(candidate);
    }
    for (const key of ["files", "paths", "changed", "added", "modified", "deleted", "created", "removed", "entries", "operations"]) {
      visit(object[key]);
    }
  };
  visit(value);
  return result;
}

function extractPathValues(args: unknown, toolName: string): string[] {
  const result: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      const candidate = object[key];
      if (typeof candidate === "string" && candidate.trim()) result.push(candidate);
    }
    for (const key of ["files", "edits", "changes", "operations"]) visit(object[key]);
  };
  visit(args);

  if (toolName === "apply_patch") {
    const patch = asRecord(args)?.patch;
    if (typeof patch === "string") {
      const re = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
      for (const match of patch.matchAll(re)) result.push(match[1]!);
    }
  }
  return result;
}

/** Fold a tool-reported path onto the game-relative form the snapshot diff uses.
 *
 * A relative candidate must be resolved against `executionRoot`, not `gameDir`:
 * every kernel runs with cwd = the project root (`forgeax-core-kernel.ts`
 * spawns `serve` with `cwd: projectRoot`) and the prompt's `# Environment`
 * declares that same root, so the model's `file_path` is project-root relative
 * (observed: `.forgeax/games/<slug>/src/x.md`). Resolving it against `gameDir`
 * double-prefixes the slug, and the resulting key never matches a diff entry.
 * A path outside the game returns null — it is a real change, but not a game
 * deliverable, so it stays in `unattributedCount` instead of the file list.
 */
function normalizeGamePath(
  candidate: string,
  gameDir: string,
  executionRoot: string,
): string | null {
  const raw = candidate.trim().replace(/^file:\/\//, "");
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(executionRoot, raw);
  const rel = relative(resolve(gameDir), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return (sep === "/" ? rel : rel.split(sep).join("/"));
}

function toDeliverFile(file: FileDiffStat): DeliverSummary["files"][number] {
  return {
    path: file.path,
    change: file.status === "modified" ? "edit" : file.status === "added" ? "new" : "del",
    insertions: file.insertions,
    deletions: file.deletions,
    binary: file.binary,
  };
}

function toArtifactFile(file: FileDiffStat): ArtifactSummary["files"][number] {
  return {
    path: file.path,
    change: file.status === "modified" ? "edit" : file.status === "added" ? "new" : "del",
    insertions: file.insertions,
    deletions: file.deletions,
    binary: file.binary,
  };
}

function stableArtifactId(sid: string, turnId: string, checkpointMsgId?: string): string {
  return createHash("sha256")
    .update(`${sid}\0${turnId}\0${checkpointMsgId ?? ""}`)
    .digest("hex");
}

function roundMeta(
  events: StoredEvent[],
  unattributedCount: number,
): DeliverSummary["meta"] {
  const agents = new Set<string>();
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  for (const event of events) {
    firstTs = firstTs === undefined ? event.ts : Math.min(firstTs, event.ts);
    lastTs = lastTs === undefined ? event.ts : Math.max(lastTs, event.ts);
    const agent = event.emitterId ?? agentFromSource(event.source);
    if (agent) agents.add(agent);
  }

  const turnCosts = events
    .filter((event) => event.type === "hook:turnEnd")
    .map((event) => costFromPayload(event.payload))
    .filter((cost): cost is number => cost !== undefined);
  const assistantCosts = events
    .filter((event) => event.type === "hook:assistantMessage")
    .map((event) => costFromPayload(event.payload))
    .filter((cost): cost is number => cost !== undefined);
  const costs = turnCosts.length ? turnCosts : assistantCosts;
  const costUsd = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined;

  return {
    durationMs: firstTs !== undefined && lastTs !== undefined
      ? Math.max(0, lastTs - firstTs)
      : 0,
    agents: [...agents].sort(),
    ...(costUsd !== undefined ? { costUsd } : {}),
    unattributedCount,
  };
}

function costFromPayload(payload: Record<string, unknown> | undefined): number | undefined {
  const object = asRecord(payload);
  const usage = asRecord(object?.usage) ?? asRecord(asRecord(object?.llmMessage)?.usage);
  const candidates = [
    usage?.costUsd,
    usage?.cost_usd,
    usage?.totalCostUsd,
    usage?.total_cost_usd,
    usage?.cost,
    object?.costUsd,
    object?.cost,
  ];
  return candidates.find((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
}

/** Keep the model-authored conclusion that belongs in the artifact card, while
 * leaving files, duration, agents and counts host-owned.  Tool-result events
 * differ by provider: native paths carry `result`, while the in-process tool
 * runner carries an `llmMessage`.  Both are read as a best-effort semantic
 * projection and are never allowed to manufacture an artifact by themselves. */
function semanticFromEvents(events: StoredEvent[]): ArtifactSemantic | undefined {
  let claimed: ArtifactSemantic | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "hook:toolResult") continue;
    const payload = event.payload ?? {};
    const name = stringValue(payload.name);
    if (!name || canonicalToolName(name) !== "deliver_summary") continue;
    const raw = payload.result ?? extractLlmResult(payload.llmMessage);
    const value = parseJsonValue(raw);
    const envelope = asRecord(value);
    const summary = asRecord(envelope?.summary) ?? envelope;
    if (!summary) continue;
    const outcome = typeof summary.outcome === "string" && summary.outcome.trim()
      ? summary.outcome.trim() : undefined;
    const tests = Array.isArray(summary.tests)
      ? summary.tests.flatMap((item): NonNullable<ArtifactSemantic["tests"]> => {
        const test = asRecord(item);
        if (!test || typeof test.name !== "string") return [];
        const pass = typeof test.pass === "boolean"
          ? test.pass
          : typeof test.ok === "boolean" ? test.ok : undefined;
        return pass === undefined ? [] : [{
          name: test.name,
          pass,
          ...(typeof test.detail === "string" ? { detail: test.detail } : {}),
        }];
      })
      : undefined;
    const next = Array.isArray(summary.next)
      ? summary.next.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5)
      : undefined;
    const build = typeof summary.build === "string"
      ? summary.build
      : asRecord(summary.build)?.version && typeof asRecord(summary.build)?.version === "string"
        ? asRecord(summary.build)!.version as string
        : undefined;
    if (!outcome && !tests?.length && !next?.length && !build) continue;
    claimed = {
      ...(outcome ? { outcome } : {}),
      ...(tests?.length ? { tests } : {}),
      ...(next?.length ? { next } : {}),
      ...(build ? { build } : {}),
    };
    break;
  }

  const outcome = meaningfulOutcome(claimed?.outcome) ?? outcomeFromAssistant(events);
  const tests = claimed?.tests?.length ? claimed.tests : testsFromEvents(events);
  const next = claimed?.next?.length ? claimed.next.slice(0, 5) : undefined;
  if (!outcome && !tests?.length && !next?.length && !claimed?.build) return undefined;
  return {
    ...(outcome ? { outcome } : {}),
    ...(tests?.length ? { tests } : {}),
    ...(next?.length ? { next } : {}),
    ...(claimed?.build ? { build: claimed.build } : {}),
  };
}

function meaningfulOutcome(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || /^(?:done|completed|implemented|finished|完成|已完成|搞定)[.!。！]?$/i.test(text)) return undefined;
  return text;
}

function outcomeFromAssistant(events: StoredEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "hook:assistantMessage") continue;
    const payload = event.payload ?? {};
    const text = extractLlmResult(payload.llmMessage ?? payload.message ?? payload.text);
    if (typeof text !== "string") continue;
    const points = text
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length >= 8 && !/^https?:\/\//i.test(line))
      .slice(0, 5);
    if (points.length) return points.map((point) => `- ${point}`).join("\n");
  }
  return undefined;
}

function testsFromEvents(events: StoredEvent[]): NonNullable<ArtifactSemantic["tests"]> | undefined {
  const calls = new Map<string, { name: string; command?: string }>();
  const tests: NonNullable<ArtifactSemantic["tests"]> = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    const callId = stringValue(payload.callId) ?? stringValue(asRecord(payload.toolCall)?.id);
    if (event.type === "hook:toolCall") {
      const name = stringValue(payload.name) ?? "";
      const args = asRecord(payload.args) ?? asRecord(asRecord(payload.toolCall)?.arguments);
      const command = [args?.cmd, args?.command, args?.script].find((value): value is string => typeof value === "string");
      if (callId) calls.set(callId, { name, ...(command ? { command } : {}) });
      continue;
    }
    if (event.type !== "hook:toolResult" || !callId) continue;
    const call = calls.get(callId);
    if (!call) continue;
    const label = call.command ?? call.name;
    if (!/(?:^|\s|:|\/)(?:test|check|lint|typecheck|build)(?:\s|$|:)/i.test(label)) continue;
    const ok = typeof payload.ok === "boolean" ? payload.ok : !payload.error;
    tests.push({
      name: label.replace(/\s+/g, " ").trim().slice(0, 100),
      pass: ok,
      ...(typeof payload.error === "string" ? { detail: payload.error.slice(0, 200) } : {}),
    });
  }
  return tests.length ? tests.slice(0, 20) : undefined;
}

function extractLlmResult(value: unknown): unknown {
  const message = asRecord(value);
  if (!message) return value;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return value;
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object" && !Array.isArray(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const raw = value.trim().replace(/^\[deliver_summary\]\s*/i, "");
  try { return JSON.parse(raw) as unknown; } catch { return value; }
}

function agentFromSource(source: string | undefined): string | undefined {
  return source?.startsWith("agent:") ? source.slice("agent:".length) || undefined : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
