import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitLifeEvent, onLifeEvent, recentLifeEvents, soulMemoryRoot } from '../src/soul';
import { npcSoulMemoryRoot } from '../src/npc-brain/safe-id';

describe('soul NPC id observability', () => {
  test('Brain maps dotted NPC soul ids without changing the Soul engine slug grammar', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-soul-npc-id-'));
    try {
      const pudding = npcSoulMemoryRoot(projectRoot, 'paopaotang.pudding');
      const mochi = npcSoulMemoryRoot(projectRoot, 'paopaotang.mochi');
      const fallback = soulMemoryRoot(projectRoot, 'default');

      expect(pudding).not.toBe(mochi);
      expect(pudding).not.toBe(fallback);
      expect(mochi).not.toBe(fallback);
      expect(pudding).toBe(join(projectRoot, '.forgeax/souls', 'paopaotang.pudding', 'memory'));
      expect(mochi).toBe(join(projectRoot, '.forgeax/souls', 'paopaotang.mochi', 'memory'));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('plain soul slugs keep their existing memory root layout', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-soul-plain-id-'));
    try {
      expect(soulMemoryRoot(projectRoot, 'wanderer')).toBe(
        join(projectRoot, '.forgeax/souls', 'wanderer', 'memory'),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('npc.decision life events flow through the generic ring and listeners', () => {
    const agentId = `paopaotang.pudding-${Date.now()}`;
    const seen: unknown[] = [];
    const stopThrowing = onLifeEvent(() => {
      throw new Error('listener failure must not affect emitLifeEvent');
    });
    const stopRecording = onLifeEvent((ev) => {
      if (ev.agentId === agentId) seen.push(ev);
    });

    try {
      emitLifeEvent({
        kind: 'npc.decision',
        agentId,
        game: 'paopaotang',
        eventId: 'evt-1',
        seq: 1,
        outcome: 'decision',
        fallback: false,
        at: 123,
      });
    } finally {
      stopThrowing();
      stopRecording();
    }

    expect(seen).toEqual([
      {
        kind: 'npc.decision',
        agentId,
        game: 'paopaotang',
        eventId: 'evt-1',
        seq: 1,
        outcome: 'decision',
        fallback: false,
        at: 123,
      },
    ]);
    expect(recentLifeEvents(agentId)).toContainEqual({
      kind: 'npc.decision',
      agentId,
      game: 'paopaotang',
      eventId: 'evt-1',
      seq: 1,
      outcome: 'decision',
      fallback: false,
      at: 123,
    });
    expect(recentLifeEvents('paopaotang.mochi')).not.toContainEqual({
      kind: 'npc.decision',
      agentId,
      game: 'paopaotang',
      eventId: 'evt-1',
      seq: 1,
      outcome: 'decision',
      fallback: false,
      at: 123,
    });
  });
});
