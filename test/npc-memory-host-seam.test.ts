import { describe, expect, test } from 'bun:test';
import { recallNpcMemory, recallNpcMemoryBatch, type NpcMemoryReaderHostSeam, type NpcMemoryRecallAuditEvent } from '../src/npc-brain/memory-host-seam';
import type { NpcMemoryRecallRequestV1, NpcMemoryRecallResultV1 } from '@forgeax/types/npc-memory';

const result: NpcMemoryRecallResultV1 = {
  source: { kind: 'live-file' }, rawRecallVersion: 1, rawBlocks: [],
  diagnostics: { stale: false, volatileStateUsed: false, projectionMode: 'full', identityResolved: true },
};
const request = (ownerNpcId: string): NpcMemoryRecallRequestV1 => ({
  subject: {
    ownerNpcId, soulId: `demo.${ownerNpcId}`,
    scope: { authority: 'forgeax-file', game: 'demo', memoryGame: 'demo', soulId: `demo.${ownerNpcId}`, storagePartition: { kind: 'soul-shared' } },
  }, trigger: 'active_decision', at: { day: 0, hour: 1, minute: 2 },
  context: { mapId: 'map', sceneAreaId: null, visibleRefIds: [], focusEntityIds: [], conversationTurns: [] }, budget: { mode: 'legacy-exact' },
});

function host(reader: NpcMemoryReaderHostSeam['reader'], now: () => number, audit: NpcMemoryRecallAuditEvent[]): NpcMemoryReaderHostSeam {
  return { mode: 'active', reader, now, audit: (event) => audit.push(event) };
}

describe('NPC memory host seam', () => {
  test('off mode never invokes reader', async () => {
    let calls = 0;
    const audit: NpcMemoryRecallAuditEvent[] = [];
    const out = await recallNpcMemory({ mode: 'off', reader: { recall: async () => { calls += 1; return result; } }, audit: (e) => audit.push(e) }, {
      ownerNpcId: 'guide', request: request('guide'), decisionDeadlineAt: Date.now() + 1000,
    });
    expect(calls).toBe(0);
    expect(out.status).toBe('skipped');
    expect(audit).toEqual([]);
  });

  test('an already-aborted admission never invokes the reader', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error('cancelled before recall'));
    const audit: NpcMemoryRecallAuditEvent[] = [];
    const out = await recallNpcMemory(host({ recall: async () => { calls += 1; return result; } }, Date.now, audit), {
      ownerNpcId: 'guide', eventId: 'evt-audit', request: request('guide'), decisionDeadlineAt: Date.now() + 1000, signal: controller.signal,
    });
    expect(calls).toBe(0);
    expect(out.status).toBe('failed');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe('aborted');
    expect(audit[0]?.eventId).toBe('evt-audit');
  });

  test('invalid provider output emits one failed audit and no false success', async () => {
    const audit: NpcMemoryRecallAuditEvent[] = [];
    const out = await recallNpcMemory(host({ recall: async () => ({ broken: true } as never) }, Date.now, audit), {
      ownerNpcId: 'guide', request: request('guide'), decisionDeadlineAt: Date.now() + 1000,
    });
    expect(out.status).toBe('failed');
    expect(audit.map((entry) => entry.status)).toEqual(['failed']);
  });

  test('uses min absolute deadline and turns provider failure into empty outcome', async () => {
    let now = 1000;
    const audit: NpcMemoryRecallAuditEvent[] = [];
    const out = await recallNpcMemory(host({ recall: async () => { throw new Error('down'); } }, () => now, audit), {
      ownerNpcId: 'guide', request: request('guide'), decisionDeadlineAt: 2000, memoryRecallBudgetMs: 400,
    });
    expect(out.deadlineAt).toBe(1400);
    expect(out.result).toBeUndefined();
    expect(out.status).toBe('failed');
    expect(audit[0]?.reason).toBe('provider-error');
  });

  test('shadow mode reads through the seam without gaining a writer path', async () => {
    let calls = 0;
    const audit: NpcMemoryRecallAuditEvent[] = [];
    const out = await recallNpcMemory({ mode: 'shadow', reader: { recall: async () => { calls += 1; return result; } }, audit: (e) => audit.push(e) }, {
      ownerNpcId: 'guide', request: request('guide'), decisionDeadlineAt: Date.now() + 1000,
    });
    expect(calls).toBe(1);
    expect(out.status).toBe('succeeded');
    expect(audit[0]?.mode).toBe('shadow');
  });

  test('batch recalls are isolated and preserve each captured deadline', async () => {
    const calls: string[] = [];
    const audit: NpcMemoryRecallAuditEvent[] = [];
    const reader = { recall: async (input: NpcMemoryRecallRequestV1) => {
      calls.push(input.subject.ownerNpcId);
      if (input.subject.ownerNpcId === 'slow') throw new Error('slow failure');
      return result;
    } };
    const out = await recallNpcMemoryBatch(host(reader, Date.now, audit), [
      { npcId: 'fast', ownerNpcId: 'fast', request: request('fast'), decisionDeadlineAt: Date.now() + 1000 },
      { npcId: 'slow', ownerNpcId: 'slow', request: request('slow'), decisionDeadlineAt: Date.now() + 2000 },
    ]);
    expect(calls.sort()).toEqual(['fast', 'slow']);
    expect(out.map((item) => item.outcome.status)).toEqual(['succeeded', 'failed']);
    expect(out[0]?.outcome.deadlineAt).toBeLessThan(out[1]?.outcome.deadlineAt ?? 0);
  });
});
