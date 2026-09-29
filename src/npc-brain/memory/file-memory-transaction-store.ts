import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isMemorySlug,
  materializePlannedMemoryEntryAsync,
  planClassifiedMemoryFactsAsync,
  rebuildMemoryIndexAsync,
} from '../../soul/layered-memory-runtime.mjs';
import type { PlannedMemoryEntry } from '../../soul/layered-memory-runtime.mjs';
import type { LayeredMemoryRef, MemoryFact, MemoryTier } from '../../soul/types';

/** Crash boundaries intentionally exposed for focused recovery tests. */
export type FileMemoryFailpoint = 'after-intent' | 'after-fact' | 'after-index' | 'after-receipt';

export interface FileMemoryTransactionInput {
  /** Host-resolved, absolute memory reference. Never derive this from a fact. */
  ref: LayeredMemoryRef;
  /** Host-owned durable state directory, kept outside the memory root. */
  stateDir: string;
  idempotencyKey: string;
  canonicalCommandHash: string;
  facts: MemoryFact[];
}

export interface FileMemoryRecoveryInput {
  /** Host-provided scope; recovery never takes root from an intent file. */
  ref: LayeredMemoryRef;
  stateDir: string;
  /** Exact ledger key when known; omitting it discovers only this host scope. */
  idempotencyKey?: string;
  /** Optional host assertion for the command represented by the intent/receipt. */
  canonicalCommandHash?: string;
}

export interface FileMemoryReceipt {
  version: 1;
  idempotencyKey: string;
  canonicalCommandHash: string;
  root: string;
  game?: string;
  factsHash: string;
  transactionInputHash: string;
  plans: PlannedMemoryEntry[];
  written: Array<{ tier: MemoryTier; game?: string; file: string }>;
  integrity: string;
}

export type FileMemoryTransactionResult =
  | {
      status: 'committed';
      idempotencyKey: string;
      canonicalCommandHash: string;
      written: FileMemoryReceipt['written'];
      receipt: FileMemoryReceipt;
    }
  | {
      status: 'duplicate';
      idempotencyKey: string;
      canonicalCommandHash: string;
      written: FileMemoryReceipt['written'];
      receipt: FileMemoryReceipt;
    };

export interface FileMemoryTransactionStoreOptions {
  failpoint?: (point: FileMemoryFailpoint, detail?: { factIndex?: number; file?: string }) => void;
  maxStateRecordBytes?: number;
}

interface Intent {
  version: 1;
  idempotencyKey: string;
  canonicalCommandHash: string;
  root: string;
  game?: string;
  factsHash: string;
  transactionInputHash: string;
  plans: PlannedMemoryEntry[];
  integrity: string;
}

const scopeLocks = new Set<string>();
const TEMP_MARKER = '.fx-memory-tmp-';
const TEMP_NAME_RE = /^\.fx-memory-tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_NAME = '.fx-memory-scope-owner.lock';
const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{32}$/;
const COMMAND_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_FACTS = 128;
const MAX_FACT_TEXT_LENGTH = 128 * 1024;
const MAX_FACT_TITLE_LENGTH = 2 * 1024;
const MAX_STATE_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTION_INPUT_BYTES = 8 * 1024 * 1024;

export class FileMemoryTransactionConflictError extends Error {
  readonly code = 'FILE_MEMORY_IDEMPOTENCY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'FileMemoryTransactionConflictError';
  }
}

export class FileMemoryTransactionBusyError extends Error {
  readonly code = 'FILE_MEMORY_SCOPE_BUSY';

  constructor(root: string) {
    super(`File memory scope is already being written in this process: ${root}`);
    this.name = 'FileMemoryTransactionBusyError';
  }
}

export class FileMemoryDurabilityUnsupportedError extends Error {
  readonly code = 'FILE_MEMORY_STRICT_DURABILITY_UNSUPPORTED';

  constructor() {
    super('strict durable file memory transactions are unsupported on this platform');
    this.name = 'FileMemoryDurabilityUnsupportedError';
  }
}

function assertAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacters(value) || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function assertStrictDurability(): void {
  if (process.platform === 'win32') throw new FileMemoryDurabilityUnsupportedError();
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertIndependentStateDir(root: string, stateDir: string): void {
  if (isInside(root, stateDir) || isInside(stateDir, root)) {
    throw new TypeError('stateDir must not overlap memory root');
  }
}

async function assertNoSymlinkComponents(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || hasControlCharacters(path)) throw new TypeError(`${label} contains an unsafe path`);
  const parts = resolve(path).split(sep);
  let current = parts[0] === '' ? sep : parts[0];
  for (const component of parts.slice(parts[0] === '' ? 1 : 0)) {
    if (!component) continue;
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink() && !isSystemPathAlias(current)) throw new TypeError(`${label} cannot contain symlink or junction: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function isSystemPathAlias(path: string): boolean {
  return process.platform === 'darwin' && (path === '/var' || path === '/tmp');
}

function assertSafeRef(ref: LayeredMemoryRef): LayeredMemoryRef {
  const root = assertAbsolutePath(ref.root, 'memory root');
  if (ref.game !== undefined && !isMemorySlug(ref.game)) {
    throw new TypeError('memory game must be a safe slug');
  }
  return { root, ...(ref.game === undefined ? {} : { game: ref.game }) };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function assertInput(input: FileMemoryTransactionInput): Promise<{
  ref: LayeredMemoryRef;
  stateDir: string;
  idempotencyKey: string;
  canonicalCommandHash: string;
  facts: MemoryFact[];
  factsHash: string;
  transactionInputHash: string;
}> {
  if (!input || typeof input !== 'object') throw new TypeError('file memory transaction input is required');
  const ref = assertSafeRef(input.ref);
  const stateDir = assertAbsolutePath(input.stateDir, 'stateDir');
  await assertNoSymlinkComponents(ref.root, 'memory root');
  await assertNoSymlinkComponents(stateDir, 'stateDir');
  assertIndependentStateDir(ref.root, stateDir);
  if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
    throw new TypeError('idempotencyKey must be 32 lowercase hexadecimal characters');
  }
  if (typeof input.canonicalCommandHash !== 'string' || !COMMAND_HASH_RE.test(input.canonicalCommandHash)) {
    throw new TypeError('canonicalCommandHash must be 64 lowercase hexadecimal characters');
  }
  if (!Array.isArray(input.facts) || input.facts.length > MAX_FACTS) throw new TypeError(`facts must contain at most ${MAX_FACTS} entries`);
  for (const fact of input.facts) {
    if (!fact || typeof fact !== 'object' || typeof fact.text !== 'string' || fact.text.length > MAX_FACT_TEXT_LENGTH
      || hasUnpairedSurrogate(fact.text)) {
      throw new TypeError(`memory fact text must be a string of at most ${MAX_FACT_TEXT_LENGTH} characters`);
    }
    if (fact.title !== undefined && (typeof fact.title !== 'string' || fact.title.length > MAX_FACT_TITLE_LENGTH
      || hasUnpairedSurrogate(fact.title))) {
      throw new TypeError(`memory fact title must be at most ${MAX_FACT_TITLE_LENGTH} characters`);
    }
    if (fact.kind !== undefined && fact.kind !== 'general' && fact.kind !== 'game') {
      throw new TypeError('memory fact kind must be general or game');
    }
  }
  const factsHash = hashFacts(input.facts);
  if (Buffer.byteLength(JSON.stringify(input.facts), 'utf8') > MAX_TRANSACTION_INPUT_BYTES) {
    throw new TypeError(`transaction input exceeds ${MAX_TRANSACTION_INPUT_BYTES} bytes`);
  }
  const transactionInputHash = hashTransactionInput(ref, stateDir, input.idempotencyKey, input.canonicalCommandHash, factsHash);
  return {
    ref,
    stateDir,
    idempotencyKey: input.idempotencyKey,
    canonicalCommandHash: input.canonicalCommandHash,
    facts: input.facts,
    factsHash,
    transactionInputHash,
  };
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function hashFacts(facts: readonly MemoryFact[]): string {
  return createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex');
}

function hashTransactionInput(ref: LayeredMemoryRef, stateDir: string, idempotencyKey: string, canonicalCommandHash: string, factsHash: string): string {
  return createHash('sha256').update(JSON.stringify({
    root: ref.root,
    game: ref.game ?? null,
    stateDir,
    idempotencyKey,
    canonicalCommandHash,
    factsHash,
  }), 'utf8').digest('hex');
}

interface ScopeOwnerLock {
  pid: number;
  token: string;
  startedAt: number;
}

async function acquireScopeOwnerLock(path: string): Promise<string> {
  const token = randomUUID();
  const body = Buffer.from(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() } satisfies ScopeOwnerLock) + '\n', 'utf8');
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlinkComponents(dirname(path), 'scope owner directory');
  for (;;) {
    // Prepare before publication: an O_EXCL file would otherwise expose an
    // empty/malformed lock if this process crashes during its first write.
    const prepare = `${path}.prepare-${randomUUID()}`;
    let published = false;
    try {
      const handle = await open(prepare, 'wx', 0o600);
      try {
        await writeHandleFully(handle, body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(prepare, path);
        published = true;
        await fsyncDirectory(dirname(path));
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } catch (error) {
      if (published) await releaseScopeOwnerLock(path, token);
      throw error;
    } finally {
      await unlink(prepare).catch(() => {});
    }
    const owner = await readScopeOwnerLock(path);
    if (owner === undefined) {
      if (!(await pathExists(path))) continue;
      throw new FileMemoryTransactionBusyError(path);
    }
    if (isProcessAlive(owner.pid)) throw new FileMemoryTransactionBusyError(path);
    const stale = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, stale);
      await unlink(stale);
      await fsyncDirectory(dirname(path));
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
    }
  }
}

async function releaseScopeOwnerLock(path: string, token: string): Promise<void> {
  try {
    const owner = await readScopeOwnerLock(path);
    if (owner?.token !== token) return;
    await unlink(path);
    await fsyncDirectory(dirname(path));
  } catch {
    // Leave an unverifiable lock for safe stale-pid recovery.
  }
}

async function readScopeOwnerLock(path: string): Promise<ScopeOwnerLock | undefined> {
  await assertNoSymlinkComponents(path, 'scope owner lock');
  if (!(await pathExists(path)) || (await stat(path)).size > 4096) return undefined;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ScopeOwnerLock>;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.token) || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return undefined;
    return value as ScopeOwnerLock;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') {
    // Windows does not provide a portable directory fsync through Node. File
    // fsync plus atomic rename still applies; macOS/Linux take the strict path.
    return;
  }
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurably(path: string, bytes: string, maxBytes = MAX_STATE_RECORD_BYTES): Promise<void> {
  if (Buffer.byteLength(bytes, 'utf8') > maxBytes) throw new FileMemoryTransactionConflictError(`durable record exceeds ${maxBytes} bytes: ${path}`);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await assertNoSymlinkComponents(dir, 'durable record directory');
  if (await pathExists(path)) await assertNoSymlinkComponents(path, 'durable record');
  const temp = join(dir, `${TEMP_MARKER}${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, 'wx', 0o600);
    const data = Buffer.from(bytes, 'utf8');
    await writeHandleFully(handle, data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await fsyncDirectory(dir);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function cleanTemporaryFiles(dir: string): Promise<void> {
  if (!(await pathExists(dir))) return;
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      await cleanTemporaryFiles(path);
      continue;
    }
    if (name.isFile() && TEMP_NAME_RE.test(name.name)) {
      await unlink(path).catch(() => {});
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeHandleFully(handle: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const result = await handle.write(data.subarray(offset));
    if (result.bytesWritten <= 0) throw new Error('durable memory write made no progress');
    offset += result.bytesWritten;
  }
}

function ledgerIdentity(root: string, game: string | undefined, idempotencyKey: string): string {
  // The fields are length/grammar constrained (paths reject controls, game is
  // a slug, and key is fixed lower-case hex), so newline tuple framing is
  // unambiguous while retaining the v1 ledger filename format.
  return `${root}\n${game ?? ''}\n${idempotencyKey}`;
}

function scopeLockPath(ref: LayeredMemoryRef): string {
  // Every game under one NPC root shares traits and MEMORY.md. The lock is
  // therefore root-scoped and lives at that root, so two hosts cannot evade it
  // by choosing different state directories for the same NPC.
  return join(ref.root, LOCK_NAME);
}

function stateFile(stateDir: string, kind: 'intent' | 'receipt', root: string, game: string | undefined, idempotencyKey: string): string {
  const digest = createHash('sha256').update(ledgerIdentity(root, game, idempotencyKey), 'utf8').digest('hex');
  return join(stateDir, `${digest}.${kind}.json`);
}

function recordIntegrity(value: Record<string, unknown>): string {
  // Detects accidental record corruption only. Authentication of the command
  // envelope belongs to the host/provider boundary, not this local store.
  const { integrity: _ignored, ...content } = value;
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
}

async function readJson<T>(path: string, label: string, maxBytes = MAX_STATE_RECORD_BYTES): Promise<T | undefined> {
  if (!(await pathExists(path))) return undefined;
  await assertNoSymlinkComponents(path, label);
  if ((await stat(path)).size > maxBytes) {
    throw new FileMemoryTransactionConflictError(`${label} exceeds ${maxBytes} byte read limit: ${path}`);
  }
  try {
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) throw new Error('record exceeds byte limit');
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new FileMemoryTransactionConflictError(`${label} is malformed: ${path}`);
  }
}

async function assertSafePlan(ref: LayeredMemoryRef, plan: PlannedMemoryEntry): Promise<void> {
  if (!plan || typeof plan.file !== 'string' || plan.file.length === 0 || plan.file.includes('\0') || plan.file.startsWith('/') || plan.file.includes('\\')) {
    throw new FileMemoryTransactionConflictError('transaction intent contains an unsafe relative file');
  }
  if (plan.tier !== 'traits' && plan.tier !== 'episodes') {
    throw new FileMemoryTransactionConflictError('transaction intent contains an unsupported memory tier');
  }
  const target = resolve(ref.root, ...plan.file.split('/'));
  if (!isInside(ref.root, target)) throw new FileMemoryTransactionConflictError('transaction file escapes memory root');
  await assertNoSymlinkComponents(target, 'transaction target');
  const parts = plan.file.split('/');
  const expected = plan.tier === 'episodes'
    ? parts.length === 3 && parts[0] === 'episodes' && plan.game === parts[1]
    : parts.length === 2 && parts[0] === plan.tier && plan.game === undefined;
  if (!expected || !plan.file.endsWith('.md') || !/^[a-z0-9-]{1,48}(?:-\d+)?\.md$/.test(parts.at(-1) ?? '')) {
    throw new FileMemoryTransactionConflictError('transaction intent contains an invalid memory file');
  }
  if (plan.tier === 'episodes' && (!isMemorySlug(plan.game) || plan.game !== ref.game)) {
    throw new FileMemoryTransactionConflictError('transaction intent contains an unsafe game slug');
  }
  if (typeof plan.body !== 'string') throw new FileMemoryTransactionConflictError('transaction intent contains invalid body');
}

function writtenFromPlans(plans: PlannedMemoryEntry[]): FileMemoryReceipt['written'] {
  return plans.map(({ tier, game, file }) => ({ tier, ...(game ? { game } : {}), file }));
}

function assertIntentShape(value: unknown): asserts value is Intent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileMemoryTransactionConflictError('transaction intent is invalid');
  }
  const intent = value as Partial<Intent>;
  if (intent.version !== 1 || typeof intent.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(intent.idempotencyKey) ||
      typeof intent.canonicalCommandHash !== 'string' || !COMMAND_HASH_RE.test(intent.canonicalCommandHash) ||
      typeof intent.root !== 'string' || !isAbsolute(intent.root) || hasControlCharacters(intent.root) ||
      (intent.game !== undefined && (typeof intent.game !== 'string' || !isMemorySlug(intent.game))) ||
      typeof intent.factsHash !== 'string' || !COMMAND_HASH_RE.test(intent.factsHash) ||
      typeof intent.transactionInputHash !== 'string' || !COMMAND_HASH_RE.test(intent.transactionInputHash) ||
      !Array.isArray(intent.plans) || typeof intent.integrity !== 'string' || !COMMAND_HASH_RE.test(intent.integrity)) {
    throw new FileMemoryTransactionConflictError('transaction intent is invalid');
  }
}

