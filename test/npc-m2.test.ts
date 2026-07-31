import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpcBatchCollector } from '../src/npc-brain/batch-collector';
import { NpcGovernor } from '../src/npc-brain/governor';
import { NpcBrainService } from '../src/npc-brain/service';
import { NpcWorkingMemory } from '../src/npc-brain/working-memory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectRoot() {
  const value = mkdtempSync(join(tmpdir(), 'npc-m2-'));
  roots.push(value);
  return value;
}

function snapshot(npcId: string, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    eventId: `event-${npcId}`,
    game: 'arena',
    npcId,
    t: 1,
    trigger: 'heartbeat',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [{ kind: 'player', id: 'p1', pos: { x: 1, y: 1 }, facts: [] }],
    events: [],
    affordances: [{ action: 'idle' }],
    scene: 'square',
    visibilityGroup: 'public',
    ...overrides,
  };
}

describe('M2 cognitive LOD and budgets', () => {
  test('uses explicit spotlight, ambient retention, offstage pause, and situational cache', () => {
    let now = 0;
    const governor = new NpcGovernor({ now: () => now, batchWindowMs: 0, demotionRetentionMs: 600_000 });
    governor.attach('arena', 'guide');
    const active = snapshot('guide');
    expect(governor.classify(active as any)).toBe('spotlight');
    governor.rememberAmbientDecision(active as any, { line: 'cached' });
    governor.detach('arena', 'guide');
    expect(governor.classify(active as any)).toBe('ambient');
    expect(governor.ambientDecision<{ line: string }>(active as any)).toEqual({ line: 'cached' });
    expect(governor.ambientDecision(snapshot('guide', { scene: 'dock' }) as any)).toBeUndefined();
    now = 600_001;
    expect(governor.classify(active as any)).toBe('offstage');
    governor.attach('arena', 'guide');
    expect(governor.classify(snapshot('guide', { nearby: [] }) as any)).toBe('offstage');
  });

  test('enforces global and per-game calls/tokens and reports budget dimensions', async () => {
    const governor = new NpcGovernor({
      callsPerMinute: 2,
      tokensPerMinute: 100,
      maxConcurrent: 1,
      batchWindowMs: 0,
      now: () => 0,
    });
    expect((await governor.schedule({
      game: 'arena',
      level: 'spotlight',
      priority: 'player',
      estimatedTokens: 60,
      gameLimits: { callsPerMinute: 1, tokensPerMinute: 80 },
      run: async () => 'ok',
    })).accepted).toBe(true);
    const skipped = await governor.schedule({
      game: 'arena',
      level: 'spotlight',
      priority: 'heartbeat',
      estimatedTokens: 1,
      gameLimits: { callsPerMinute: 1, tokensPerMinute: 80 },
      run: async () => 'never',
    });
    expect(skipped).toEqual({ accepted: false, reason: 'calls_budget' });
    expect(governor.budgetState('arena', { callsPerMinute: 1, tokensPerMinute: 80 })).toMatchObject({
      state: 'exhausted',
      calls: { limit: 1, used: 1, remaining: 0 },
      tokens: { limit: 80, used: 60, remaining: 20 },
    });
  });

  test('drops queued heartbeat work before player work under pressure', async () => {
    let drain!: () => void;
    const governor = new NpcGovernor({
      batchWindowMs: 100,
      maxQueued: 1,
      setTimer: (callback) => {
        drain = callback;
        return 1;
      },
      now: () => 0,
    });
    const heartbeat = governor.schedule({
      game: 'arena',
      level: 'spotlight',
      priority: 'heartbeat',
      estimatedTokens: 1,
      run: async () => 'heartbeat',
    });
    const player = governor.schedule({
      game: 'arena',
      level: 'spotlight',
      priority: 'player',
      estimatedTokens: 1,
      run: async () => 'player',
    });
    drain();
    expect(await heartbeat).toEqual({ accepted: false, reason: 'queue_drop' });
    expect(await player).toEqual({ accepted: true, value: 'player' });
  });

  test('keeps global and game configuration as independent hard ceilings', async () => {
    const root = projectRoot();
    mkdirSync(join(root, '.forgeax/games/arena'), { recursive: true });
    writeFileSync(join(root, '.forgeax/npc-brain.json'), JSON.stringify({
      budget: { maxCallsPerMinute: 10, maxTokensPerMinute: 10_000 },
    }));
    writeFileSync(join(root, '.forgeax/games/arena/forge.json'), JSON.stringify({
      npc: { budget: { maxCallsPerMinute: 2, maxTokensPerMinute: 1_000 } },
    }));
    let calls = 0;
    const brain = new NpcBrainService({
      projectRoot: root,
      now: () => 0,
      complete: async (request) => {
        calls += 1;
        return { text: '{}', model: request.model, transport: 'mock', latencyMs: 1 };
      },
    });
    for (let index = 0; index < 3; index++) {
      await brain.decide(snapshot('guide', {
        trigger: 'player_message',
        eventId: `configured-${index}`,
      }));
    }
    expect(calls).toBe(2);
    expect(brain.budgetState('arena')).toMatchObject({
      state: 'exhausted',
      calls: { limit: 2, used: 2, remaining: 0 },
    });
  });
});

