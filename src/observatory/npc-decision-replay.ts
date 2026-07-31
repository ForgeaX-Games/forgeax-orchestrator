import type { NpcDecisionWire, PerceptionSnapshot } from '../npc-brain/protocol';
import type { StoredEvent } from '../ledger/types';

export interface NpcReplayStep {
  at: number;
  soulId: string;
  snapshot: PerceptionSnapshot;
  decision: NpcDecisionWire;
}

/**
 * Projects NPC decision evidence into the repository's existing StoredEvent
 * ledger shape. Observatory replay and future Replay-as-Eval consumers can read
 * it without a second NPC-only replay format.
 */
export function npcDecisionReplayToStoredEvents(
  steps: readonly NpcReplayStep[],
): StoredEvent[] {
  return steps.flatMap((step, index) => {
    const turn = index + 1;
    const callId = `npc-intent-${step.snapshot.eventId}`;
    const action = step.decision.intent?.action ?? 'observe';
    const params = step.decision.intent?.params ?? {};
    const base = {
      emitterId: step.soulId,
      source: 'npc-brain',
    };
    return [
      {
        ...base,
        type: 'hook:turnStart',
        ts: step.at,
        payload: {
          turn,
          model: 'deterministic-bot-policy',
          snapshot: step.snapshot,
        },
      },
      {
        ...base,
        type: 'hook:toolCall',
        ts: step.at + 1,
        payload: { callId, name: action, args: params },
      },
      {
        ...base,
        type: 'hook:toolResult',
        ts: step.at + 2,
        payload: { callId, name: action, result: 'accepted by offline match body' },
      },
      {
        ...base,
        type: 'hook:assistantMessage',
        ts: step.at + 3,
        payload: {
          model: 'deterministic-bot-policy',
          msg: { role: 'assistant', content: JSON.stringify(step.decision) },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
      },
      {
        ...base,
        type: 'hook:turnEnd',
        ts: step.at + 4,
        payload: { turn, durationMs: 4, aborted: false },
      },
    ] satisfies StoredEvent[];
  });
}
