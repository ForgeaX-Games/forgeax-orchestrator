import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@forgeax/types/npc-memory';
import {
  DurableMemoryOutbox,
  DurableMemoryOutboxAbortTimeoutError,
  DurableMemoryOutboxConflictError,
  DurableMemoryOutboxCapacityError,
  type DurableMemoryHandoff,
} from '../src/npc-brain/memory/durable-memory-outbox';

const TMP = mkdtempSync(join(tmpdir(), 'fx-memory-outbox-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const hex = (value: string, length: 32 | 64 = 64) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);
const canonicalHash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

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

function handoff(
  name: string,
  commands: Array<{ name: string; scope: string }> = [{ name: `${name}-command`, scope: 'scope-a' }],
): DurableMemoryHandoff<{ value: string }, { value: string }> {
  return {
    handoffId: `handoff-${name}`,
    eventId: `event-${name}`,
    decisionHash: canonicalHash({ value: `decision-${name}` }),
    decision: { value: `decision-${name}` },
    commands: commands.map(({ name: commandName, scope }) => ({
      commandId: `command-${commandName}`,
      scopeKey: scope,
      idempotencyKey: hex(`idem-${commandName}`, 32),
      commandHash: canonicalHash({ value: commandName }),
      payload: { value: commandName },
    })),
  };
}

describe('DurableMemoryOutbox', () => {
  test('fsync handoff is replayable and exact retries reuse the decision receipt', async () => {
    const stateDir = join(TMP, 'replay');
    const first = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, providerReceiptId: 'unused', status: 'written' }),
    });
    await first.start();
    const request = handoff('one');
    expect((await first.enqueueHandoff(request)).status).toBe('enqueued');
    expect((await first.enqueueHandoff(request)).status).toBe('duplicate');
    expect(first.getHandoff(request.handoffId)).toEqual(request);
    await first.stop({ mode: 'abort' });

    const replayed = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, providerReceiptId: 'unused', status: 'written' }),
    });
    await replayed.start();
    expect(replayed.getHandoff(request.handoffId)).toEqual(request);
    expect(replayed.pendingCount).toBe(1);
    await expect(replayed.enqueueHandoff({ ...request, decisionHash: hex('different') }))
      .rejects.toBeInstanceOf(DurableMemoryOutboxConflictError);
    await replayed.stop({ mode: 'abort' });
  });

  test('drain stop closes enqueue admission before observing pending work', async () => {
    const outbox = new DurableMemoryOutbox({
      stateDir: join(TMP, 'drain-admission-race'),
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }),
    });
    await outbox.start();
    // stop() reaches its first await while drain sees no work. The following
    // enqueue used to pass admission and leave a pending command after stop.
    const stopping = outbox.stop({ mode: 'drain' });
    await expect(outbox.enqueueHandoff(handoff('drain-admission-race'))).rejects.toThrow(/stopping/);
    await stopping;
    expect(outbox.pendingCount).toBe(0);
  });

  test('abort times out an uncooperative dispatch without releasing ownership, then permits safe retry after it settles', async () => {
    const stateDir = join(TMP, 'abort-uncooperative-dispatch');
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    let releaseDispatch!: () => void;
    const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const outbox = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      abortSettleTimeoutMs: 20,
      dispatch: async (command) => {
        dispatchStarted();
        // Deliberately ignore the supplied AbortSignal to model a broken
        // network/provider implementation.
        await dispatchFinished;
        return { commandId: command.commandId, status: 'written' as const };
      },
    });
    await outbox.start();
    await outbox.enqueueHandoff(handoff('abort-uncooperative-dispatch'));
    const running = outbox.runReady();
    await started;

    await expect(outbox.stop({ mode: 'abort' })).rejects.toBeInstanceOf(DurableMemoryOutboxAbortTimeoutError);
    await expect(new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }),
    }).start()).rejects.toThrow(/already owned/);

    releaseDispatch();
    await running;
    await outbox.stop({ mode: 'abort' });
    const reopened = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }),
    });
    await reopened.start();
    await reopened.stop({ mode: 'abort' });
  });

  test('owner lock rejects a live subprocess, recovers a killed owner, and ignores abandoned prepare artifacts', async () => {
    const stateDir = join(TMP, 'owner-lock-subprocess');
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, 'memory-commands.v1.owner.lock');
    const readyPath = join(stateDir, 'owner-ready');
    const owner = spawnLiveLockOwner(lockPath, readyPath);
    await waitForFile(readyPath);
    const options = {
      stateDir,
      autoRun: false,
      dispatch: async (command: { commandId: string }) => ({ commandId: command.commandId, status: 'written' as const }),
    };
    await expect(new DurableMemoryOutbox(options).start()).rejects.toThrow(/already owned/);
    owner.kill('SIGKILL');
    await owner.exited;

    const recovered = new DurableMemoryOutbox(options);
    await recovered.start();
    await recovered.stop({ mode: 'abort' });

    const abandonedPrepare = `${lockPath}.prepare-00000000-0000-4000-8000-000000000000`;
    writeFileSync(abandonedPrepare, 'incomplete pre-publication lock artifact\n');
    const ignoresPrepare = new DurableMemoryOutbox(options);
    await ignoresPrepare.start();
    await ignoresPrepare.stop({ mode: 'abort' });

    writeFileSync(lockPath, 'malformed published lock\n');
    await expect(new DurableMemoryOutbox(options).start()).rejects.toThrow(/malformed/);
  });

  test('orders one scope while allowing independent scopes to dispatch together', async () => {
    const stateDir = join(TMP, 'ordering');
    let now = 1_000;
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    const outbox = new DurableMemoryOutbox<{ value: string }, { value: string }>({
      stateDir,
      now: () => now,
      autoRun: false,
      retryBaseMs: 10,
      dispatch: async (command) => {
        calls.push(command.commandId);
        const count = (attempts.get(command.commandId) ?? 0) + 1;
        attempts.set(command.commandId, count);
        if (command.commandId.includes('a1') && count === 1) {
          const error = new Error('retry') as Error & { code: string };
          error.code = 'io_error';
          throw error;
        }
        return { commandId: command.commandId, providerReceiptId: `receipt-${command.commandId}`, status: 'written' };
      },
    });
    await outbox.start();
    await outbox.enqueueHandoff(handoff('batch', [
      { name: 'a1', scope: 'scope-a' },
      { name: 'a2', scope: 'scope-a' },
      { name: 'b1', scope: 'scope-b' },
    ]));
    expect(await outbox.runReady()).toBe(2);
    expect(calls).toEqual(expect.arrayContaining(['command-a1', 'command-b1']));
    expect(calls).not.toContain('command-a2');
    now += 10;
    expect(await outbox.runReady()).toBe(1);
    expect(calls.at(-1)).toBe('command-a1');
    expect(await outbox.runReady()).toBe(1);
    expect(calls.at(-1)).toBe('command-a2');
    expect(outbox.succeededCount).toBe(3);
    await outbox.stop({ mode: 'abort' });
  });

  test('replays an unknown dispatch through provider idempotency after crash-before-ack', async () => {
    const stateDir = join(TMP, 'unknown');
    const applied = new Set<string>();
    let sideEffects = 0;
    const dispatch = async (command: { commandId: string }) => {
      const duplicate = applied.has(command.commandId);
      if (!duplicate) {
        applied.add(command.commandId);
        sideEffects += 1;
      }
      return {
        commandId: command.commandId,
        providerReceiptId: `receipt-${command.commandId}`,
        status: duplicate ? 'duplicate' as const : 'written' as const,
      };
    };
    const crashing = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch,
      failpoint: () => { throw new Error('simulated process crash'); },
    });
    await crashing.start();
    await crashing.enqueueHandoff(handoff('unknown'));
    await expect(crashing.runReady()).rejects.toThrow('simulated process crash');
    expect(sideEffects).toBe(1);
    await crashing.stop({ mode: 'abort' });

    const restarted = new DurableMemoryOutbox({ stateDir, autoRun: false, dispatch });
    await restarted.start();
    expect(restarted.pendingCount).toBe(1);
    await restarted.runReady();
    expect(sideEffects).toBe(1);
    expect(restarted.succeededCount).toBe(1);
    await restarted.stop({ mode: 'abort' });
  });

  test('ignores only an incomplete final line and fails closed on complete corruption', async () => {
    const stateDir = join(TMP, 'corruption');
    const outbox = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, providerReceiptId: 'unused', status: 'written' }),
    });
    await outbox.start();
    await outbox.enqueueHandoff(handoff('corrupt'));
    await outbox.stop({ mode: 'abort' });
    const journal = join(stateDir, 'memory-commands.v1.jsonl');
    appendFileSync(journal, 'partial-crash-tail');
    const tolerated = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, providerReceiptId: 'unused', status: 'written' }),
    });
    await tolerated.start();
    const afterTail = handoff('after-tail');
    await tolerated.enqueueHandoff(afterTail);
    await tolerated.stop({ mode: 'abort' });
    const repaired = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, providerReceiptId: 'unused', status: 'written' }),
    });
    await repaired.start();
    expect(repaired.getHandoff(afterTail.handoffId)).toEqual(afterTail);
    await repaired.stop({ mode: 'abort' });

    appendFileSync(journal, 'partial-crash-tail\n');
    const corrupt = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, providerReceiptId: 'unused', status: 'written' }),
    });
    await expect(corrupt.start()).rejects.toThrow(/checksum prefix/);
    expect(readFileSync(journal, 'utf8')).toContain('partial-crash-tail');
  });

  test('rejects reuse of one scope/idempotency key by another command', async () => {
    const stateDir = join(TMP, 'idempotency-owner');
    const outbox = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, status: 'written' }),
    });
    await outbox.start();
    const first = handoff('owner-first');
    await outbox.enqueueHandoff(first);
    const second = handoff('owner-second');
    const reused = {
      ...second,
      commands: [{
        ...second.commands[0],
        scopeKey: first.commands[0].scopeKey,
        idempotencyKey: first.commands[0].idempotencyKey,
      }],
    };
    await expect(outbox.enqueueHandoff(reused)).rejects.toBeInstanceOf(DurableMemoryOutboxConflictError);
    await outbox.stop({ mode: 'abort' });
  });

  test('does not acknowledge a provider receipt for another command', async () => {
    const stateDir = join(TMP, 'receipt-binding');
    const outbox = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      maxAttempts: 1,
      dispatch: async () => ({ commandId: 'wrong-command', status: 'written' }),
    });
    await outbox.start();
    await outbox.enqueueHandoff(handoff('receipt-binding'));
    expect(await outbox.runReady()).toBe(1);
    expect(outbox.succeededCount).toBe(0);
    expect(outbox.deadLetterCount).toBe(1);
    await outbox.stop({ mode: 'abort' });
  });

  test('provider code cannot mutate the journal-authoritative command payload', async () => {
    const stateDir = join(TMP, 'dispatch-mutation');
    const request = handoff('dispatch-mutation');
    const outbox = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      maxAttempts: 1,
      dispatch: async (command) => {
        (command.payload as { value: string }).value = 'provider-tampered';
        return { commandId: command.commandId, status: 'written' as const };
      },
    });
    await outbox.start();
    await outbox.enqueueHandoff(request);
    await outbox.runReady();
    expect(outbox.deadLetterCount).toBe(1);
    expect(outbox.getHandoff(request.handoffId)).toEqual(request);
    await outbox.stop({ mode: 'abort' });

    const replayed = new DurableMemoryOutbox({
      stateDir,
      autoRun: false,
      dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }),
    });
    await replayed.start();
    expect(replayed.getHandoff(request.handoffId)).toEqual(request);
    await replayed.stop({ mode: 'abort' });
  });

  test('unsupported and rejected provider outcomes are terminal dead letters without retry', async () => {
    for (const status of ['unsupported', 'rejected'] as const) {
      const stateDir = join(TMP, `terminal-${status}`);
      let calls = 0;
      const outbox = new DurableMemoryOutbox({
        stateDir,
        autoRun: false,
        dispatch: async (command) => {
          calls += 1;
          return { commandId: command.commandId, status, providerReceiptId: `${status}-receipt` };
        },
      });
      await outbox.start();
      await outbox.enqueueHandoff(handoff(`terminal-${status}`));
      expect(await outbox.runReady()).toBe(1);
      expect(calls).toBe(1);
      expect(outbox.pendingCount).toBe(0);
      expect(outbox.deadLetterCount).toBe(1);
      await outbox.stop({ mode: 'abort' });
    }
  });

  test('compacts before append and prunes expired terminal state after restart', async () => {
    const stateDir = join(TMP, 'compact-prune');
    let now = 1_000;
    const dispatch = async (command: { commandId: string }) => ({ commandId: command.commandId, status: 'written' as const });
    const first = new DurableMemoryOutbox({ stateDir, autoRun: false, now: () => now, maxJournalBytes: 2_000, terminalRetentionMs: 10, dispatch });
    await first.start();
    const old = handoff('compact-old');
    await first.enqueueHandoff(old);
    await first.runReady();
    await first.stop({ mode: 'abort' });

    now += 100;
    const restarted = new DurableMemoryOutbox({ stateDir, autoRun: false, now: () => now, maxJournalBytes: 2_000, terminalRetentionMs: 10, dispatch });
    await restarted.start();
    expect(restarted.succeededCount).toBe(0);
    expect((await restarted.enqueueHandoff(old)).status).toBe('enqueued');
    await restarted.stop({ mode: 'abort' });
  });

  test('rebinds the appended sequence after real compaction and restart', async () => {
    const stateDir = join(TMP, 'compact-rebind');
    let now = 1_000;
    const dispatch = async (command: { commandId: string }) => ({ commandId: command.commandId, status: 'written' as const });
    const first = new DurableMemoryOutbox({ stateDir, autoRun: false, now: () => now, maxJournalBytes: 3_200, terminalRetentionMs: 10, dispatch });
    await first.start();
    for (const name of ['one', 'two', 'three']) {
      await first.enqueueHandoff(handoff(`rebind-${name}`));
      await first.runReady();
    }
    now = 2_000;
    const fourth = handoff('rebind-four');
    await first.enqueueHandoff(fourth);
    await first.stop({ mode: 'abort' });

    const restarted = new DurableMemoryOutbox({ stateDir, autoRun: false, now: () => now, maxJournalBytes: 3_200, terminalRetentionMs: 10, dispatch });
    await restarted.start();
    expect(restarted.getHandoff(fourth.handoffId)).toEqual(fourth);
    expect(restarted.pendingCount).toBe(1);
    await restarted.stop({ mode: 'abort' });
  });

  test('fails closed when accidental payload corruption leaves caller hashes unchanged', async () => {
    for (const kind of ['decision', 'payload'] as const) {
      const stateDir = join(TMP, `tamper-${kind}`);
      const outbox = new DurableMemoryOutbox({ stateDir, autoRun: false, dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }) });
      await outbox.start();
      await outbox.enqueueHandoff(handoff(`tamper-${kind}`));
      await outbox.stop({ mode: 'abort' });
      const journal = join(stateDir, 'memory-commands.v1.jsonl');
      const lines = readFileSync(journal, 'utf8').trimEnd().split('\n');
      const tab = lines[0].indexOf('\t');
      const record = JSON.parse(lines[0].slice(tab + 1)) as Record<string, any>;
      if (kind === 'decision') record.handoff.decision.value = 'tampered';
      else record.handoff.commands[0].payload.value = 'tampered';
      const json = JSON.stringify(record);
      lines[0] = `${hex(json)}\t${json}`;
      writeFileSync(journal, `${lines.join('\n')}\n`);
      const reopened = new DurableMemoryOutbox({ stateDir, autoRun: false, dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }) });
      await expect(reopened.start()).rejects.toThrow(/canonical (decision|payload)/);
    }
  });

  test('rejects non-I-JSON lone surrogates before enqueue', async () => {
    const stateDir = join(TMP, 'lone-surrogate');
    const outbox = new DurableMemoryOutbox({ stateDir, autoRun: false, dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }) });
    await outbox.start();
    const invalid = handoff('lone-surrogate');
    invalid.decision.value = '\ud800';
    await expect(outbox.enqueueHandoff(invalid)).rejects.toThrow();
    await outbox.stop({ mode: 'abort' });
  });

  test('replay yields to the event loop while reading a large journal', async () => {
    const stateDir = join(TMP, 'responsive-replay');
    const value = { value: Array.from({ length: 10_000 }, () => 'xxxxxxxxxx') };
    const largeHandoff: DurableMemoryHandoff<unknown, unknown> = {
      handoffId: 'handoff-large-replay',
      eventId: 'event-large-replay',
      decisionHash: canonicalHash(value),
      decision: value,
      commands: [{
        commandId: 'command-large-replay', scopeKey: 'scope-large', idempotencyKey: hex('idem-large', 32),
        commandHash: canonicalHash(value), payload: value,
      }],
    };
    const first = new DurableMemoryOutbox({ stateDir, autoRun: false, dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }) });
    await first.start();
    await first.enqueueHandoff(largeHandoff);
    await first.stop({ mode: 'abort' });
    const restarted = new DurableMemoryOutbox({ stateDir, autoRun: false, dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }) });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    await restarted.start();
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    await restarted.stop({ mode: 'abort' });
  });

  test('fails closed when a single handoff cannot fit the journal cap', async () => {
    const outbox = new DurableMemoryOutbox({
      stateDir: join(TMP, 'tiny-cap'),
      autoRun: false,
      maxJournalBytes: 256,
      dispatch: async (command) => ({ commandId: command.commandId, status: 'written' as const }),
    });
    await outbox.start();
    await expect(outbox.enqueueHandoff(handoff('too-large'))).rejects.toBeInstanceOf(DurableMemoryOutboxCapacityError);
    await outbox.stop({ mode: 'abort' });
  });
});