describe('M2 true batching', () => {
  test('collects arrivals for exactly 100ms and flushes once', async () => {
    let timer: (() => void) | undefined;
    let delay = 0;
    let calls = 0;
    const collector = new NpcBatchCollector<number, number>({
      windowMs: 100,
      setTimer: (callback, requestedDelay) => {
        timer = callback;
        delay = requestedDelay;
        return 1;
      },
      flush: async (items) => {
        calls += 1;
        return items.map((item) => item * 2);
      },
    });
    const pending = [collector.add(1), collector.add(2), collector.add(3)];
    expect(delay).toBe(100);
    expect(calls).toBe(0);
    timer!();
    expect(await Promise.all(pending)).toEqual([[2, 4, 6], [2, 4, 6], [2, 4, 6]]);
    expect(calls).toBe(1);
  });

  test('decides five spotlight NPCs with one LLM call', async () => {
    let calls = 0;
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      now: () => 0,
      complete: async (request) => {
        calls += 1;
        const sections = request.messages[1]!.content.trim().split('\n').map((line) => JSON.parse(line));
        return {
          text: JSON.stringify({
            decisions: sections.map(({ npcId }: { npcId: string }) => ({
              npcId,
              decision: { utterance: { lines: [`hello ${npcId}`] } },
            })),
          }),
          model: request.model,
          transport: 'mock',
          latencyMs: 1,
        };
      },
    });
    const snapshots = Array.from({ length: 5 }, (_, index) => snapshot(`npc-${index}`));
    for (const item of snapshots) brain.attach('arena', item.npcId);
    const decisions = await brain.decideBatch(snapshots);
    expect(decisions).toHaveLength(5);
    expect(calls).toBe(1);
    expect(brain.budgetState('arena').calls?.used).toBe(1);
  });

  test('falls back when a player-message batch omits the required utterance', async () => {
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      now: () => 0,
      complete: async (request) => ({
        text: JSON.stringify({
          decisions: [{ npcId: 'guide', decision: { intent: { action: 'idle', ttlSec: 1 } } }],
        }),
        model: request.model,
        transport: 'mock',
        latencyMs: 1,
      }),
    });

    const decisions = await brain.decideBatch([
      snapshot('guide', { trigger: 'player_message', text: 'Where is the gate?' }),
    ]);
    expect(decisions).toEqual([]);
  });

  test('bounds a batch provider call by the caller deadline', async () => {
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      complete: async () => new Promise(() => {}),
    });

    const startedAt = Date.now();
    const decisions = await brain.decideBatch(
      [snapshot('guide')],
      () => ({ deadlineMs: 10 }),
    );
    expect(decisions).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test('does not feed heartbeat decisions back into working-memory prompts', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      complete: async (request) => {
        prompts.push(request.messages[1]!.content);
        calls += 1;
        return {
          text: JSON.stringify({
            decisions: [{
              npcId: 'guide',
              decision: { utterance: { lines: [`heartbeat-reply-${calls}`] } },
            }],
          }),
          model: request.model,
          transport: 'mock',
          latencyMs: 1,
        };
      },
    });

    brain.attach('arena', 'guide');
    await brain.decideBatch([snapshot('guide')]);
    await brain.decideBatch([snapshot('guide', { eventId: 'heartbeat-2' })]);
    expect(prompts[1]).not.toContain('heartbeat-reply-1');
  });
});

