/**
 * Best-effort, asynchronous audit projection for the NPC memory boundary.
 *
 * This JSONL file is deliberately NOT a recovery ledger: provider receipts and
 * the durable memory outbox remain the authority for memory state and command
 * delivery.  Losing an audit row must never affect a game decision or cause a
 * command to be replayed.  The sink therefore uses a bounded best-effort queue
 * and exposes a drain only for orderly process shutdown.
 */
import { appendFile, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { AsyncLedgerWriter } from '../../session/async-ledger-writer';

const AUDIT_DIR_PARTS = ['.forgeax', 'npc-brain', 'audit'] as const;
const AUDIT_FILE = 'memory-audit.v1.jsonl';
const DEFAULT_HIGH_WATER = 1_000;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ROTATIONS = 5;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_STRING_CHARS = 16_384;
const MAX_JSON_DEPTH = 12;
const MAX_ARRAY_ITEMS = 1_000;

export type NpcMemoryAuditSource = 'brain' | 'provider';

/**
 * Correlation fields are optional on purpose: this sink preserves identifiers
 * supplied by a caller and never mints a requestId/eventId to make unrelated
 * work appear joined. `error` and `detail` are normalized to JSON before write.
 */
export interface NpcMemoryAuditRecordInput {
  readonly source: NpcMemoryAuditSource;
  readonly at?: number;
  readonly requestId?: string;
  readonly eventId?: string;
  readonly ownerNpcId?: string;
  readonly subject?: unknown;
  readonly providerId?: string;
  readonly operation?: string;
  readonly commandId?: string;
  readonly status?: string;
  readonly latencyMs?: number;
  readonly error?: unknown;
  readonly detail?: unknown;
}

export interface NpcMemoryAuditSinkOptions {
  /** Absolute product root. Records always live below its fixed audit path. */
  readonly projectRoot: string;
  /** Pending best-effort records; older records are dropped at this bound. */
  readonly highWater?: number;
  /** Rotate before the next append once the active projection reaches this size. */
  readonly maxFileBytes?: number;
  readonly now?: () => number;
  /** Diagnostic hook only. It is isolated from the game/audit caller. */
  readonly onError?: (error: unknown) => void;
}

export interface NpcMemoryAuditSink {
  /** Enqueue one audit projection. Best-effort: this method never throws. */
  write(record: NpcMemoryAuditRecordInput): void;
  /** Wait for currently admitted audit writes. This never throws. */
  drain(): Promise<void>;
  /** Close admission, drain existing records, then release queue ownership. */
  stop(): Promise<void>;
  readonly dropped: number;
  readonly pending: number;
  readonly path: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
type NormalizedRecord = Readonly<Record<string, JsonValue>>;

function positiveInteger(value: number | undefined, label: string, fallback = DEFAULT_HIGH_WATER): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new TypeError(`${label} must be a positive integer`);
  return result;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function boundedString(value: string, label: string): string {
  if (value.length === 0 || value.length > MAX_STRING_CHARS || hasControlCharacters(value)) {
    throw new TypeError(`${label} must be a non-empty bounded string without control characters`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return boundedString(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function normalizeError(error: unknown): JsonValue {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === 'string'
      ? (error as Error & { code: string }).code
      : undefined;
    return {
      name: error.name || 'Error',
      message: error.message.slice(0, MAX_STRING_CHARS),
      ...(code === undefined ? {} : { code: code.slice(0, MAX_STRING_CHARS) }),
    };
  }
  return normalizeJson(error, new WeakSet<object>(), 0);
}

function normalizeJson(value: unknown, seen: WeakSet<object>, depth: number): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (depth >= MAX_JSON_DEPTH) return '[max-depth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeJson(item, seen, depth + 1));
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).slice(0, MAX_ARRAY_ITEMS)) {
      result[key.slice(0, MAX_STRING_CHARS)] = normalizeJson((value as Record<string, unknown>)[key], seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function normalizeRecord(input: NpcMemoryAuditRecordInput, now: () => number): NormalizedRecord {
  if (!input || typeof input !== 'object') throw new TypeError('NPC memory audit record is required');
  if (input.source !== 'brain' && input.source !== 'provider') throw new TypeError('NPC memory audit source must be brain or provider');
  const at = input.at ?? now();
  if (!Number.isFinite(at)) throw new TypeError('NPC memory audit at must be finite');
  const latencyMs = optionalFiniteNumber(input.latencyMs, 'NPC memory audit latencyMs');
  const record: Record<string, JsonValue> = {
    version: 1,
    at,
    source: input.source,
  };
  for (const [key, value] of [
    ['requestId', optionalString(input.requestId, 'NPC memory audit requestId')],
    ['eventId', optionalString(input.eventId, 'NPC memory audit eventId')],
    ['ownerNpcId', optionalString(input.ownerNpcId, 'NPC memory audit ownerNpcId')],
    ['providerId', optionalString(input.providerId, 'NPC memory audit providerId')],
    ['operation', optionalString(input.operation, 'NPC memory audit operation')],
    ['commandId', optionalString(input.commandId, 'NPC memory audit commandId')],
    ['status', optionalString(input.status, 'NPC memory audit status')],
  ] as const) {
    if (value !== undefined) record[key] = value;
  }
  if (latencyMs !== undefined) record.latencyMs = latencyMs;
  if (input.subject !== undefined) record.subject = normalizeJson(input.subject, new WeakSet<object>(), 0);
  if (input.error !== undefined) record.error = normalizeError(input.error);
  if (input.detail !== undefined) record.detail = normalizeJson(input.detail, new WeakSet<object>(), 0);
  return Object.freeze(record);
}

async function assertNoSymlinkComponents(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || hasControlCharacters(path)) throw new TypeError(`${label} contains an unsafe path`);
  const absolute = resolve(path);
  const parts = absolute.split(sep);
  let current = parts[0] === '' ? sep : parts[0];
  for (const component of parts.slice(parts[0] === '' ? 1 : 0)) {
    if (!component) continue;
    current = join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() && !isSystemPathAlias(current)) {
        throw new TypeError(`${label} cannot contain symlink or junction: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function isSystemPathAlias(path: string): boolean {
  return process.platform === 'darwin' && (path === '/var' || path === '/tmp');
}

/** Create the non-authoritative NPC memory audit projection. */
export function createNpcMemoryAuditSink(options: NpcMemoryAuditSinkOptions): NpcMemoryAuditSink {
  if (!options || typeof options !== 'object') throw new TypeError('NPC memory audit sink options are required');
  if (typeof options.projectRoot !== 'string' || !isAbsolute(options.projectRoot) || hasControlCharacters(options.projectRoot)) {
    throw new TypeError('NPC memory audit projectRoot must be an absolute safe path');
  }
  const projectRoot = resolve(options.projectRoot);
  const auditDir = join(projectRoot, ...AUDIT_DIR_PARTS);
  const path = join(auditDir, AUDIT_FILE);
  const highWater = positiveInteger(options.highWater, 'NPC memory audit highWater');
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    'NPC memory audit maxFileBytes',
    DEFAULT_MAX_FILE_BYTES,
  );
  const now = options.now ?? Date.now;
  const writer = new AsyncLedgerWriter(`npc-memory-audit:${projectRoot}`, { highWater });
  let stopped = false;
  let activeFileBytes: number | undefined;

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* diagnostics never own gameplay */ }
  };

  const moveIfPresent = async (from: string, to: string): Promise<void> => {
    try {
      await rm(to, { force: true });
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };

  const rotate = async (): Promise<void> => {
    await rm(`${path}.${MAX_ROTATIONS}`, { force: true });
    for (let index = MAX_ROTATIONS - 1; index >= 1; index -= 1) {
      await moveIfPresent(`${path}.${index}`, `${path}.${index + 1}`);
    }
    await moveIfPresent(path, `${path}.1`);
    activeFileBytes = 0;
  };

  const append = async (record: NormalizedRecord): Promise<void> => {
    try {
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new RangeError('NPC memory audit record exceeds byte limit');
      await assertNoSymlinkComponents(projectRoot, 'NPC memory audit projectRoot');
      // Check the whole fixed target before mkdir: an existing `.forgeax` or
      // `npc-brain` link could otherwise make mkdir create directories outside
      // the product root before the post-create verification rejects it.
      await assertNoSymlinkComponents(auditDir, 'NPC memory audit directory');
      await mkdir(auditDir, { recursive: true });
      await assertNoSymlinkComponents(auditDir, 'NPC memory audit directory');
      await assertNoSymlinkComponents(path, 'NPC memory audit file');
      if (activeFileBytes === undefined) {
        try { activeFileBytes = (await stat(path)).size; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          activeFileBytes = 0;
        }
      }
      if (activeFileBytes >= maxFileBytes) await rotate();
      await appendFile(path, line, 'utf8');
      activeFileBytes += Buffer.byteLength(line);
    } catch (error) {
      reportError(error);
    }
  };

  return Object.freeze({
    write(record: NpcMemoryAuditRecordInput): void {
      if (stopped) return;
      try {
        const normalized = normalizeRecord(record, now);
        void writer.enqueueTask(() => append(normalized), 'best-effort');
      } catch (error) {
        reportError(error);
      }
    },
    async drain(): Promise<void> {
      try { await writer.flush(); } catch (error) { reportError(error); }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try { await writer.flush(); } catch (error) { reportError(error); }
      writer.dispose();
    },
    get dropped(): number { return writer.dropped; },
    get pending(): number { return writer.pending; },
    path,
  });
}