function assertReceiptShape(value: unknown): asserts value is FileMemoryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileMemoryTransactionConflictError('transaction receipt is invalid');
  }
  const receipt = value as Partial<FileMemoryReceipt>;
  if (receipt.version !== 1 || typeof receipt.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(receipt.idempotencyKey) ||
      typeof receipt.canonicalCommandHash !== 'string' || !COMMAND_HASH_RE.test(receipt.canonicalCommandHash) ||
      typeof receipt.root !== 'string' || !isAbsolute(receipt.root) || hasControlCharacters(receipt.root) ||
      (receipt.game !== undefined && (typeof receipt.game !== 'string' || !isMemorySlug(receipt.game))) ||
      typeof receipt.factsHash !== 'string' || !COMMAND_HASH_RE.test(receipt.factsHash) ||
      typeof receipt.transactionInputHash !== 'string' || !COMMAND_HASH_RE.test(receipt.transactionInputHash) ||
      !Array.isArray(receipt.plans) || !Array.isArray(receipt.written) ||
      typeof receipt.integrity !== 'string' || !COMMAND_HASH_RE.test(receipt.integrity)) {
    throw new FileMemoryTransactionConflictError('transaction receipt is invalid');
  }
}

function assertIntentIdentity(intent: Intent, input: { ref: LayeredMemoryRef; idempotencyKey: string; canonicalCommandHash: string; factsHash?: string; transactionInputHash?: string }): void {
  assertIntentShape(intent);
  if (recordIntegrity(intent as unknown as Record<string, unknown>) !== intent.integrity) {
    throw new FileMemoryTransactionConflictError('transaction intent integrity check failed');
  }
  if (intent.version !== 1 || intent.idempotencyKey !== input.idempotencyKey) {
    throw new FileMemoryTransactionConflictError('transaction intent key does not match request');
  }
  if (intent.canonicalCommandHash !== input.canonicalCommandHash || intent.root !== input.ref.root || intent.game !== input.ref.game) {
    throw new FileMemoryTransactionConflictError('idempotency key was reused with a different command or scope');
  }
  if (input.factsHash !== undefined && intent.factsHash !== input.factsHash) {
    throw new FileMemoryTransactionConflictError('idempotency key was reused with different transaction facts');
  }
  if (input.transactionInputHash !== undefined && intent.transactionInputHash !== input.transactionInputHash) {
    throw new FileMemoryTransactionConflictError('transaction input hash mismatch');
  }
  if (!Array.isArray(intent.plans)) throw new FileMemoryTransactionConflictError('transaction intent plans are invalid');
  // Target symlink checks run immediately before materialization in the async
  // commit/recovery path; identity validation itself performs no filesystem IO.
}

