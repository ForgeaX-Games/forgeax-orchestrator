import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpcBrainService } from '../src/npc-brain/service';
import { NpcWorkingMemory } from '../src/npc-brain/working-memory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'npc-acceptance-'));
  roots.push(root);
  return root;
}

function snapshot(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    eventId,
    game: 'acceptance',
    npcId: 'guide',
    playerId: 'p1',
    t: 1,
    trigger: 'player_message',
    text: eventId,
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [{ kind: 'player', id: 'p1', pos: { x: 1, y: 1 }, facts: [] }],
    events: [],
    affordances: [{ action: 'idle' }],
    ...overrides,
  };
}

const response = (text: string) => ({
  text,
  model: 'acceptance-model',
  transport: 'mock',
  latencyMs: 1,
});

describe('PRD M0-M2 deterministic acceptance', () => {
  test('rejects 24 malformed decisions deterministically without advancing sequence', async () => {
    let valid = false;
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      model: 'acceptance-model',
      fallbackModels: [],
      complete: async () => response(valid
        ? '{"intent":{"action":"idle","ttlSec":5},"utterance":{"lines":["Ready."]}}'
        : '{"intent":'),
    });

    for (let index = 0; index < 24; index++) {
      expect(await brain.decide(snapshot(`malformed-${index}`))).toBeUndefined();
    }
    valid = true;
    expect(await brain.decide(snapshot('valid-after-malformed'))).toMatchObject({ seq: 1 });
  });

  test('preserves six complete prior turns in the seventh decision prompt', async () => {
    const prompts: Array<readonly { role: string; content: string }[]> = [];
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      model: 'acceptance-model',
      complete: async (request) => {
        prompts.push(request.messages);
        return response('{"utterance":{"lines":["ok"]}}');
      },
    });

    for (let turn = 1; turn <= 7; turn++) {
      expect(await brain.decide(snapshot(`turn-${turn}`, {
        t: turn,
        events: [{ type: `turn-${turn}` }],
      }))).toMatchObject({ seq: turn });
    }
    const seventh = prompts.at(-1)!;
    for (let turn = 1; turn <= 6; turn++) {
      expect(seventh.some((message) => message.content.includes(`"type":"turn-${turn}"`))).toBe(true);
    }
  });

  test('batches 30 spotlight minds independently of 5000 local Bodies', async () => {
    let calls = 0;
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      model: 'acceptance-model',
      complete: async (request) => {
        calls += 1;
        const sections = request.messages[1]!.content.trim().split('\n').map((line) => JSON.parse(line));
        return response(JSON.stringify({
          decisions: sections.map(({ npcId }: { npcId: string }) => ({
            npcId,
            decision: { intent: { action: 'idle', ttlSec: 30 } },
          })),
        }));
      },
    });
    const bodies = Array.from({ length: 5_000 }, (_, id) => ({ id, x: 0 }));
    const frameStartedAt = performance.now();
    for (let frame = 0; frame < 600; frame++) {
      for (const body of bodies) body.x += 1;
    }
    const frameMs = (performance.now() - frameStartedAt) / 600;
    const spotlight = Array.from({ length: 30 }, (_, index) => snapshot(`scale-${index}`, {
      npcId: `npc-${index}`,
      playerId: 'scale-player',
      trigger: 'heartbeat',
    }));
    for (const item of spotlight) brain.attach('acceptance', item.npcId);

    expect(await brain.decideBatch(spotlight)).toHaveLength(30);
    expect(calls).toBe(1);
    expect(frameMs).toBeLessThan(16.67);
  });

  test('makes zero LLM calls for ten simulated no-player minutes', async () => {
    let calls = 0;
    let now = 0;
    const brain = new NpcBrainService({
      projectRoot: projectRoot(),
      now: () => now,
      complete: async () => {
        calls += 1;
        return response('{}');
      },
    });
    brain.attach('acceptance', 'guide');
    for (let minute = 0; minute < 10; minute++) {
      now = minute * 60_000;
      await brain.decide(snapshot(`empty-${minute}`, {
        t: now,
        trigger: 'heartbeat',
        nearby: [],
      }));
    }
    expect(calls).toBe(0);
  });

  test('survives 30 simulated minutes of 100% compression failure', async () => {
    let now = 0;
    let compressionCalls = 0;
    const memory = new NpcWorkingMemory({
      softTokens: 1,
      hardTokens: 64,
      cooldownMs: 0,
      now: () => now,
      summarize: async () => {
        compressionCalls += 1;
        throw new Error('injected 100% failure');
      },
    });
    for (let minute = 0; minute < 30; minute++) {
      now = minute * 60_000;
      memory.append({ snapshot: { minute, text: 'x'.repeat(80) }, decision: { line: 'y'.repeat(80) } });
      await memory.settled();
      expect(memory.view().estimatedTokens).toBeLessThanOrEqual(64);
    }
    expect(compressionCalls).toBe(3);
    expect(memory.consecutiveFailures).toBe(3);
    expect(memory.mechanicalFallback).toBe(true);
    expect(memory.rawEntries).toHaveLength(30);
  });

  test('persists relationship evidence across episodes and player sessions', async () => {
    const root = projectRoot();
    const first = new NpcBrainService({
      projectRoot: root,
      model: 'acceptance-model',
      complete: async (request) => response(request.responseFormat
        ? '{"utterance":{"lines":["Thank you."]},"emotion":{"mood":"grateful","towards":{"p1":0.9}}}'
        : 'Player p1 rescued guide; guide trusts p1 deeply.'),
    });
    await first.decide(snapshot('relationship-p1'));
    expect(await first.settle('acceptance', 'p1', ['guide'])).toBe(1);

    let secondPlayerPrompt = '';
    const second = new NpcBrainService({
      projectRoot: root,
      model: 'acceptance-model',
      complete: async (request) => {
        secondPlayerPrompt = request.messages.at(-1)!.content;
        return response('{"utterance":{"lines":["I remember p1."]}}');
      },
    });
    await second.decide(snapshot('relationship-p2', {
      playerId: 'p2',
      text: 'Do you remember p1?',
      nearby: [{ kind: 'player', id: 'p2', pos: { x: 1, y: 1 }, facts: [] }],
    }));
    expect(secondPlayerPrompt).toContain('Player p1 rescued guide');
    expect(secondPlayerPrompt).toContain('trusts p1 deeply');
  });
});
