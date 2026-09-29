import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
  ProductLedgerEntrySchema,
  ProductReadbackSchema,
  type ProductActor,
  type ProductJsonObject,
  type ProductJsonValue,
  type ProductLedgerAttempt,
  type ProductLedgerEntry,
  type ProductLedgerTerminal,
  type ProductReadback,
  type ProductReceipt,
  type ProductStructuredError,
} from '@forgeax/types/product-ai-native';

import { resolveFirstClassUiTool, isFirstClassUiToolName } from '../api/lib/ui-manifest-registry';
import type { AgentTreeAPI } from '../core/types';
import { sanitizeJournalValueWithStats } from '../events/journal-sink';
import { catalogGet, type ActionEffect } from './action-catalog';

export const FORGEAX_ACTION_SURFACE_ID = 'forgeax.action-catalog';
export const PRODUCT_ACTION_LEDGER_FILE = '.forgeax/product-ai-native-ledger.jsonl';
export const PRODUCT_ACTION_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60_000;

const MAX_ARGS_SUMMARY_BYTES = 8 * 1024;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;
const lastRetentionSweep = new Map<string, number>();

export interface ProductActionCandidate {
  actionId: string;
  actionArgs: Record<string, unknown>;
  effect: ActionEffect;
}

export interface BeginProductActionInvocationInput {
  projectRoot: string;
  sessionId?: string;
  actorKind: ProductActor['kind'];
  actorId: string;
  /** Server-derived only. Never populate this from an action request body. */
  trustedRootActorId?: string;
  actionId: string;
  actionArgs: Record<string, unknown>;
  effect: ActionEffect;
  clientCallId?: string;
}

export interface ProductActionLedgerQuery {
  sessionId?: string;
  executionId?: string;
  clientCallId?: string;
  actionId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function resolveTrustedRootActorId(
  tree: Pick<AgentTreeAPI, 'parent'>,
  actorId: string,
): string {
  let current = actorId.trim();
  if (!current) throw new Error('trusted actor id is required');
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) {
      throw new Error(`trusted agent parent cycle at ${current}`);
    }
    visited.add(current);
    const parent = tree.parent(current);
    if (!parent) return current;
    const parentId = parent.path.trim();
    if (!parentId) throw new Error(`trusted agent parent for ${current} has no path`);
    current = parentId;
  }
}

/** 脱敏 → 可序列化投影,并把脱敏层的字符串截断一并带出。
 *  `truncated` 是两级截断的**并**:字段级(sanitizer 剪超长字符串)与整体级
 *  (下面的 8KB 摘要上限)。缺任何一级,盘上都会出现"被剪过但没标记"的行。 */
function asJsonValue(value: unknown): { value: ProductJsonValue; truncated: boolean } {
  const sanitized = sanitizeJournalValueWithStats(value);
  try {
    return {
      value: JSON.parse(JSON.stringify(sanitized.value)) as ProductJsonValue,
      truncated: sanitized.truncated,
    };
  } catch {
    return { value: '[unserializable]', truncated: sanitized.truncated };
  }
}

function summarizeArgs(args: Record<string, unknown>): { value: ProductJsonObject; truncated: boolean } {
  const sanitized = asJsonValue(args);
  const value = sanitized.value;
  const objectValue = value && typeof value === 'object' && !Array.isArray(value)
    ? value as ProductJsonObject
    : { value };
  const serialized = JSON.stringify(objectValue);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_ARGS_SUMMARY_BYTES) return { value: objectValue, truncated: sanitized.truncated };
  return {
    value: {
      truncated: true,
      bytes,
      keys: Object.keys(objectValue),
    },
    truncated: true,
  };
}

function productInstanceId(projectRoot: string): string {
  const normalized = resolve(projectRoot);
  return `forgeax:${createHash('sha256').update(normalized).digest('hex')}`;
}

function ledgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), PRODUCT_ACTION_LEDGER_FILE);
}

function parseLedgerRows(raw: string): ProductLedgerEntry[] {
  const entries: ProductLedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = ProductLedgerEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // Append-only journals may contain a torn final line after a crash.
    }
  }
  return entries;
}