function assertReceiptIdentity(receipt: FileMemoryReceipt, input: { ref: LayeredMemoryRef; idempotencyKey: string; canonicalCommandHash: string; factsHash?: string; transactionInputHash?: string }): void {
  assertReceiptShape(receipt);
  if (recordIntegrity(receipt as unknown as Record<string, unknown>) !== receipt.integrity) {
    throw new FileMemoryTransactionConflictError('transaction receipt integrity check failed');
  }
  if (receipt.version !== 1 || receipt.idempotencyKey !== input.idempotencyKey || receipt.canonicalCommandHash !== input.canonicalCommandHash || receipt.root !== input.ref.root || receipt.game !== input.ref.game) {
    throw new FileMemoryTransactionConflictError('idempotency key was reused with a different command or scope');
  }
  if (input.factsHash !== undefined && receipt.factsHash !== input.factsHash) {
    throw new FileMemoryTransactionConflictError('idempotency key was reused with different transaction facts');
  }
  if (input.transactionInputHash !== undefined && receipt.transactionInputHash !== input.transactionInputHash) {
    throw new FileMemoryTransactionConflictError('transaction input hash mismatch');
  }
  // Target symlink checks run immediately before materialization.
  const expectedWritten = writtenFromPlans(receipt.plans);
  if (JSON.stringify(receipt.written) !== JSON.stringify(expectedWritten)) {
    throw new FileMemoryTransactionConflictError('transaction receipt written entries do not match its plans');
  }
}

