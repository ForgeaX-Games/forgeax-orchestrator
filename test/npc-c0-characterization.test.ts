import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { complete as completeLlm } from '../src/lib/llm-gateway';
import { NpcBrainService } from '../src/npc-brain/service';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function controlledProvider() {
  const entered = [deferred(), deferred()] as const;
  const release = [deferred(), deferred()] as const;
  let calls = 0;
  let active = 0;
  let maxActive = 0;

  const complete: typeof completeLlm = async (request) => {
    const callIndex = calls++;
    const entry = entered[callIndex];
    const gate = release[callIndex];
    if (!entry || !gate) throw new Error(`unexpected provider call ${callIndex + 1}`);

    active += 1;
    maxActive = Math.max(maxActive, active);
    entry.resolve();
    await gate.promise;
    active -= 1;

    const decision = { utterance: { lines: [`provider-call-${callIndex + 1}`] } };
    return {
      text: request.responseFormat?.name === 'npc_decisions'
        ? JSON.stringify({ decisions: [{ npcId: 'guide', decision }] })
        : JSON.stringify(decision),
      model: request.model,
      transport: 'c0-controlled',
      latencyMs: 1,
    };
  };

  return {
    complete,
    entered,
    release,
    get calls() { return calls; },
    get active() { return active; },
    get maxActive() { return maxActive; },
  };
}

function snapshot(eventId: string) {
  return {
    v: 1,
    eventId,
    game: 'c0-characterization',
    npcId: 'guide',
    playerId: 'player-1',
    t: 1,
    trigger: 'event',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [],
    events: [{ type: eventId }],
    affordances: [{ action: 'idle' }],
  };
}

async function expectPromptEntry(entry: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entry,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not enter the provider boundary`)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const roots: string[] = [];

function projectRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'npc-c0-characterization-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('C0 current NPC execution characterization', () => {
  test('serializes two same-NPC decide calls at the provider boundary', async () => {
    const provider = controlledProvider();
    const brain = new NpcBrainService({ projectRoot: projectRoot(), complete: provider.complete });
    const first = brain.decide(snapshot('serial-1'));
    await expectPromptEntry(provider.entered[0].promise, 'first decide');

    const second = brain.decide(snapshot('serial-2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.calls).toBe(1);
    expect(provider.active).toBe(1);
    expect(provider.maxActive).toBe(1);

    provider.release[0].resolve();
    await expectPromptEntry(provider.entered[1].promise, 'second decide');
    expect(provider.active).toBe(1);
    expect(provider.maxActive).toBe(1);

    provider.release[1].resolve();
    const decisions = await Promise.all([first, second]);
    expect(decisions.map((decision) => decision?.seq)).toEqual([1, 2]);
    expect(provider.active).toBe(0);
  });

  test('currently lets two same-NPC single-item decideBatch calls overlap at the provider boundary', async () => {
    const provider = controlledProvider();
    const brain = new NpcBrainService({ projectRoot: projectRoot(), complete: provider.complete });
    const first = brain.decideBatch([snapshot('batch-1')]);
    const second = brain.decideBatch([snapshot('batch-2')]);

    try {
      await Promise.all([
        expectPromptEntry(provider.entered[0].promise, 'first decideBatch'),
        expectPromptEntry(provider.entered[1].promise, 'second decideBatch'),
      ]);
      expect(provider.calls).toBe(2);
      expect(provider.active).toBe(2);
      expect(provider.maxActive).toBe(2);
    } finally {
      provider.release[0].resolve();
      provider.release[1].resolve();
    }

    const decisions = await Promise.all([first, second]);
    expect(decisions.flatMap((batch) => batch.map((decision) => decision.seq)).sort()).toEqual([1, 2]);
    expect(provider.active).toBe(0);
  });
});