export function enforceProductActionLedgerRetention(
  projectRoot: string,
  options: { now?: number; force?: boolean } = {},
): void {
  const path = ledgerPath(projectRoot);
  const now = options.now ?? Date.now();
  const lastSweep = lastRetentionSweep.get(path) ?? Number.NEGATIVE_INFINITY;
  if (!options.force && now - lastSweep < RETENTION_SWEEP_INTERVAL_MS) return;
  lastRetentionSweep.set(path, now);

  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const entries = parseLedgerRows(raw);
  const cutoff = now - PRODUCT_ACTION_LEDGER_RETENTION_MS;
  const retainedExecutions = new Set(
    entries
      .filter((entry) => entryTime(entry) >= cutoff)
      .map((entry) => entry.executionId),
  );
  const retained = entries.filter((entry) => retainedExecutions.has(entry.executionId));
  if (retained.length === entries.length) return;

  const temporaryPath = `${path}.retention-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(
    temporaryPath,
    retained.length ? `${retained.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '',
    'utf8',
  );
  renameSync(temporaryPath, path);
}

function appendLedgerEntry(projectRoot: string, entry: ProductLedgerEntry): void {
  const parsed = ProductLedgerEntrySchema.parse(entry);
  const path = ledgerPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  enforceProductActionLedgerRetention(projectRoot);
  appendFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');
}

export function inspectProductActionInvocation(
  name: string,
  args: unknown,
  sessionId: string,
): ProductActionCandidate | undefined {
  const normalizedArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  if (name === 'ui_invoke') {
    const actionId = typeof normalizedArgs.actionId === 'string' && normalizedArgs.actionId.trim()
      ? normalizedArgs.actionId.trim()
      : 'ui_invoke:missing-action-id';
    const actionArgs = normalizedArgs.args && typeof normalizedArgs.args === 'object' && !Array.isArray(normalizedArgs.args)
      ? normalizedArgs.args as Record<string, unknown>
      : {};
    return { actionId, actionArgs, effect: catalogGet(actionId)?.effect ?? 'write' };
  }
  if (!isFirstClassUiToolName(name)) return undefined;
  const actionId = resolveFirstClassUiTool(sessionId, name)?.actionId ?? name;
  return { actionId, actionArgs: normalizedArgs, effect: catalogGet(actionId)?.effect ?? 'write' };
}

function structuredError(
  code: string,
  message: string,
  retryable = false,
  recoveryActions?: string[],
): ProductStructuredError {
  return {
    code: code || 'unknown-error',
    message: message || 'Unknown product action error',
    retryable,
    ...(recoveryActions?.length ? { recoveryActions: [...new Set(recoveryActions)] } : {}),
  };
}

function rawErrorCode(raw: Record<string, unknown>, fallback: string): string {
  return typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim() : fallback;
}

function rawMessage(raw: Record<string, unknown>, fallback: string): string {
  if (typeof raw.reason === 'string' && raw.reason.trim()) return raw.reason.trim();
  if (typeof raw.error === 'string' && raw.error.trim()) return raw.error.trim();
  if (typeof raw.message === 'string' && raw.message.trim()) return raw.message.trim();
  return fallback;
}

function readbackFor(effect: ActionEffect, raw: Record<string, unknown>): ProductReadback {
  const parsed = ProductReadbackSchema.safeParse(raw.readback);
  if (parsed.success) return parsed.data;
  return effect === 'read' ? { status: 'not-applicable' } : { status: 'unverified' };
}

export class ProductActionLedgerHandle {
  readonly executionId: string;
  readonly actionId: string;
  readonly effect: ActionEffect;

  private readonly projectRoot: string;
  private readonly attempt: ProductLedgerAttempt;
  private terminalWritten = false;

  constructor(input: BeginProductActionInvocationInput) {
    const executionId = randomUUID();
    const startedAt = new Date().toISOString();
    const summary = summarizeArgs(input.actionArgs);
    this.executionId = executionId;
    this.actionId = input.actionId;
    this.effect = input.effect;
    this.projectRoot = input.projectRoot;
    this.attempt = {
      protocolVersion: PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
      phase: 'attempt',
      executionId,
      rootActorId: input.trustedRootActorId ?? input.actorId,
      productInstanceId: productInstanceId(input.projectRoot),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      actor: { kind: input.actorKind, id: input.actorId },
      surfaceId: FORGEAX_ACTION_SURFACE_ID,
      actionId: input.actionId,
      ...(input.clientCallId ? { clientCallId: input.clientCallId } : {}),
      argsSummary: summary.value,
      startedAt,
      ...(summary.truncated ? { truncated: true } : {}),
    };
    appendLedgerEntry(this.projectRoot, this.attempt);
  }