async function ensureReceiptMaterialized(receipt: FileMemoryReceipt, ref: LayeredMemoryRef): Promise<void> {
  // Durable receipts are recovered input, not an authority boundary. Validate
  // the complete plan before the first repair so a malformed later entry cannot
  // leave a partially materialized or root-escaping transaction.
  for (const plan of receipt.plans) await assertSafePlan(ref, plan);
  for (const plan of receipt.plans) {
    const target = join(ref.root, ...plan.file.split('/'));
    await assertNoSymlinkComponents(target, 'transaction target');
    if (await pathExists(target)) {
      if (await readFile(target, 'utf8') !== plan.body) {
        throw new FileMemoryTransactionConflictError(`receipt memory file was changed: ${plan.file}`);
      }
    } else {
      await materializePlannedMemoryEntryAsync(ref, plan, { durable: true });
    }
  }
  // Rebuilding is intentionally idempotent. It repairs a missing/stale index
  // on duplicate delivery instead of silently claiming success with bad state.
  await rebuildMemoryIndexAsync(ref.root, { durable: true });
}

function duplicateResult(receipt: FileMemoryReceipt): FileMemoryTransactionResult {
  return {
    status: 'duplicate',
    idempotencyKey: receipt.idempotencyKey,
    canonicalCommandHash: receipt.canonicalCommandHash,
    written: receipt.written,
    receipt,
  };
}

