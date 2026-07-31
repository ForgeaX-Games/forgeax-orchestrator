import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterState, adapt } from '../src/observatory/event-adapter';
import { replaySessionEvents } from '../src/observatory/ledger-replay';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { FlatSessionLayout } from '../src/fs/session-layout';
import {
  PLAYER_COMPLETE_AFFORDANCES,
  runBotMatchEval,
  writeBotEvalArtifacts,
} from '../src/npc-brain/bot-eval';
import { NpcBrainService } from '../src/npc-brain/service';

const roots: string[] = [];
afterEach(() => {
  resetPathManager();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'npc-m3-'));
  roots.push(value);
  return value;
}

function snapshot(eventId: string) {
  return {
    v: 1,
    eventId,
    game: 'second-world',
    npcId: 'traveler',
    t: 1,
    trigger: 'spotlight',
    self: { pos: { x: 0, y: 0 }, activity: 'arriving' },
    nearby: [{ kind: 'player', id: 'p1', pos: { x: 1, y: 0 }, facts: [] }],
    events: [{ type: 'promoted' }],
    affordances: [{ action: 'wait' }],
  };
}

describe('M3 offline bot evaluation', () => {
  test('exposes the complete player action surface', () => {
    expect(PLAYER_COMPLETE_AFFORDANCES.map((item) => item.action)).toEqual([
      'move',
      'place_bubble',
      'collect_item',
      'wait',
    ]);
  });

  test('runs 100 accelerated matches with materially different behavior', () => {
    const { report } = runBotMatchEval(100);
    expect(report.matches).toBe(100);
    expect(report.aggressive.wins + report.conservative.wins + report.aggressive.draws).toBe(100);
    expect(report.differentiation.meaningful).toBe(true);
    expect(report.differentiation.bubbleRateDelta).toBeGreaterThanOrEqual(0.15);
    expect(report.differentiation.nearRateDelta).toBeGreaterThanOrEqual(0.1);
    expect(report.differentiation.itemRateDelta).toBeGreaterThanOrEqual(0.1);
  });

  test('writes replay into the existing session ledger and observatory adapter path', async () => {
    const projectRoot = root();
    const result = runBotMatchEval(4, 7);
    const artifacts = writeBotEvalArtifacts(projectRoot, result, 'npc-eval-replay');
    expect(existsSync(artifacts.reportPath)).toBe(true);
    expect(artifacts.replayPath).toBe(join(
      projectRoot,
      '.forgeax/sessions/npc-eval-replay/global-events.jsonl',
    ));
    const paths = initPathManager({
      projectRoot,
      layout: new FlatSessionLayout(join(projectRoot, '.forgeax/sessions'), projectRoot),
    });
    const replayed = await replaySessionEvents('npc-eval-replay', paths);
    expect(replayed).toHaveLength(result.replay.length);
    const state = createAdapterState();
    const adapted = replayed.flatMap((event) => adapt(event, state));
    expect(adapted.some((event) => event.type === 'tool_use' && event.name === 'place_bubble')).toBe(true);
    expect(adapted.some((event) => event.type === 'turn_end')).toBe(true);
  });
});

describe('M3 cross-game reincarnation', () => {
  test('shows prior-world context once on first entry without making it a current-world fact', async () => {
    const projectRoot = root();
    const pack = join(projectRoot, '.forgeax/souls-builtin/shared.traveler');
    mkdirSync(join(pack, 'persona'), { recursive: true });
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ id: 'shared.traveler' }));
    writeFileSync(join(pack, 'persona/identity.md'), 'A cautious traveler who keeps the same temperament.');
    const memory = join(projectRoot, '.forgeax/souls/shared.traveler/memory');
    mkdirSync(join(memory, 'traits'), { recursive: true });
    mkdirSync(join(memory, 'episodes/first-world'), { recursive: true });
    writeFileSync(join(memory, 'traits/cautious.md'), 'Checks exits before committing.');
    writeFileSync(join(memory, 'episodes/first-world/old-rumor.md'), 'Heard that the old king hid a bell beneath the red bridge.');

    const prompts: string[] = [];
    const brain = new NpcBrainService({
      projectRoot,
      now: () => 0,
      complete: async (request) => {
        prompts.push(request.messages.map((message) => message.content).join('\n'));
        return {
          text: JSON.stringify({
            intent: { action: 'wait', ttlSec: 1 },
            utterance: { lines: ['I remember an old rumor.'] },
          }),
          model: request.model,
          transport: 'deterministic',
          latencyMs: 1,
        };
      },
    });
    await brain.decide(snapshot('first-entry'), { soulId: 'shared.traveler' });
    await brain.decide({ ...snapshot('second-turn'), trigger: 'player_message', text: 'What do you remember?' }, {
      soulId: 'shared.traveler',
    });

    expect(prompts[0]).toContain('Reincarnation · entering a new world (`second-world`)');
    expect(prompts[0]).toContain('context from other worlds');
    expect(prompts[0]).toContain('never assert them as facts about `second-world`');
    expect(prompts[0]).toContain('Checks exits before committing.');
    expect(prompts[0]).toContain('old king hid a bell');
    expect(prompts[0]).toContain('past-life rumor');
    expect(prompts[1]).not.toContain('Reincarnation · entering a new world');
    expect(existsSync(join(memory, 'episodes/second-world'))).toBe(false);
    expect(readFileSync(join(memory, 'episodes/first-world/old-rumor.md'), 'utf8')).toContain('old king');
  });
});