describe('M2 working memory and settlement', () => {
  test('never mutates raw logs, never exceeds hard waterline, and falls back after three failures', async () => {
    let calls = 0;
    const memory = new NpcWorkingMemory({
      softTokens: 5,
      hardTokens: 20,
      cooldownMs: 0,
      now: () => calls,
      summarize: async () => {
        calls += 1;
        throw new Error('injected compression failure');
      },
    });
    for (let index = 0; index < 3; index++) {
      memory.append({ snapshot: { text: `player-${index}` }, decision: { line: `npc-${index}` } });
      await memory.settled();
    }
    expect(memory.consecutiveFailures).toBe(3);
    expect(memory.mechanicalFallback).toBe(true);
    expect(memory.rawEntries).toHaveLength(3);
    expect(memory.view().estimatedTokens).toBeLessThanOrEqual(20);
  });

  test('rejects a syntactically valid summary that invents an unseen fact', async () => {
    const memory = new NpcWorkingMemory({
      softTokens: 1,
      hardTokens: 100,
      cooldownMs: 0,
      summarize: async () => 'player met the nonexistent blacksmith',
      validateSummary: (summary, entries) => JSON.stringify(entries).includes(summary),
    });
    memory.append({ snapshot: { text: 'player waved' }, decision: { line: 'hello' } });
    await memory.settled();
    expect(memory.summaries).toHaveLength(0);
    expect(memory.consecutiveFailures).toBe(1);
    expect(memory.rawEntries).toHaveLength(1);
  });

  test('keeps a per-NPC compression lock while decisions append', async () => {
    let release!: (value: string) => void;
    let calls = 0;
    const memory = new NpcWorkingMemory({
      softTokens: 1,
      hardTokens: 100,
      cooldownMs: 0,
      summarize: () => {
        calls += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    memory.append({ snapshot: { turn: 1 }, decision: { turn: 1 } });
    memory.append({ snapshot: { turn: 2 }, decision: { turn: 2 } });
    expect(calls).toBe(1);
    expect(memory.rawEntries).toHaveLength(2);
    release('turn one happened');
    await memory.settled();
    expect(memory.rawEntries).toHaveLength(2);
    expect(memory.summaries[0]?.boundary).toBe(1);
  });

  test('feeds server mood/towards into later prompts and settles from raw log', async () => {
    const root = projectRoot();
    let decisionCalls = 0;
    let secondPrompt = '';
    const brain = new NpcBrainService({
      projectRoot: root,
      now: () => 0,
      complete: async (request) => {
        if (!request.responseFormat) {
          return { text: 'Player p1 helped the guide, who now trusts p1.', model: request.model, transport: 'mock', latencyMs: 1 };
        }
        decisionCalls += 1;
        secondPrompt = decisionCalls === 2 ? request.messages.at(-1)!.content : secondPrompt;
        return {
          text: JSON.stringify({
            utterance: { lines: ['hello'] },
            emotion: { mood: 'grateful', towards: { p1: 0.8, p2: -0.2 } },
          }),
          model: request.model,
          transport: 'mock',
          latencyMs: 1,
        };
      },
    });
    await brain.decide(snapshot('guide', { trigger: 'player_message', playerId: 'p1' }));
    await brain.decide(snapshot('guide', { eventId: 'event-2', trigger: 'player_message', playerId: 'p1' }));
    expect(secondPrompt).toContain('"p1":0.8');
    expect(secondPrompt).toContain('"p2":-0.2');
    expect(await brain.settle('arena', 'p1', ['guide'])).toBe(1);
    expect(existsSync(join(root, '.forgeax/souls/arena.guide/memory/episodes/arena/player-p1-helped-the-guide-who-now-trusts-p1.md'))).toBe(true);
    expect(brain.activeBrainCount).toBe(0);
  });
});