async function commitIntent(
  intent: Intent,
  stateDir: string,
  failpoint: FileMemoryTransactionStoreOptions['failpoint'],
  invokeFailpoint: boolean,
  maxStateRecordBytes = MAX_STATE_RECORD_BYTES,
): Promise<FileMemoryTransactionResult> {
  const ref: LayeredMemoryRef = { root: intent.root, ...(intent.game === undefined ? {} : { game: intent.game }) };
  // A recovered intent must fail closed before any of its entries are applied.
  for (const plan of intent.plans) await assertSafePlan(ref, plan);
  for (let factIndex = 0; factIndex < intent.plans.length; factIndex += 1) {
    const plan = intent.plans[factIndex];
    const target = join(ref.root, ...plan.file.split('/'));
    if (await pathExists(target)) {
      if (await readFile(target, 'utf8') !== plan.body) {
        throw new FileMemoryTransactionConflictError(`planned memory file was changed: ${plan.file}`);
      }
    } else {
      await materializePlannedMemoryEntryAsync(ref, plan, { durable: true });
    }
    if (invokeFailpoint) failpoint?.('after-fact', { factIndex, file: plan.file });
  }

  await rebuildMemoryIndexAsync(ref.root, { durable: true });
  if (invokeFailpoint) failpoint?.('after-index');

  const receiptContent = {
    version: 1 as const,
    idempotencyKey: intent.idempotencyKey,
    canonicalCommandHash: intent.canonicalCommandHash,
    root: intent.root,
    factsHash: intent.factsHash,
    transactionInputHash: intent.transactionInputHash,
    ...(intent.game === undefined ? {} : { game: intent.game }),
    plans: intent.plans,
    written: writtenFromPlans(intent.plans),
  };
  const receipt: FileMemoryReceipt = {
    ...receiptContent,
    integrity: recordIntegrity(receiptContent),
  };
  await writeDurably(stateFile(stateDir, 'receipt', intent.root, intent.game, intent.idempotencyKey), `${JSON.stringify(receipt)}\n`, maxStateRecordBytes);
  if (invokeFailpoint) failpoint?.('after-receipt');

  const intentPath = stateFile(stateDir, 'intent', intent.root, intent.game, intent.idempotencyKey);
  try { await unlink(intentPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fsyncDirectory(stateDir);
  return {
    status: 'committed',
    idempotencyKey: intent.idempotencyKey,
    canonicalCommandHash: intent.canonicalCommandHash,
    written: receipt.written,
    receipt,
  };
}

async function recoverOne(ref: LayeredMemoryRef, stateDir: string, idempotencyKey: string, canonicalCommandHash?: string, maxStateRecordBytes = MAX_STATE_RECORD_BYTES): Promise<void> {
  const intentPath = stateFile(stateDir, 'intent', ref.root, ref.game, idempotencyKey);
  const receiptPath = stateFile(stateDir, 'receipt', ref.root, ref.game, idempotencyKey);
  const intent = await readJson<Intent>(intentPath, 'transaction intent', maxStateRecordBytes);
  const receipt = await readJson<FileMemoryReceipt>(receiptPath, 'transaction receipt', maxStateRecordBytes);
  if (intent) {
    assertIntentShape(intent);
    assertIntentIdentity(intent, {
      ref,
      idempotencyKey,
      canonicalCommandHash: canonicalCommandHash ?? intent.canonicalCommandHash,
    });
    if (receipt) {
      assertReceiptIdentity(receipt, {
        ref,
        idempotencyKey,
        canonicalCommandHash: intent.canonicalCommandHash,
        factsHash: intent.factsHash,
        transactionInputHash: intent.transactionInputHash,
      });
      if (JSON.stringify(receipt.plans) !== JSON.stringify(intent.plans)) {
        throw new FileMemoryTransactionConflictError('transaction receipt plans do not match its intent');
      }
      await ensureReceiptMaterialized(receipt, ref);
      try { await unlink(intentPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fsyncDirectory(stateDir);
    } else {
      await commitIntent(intent, stateDir, undefined, false, maxStateRecordBytes);
    }
    return;
  }
  if (receipt) {
    assertReceiptIdentity(receipt, {
      ref,
      idempotencyKey,
      canonicalCommandHash: canonicalCommandHash ?? receipt.canonicalCommandHash,
    });
    await ensureReceiptMaterialized(receipt, ref);
  }
}

async function recoverScope(input: FileMemoryRecoveryInput, maxStateRecordBytes = MAX_STATE_RECORD_BYTES): Promise<void> {
  assertStrictDurability();
  const ref = assertSafeRef(input.ref);
  const stateDir = assertAbsolutePath(input.stateDir, 'stateDir');
  await assertNoSymlinkComponents(ref.root, 'memory root');
  await assertNoSymlinkComponents(stateDir, 'stateDir');
  assertIndependentStateDir(ref.root, stateDir);
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
    throw new TypeError('idempotencyKey must be 32 lowercase hexadecimal characters');
  }
  if (input.canonicalCommandHash !== undefined && !COMMAND_HASH_RE.test(input.canonicalCommandHash)) {
    throw new TypeError('canonicalCommandHash must be 64 lowercase hexadecimal characters');
  }
  await mkdir(stateDir, { recursive: true });
  // State-record temps use collision-resistant names and are harmless when
  // abandoned. Do not sweep the shared stateDir while holding only one NPC
  // root lock: another root may be durably writing there at the same time.
  await cleanTemporaryFiles(ref.root);

  if (input.idempotencyKey !== undefined) {
    // Resolve the ledger path from the host-provided scope and key. An
    // intent's self-reported root is only metadata to validate after lookup.
    await recoverOne(ref, stateDir, input.idempotencyKey, input.canonicalCommandHash, maxStateRecordBytes);
    return;
  }

  // Scope discovery is metadata-only: every record must be stored at the
  // digest of its own self-reported scope/key, and only exact host scope
  // records are passed to recoverOne. No other root is ever materialized.
  const keys = new Set<string>();
  for (const name of (await readdir(stateDir)).filter((entry) => entry.endsWith('.intent.json')).sort()) {
    const path = join(stateDir, name);
    const intent = await readJson<Intent>(path, 'transaction intent', maxStateRecordBytes);
    if (!intent) continue;
    assertIntentShape(intent);
    if (recordIntegrity(intent as unknown as Record<string, unknown>) !== intent.integrity) {
      throw new FileMemoryTransactionConflictError('transaction intent integrity check failed');
    }
    const candidateRef = assertSafeRef({ root: intent.root, ...(intent.game === undefined ? {} : { game: intent.game }) });
    try { assertIndependentStateDir(candidateRef.root, stateDir); } catch {
      throw new FileMemoryTransactionConflictError(`transaction intent scope overlaps stateDir: ${path}`);
    }
    assertIntentIdentity(intent, {
      ref: candidateRef,
      idempotencyKey: intent.idempotencyKey,
      canonicalCommandHash: intent.canonicalCommandHash,
    });
    if (stateFile(stateDir, 'intent', candidateRef.root, candidateRef.game, intent.idempotencyKey) !== path) {
      throw new FileMemoryTransactionConflictError(`transaction intent path/integrity mismatch: ${path}`);
    }
    if (candidateRef.root === ref.root && candidateRef.game === ref.game) keys.add(intent.idempotencyKey);
  }
  for (const name of (await readdir(stateDir)).filter((entry) => entry.endsWith('.receipt.json')).sort()) {
    const path = join(stateDir, name);
    const receipt = await readJson<FileMemoryReceipt>(path, 'transaction receipt', maxStateRecordBytes);
    if (!receipt) continue;
    assertReceiptShape(receipt);
    if (recordIntegrity(receipt as unknown as Record<string, unknown>) !== receipt.integrity) {
      throw new FileMemoryTransactionConflictError('transaction receipt integrity check failed');
    }
    const candidateRef = assertSafeRef({ root: receipt.root, ...(receipt.game === undefined ? {} : { game: receipt.game }) });
    try { assertIndependentStateDir(candidateRef.root, stateDir); } catch {
      throw new FileMemoryTransactionConflictError(`transaction receipt scope overlaps stateDir: ${path}`);
    }
    assertReceiptIdentity(receipt, {
      ref: candidateRef,
      idempotencyKey: receipt.idempotencyKey,
      canonicalCommandHash: receipt.canonicalCommandHash,
    });
    if (stateFile(stateDir, 'receipt', candidateRef.root, candidateRef.game, receipt.idempotencyKey) !== path) {
      throw new FileMemoryTransactionConflictError(`transaction receipt path/integrity mismatch: ${path}`);
    }
    if (candidateRef.root === ref.root && candidateRef.game === ref.game) keys.add(receipt.idempotencyKey);
  }
  for (const idempotencyKey of [...keys].sort()) await recoverOne(ref, stateDir, idempotencyKey, undefined, maxStateRecordBytes);
}

/**
 * Durable File memory primitive. Filesystem work is asynchronous so callers on
 * the Bun server request path never block the event loop. Durability still
 * comes from the fsync/rename protocol; scopeLocks only rejects accidental
 * same-process re-entry and is never used as a crash-recovery mechanism.
 */
export class FileMemoryTransactionStore {
  readonly #failpoint?: FileMemoryTransactionStoreOptions['failpoint'];
  readonly #maxStateRecordBytes: number;

  constructor(options: FileMemoryTransactionStoreOptions = {}) {
    assertStrictDurability();
    this.#failpoint = options.failpoint;
    this.#maxStateRecordBytes = options.maxStateRecordBytes ?? MAX_STATE_RECORD_BYTES;
    if (!Number.isSafeInteger(this.#maxStateRecordBytes) || this.#maxStateRecordBytes <= 0) {
      throw new TypeError('maxStateRecordBytes must be a positive integer');
    }
  }

  async recover(input: FileMemoryRecoveryInput): Promise<void> {
    assertStrictDurability();
    const ref = assertSafeRef(input.ref);
    const stateDir = assertAbsolutePath(input.stateDir, 'stateDir');
    await assertNoSymlinkComponents(ref.root, 'memory root');
    await assertNoSymlinkComponents(stateDir, 'stateDir');
    const lockKey = ref.root;
    if (scopeLocks.has(lockKey)) throw new FileMemoryTransactionBusyError(ref.root);
    scopeLocks.add(lockKey);
    const lockPath = scopeLockPath(ref);
    let token: string | undefined;
    try {
      token = await acquireScopeOwnerLock(lockPath);
      await recoverScope({ ...input, ref, stateDir }, this.#maxStateRecordBytes);
    } finally {
      if (token !== undefined) await releaseScopeOwnerLock(lockPath, token);
      scopeLocks.delete(lockKey);
    }
  }

  async commit(input: FileMemoryTransactionInput): Promise<FileMemoryTransactionResult> {
    const normalized = await assertInput(input);
    if (Buffer.byteLength(JSON.stringify(normalized.facts), 'utf8') > this.#maxStateRecordBytes) {
      throw new TypeError(`transaction input exceeds ${this.#maxStateRecordBytes} bytes`);
    }
    const lock = normalized.ref.root;
    if (scopeLocks.has(lock)) throw new FileMemoryTransactionBusyError(lock);
    scopeLocks.add(lock);
    const lockPath = scopeLockPath(normalized.ref);
    let token: string | undefined;
    try {
      token = await acquireScopeOwnerLock(lockPath);
      await mkdir(normalized.stateDir, { recursive: true });
      await cleanTemporaryFiles(normalized.ref.root);
      await recoverScope({
        ref: normalized.ref,
        stateDir: normalized.stateDir,
        idempotencyKey: normalized.idempotencyKey,
        canonicalCommandHash: normalized.canonicalCommandHash,
      }, this.#maxStateRecordBytes);

      const receiptPath = stateFile(normalized.stateDir, 'receipt', normalized.ref.root, normalized.ref.game, normalized.idempotencyKey);
      const existingReceipt = await readJson<FileMemoryReceipt>(receiptPath, 'transaction receipt', this.#maxStateRecordBytes);
      if (existingReceipt) {
        assertReceiptIdentity(existingReceipt, normalized);
        await ensureReceiptMaterialized(existingReceipt, normalized.ref);
        return duplicateResult(existingReceipt);
      }

      const intentPath = stateFile(normalized.stateDir, 'intent', normalized.ref.root, normalized.ref.game, normalized.idempotencyKey);
      const existingIntent = await readJson<Intent>(intentPath, 'transaction intent', this.#maxStateRecordBytes);
      let intent: Intent;
      if (existingIntent) {
        assertIntentIdentity(existingIntent, normalized);
        intent = existingIntent;
      } else {
        const plans = await planClassifiedMemoryFactsAsync(normalized.ref, normalized.facts);
        const intentContent = {
          version: 1 as const,
          idempotencyKey: normalized.idempotencyKey,
          canonicalCommandHash: normalized.canonicalCommandHash,
          factsHash: normalized.factsHash,
          transactionInputHash: normalized.transactionInputHash,
          root: normalized.ref.root,
          ...(normalized.ref.game === undefined ? {} : { game: normalized.ref.game }),
          plans,
        };
        intent = {
          ...intentContent,
          integrity: recordIntegrity(intentContent),
        };
        for (const plan of plans) await assertSafePlan(normalized.ref, plan);
        await writeDurably(intentPath, `${JSON.stringify(intent)}\n`, this.#maxStateRecordBytes);
        this.#failpoint?.('after-intent');
      }

      return await commitIntent(intent, normalized.stateDir, this.#failpoint, true, this.#maxStateRecordBytes);
    } finally {
      if (token !== undefined) await releaseScopeOwnerLock(lockPath, token);
      scopeLocks.delete(lock);
    }
  }
}

export function commitFileMemoryTransaction(
  input: FileMemoryTransactionInput,
  options: FileMemoryTransactionStoreOptions = {},
): Promise<FileMemoryTransactionResult> {
  return new FileMemoryTransactionStore(options).commit(input);
}

/** Alias kept internal for callers that describe the operation as applying a command. */
export const applyFileMemoryTransaction = commitFileMemoryTransaction;

export function recoverFileMemoryTransactions(input: FileMemoryRecoveryInput): Promise<void> {
  return new FileMemoryTransactionStore().recover(input);
}