  private finish(entry: Omit<ProductLedgerTerminal, keyof typeof this.attempt | 'phase' | 'endedAt'> & {
    status: ProductLedgerTerminal['status'];
    endedAt?: string;
    /** 终态行自己的截断留痕(结果投影被剪时置位);attempt 的 truncated 说的是入参。 */
    truncated?: boolean;
  }): void {
    if (this.terminalWritten) throw new Error(`terminal already written for execution ${this.executionId}`);
    const terminal: ProductLedgerTerminal = {
      protocolVersion: this.attempt.protocolVersion,
      phase: 'terminal',
      executionId: this.attempt.executionId,
      rootActorId: this.attempt.rootActorId,
      productInstanceId: this.attempt.productInstanceId,
      ...(this.attempt.sessionId ? { sessionId: this.attempt.sessionId } : {}),
      actor: this.attempt.actor,
      surfaceId: this.attempt.surfaceId,
      actionId: this.attempt.actionId,
      ...(this.attempt.clientCallId ? { clientCallId: this.attempt.clientCallId } : {}),
      startedAt: this.attempt.startedAt,
      endedAt: entry.endedAt ?? new Date().toISOString(),
      status: entry.status,
      ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
      ...(entry.effectState !== undefined ? { effectState: entry.effectState } : {}),
      ...(entry.beforeRevision !== undefined ? { beforeRevision: entry.beforeRevision } : {}),
      ...(entry.afterRevision !== undefined ? { afterRevision: entry.afterRevision } : {}),
      ...(entry.truncated ? { truncated: true } : {}),
    };
    appendLedgerEntry(this.projectRoot, terminal);
    this.terminalWritten = true;
  }

  reject(code: string, message: string, retryable = false, recoveryActions?: string[]): ProductReceipt {
    this.finish({ status: 'rejected', errorCode: code, effectState: 'none' });
    return {
      protocolVersion: PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
      executionId: this.executionId,
      status: 'rejected',
      started: false,
      error: structuredError(code, message, retryable, recoveryActions),
    };
  }

  fail(
    code: string,
    message: string,
    effectState: 'none' | 'partial' | 'unknown' = 'unknown',
    retryable = false,
    recoveryActions?: string[],
  ): ProductReceipt {
    this.finish({ status: 'failed', errorCode: code, effectState });
    return {
      protocolVersion: PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
      executionId: this.executionId,
      status: 'failed',
      started: true,
      effectState,
      error: structuredError(code, message, retryable, recoveryActions),
    };
  }

