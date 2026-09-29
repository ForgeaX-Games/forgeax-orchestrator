import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAttemptId, deriveAttemptIdempotencyHash, type NpcActionAttemptV1 } from '../src/npc-brain/a2a-contract';
import { NpcBrainService } from '../src/npc-brain/service';
import type { AgentRecord } from '../src/soul';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'npc-partial-resolver-'));
  roots.push(value);
  return value;
}

function record(projectRoot: string, agentId: string, persona = 'A concise product NPC.'): AgentRecord {
  return {
    agentId,
    source: 'builtin',
    trustTier: 'own',
    persona,
    skills: [],
    tools: [],
    memory: { root: join(projectRoot, 'resolver-memory'), game: 'asiw' },
    warnings: [],
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    eventId: 'evt-1',
    game: 'asiw',
    npcId: 'elara',
    playerId: 'player-1',
    t: 1,
    trigger: 'player_message',
    text: 'hello',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [],
    events: [],
    affordances: [{ action: 'asiw.speak.v1' }],
    ...overrides,
  };
}

function attempt(): NpcActionAttemptV1 {
  const subject = {
    worldId: 'metaworld', worldEpoch: 1, npcId: 'elara', instanceId: 'metaworld_elara', instanceEpoch: 1,
  } as const;
  const candidate = {
    schemaVersion: 1,
    attemptId: deriveAttemptId(subject, 'trigger-1', 1),
    triggerId: 'trigger-1',
    triggerSeq: 1,
    subject,
    priorityClass: 'normal',
    snapshotVersion: 'snapshot-1',
    allowedActionKinds: ['asiw.speak.v1'],
    admittedConflictKeys: [],
    baseConflictEpochs: {},
    admittedAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    idempotencyHash: 'sha256:' + '0'.repeat(64),
  } as NpcActionAttemptV1;
  return { ...candidate, idempotencyHash: deriveAttemptIdempotencyHash(candidate) };
}

describe('NpcBrainService partial product AgentRecord resolver', () => {
  test('uses an owned product record with exact resolver options through preload then propose', async () => {
    const projectRoot = root();
    const owned = record(projectRoot, 'asiw.elara', 'Elara product persona.');
    const calls: Array<[string, Readonly<{ projectRoot: string; game: string }>]> = [];
    let renderedPersona = '';
    const brain = new NpcBrainService({
      projectRoot,
      resolveAgentRecord: async (agentId, options) => {
        calls.push([agentId, options]);
        return agentId === 'asiw.elara' ? owned : undefined;
      },
      complete: async (request) => {
        renderedPersona = request.messages[0]?.content ?? '';
        return {
          text: JSON.stringify({ utterance: { lines: ['Hello Leo.'] } }),
          model: request.model,
          transport: 'test',
          latencyMs: 1,
        };
      },
    });
    const proposalOnly = brain as unknown as {
      decide: (...args: unknown[]) => Promise<unknown>;
      decideBatch: (...args: unknown[]) => Promise<unknown>;
    };
    proposalOnly.decide = async () => { throw new Error('propose must not call decide'); };
    proposalOnly.decideBatch = async () => { throw new Error('propose must not call decideBatch'); };

    await brain.preload('asiw', [{ soulId: 'asiw.elara' }], 'player-1');
    const proposal = await brain.propose(attempt(), snapshot(), {
      soulId: 'asiw.elara',
      speechActionKind: 'asiw.speak.v1',
    });

    expect(calls).toEqual([['asiw.elara', { projectRoot, game: 'asiw' }]]);
    expect(proposal.disposition).toBe('action');
    expect(renderedPersona).toContain('Elara product persona.');
    // Proposal ownership is deliberately separate from decide/decideBatch and memory writes.
    expect(existsSync(join(projectRoot, '.forgeax', 'souls', 'asiw.elara', 'memory'))).toBe(false);
  });

  test('falls through an undefined non-ASIW result to the existing loader and packDir model discovery', async () => {
    const projectRoot = root();
    const pack = join(projectRoot, '.forgeax', 'souls-builtin', 'demo.guide');
    mkdirSync(join(pack, 'persona'), { recursive: true });
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ id: 'demo.guide' }));
    writeFileSync(join(pack, 'agent.json'), JSON.stringify({ models: { model: 'pack-model' } }));
    writeFileSync(join(pack, 'persona', 'identity.md'), '# Guide');
    const calls: string[] = [];
    let requestedModel = '';
    const brain = new NpcBrainService({
      projectRoot,
      resolveAgentRecord: async (agentId) => {
        calls.push(agentId);
        return undefined;
      },
      complete: async (request) => {
        requestedModel = request.model;
        return {
          text: JSON.stringify({ utterance: { lines: ['ok'] } }),
          model: request.model,
          transport: 'test',
          latencyMs: 1,
        };
      },
    });

    await brain.preload('demo', [{ soulId: 'demo.guide' }]);
    await brain.decide(snapshot({ game: 'demo', npcId: 'guide', eventId: 'evt-fallback' }), { soulId: 'demo.guide' });

    expect(calls).toEqual(['demo.guide']);
    expect(requestedModel).toBe('pack-model');
  });

  test('rejects a product record whose agentId does not match the requested soul', async () => {
    const projectRoot = root();
    const mismatched = record(projectRoot, 'asiw.leo', 'Leo product persona.');
    let fallbackCalls = 0;
    const brain = new NpcBrainService({
      projectRoot,
      resolveAgentRecord: async () => mismatched,
      loadAgentRecord: async () => {
        fallbackCalls += 1;
        throw new Error('fallback must not run');
      },
    });

    await expect(brain.preload('asiw', [{ soulId: 'asiw.elara' }])).rejects.toThrow(
      'product AgentRecord resolver returned asiw.leo for asiw.elara',
    );
    expect(fallbackCalls).toBe(0);
  });

  test('fails closed for an owned resolver error and never invokes the fallback loader', async () => {
    let fallbackCalls = 0;
    const brain = new NpcBrainService({
      projectRoot: root(),
      resolveAgentRecord: async () => { throw new Error('owned ASIW record missing'); },
      loadAgentRecord: async () => {
        fallbackCalls += 1;
        throw new Error('fallback must not run');
      },
    });

    await expect(brain.preload('asiw', [{ soulId: 'asiw.elara' }])).rejects.toThrow('owned ASIW record missing');
    expect(fallbackCalls).toBe(0);
  });
});
