import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  FileMemoryTransactionConflictError,
  FileMemoryTransactionBusyError,
  FileMemoryTransactionStore,
  type FileMemoryFailpoint,
} from '../src/npc-brain/memory/file-memory-transaction-store';
import { readMemoryIndex, writeMemoryEntry } from '../src/soul/layered-memory';

const TMP = mkdtempSync(join(tmpdir(), 'fx-file-memory-txn-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function fixture(name: string): { root: string; stateDir: string } {
  const base = join(TMP, name);
  const root = join(base, 'memory');
  const stateDir = join(base, 'state');
  mkdirSync(root, { recursive: true });
  return { root, stateDir };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for child process: ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function spawnLiveLockOwner(lockPath: string, readyPath: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, '-e', `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.FX_MEMORY_LOCK, JSON.stringify({
      pid: process.pid,
      token: '00000000-0000-4000-8000-000000000000',
      startedAt: Date.now(),
    }) + '\\n', { mode: 0o600 });
    writeFileSync(process.env.FX_MEMORY_READY, 'ready\\n');
    setInterval(() => {}, 1_000);
  `], {
    env: { ...process.env, FX_MEMORY_LOCK: lockPath, FX_MEMORY_READY: readyPath },
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

function statePath(request: Parameters<FileMemoryTransactionStore['commit']>[0], kind: 'intent' | 'receipt'): string {
  const identity = `${request.ref.root}\n${request.ref.game ?? ''}\n${request.idempotencyKey}`;
  return join(request.stateDir, `${sha256(identity)}.${kind}.json`);
}

function input(root: string, stateDir: string, idempotencyKey: string, text = 'A stable fact.'): Parameters<FileMemoryTransactionStore['commit']>[0] {
  return {
    ref: { root },
    stateDir,
    idempotencyKey: sha256(`idempotency:${idempotencyKey}`).slice(0, 32),
    canonicalCommandHash: sha256(`command:${idempotencyKey}:${text}`),
    facts: [{ kind: 'general', title: 'Same title', text }],
  };
}

function filesUnder(root: string): Record<string, string> {
  const output: Record<string, string> = {};
  const walk = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      const rel = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) walk(path, rel);
      else output[rel] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return output;
}

describe('FileMemoryTransactionStore', () => {
  test('first write is byte-equivalent to legacy writeMemoryEntry', async () => {
    const legacy = fixture('parity-legacy');
    const durable = fixture('parity-durable');
    writeMemoryEntry({ root: legacy.root }, { tier: 'traits', title: 'Same title', text: 'A stable fact.' });

    const result = await new FileMemoryTransactionStore().commit(input(durable.root, durable.stateDir, 'parity'));
    expect(result.status).toBe('committed');
    expect(filesUnder(durable.root)).toEqual(filesUnder(legacy.root));
    expect(existsSync(join(durable.root, 'traits', 'same-title.md'))).toBe(true);
    expect(Object.keys(filesUnder(durable.stateDir)).filter((file) => file.endsWith('.receipt.json'))).toHaveLength(1);
  });

  test('same-title facts reserve suffixes in order across transactions', async () => {
    const { root, stateDir } = fixture('suffix');
    const store = new FileMemoryTransactionStore();
    const first = await store.commit(input(root, stateDir, 'one'));
    const second = await store.commit({ ...input(root, stateDir, 'two'), facts: [
      { kind: 'general', title: 'Same title', text: 'second' },
      { kind: 'general', title: 'Same title', text: 'third' },
    ] });
    expect(first.written.map((entry) => entry.file)).toEqual(['traits/same-title.md']);
    expect(second.written.map((entry) => entry.file)).toEqual(['traits/same-title-2.md', 'traits/same-title-3.md']);
    expect(readFileSync(join(root, 'traits', 'same-title-2.md'), 'utf8')).toBe('# Same title\n\nsecond\n');
    expect(readFileSync(join(root, 'traits', 'same-title-3.md'), 'utf8')).toBe('# Same title\n\nthird\n');
  });

  test('same-process scope re-entry is rejected while the durable write is active', async () => {
    const { root, stateDir } = fixture('reentry');
    const request = input(root, stateDir, 'reentry-primary');
    const nested = input(root, stateDir, 'reentry-nested');
    let nestedRejected = false;
    let nestedPromise: Promise<unknown> | undefined;
    let recoverPromise: Promise<unknown> | undefined;
    const store = new FileMemoryTransactionStore({
      failpoint: (point) => {
        if (point !== 'after-intent') return;
        nestedPromise = store.commit(nested);
        recoverPromise = store.recover({ ref: request.ref, stateDir });
        void nestedPromise.catch(() => {});
        void recoverPromise.catch(() => {});
        nestedRejected = true;
      },
    });
    await expect(store.commit(request)).resolves.toMatchObject({ status: 'committed' });
    await expect(nestedPromise!).rejects.toBeInstanceOf(FileMemoryTransactionBusyError);
    await expect(recoverPromise!).rejects.toBeInstanceOf(FileMemoryTransactionBusyError);
    expect(nestedRejected).toBe(true);
  });

  test('duplicate returns receipt and a reused key with a different hash fails closed', async () => {
    const { root, stateDir } = fixture('idempotency');
    const store = new FileMemoryTransactionStore();
    const request = input(root, stateDir, 'same-key');
    const first = await store.commit(request);
    const duplicate = await store.commit(request);
    expect(first.status).toBe('committed');
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.receipt).toEqual(first.receipt);
    await expect(store.commit({ ...request, canonicalCommandHash: sha256('different') })).rejects.toBeInstanceOf(FileMemoryTransactionConflictError);
    expect(filesUnder(root)['traits/same-title.md']).toBe('# Same title\n\nA stable fact.\n');
  });

  test('rejects malformed keys, hashes, facts, and unknown fact kinds', async () => {
    const { root, stateDir } = fixture('input-validation');
    const request = input(root, stateDir, 'validation');
    const store = new FileMemoryTransactionStore();
    await expect(store.commit({ ...request, idempotencyKey: 'ABC' })).rejects.toThrow(/32 lowercase hexadecimal/);
    await expect(store.commit({ ...request, canonicalCommandHash: 'ABC' })).rejects.toThrow(/64 lowercase hexadecimal/);
    await expect(store.commit({ ...request, facts: new Array(129).fill(request.facts[0]) })).rejects.toThrow(/at most 128/);
    await expect(store.commit({ ...request, facts: [{ text: 'x', kind: 'other' as never }] })).rejects.toThrow(/kind must be general or game/);
    await expect(store.commit({ ...request, facts: [{ text: 'x'.repeat(128 * 1024 + 1) }] })).rejects.toThrow(/at most 131072/);
    await expect(store.commit({ ...request, facts: [{ text: '\ud800' }] })).rejects.toThrow(/text must be a string/);
    await expect(store.commit({ ...request, facts: [{ text: 'valid', title: '\udc00' }] })).rejects.toThrow(/title must be/);
  });

  test('one NPC root is writer-locked across games and state directories', async () => {
    const { root, stateDir } = fixture('root-wide-lock');
    const first = { ...input(root, stateDir, 'root-lock-first'), ref: { root, game: 'game-a' } };
    const second = { ...input(root, join(TMP, 'root-wide-other-state'), 'root-lock-second'), ref: { root, game: 'game-b' } };
    let nested: Promise<unknown> | undefined;
    const store = new FileMemoryTransactionStore({
      failpoint: (point) => {
        if (point !== 'after-intent' || nested) return;
        nested = store.commit(second);
        void nested.catch(() => {});
      },
    });
    await expect(store.commit(first)).resolves.toMatchObject({ status: 'committed' });
    await expect(nested!).rejects.toBeInstanceOf(FileMemoryTransactionBusyError);
  });

  test('scope lock rejects a live subprocess, recovers a killed owner, and ignores abandoned prepare artifacts', async () => {
    const { root, stateDir } = fixture('scope-lock-subprocess');
    const request = input(root, stateDir, 'scope-lock-subprocess');
    const lockPath = join(root, '.fx-memory-scope-owner.lock');
    const readyPath = join(root, 'owner-ready');
    const owner = spawnLiveLockOwner(lockPath, readyPath);
    await waitForFile(readyPath);
    await expect(new FileMemoryTransactionStore().commit(request)).rejects.toBeInstanceOf(FileMemoryTransactionBusyError);
    owner.kill('SIGKILL');
    await owner.exited;

    await expect(new FileMemoryTransactionStore().commit(request)).resolves.toMatchObject({ status: 'committed' });

    const abandonedPrepare = `${lockPath}.prepare-00000000-0000-4000-8000-000000000000`;
    writeFileSync(abandonedPrepare, 'incomplete pre-publication lock artifact\n');
    await expect(new FileMemoryTransactionStore().commit(input(root, stateDir, 'scope-lock-prepare')))
      .resolves.toMatchObject({ status: 'committed' });

    writeFileSync(lockPath, 'malformed published lock\n');
    await expect(new FileMemoryTransactionStore().commit(input(root, stateDir, 'scope-lock-malformed')))
      .rejects.toBeInstanceOf(FileMemoryTransactionBusyError);
  });

  test('failed owner-lock acquisition does not leak the in-process root lock', async () => {
    const { root, stateDir } = fixture('lock-acquire-cleanup');
    const lockPath = join(root, '.fx-memory-scope-owner.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: '00000000-0000-4000-8000-000000000000', startedAt: Date.now() })}\n`);
    const request = input(root, stateDir, 'lock-acquire-cleanup');
    const store = new FileMemoryTransactionStore();
    await expect(store.commit(request)).rejects.toBeInstanceOf(FileMemoryTransactionBusyError);
    unlinkSync(lockPath);
    await expect(store.commit(request)).resolves.toMatchObject({ status: 'committed' });
  });

  test('ledger identity includes canonical scope, so raw keys may repeat across roots', async () => {
    const first = fixture('scope-key-first');
    const second = fixture('scope-key-second');
    const stateDir = join(TMP, 'scope-key-shared-state');
    const store = new FileMemoryTransactionStore();
    expect((await store.commit(input(first.root, stateDir, 'same-raw-key'))).status).toBe('committed');
    expect((await store.commit(input(second.root, stateDir, 'same-raw-key'))).status).toBe('committed');
  });

  test('each durable crash boundary recovers the frozen plan after restart', async () => {
    const points: FileMemoryFailpoint[] = ['after-intent', 'after-fact', 'after-index', 'after-receipt'];
    for (const point of points) {
      const { root, stateDir } = fixture(`recover-${point}`);
      const request = input(root, stateDir, point);
      const crashing = new FileMemoryTransactionStore({
        failpoint: (observed) => {
          if (observed === point) throw new Error(`injected ${point}`);
        },
      });
      await expect(crashing.commit(request)).rejects.toThrow(`injected ${point}`);

      const restarted = new FileMemoryTransactionStore();
      await restarted.recover({
        ref: request.ref,
        stateDir,
      });
      const duplicate = await restarted.commit(request);
      expect(duplicate.status).toBe('duplicate');
      expect(readFileSync(join(root, 'traits', 'same-title.md'), 'utf8')).toBe('# Same title\n\nA stable fact.\n');
      expect(readMemoryIndex(root)).toContain('traits/same-title.md');
      expect(Object.keys(filesUnder(stateDir)).filter((file) => file.endsWith('.receipt.json'))).toHaveLength(1);
      expect(Object.keys(filesUnder(root)).some((file) => file.includes('.fx-memory-tmp-'))).toBe(false);
    }
  });

  test('after-first-fact crash resumes a multi-fact plan without suffix drift', async () => {
    const { root, stateDir } = fixture('recover-multi-fact');
    const request = {
      ...input(root, stateDir, 'multi-fact'),
      facts: [
        { kind: 'general' as const, title: 'Same title', text: 'first' },
        { kind: 'general' as const, title: 'Same title', text: 'second' },
      ],
    };
    const crashing = new FileMemoryTransactionStore({
      failpoint: (point) => {
        if (point === 'after-fact') throw new Error('injected after first fact');
      },
    });
    await expect(crashing.commit(request)).rejects.toThrow('injected after first fact');
    expect(existsSync(join(root, 'traits', 'same-title.md'))).toBe(true);
    expect(existsSync(join(root, 'traits', 'same-title-2.md'))).toBe(false);

    const restarted = new FileMemoryTransactionStore();
    const duplicate = await restarted.commit(request);
    expect(duplicate.status).toBe('duplicate');
    expect(readFileSync(join(root, 'traits', 'same-title.md'), 'utf8')).toBe('# Same title\n\nfirst\n');
    expect(readFileSync(join(root, 'traits', 'same-title-2.md'), 'utf8')).toBe('# Same title\n\nsecond\n');
    expect(existsSync(join(root, 'traits', 'same-title-3.md'))).toBe(false);
  });

  test('scope-bound recovery rejects a tampered intent root without writing it', async () => {
    const { root, stateDir } = fixture('tampered-intent-root');
    const request = input(root, stateDir, 'tampered-root');
    mkdirSync(stateDir, { recursive: true });
    const evilRoot = join(TMP, 'evil-intent-root', 'memory');
    writeFileSync(statePath(request, 'intent'), JSON.stringify({
      version: 1,
      idempotencyKey: request.idempotencyKey,
      canonicalCommandHash: request.canonicalCommandHash,
      root: evilRoot,
      plans: [{ tier: 'traits', file: 'traits/owned.md', body: 'must not write\n' }],
    }));
    await expect(new FileMemoryTransactionStore().recover({
      ref: request.ref,
      stateDir,
      idempotencyKey: request.idempotencyKey,
      canonicalCommandHash: request.canonicalCommandHash,
    })).rejects.toBeInstanceOf(FileMemoryTransactionConflictError);
    expect(existsSync(join(evilRoot, 'traits', 'owned.md'))).toBe(false);
    expect(existsSync(join(root, 'traits', 'owned.md'))).toBe(false);
  });

  test('malformed intent/receipt records fail as explicit transaction conflicts', async () => {
    const intentFixture = fixture('malformed-intent');
    const intentRequest = input(intentFixture.root, intentFixture.stateDir, 'malformed-intent');
    mkdirSync(intentFixture.stateDir, { recursive: true });
    writeFileSync(statePath(intentRequest, 'intent'), '{not-json');
    await expect(new FileMemoryTransactionStore().recover({
      ref: intentRequest.ref,
      stateDir: intentFixture.stateDir,
      idempotencyKey: intentRequest.idempotencyKey,
    })).rejects.toBeInstanceOf(FileMemoryTransactionConflictError);

    const receiptFixture = fixture('malformed-receipt');
    const receiptRequest = input(receiptFixture.root, receiptFixture.stateDir, 'malformed-receipt');
    mkdirSync(receiptFixture.stateDir, { recursive: true });
    writeFileSync(statePath(receiptRequest, 'receipt'), '{not-json');
    await expect(new FileMemoryTransactionStore().commit(receiptRequest)).rejects.toBeInstanceOf(FileMemoryTransactionConflictError);
  });

  test('duplicate repairs missing index/fact and rejects a tampered fact body', async () => {
    const { root, stateDir } = fixture('receipt-repair');
    const request = input(root, stateDir, 'receipt-repair');
    const store = new FileMemoryTransactionStore();
    await store.commit(request);
    unlinkSync(join(root, 'traits', 'same-title.md'));
    unlinkSync(join(root, 'MEMORY.md'));
    expect((await store.commit(request)).status).toBe('duplicate');
    expect(readFileSync(join(root, 'traits', 'same-title.md'), 'utf8')).toBe('# Same title\n\nA stable fact.\n');
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toContain('traits/same-title.md');

    writeFileSync(join(root, 'traits', 'same-title.md'), 'tampered\n');
    await expect(store.commit(request)).rejects.toBeInstanceOf(FileMemoryTransactionConflictError);
  });

  test('receipt-only recovery rejects a rechecksummed root-escaping plan before writing', async () => {
    const { root, stateDir } = fixture('receipt-plan-boundary');
    const request = input(root, stateDir, 'receipt-plan-boundary');
    await new FileMemoryTransactionStore().commit(request);
    const receiptPath = statePath(request, 'receipt');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, any>;
    receipt.plans[0].file = 'traits/../../escaped.md';
    receipt.written = [{ tier: 'traits', file: 'traits/../../escaped.md' }];
    const { integrity: _oldIntegrity, ...content } = receipt;
    receipt.integrity = sha256(JSON.stringify(content));
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    unlinkSync(join(root, 'traits', 'same-title.md'));

    await expect(new FileMemoryTransactionStore().recover({
      ref: request.ref,
      stateDir,
      idempotencyKey: request.idempotencyKey,
      canonicalCommandHash: request.canonicalCommandHash,
    })).rejects.toBeInstanceOf(FileMemoryTransactionConflictError);
    expect(existsSync(join(root, '..', 'escaped.md'))).toBe(false);
  });

  test('same command hash and idempotency key cannot change transaction facts', async () => {
    const { root, stateDir } = fixture('facts-binding');
    const store = new FileMemoryTransactionStore();
    const request = input(root, stateDir, 'facts-binding', 'first');
    expect((await store.commit(request)).status).toBe('committed');
    await expect(store.commit({ ...request, facts: [{ kind: 'general', title: 'Same title', text: 'second' }] }))
      .rejects.toBeInstanceOf(FileMemoryTransactionConflictError);
  });

  test('rejects symlinked scope and final memory target components', async () => {
    const base = join(TMP, 'symlink-boundary');
    const actualRoot = join(base, 'actual-root');
    const actualState = join(base, 'actual-state');
    mkdirSync(actualRoot, { recursive: true });
    mkdirSync(actualState, { recursive: true });
    const linkedRoot = join(base, 'linked-root');
    const linkedState = join(base, 'linked-state');
    symlinkSync(actualRoot, linkedRoot, 'dir');
    symlinkSync(actualState, linkedState, 'dir');
    const request = input(linkedRoot, join(base, 'other-state'), 'symlink-root');
    await expect(new FileMemoryTransactionStore().commit(request)).rejects.toThrow(/symlink|junction/);
    await expect(new FileMemoryTransactionStore().commit({ ...input(actualRoot, linkedState, 'symlink-state') }))
      .rejects.toThrow(/symlink|junction/);
    const targetDir = join(actualRoot, 'traits');
    symlinkSync(join(base, 'outside'), targetDir, 'dir');
    await expect(new FileMemoryTransactionStore().commit(input(actualRoot, actualState, 'symlink-target')))
      .rejects.toThrow(/symlink|junction/);
  });

  test('state records obey the configured read byte cap', async () => {
    const { root, stateDir } = fixture('state-cap');
    const request = input(root, stateDir, 'state-cap');
    const store = new FileMemoryTransactionStore({ maxStateRecordBytes: 64 });
    await expect(store.commit(request)).rejects.toThrow(/exceeds/);
  });

  test('cleanup removes only exact generated temps and preserves similar user files', async () => {
    const { root, stateDir } = fixture('temp-cleanup');
    const similarRoot = join(root, '.user.fx-memory-tmp-00000000-0000-4000-8000-000000000000');
    const similarState = join(stateDir, '.fx-memory-tmp-not-a-uuid');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(similarRoot, 'keep root temp-like file');
    writeFileSync(similarState, 'keep state temp-like file');
    const request = input(root, stateDir, 'temp-cleanup');
    const crashing = new FileMemoryTransactionStore({ failpoint: (point) => {
      if (point === 'after-intent') throw new Error('injected');
    } });
    await expect(crashing.commit(request)).rejects.toThrow('injected');
    await new FileMemoryTransactionStore().recover({
      ref: request.ref,
      stateDir,
      idempotencyKey: request.idempotencyKey,
    });
    expect(existsSync(similarRoot)).toBe(true);
    expect(existsSync(similarState)).toBe(true);
  });

  test('low-level planning helpers stay off the layered-memory public facade', async () => {
    const facade = await import('../src/soul/layered-memory');
    expect('planMemoryEntry' in facade).toBe(false);
    expect('planClassifiedMemoryFacts' in facade).toBe(false);
    expect('materializePlannedMemoryEntry' in facade).toBe(false);
    expect('rebuildMemoryIndex' in facade).toBe(false);
    expect('isMemorySlug' in facade).toBe(false);
  });

  test('stateDir cannot overlap memory root', async () => {
    const root = join(TMP, 'unsafe', 'memory');
    mkdirSync(root, { recursive: true });
    await expect(new FileMemoryTransactionStore().commit({
      ...input(root, join(root, 'state'), 'unsafe'),
    })).rejects.toThrow(/stateDir must not overlap/);
  });
});