  complete(rawResult: unknown): ProductReceipt {
    const { value: result, truncated } = asJsonValue(rawResult);
    const raw = result && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown>
      : {};
    const readback = readbackFor(this.effect, raw);
    const beforeRevision = typeof raw.beforeRevision === 'string' && raw.beforeRevision
      ? raw.beforeRevision
      : null;
    const afterRevision = readback.status === 'verified'
      ? readback.revision
      : typeof raw.afterRevision === 'string' && raw.afterRevision
        ? raw.afterRevision
        : null;
    this.finish({
      status: 'completed',
      errorCode: null,
      ...(beforeRevision ? { beforeRevision } : {}),
      ...(afterRevision ? { afterRevision } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
    return {
      protocolVersion: PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
      executionId: this.executionId,
      status: 'completed',
      started: true,
      result,
      readback,
    };
  }

  settleBusinessResult(rawResult: unknown): ProductReceipt {
    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
      return this.fail('malformed-action-result', 'Product action returned no structured terminal result');
    }
    const raw = rawResult as Record<string, unknown>;
    if (raw.unavailable === true) {
      return this.reject('executor-unavailable', rawMessage(raw, 'No product action executor is available'));
    }
    if (raw.started === false && raw.status !== 'rejected') {
      return this.fail(
        'contradictory-action-result',
        'Product action returned a terminal result while claiming execution never started',
      );
    }
    if (raw.status === 'completed') return this.complete(rawResult);
    if (raw.status === 'accepted') {
      return this.fail(
        'action-completion-unknown',
        'Product action was accepted but no terminal completion receipt was observed',
      );
    }
    if (raw.status === 'rejected') {
      if (raw.started === false) {
        return this.reject(rawErrorCode(raw, 'action-rejected'), rawMessage(raw, 'Product action was rejected'));
      }
      return this.fail(
        rawErrorCode(raw, 'action-failed-after-dispatch'),
        rawMessage(raw, 'Product action failed after dispatch; side effects are unknown'),
      );
    }
    if (raw.status === 'failed') {
      const effectState = raw.effectState === 'none' || raw.effectState === 'partial' || raw.effectState === 'unknown'
        ? raw.effectState
        : 'unknown';
      return this.fail(rawErrorCode(raw, 'action-failed'), rawMessage(raw, 'Product action failed'), effectState);
    }
    return this.fail('malformed-action-result', 'Product action returned an unknown terminal status');
  }
}

export function beginProductActionInvocation(
  input: BeginProductActionInvocationInput,
): ProductActionLedgerHandle {
  return new ProductActionLedgerHandle(input);
}

export const PRODUCT_ACTION_COMPLETION_TTL_MS = 10 * 60_000;

interface PendingProductActionInvocation {
  handle: ProductActionLedgerHandle;
  completionToken: string;
  expiresAt: number;
}

export type ProductActionLedgerSettlement =
  | { ok: true; receipt: ProductReceipt }
  | { ok: false; code: 'pending-not-found' | 'completion-token-mismatch'; reason: string };

/** A browser action spans two HTTP calls. The server-only completion token binds the
 * terminal call to its attempt even if the tab changes session or its lease expires. */
export class ProductActionLedgerRegistry {
  private readonly pending = new Map<string, PendingProductActionInvocation>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRODUCT_ACTION_COMPLETION_TTL_MS;
  }

  private sweep(): void {
    const now = this.now();
    for (const [executionId, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(executionId);
    }
  }

  begin(input: BeginProductActionInvocationInput): { executionId: string; completionToken: string } {
    this.sweep();
    const handle = beginProductActionInvocation(input);
    const completionToken = randomUUID();
    this.pending.set(handle.executionId, {
      handle,
      completionToken,
      expiresAt: this.now() + this.ttlMs,
    });
    return { executionId: handle.executionId, completionToken };
  }

  settle(input: {
    executionId: string;
    completionToken: string;
    result: unknown;
    started: boolean;
  }): ProductActionLedgerSettlement {
    this.sweep();
    const pending = this.pending.get(input.executionId);
    if (!pending) {
      return {
        ok: false,
        code: 'pending-not-found',
        reason: 'No pending product action attempt exists for this executionId',
      };
    }
    if (pending.completionToken !== input.completionToken) {
      return {
        ok: false,
        code: 'completion-token-mismatch',
        reason: 'The completion token does not match the pending product action attempt',
      };
    }
    const rawResult = input.result && typeof input.result === 'object' && !Array.isArray(input.result)
      ? { ...(input.result as Record<string, unknown>), started: input.started }
      : input.result;
    const receipt = pending.handle.settleBusinessResult(rawResult);
    this.pending.delete(input.executionId);
    return { ok: true, receipt };
  }

  clear(): void {
    this.pending.clear();
  }
}

export const productActionLedgerRegistry = new ProductActionLedgerRegistry();

function entryTime(entry: ProductLedgerEntry): number {
  return Date.parse(entry.phase === 'terminal' ? entry.endedAt : entry.startedAt);
}

export function readProductActionLedger(
  projectRoot: string,
  query: ProductActionLedgerQuery,
): ProductLedgerEntry[] {
  enforceProductActionLedgerRetention(projectRoot);
  let raw = '';
  try {
    raw = readFileSync(ledgerPath(projectRoot), 'utf8');
  } catch {
    return [];
  }
  const entries = parseLedgerRows(raw)
    .filter((entry) => query.sessionId === undefined || entry.sessionId === query.sessionId);
  const terminalIds = new Set(entries.filter((entry) => entry.phase === 'terminal').map((entry) => entry.executionId));
  const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
  const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
  const filtered = entries
    .filter((entry) => !query.executionId || entry.executionId === query.executionId)
    .filter((entry) => !query.clientCallId || entry.clientCallId === query.clientCallId)
    .filter((entry) => !query.actionId || entry.actionId === query.actionId)
    .filter((entry) => {
      const timestamp = entryTime(entry);
      return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
    })
    .map((entry) => entry.phase === 'attempt' && !terminalIds.has(entry.executionId)
      ? { ...entry, queryState: 'incomplete' as const }
      : entry);
  const limit = Number.isInteger(query.limit) && Number(query.limit) > 0 ? Number(query.limit) : undefined;
  return limit ? filtered.slice(-limit) : filtered;
}
