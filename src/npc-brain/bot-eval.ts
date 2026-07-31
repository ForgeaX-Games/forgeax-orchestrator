import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NPC_PROTOCOL_VERSION, type NpcDecisionWire, type PerceptionSnapshot } from './protocol';
import { npcDecisionReplayToStoredEvents, type NpcReplayStep } from '../observatory/npc-decision-replay';

type Affordance = PerceptionSnapshot['affordances'][number];

/** @deprecated Games own their action catalog; pass affordances to evaluation adapters. */
export const PLAYER_COMPLETE_AFFORDANCES: readonly Affordance[] = [
  {
    action: 'move',
    params: {
      direction: { type: 'enum', source: 'literal', values: ['up', 'down', 'left', 'right'] },
    },
  },
  { action: 'place_bubble' },
  { action: 'collect_item', params: { target: { type: 'enum', source: 'nearby.id' } } },
  { action: 'wait' },
] as const;

export interface BotTraits {
  soulId: string;
  label: string;
  aggression: number;
  approachBias: number;
  itemBias: number;
  evasion: number;
}

export const AGGRESSIVE_BOT: BotTraits = {
  soulId: 'paopaotang.bot-aggressive',
  label: 'Aggressive',
  aggression: 0.78,
  approachBias: 0.82,
  itemBias: 0.24,
  evasion: 0.38,
};

export const CONSERVATIVE_BOT: BotTraits = {
  soulId: 'paopaotang.bot-conservative',
  label: 'Conservative',
  aggression: 0.27,
  approachBias: 0.28,
  itemBias: 0.76,
  evasion: 0.78,
};

export interface BotBehaviorStats {
  decisions: number;
  bubbles: number;
  movesToward: number;
  movesAway: number;
  itemCollections: number;
  nearTurns: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface BotEvalReport {
  game: 'paopaotang';
  matches: number;
  seed: number;
  aggressive: BotBehaviorStats;
  conservative: BotBehaviorStats;
  replayEvents: number;
  differentiation: {
    bubbleRateDelta: number;
    nearRateDelta: number;
    itemRateDelta: number;
    meaningful: boolean;
  };
}

interface MatchBot {
  traits: BotTraits;
  stats: BotBehaviorStats;
  items: number;
}

export function runBotMatchEval(matches = 100, seed = 0xF0A6E): {
  report: BotEvalReport;
  replay: ReturnType<typeof npcDecisionReplayToStoredEvents>;
} {
  if (!Number.isInteger(matches) || matches < 1) throw new Error('matches must be a positive integer');
  const random = mulberry32(seed);
  const aggressive = freshBot(AGGRESSIVE_BOT);
  const conservative = freshBot(CONSERVATIVE_BOT);
  const replaySteps: NpcReplayStep[] = [];
  let replayClock = 1_800_000_000_000;

  for (let match = 1; match <= matches; match += 1) {
    let distance = 4 + Math.floor(random() * 7);
    let winner: MatchBot | undefined;
    let turn = 0;
    aggressive.items = 0;
    conservative.items = 0;
    for (; turn < 120 && !winner; turn += 1) {
      for (const [actor, opponent] of [[aggressive, conservative], [conservative, aggressive]] as const) {
        const choice = chooseAction(actor, distance, random);
        actor.stats.decisions += 1;
        if (choice === 'place_bubble') {
          actor.stats.bubbles += 1;
          if (distance <= 2) actor.stats.nearTurns += 1;
          const hitChance = clamp(
            0.08 + (distance <= 2 ? 0.26 : 0) + actor.items * 0.025 - opponent.traits.evasion * 0.18,
            0.02,
            0.55,
          );
          if (random() < hitChance) winner = actor;
        } else if (choice === 'collect_item') {
          actor.stats.itemCollections += 1;
          actor.items += 1;
        } else if (choice === 'move_toward') {
          actor.stats.movesToward += 1;
          actor.stats.nearTurns += 1;
          distance = Math.max(1, distance - 1);
        } else if (choice === 'move_away') {
          actor.stats.movesAway += 1;
          distance = Math.min(12, distance + 1);
        }
        replaySteps.push(replayStep(match, turn, actor, choice, distance, replayClock));
        replayClock += 10;
        if (winner) break;
      }
    }
    if (winner === aggressive) {
      aggressive.stats.wins += 1;
      conservative.stats.losses += 1;
    } else if (winner === conservative) {
      conservative.stats.wins += 1;
      aggressive.stats.losses += 1;
    } else {
      aggressive.stats.draws += 1;
      conservative.stats.draws += 1;
    }
  }

  const bubbleRateDelta = rate(aggressive.stats.bubbles, aggressive.stats.decisions)
    - rate(conservative.stats.bubbles, conservative.stats.decisions);
  const nearRateDelta = rate(aggressive.stats.nearTurns, aggressive.stats.decisions)
    - rate(conservative.stats.nearTurns, conservative.stats.decisions);
  const itemRateDelta = rate(conservative.stats.itemCollections, conservative.stats.decisions)
    - rate(aggressive.stats.itemCollections, aggressive.stats.decisions);
  const replay = npcDecisionReplayToStoredEvents(replaySteps);
  return {
    report: {
      game: 'paopaotang',
      matches,
      seed,
      aggressive: aggressive.stats,
      conservative: conservative.stats,
      replayEvents: replay.length,
      differentiation: {
        bubbleRateDelta,
        nearRateDelta,
        itemRateDelta,
        meaningful: bubbleRateDelta >= 0.15 && nearRateDelta >= 0.1 && itemRateDelta >= 0.1,
      },
    },
    replay,
  };
}

export function writeBotEvalArtifacts(
  projectRoot: string,
  result: ReturnType<typeof runBotMatchEval>,
  runId = `paopaotang-bots-${result.report.matches}`,
): { reportPath: string; replayPath: string } {
  const reportPath = join(projectRoot, '.forgeax/npc-brain/eval', runId, 'balance-report.md');
  const replayPath = join(projectRoot, '.forgeax/sessions', runId, 'global-events.jsonl');
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(dirname(replayPath), { recursive: true });
  writeFileSync(reportPath, renderBalanceReport(result.report));
  writeFileSync(replayPath, `${result.replay.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return { reportPath, replayPath };
}

export function renderBalanceReport(report: BotEvalReport): string {
  const a = report.aggressive;
  const c = report.conservative;
  return `# Paopaotang NPC Bot Balance Report

> Deterministic accelerated simulation · ${report.matches} matches · seed \`${report.seed}\`
>
> Replay output uses the repository's existing \`StoredEvent\` ledger shape and is written to
> \`.forgeax/sessions/paopaotang-bots-${report.matches}/global-events.jsonl\`.

| Metric | Aggressive | Conservative |
|:--|--:|--:|
| Wins | ${a.wins} | ${c.wins} |
| Losses | ${a.losses} | ${c.losses} |
| Draws | ${a.draws} | ${c.draws} |
| Decisions | ${a.decisions} | ${c.decisions} |
| Bubble placements | ${a.bubbles} | ${c.bubbles} |
| Bubble rate | ${percent(rate(a.bubbles, a.decisions))} | ${percent(rate(c.bubbles, c.decisions))} |
| Near-opponent turns | ${percent(rate(a.nearTurns, a.decisions))} | ${percent(rate(c.nearTurns, c.decisions))} |
| Item collections | ${a.itemCollections} | ${c.itemCollections} |
| Item collection rate | ${percent(rate(a.itemCollections, a.decisions))} | ${percent(rate(c.itemCollections, c.decisions))} |

## Differentiation gates

- [${report.differentiation.bubbleRateDelta >= 0.15 ? 'x' : ' '}] Aggressive bubble-rate lead ≥ 15pp: ${percent(report.differentiation.bubbleRateDelta)}
- [${report.differentiation.nearRateDelta >= 0.1 ? 'x' : ' '}] Aggressive near-opponent lead ≥ 10pp: ${percent(report.differentiation.nearRateDelta)}
- [${report.differentiation.itemRateDelta >= 0.1 ? 'x' : ' '}] Conservative item-rate lead ≥ 10pp: ${percent(report.differentiation.itemRateDelta)}
- [${report.differentiation.meaningful ? 'x' : ' '}] Overall materially differentiated behavior

## Tuning conclusion

The aggressive Soul creates pressure through proximity and bubble frequency. The conservative Soul
trades immediate pressure for item acquisition and distance control. Balance changes should preserve
these separations while moving win rate; do not equalize action frequencies.
`;
}

function freshBot(traits: BotTraits): MatchBot {
  return {
    traits,
    items: 0,
    stats: {
      decisions: 0,
      bubbles: 0,
      movesToward: 0,
      movesAway: 0,
      itemCollections: 0,
      nearTurns: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    },
  };
}

function chooseAction(
  bot: MatchBot,
  distance: number,
  random: () => number,
): 'place_bubble' | 'collect_item' | 'move_toward' | 'move_away' {
  const danger = distance <= 2;
  if (random() < bot.traits.aggression * (danger ? 0.8 : 0.32)) return 'place_bubble';
  if (random() < bot.traits.itemBias * (danger ? 0.15 : 0.45)) return 'collect_item';
  if (random() < bot.traits.approachBias) return 'move_toward';
  return 'move_away';
}

function replayStep(
  match: number,
  turn: number,
  actor: MatchBot,
  choice: ReturnType<typeof chooseAction>,
  distance: number,
  at: number,
): NpcReplayStep {
  const npcId = actor.traits.soulId.endsWith('aggressive') ? 'aggressive' : 'conservative';
  const action = choice === 'move_toward' || choice === 'move_away' ? 'move' : choice;
  const params: Record<string, string> | undefined = action === 'move'
    ? { direction: choice === 'move_toward' ? 'right' : 'left' }
    : action === 'collect_item'
      ? { target: 'item-1' }
      : undefined;
  const snapshot: PerceptionSnapshot = {
    v: NPC_PROTOCOL_VERSION,
    eventId: `match-${match}-turn-${turn}-${npcId}`,
    game: 'paopaotang',
    npcId,
    playerId: 'offline-eval',
    t: turn,
    trigger: 'event',
    self: { pos: { x: npcId === 'aggressive' ? 1 : 11, y: 5 }, activity: 'playtest' },
    nearby: [
      {
        kind: 'player',
        id: npcId === 'aggressive' ? 'conservative' : 'aggressive',
        pos: { x: npcId === 'aggressive' ? 1 + distance : 11 - distance, y: 5 },
        facts: [`distance:${distance}`],
      },
      { kind: 'item', id: 'item-1', pos: { x: 6, y: 5 }, facts: ['powerup'] },
    ],
    events: [{ type: 'offline_match_tick', match, turn }],
    affordances: [...PLAYER_COMPLETE_AFFORDANCES],
  };
  const decision: NpcDecisionWire = {
    v: NPC_PROTOCOL_VERSION,
    npcId,
    seq: match * 1_000 + turn * 2 + (npcId === 'aggressive' ? 1 : 2),
    intent: { action, ...(params ? { params } : {}), ttlSec: 1 },
  };
  return { at, soulId: actor.traits.soulId, snapshot, decision };
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ next >>> 15, next | 1);
    next ^= next + Math.imul(next ^ next >>> 7, next | 61);
    return ((next ^ next >>> 14) >>> 0) / 4_294_967_296;
  };
}
