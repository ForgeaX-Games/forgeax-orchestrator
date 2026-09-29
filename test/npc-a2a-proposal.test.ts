import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { complete as completeLlm } from '../src/lib/llm-gateway';
import { NpcBrainService, type NpcBrainConfig } from '../src/npc-brain/service';
import { onLifeEvent } from '../src/soul';
import {
  deriveAttemptId,
  deriveAttemptIdempotencyHash,
  deriveProposalId,
  parseNpcActionProposalV1,
  type NpcActionAttemptV1,
  type NpcActionProposalV1,
  validateProposalAgainstAttempt,
  validateProposalIntegrity,
} from '../src/npc-brain/a2a-contract';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'npc-a2a-proposal-'));
  roots.push(value);
  return value;
}

const subject = {
  worldId: 'world', worldEpoch: 0, npcId: 'guide', instanceId: 'guide-1', instanceEpoch: 0,
} as const;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    v: 1, eventId: 'event-1', game: 'proposal-game', npcId: 'guide', playerId: 'player-1', t: 1,
    trigger: 'player_message', text: 'hello',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' }, nearby: [], events: [],
    affordances: [{ action: 'idle' }, { action: 'speak' }], ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}): NpcActionAttemptV1 {
  const base = {
    schemaVersion: 1,
    attemptId: deriveAttemptId(subject, 'trigger-1', 1),
    triggerId: 'trigger-1', triggerSeq: 1, subject,
    priorityClass: 'normal', snapshotVersion: 'snapshot-1',
    allowedActionKinds: ['idle', 'speak'], admittedConflictKeys: [], baseConflictEpochs: {},
    admittedAt: 1, deadlineAt: Date.now() + 60_000,
  };
  const candidate = { ...base, ...overrides, idempotencyHash: 'sha256:' + '0'.repeat(64) } as NpcActionAttemptV1;
  return { ...candidate, idempotencyHash: deriveAttemptIdempotencyHash(candidate) };
}

function record(projectRoot: string) {
  return {
    agentId: 'guide', source: 'builtin' as const, trustTier: 'own' as const,
    persona: 'A concise guide.', skills: [], tools: [], memory: { root: projectRoot, game: 'proposal-game' }, warnings: [],
  };
}

async function prepared(config: Partial<NpcBrainConfig> = {}) {
  const projectRoot = config.projectRoot ?? root();
  const brain = new NpcBrainService({
    ...config,
    projectRoot,
    loadAgentRecord: config.loadAgentRecord ?? (async () => record(projectRoot)),
  });
  await brain.preload('proposal-game', [{ soulId: 'guide' }], 'player-1');
  return { brain, projectRoot };
}

function response(text: unknown): Awaited<ReturnType<typeof completeLlm>> {
  return { text: JSON.stringify(text), model: 'mock', transport: 'test', latencyMs: 1 };
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function expectValidProposal(proposal: NpcActionProposalV1, sourceAttempt: NpcActionAttemptV1): void {
  expect(parseNpcActionProposalV1(proposal)).toEqual(proposal);
  expect(validateProposalIntegrity(proposal).ok).toBe(true);
  expect(validateProposalAgainstAttempt(proposal, sourceAttempt).ok).toBe(true);
}

describe('NpcBrainService.propose', () => {
  test('maps admitted intent and emits a full B0-valid proposal without memoryOps', async () => {
    let calls = 0;
    const { brain } = await prepared({ complete: async () => { calls++; return response({
      intent: { action: 'walk_to', params: { target: 'square' }, ttlSec: 30 }, utterance: { lines: ['hello'] }, emotion: { mood: 'calm' },
      memoryOps: [{ kind: 'episode', text: 'secret', sourceEventId: 'event-1' }],
    }); } });
    const a = attempt({ allowedActionKinds: ['idle', 'speak', 'walk_to'] });
    const proposal = await brain.propose(a, snapshot({
      nearby: [{ kind: 'waypoint', id: 'square', pos: { x: 1, y: 1 }, facts: [] }],
      affordances: [
        { action: 'idle' },
        { action: 'speak' },
        { action: 'walk_to', params: { target: { type: 'enum', source: 'waypoint' } } },
      ],
    }), { soulId: 'guide' });
    expect(proposal.disposition).toBe('action');
    if (proposal.disposition !== 'action') throw new Error('expected action');
    expect(proposal.actionKind).toBe('walk_to');
    expect(proposal.payload).toEqual({ params: { target: 'square' }, ttlSec: 30 });
    expect(proposal.draftUtterance).toBe('hello');
    expect(proposal.candidateEmotion).toEqual({ mood: 'calm' });
    expect('memoryOps' in proposal).toBe(false);
    expectValidProposal(proposal, a);
    expect(calls).toBe(1);
  });

  test('allows two different same-NPC attempts to overlap and preserves identity', async () => {
    const entered = [deferred(), deferred()] as const;
    const release = [deferred(), deferred()] as const;
    let calls = 0;
    const { brain } = await prepared({ complete: async (req) => {
      const i = calls++;
      entered[i]!.resolve();
      await release[i]!.promise;
      return response({ intent: { action: 'idle', ttlSec: 30 }, utterance: { lines: [`call-${i}`] } });
    } });
    const first = attempt();
    const second = attempt({ attemptId: deriveAttemptId(subject, 'trigger-2', 2), triggerId: 'trigger-2', triggerSeq: 2 });
    second.idempotencyHash = deriveAttemptIdempotencyHash({ ...second, idempotencyHash: 'sha256:' + '0'.repeat(64) });
    const p1 = brain.propose(first, snapshot(), { soulId: 'guide' });
    const p2 = brain.propose(second, snapshot({ eventId: 'event-2' }), { soulId: 'guide' });
    await Promise.all([entered[0].promise, entered[1].promise]);
    expect(calls).toBe(2);
    let firstSettled = false;
    void p1.then(() => { firstSettled = true; });
    release[1].resolve();
    const b = await p2;
    expect(firstSettled).toBe(false);
    release[0].resolve();
    const a = await p1;
    expect(a.attemptId).toBe(first.attemptId);
    expect(b.attemptId).toBe(second.attemptId);
    expect(a.proposalId).toBe(deriveProposalId(first.attemptId));
    expect(b.proposalId).toBe(deriveProposalId(second.attemptId));
    expect(a.observedSnapshotVersion).toBe(first.snapshotVersion);
    expect(b.observedSnapshotVersion).toBe(second.snapshotVersion);
    expect(a.subject).toEqual(first.subject);
    expect(b.subject).toEqual(second.subject);
    expectValidProposal(a, first);
    expectValidProposal(b, second);
  });

  test('same-attempt in-flight retries share one provider call and canonical key reorder reuses terminal bytes', async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const { brain } = await prepared({ complete: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return response({ utterance: { lines: ['one'] } });
    } });
    const a = attempt();
    const firstPending = brain.propose(a, snapshot(), { soulId: 'guide' });
    await entered.promise;
    const secondPending = brain.propose({ ...a }, { ...snapshot() }, { soulId: 'guide' });
    const differentHash = { ...a, priorityClass: 'urgent' as const };
    differentHash.idempotencyHash = deriveAttemptIdempotencyHash(differentHash);
    await expect(brain.propose(differentHash, snapshot(), { soulId: 'guide' })).rejects.toThrow('proposal-identity-conflict');
    await expect(brain.propose(a, snapshot({ text: 'different' }), { soulId: 'guide' })).rejects.toThrow('proposal-identity-conflict');
    await expect(brain.propose(a, snapshot(), { soulId: 'guide', speechActionKind: 'speak' })).rejects.toThrow('proposal-identity-conflict');
    expect(calls).toBe(1);
    release.resolve();
    const first = await firstPending;
    const second = await secondPending;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const reordered = {
      affordances: snapshot().affordances, events: [], nearby: [],
      self: snapshot().self, text: 'hello', trigger: 'player_message', t: 1,
      playerId: 'player-1', npcId: 'guide', game: 'proposal-game', eventId: 'event-1', v: 1,
    };
    const third = await brain.propose(a, reordered, { soulId: 'guide' });
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    await expect(brain.propose(differentHash, snapshot(), { soulId: 'guide' })).rejects.toThrow('proposal-identity-conflict');
    await expect(brain.propose(a, snapshot({ text: 'different' }), { soulId: 'guide' })).rejects.toThrow('proposal-identity-conflict');
    await expect(brain.propose(a, snapshot(), { soulId: 'guide', speechActionKind: 'speak' })).rejects.toThrow('proposal-identity-conflict');
    expect(calls).toBe(1);
  });

  test('same-attempt retries are single-flight and byte-stable, while identity conflicts fail before provider', async () => {
    let calls = 0;
    const { brain } = await prepared({ complete: async () => { calls++; return response({ utterance: { lines: ['ok'] } }); } });
    const a = attempt();
    const first = await brain.propose(a, snapshot(), { soulId: 'guide' });
    const second = await brain.propose({ ...a }, { ...snapshot() }, { soulId: 'guide' });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(calls).toBe(1);
    const differentHash = { ...a, deadlineAt: a.deadlineAt - 1 };
    differentHash.idempotencyHash = deriveAttemptIdempotencyHash(differentHash);
    await expect(brain.propose(differentHash, snapshot(), { soulId: 'guide' })).rejects.toThrow('proposal-identity-conflict');
    await expect(brain.propose(a, snapshot({ text: 'different' }), { soulId: 'guide' })).rejects.toThrow('proposal-identity-conflict');
    await expect(brain.propose(a, snapshot(), { soulId: 'other' })).rejects.toThrow('proposal-identity-conflict');
    expect(calls).toBe(1);
  });

  test('proposal identity and hash tampering fail the full B0 boundary', async () => {
    const { brain } = await prepared({ complete: async () => response({ utterance: { lines: ['ok'] } }) });
    const proposal = await brain.propose(attempt(), snapshot(), { soulId: 'guide' });
    const badId = { ...proposal, proposalId: deriveProposalId(deriveAttemptId(subject, 'other', 2)) };
    const badHash = { ...proposal, proposalHash: 'sha256:' + 'f'.repeat(64) };
    expect(() => parseNpcActionProposalV1(badId)).toThrow();
    expect(() => parseNpcActionProposalV1(badHash)).toThrow();
    expect(validateProposalIntegrity(badId).ok).toBe(false);
    expect(validateProposalIntegrity(badHash).ok).toBe(false);
  });

  test('uses no fallback and maps provider failure to one terminal no-action', async () => {
    let calls = 0;
    const requestedModels: string[] = [];
    const { brain } = await prepared({ model: 'primary', fallbackModels: ['fallback'], complete: async (request) => {
      calls++;
      requestedModels.push(request.model);
      throw new Error('upstream said request timed out and aborted');
    } });
    const a = attempt();
    const proposal = await brain.propose(a, snapshot(), { soulId: 'guide' });
    expect(proposal).toMatchObject({ disposition: 'no_action', reasonCode: 'provider_failed' });
    expectValidProposal(proposal, a);
    expect(calls).toBe(1);
    expect(requestedModels).toEqual(['primary']);
  });

  test('handles explicit zero-parameter speech and no-action mappings', async () => {
    const outputs = [
      { utterance: { lines: ['say it'] } },
      { utterance: { lines: ['ignored'] }, emotion: { mood: 'happy' } },
    ];
    let index = 0;
    const { brain } = await prepared({ complete: async () => response(outputs[index++]!) });
    const speechAttempt = attempt();
    const speech = await brain.propose(speechAttempt, snapshot(), { soulId: 'guide', speechActionKind: 'speak' });
    expect(speech).toMatchObject({ disposition: 'action', actionKind: 'speak', payload: {}, draftUtterance: 'say it' });
    expectValidProposal(speech, speechAttempt);
    const noneAttempt = attempt({ attemptId: deriveAttemptId(subject, 'trigger-2', 2), triggerId: 'trigger-2', triggerSeq: 2 });
    noneAttempt.idempotencyHash = deriveAttemptIdempotencyHash({ ...noneAttempt, idempotencyHash: 'sha256:' + '0'.repeat(64) });
    const none = await brain.propose(noneAttempt, snapshot({ eventId: 'event-2' }), { soulId: 'guide' });
    expect(none).toMatchObject({ disposition: 'no_action', reasonCode: 'no_action' });
    expect('draftUtterance' in none).toBe(false);
    expect('candidateEmotion' in none).toBe(false);
    expectValidProposal(none, noneAttempt);
    expect(index).toBe(2);
  });

  test('rejects an explicit speech mapping that is not admitted', async () => {
    let calls = 0;
    const { brain } = await prepared({ complete: async () => {
      calls++;
      return response({ utterance: { lines: ['ignored'] } });
    } });
    const a = attempt();
    const proposal = await brain.propose(a, snapshot(), { soulId: 'guide', speechActionKind: 'missing-action' });
    expect(proposal).toMatchObject({ disposition: 'no_action', reasonCode: 'action_not_admitted' });
    expectValidProposal(proposal, a);
    expect(calls).toBe(1);
  });

  test('returns every required precondition/reason outcome with exact provider counts', async () => {
    let calls = 0;
    let loaderCalls = 0;
    const projectRoot = root();
    const { brain } = await prepared({
      projectRoot,
      loadAgentRecord: async () => {
        loaderCalls++;
        return record(projectRoot);
      },
      complete: async () => { calls++; return response({ utterance: { lines: ['ok'] } }); },
    });
    expect(loaderCalls).toBe(1);
    loaderCalls = 0;
    const missingAttempt = attempt();
    const missing = await brain.propose(missingAttempt, snapshot(), { soulId: 'missing' });
    expect(missing).toMatchObject({ disposition: 'no_action', reasonCode: 'context_unavailable' });
    expectValidProposal(missing, missingAttempt);
    expect(loaderCalls).toBe(0);
    const malformedAttempt = attempt({ attemptId: deriveAttemptId(subject, 'trigger-2', 2), triggerId: 'trigger-2', triggerSeq: 2 });
    malformedAttempt.idempotencyHash = deriveAttemptIdempotencyHash({ ...malformedAttempt, idempotencyHash: 'sha256:' + '0'.repeat(64) });
    let malformedCalls = 0;
    const malformedBrain = await prepared({ complete: async () => {
      malformedCalls++;
      return { text: '{bad json', model: 'mock', transport: 'test', latencyMs: 1 };
    } });
    const malformed = await malformedBrain.brain.propose(malformedAttempt, snapshot({ eventId: 'event-2' }), { soulId: 'guide' });
    expect(malformed).toMatchObject({ disposition: 'no_action', reasonCode: 'invalid_response' });
    expectValidProposal(malformed, malformedAttempt);
    expect(malformedCalls).toBe(1);
    const invalidAttempt = attempt({ attemptId: deriveAttemptId(subject, 'trigger-5', 5), triggerId: 'trigger-5', triggerSeq: 5 });
    invalidAttempt.idempotencyHash = deriveAttemptIdempotencyHash({ ...invalidAttempt, idempotencyHash: 'sha256:' + '0'.repeat(64) });
    let invalidCalls = 0;
    const invalidBrain = await prepared({ complete: async () => {
      invalidCalls++;
      return response({ intent: { action: 'teleport', ttlSec: 30 }, utterance: { lines: ['no'] } });
    } });
    const invalid = await invalidBrain.brain.propose(invalidAttempt, snapshot({ eventId: 'event-5' }), { soulId: 'guide' });
    expect(invalid).toMatchObject({ reasonCode: 'action_not_admitted' });
    expectValidProposal(invalid, invalidAttempt);
    expect(invalidCalls).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    const preAbortedAttempt = attempt({ attemptId: deriveAttemptId(subject, 'trigger-3', 3), triggerId: 'trigger-3', triggerSeq: 3 });
    preAbortedAttempt.idempotencyHash = deriveAttemptIdempotencyHash({ ...preAbortedAttempt, idempotencyHash: 'sha256:' + '0'.repeat(64) });
    const preAborted = await brain.propose(preAbortedAttempt, snapshot({ eventId: 'event-3' }), { soulId: 'guide', signal: aborted.signal });
    expect(preAborted).toMatchObject({ reasonCode: 'aborted' });
    expectValidProposal(preAborted, preAbortedAttempt);
    let expiredCalls = 0;
    const expiredBrain = await prepared({ now: () => 1, complete: async () => {
      expiredCalls++;
      return response({ utterance: { lines: ['unexpected'] } });
    } });
    const expiredAttempt = attempt({ admittedAt: 0, deadlineAt: 0, attemptId: deriveAttemptId(subject, 'trigger-4', 4), triggerId: 'trigger-4', triggerSeq: 4 });
    expiredAttempt.idempotencyHash = deriveAttemptIdempotencyHash({ ...expiredAttempt, idempotencyHash: 'sha256:' + '0'.repeat(64) });
    const expired = await expiredBrain.brain.propose(expiredAttempt, snapshot({ eventId: 'event-4' }), { soulId: 'guide' });
    expect(expired).toMatchObject({ reasonCode: 'deadline_exceeded' });
    expectValidProposal(expired, expiredAttempt);
    expect(await expiredBrain.brain.propose(expiredAttempt, snapshot({ eventId: 'event-4' }), { soulId: 'guide' })).toEqual(expired);
    expect(expiredCalls).toBe(0);
    expect(calls).toBe(0);
  });

  test('in-flight abort is one call and becomes terminal aborted', async () => {
    const entered = deferred();
    const release = deferred();
    const finished = deferred();
    let calls = 0;
    const { brain, projectRoot } = await prepared({ complete: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      finished.resolve();
      return response({ utterance: { lines: ['late'] } });
    } });
    const beforeFiles = readdirSync(projectRoot, { recursive: true }).sort();
    const beforeBudget = brain.budgetState();
    const events: unknown[] = [];
    const unsubscribe = onLifeEvent((event) => events.push(event));
    const controller = new AbortController();
    const a = attempt();
    try {
      const p = brain.propose(a, snapshot(), { soulId: 'guide', signal: controller.signal });
      await entered.promise;
      controller.abort();
      const terminal = await p;
      expect(terminal).toMatchObject({ disposition: 'no_action', reasonCode: 'aborted' });
      expectValidProposal(terminal, a);
      const terminalBytes = JSON.stringify(terminal);
      release.resolve();
      await finished.promise;
      await Promise.resolve();
      expect(JSON.stringify(await brain.propose(a, snapshot(), { soulId: 'guide', signal: controller.signal }))).toBe(terminalBytes);
      expect(calls).toBe(1);
      expect(events).toHaveLength(0);
      expect(brain.activeBrainCount).toBe(0);
      expect(brain.budgetState()).toEqual(beforeBudget);
      expect(readdirSync(projectRoot, { recursive: true }).sort()).toEqual(beforeFiles);
    } finally {
      unsubscribe();
      release.resolve();
    }
  });

  test('deadline wins over abort and late provider completion cannot alter terminal bytes', async () => {
    const entered = deferred();
    const release = deferred<Awaited<ReturnType<typeof completeLlm>>>();
    const finished = deferred();
    let now = 1;
    let calls = 0;
    const { brain, projectRoot } = await prepared({ now: () => now, complete: async () => {
      calls++;
      entered.resolve();
      const value = await release.promise;
      finished.resolve();
      return value;
    } });
    const beforeFiles = readdirSync(projectRoot, { recursive: true }).sort();
    const beforeBudget = brain.budgetState();
    const events: unknown[] = [];
    const unsubscribe = onLifeEvent((event) => events.push(event));
    const controller = new AbortController();
    const a = attempt({ deadlineAt: 10 });
    try {
      const pending = brain.propose(a, snapshot(), { soulId: 'guide', signal: controller.signal });
      await entered.promise;
      now = 10;
      controller.abort();
      const proposal = await pending;
      expect(proposal).toMatchObject({ disposition: 'no_action', reasonCode: 'deadline_exceeded' });
      expectValidProposal(proposal, a);
      const terminalBytes = JSON.stringify(proposal);
      release.resolve(response({ utterance: { lines: ['late'] } }));
      await finished.promise;
      await Promise.resolve();
      expect(JSON.stringify(await brain.propose(a, snapshot(), { soulId: 'guide', signal: controller.signal }))).toBe(terminalBytes);
      expect(calls).toBe(1);
      expect(events).toHaveLength(0);
      expect(brain.activeBrainCount).toBe(0);
      expect(brain.budgetState()).toEqual(beforeBudget);
      expect(readdirSync(projectRoot, { recursive: true }).sort()).toEqual(beforeFiles);
    } finally {
      unsubscribe();
      release.resolve(response({ utterance: { lines: ['late'] } }));
    }
  });

  test('never reuses another soul\'s working state for the same NPC slot', async () => {
    const projectRoot = root();
    const requests: Parameters<typeof completeLlm>[0][] = [];
    let call = 0;
    const brain = new NpcBrainService({
      projectRoot,
      loadAgentRecord: async (soulId) => ({
        ...record(projectRoot),
        agentId: soulId,
        persona: `persona-${soulId}`,
      }),
      complete: async (request) => {
        requests.push(request);
        call++;
        if (call === 1) return response({
          utterance: { lines: ['soul-a-private-output'] },
          emotion: { mood: 'soul-a-private-mood' },
        });
        if (call === 2) return response({ utterance: { lines: ['soul-b-proposal-output'] } });
        return response({ utterance: { lines: ['soul-a-after-output'] } });
      },
    });
    await brain.preload('proposal-game', [{ soulId: 'soul-a' }, { soulId: 'soul-b' }], 'player-1');

    const first = await brain.decide(snapshot({
      eventId: 'soul-a-first',
      text: 'soul-a-private-input',
      events: [{ type: 'soul-a-private-event' }],
    }), { soulId: 'soul-a' });
    expect(first?.seq).toBe(1);

    const proposalAttempt = attempt({
      attemptId: deriveAttemptId(subject, 'soul-b-trigger', 2),
      triggerId: 'soul-b-trigger',
      triggerSeq: 2,
    });
    const proposal = await brain.propose(proposalAttempt, snapshot({
      eventId: 'soul-b-proposal',
      text: 'soul-b-current-input',
    }), { soulId: 'soul-b' });
    expectValidProposal(proposal, proposalAttempt);
    const soulBPrompt = JSON.stringify(requests[1]?.messages);
    expect(soulBPrompt).toContain('persona-soul-b');
    expect(soulBPrompt).not.toContain('soul-a-private-event');
    expect(soulBPrompt).not.toContain('soul-a-private-output');
    expect(soulBPrompt).not.toContain('soul-a-private-mood');

    const after = await brain.decide(snapshot({
      eventId: 'soul-a-after',
      text: 'soul-a-after-input',
    }), { soulId: 'soul-a' });
    expect(after?.seq).toBe(2);
    const soulAAfterPrompt = JSON.stringify(requests[2]?.messages);
    expect(soulAAfterPrompt).toContain('soul-a-private-event');
    expect(soulAAfterPrompt).toContain('soul-a-private-output');
    expect(soulAAfterPrompt).toContain('soul-a-private-mood');
    expect(soulAAfterPrompt).not.toContain('soul-b-current-input');
    expect(soulAAfterPrompt).not.toContain('soul-b-proposal-output');
  });

  test('peeks a preloaded soul without refreshing the bounded LRU', async () => {
    const projectRoot = root();
    const loads = new Map<string, number>();
    const brain = new NpcBrainService({
      projectRoot,
      maxCachedSoulRecords: 2,
      loadAgentRecord: async (soulId) => {
        loads.set(soulId, (loads.get(soulId) ?? 0) + 1);
        return { ...record(projectRoot), agentId: soulId };
      },
      complete: async () => response({ utterance: { lines: ['proposal'] } }),
    });
    await brain.preload('proposal-game', [{ soulId: 'soul-a' }, { soulId: 'soul-b' }], 'player-1');
    await brain.propose(attempt(), snapshot(), { soulId: 'soul-a' });
    await brain.preload('proposal-game', [{ soulId: 'soul-c' }], 'player-1');
    await brain.preload('proposal-game', [{ soulId: 'soul-a' }], 'player-1');
    expect(loads).toEqual(new Map([
      ['soul-a', 2],
      ['soul-b', 1],
      ['soul-c', 1],
    ]));
  });

  test('no-action, invalid, rejected-action and provider-failure terminals have zero authoritative side effects', async () => {
    const cases = [
      {
        expectedReason: 'no_action',
        proposalSnapshot: snapshot({ trigger: 'event', text: 'no-action-canary' }),
        run: async () => response({}),
      },
      {
        expectedReason: 'invalid_response',
        proposalSnapshot: snapshot({ text: 'invalid-canary' }),
        run: async () => ({ text: '{bad json', model: 'mock', transport: 'test', latencyMs: 1 }),
      },
      {
        expectedReason: 'action_not_admitted',
        proposalSnapshot: snapshot({ text: 'rejected-action-canary' }),
        run: async () => response({
          intent: { action: 'teleport', ttlSec: 30 },
          utterance: { lines: ['rejected-action-output'] },
        }),
      },
      {
        expectedReason: 'provider_failed',
        proposalSnapshot: snapshot({ text: 'provider-failure-canary' }),
        run: async () => { throw new Error('provider failed'); },
      },
    ] as const;

    for (const item of cases) {
      const projectRoot = root();
      const { brain } = await prepared({ projectRoot, complete: item.run });
      const beforeFiles = readdirSync(projectRoot, { recursive: true }).sort();
      const beforeBudget = brain.budgetState();
      const events: unknown[] = [];
      const unsubscribe = onLifeEvent((event) => events.push(event));
      try {
        const sourceAttempt = attempt();
        const proposal = await brain.propose(sourceAttempt, item.proposalSnapshot, { soulId: 'guide' });
        expect(proposal).toMatchObject({
          disposition: 'no_action',
          reasonCode: item.expectedReason,
        });
        expectValidProposal(proposal, sourceAttempt);
        expect(events).toHaveLength(0);
        expect(brain.activeBrainCount).toBe(0);
        expect(brain.budgetState()).toEqual(beforeBudget);
        expect(readdirSync(projectRoot, { recursive: true }).sort()).toEqual(beforeFiles);
      } finally {
        unsubscribe();
      }
    }
  });

  test('successful action does not create Brain state, write files, audit or LifeEvents and leaves legacy prompt clean', async () => {
    const projectRoot = root();
    const requests: Parameters<typeof completeLlm>[0][] = [];
    let proposalPhase = true;
    const { brain } = await prepared({ projectRoot, complete: async (request) => {
      requests.push(request);
      return proposalPhase
        ? response({
          intent: { action: 'idle', ttlSec: 30 },
          utterance: { lines: ['proposal-output-canary'] },
          emotion: { mood: 'proposal-mood-canary' },
          memoryOps: [{ kind: 'episode', text: 'proposal-memory-canary', sourceEventId: 'event-1' }],
        })
        : response({ utterance: { lines: ['legacy-output'] } });
    } });
    const before = readdirSync(projectRoot, { recursive: true }).sort();
    const beforeBudget = brain.budgetState();
    expect(brain.activeBrainCount).toBe(0);
    const events: unknown[] = [];
    const unsubscribe = onLifeEvent((event) => events.push(event));
    const sourceAttempt = attempt();
    let proposal: NpcActionProposalV1;
    try {
      proposal = await brain.propose(sourceAttempt, snapshot({ text: 'proposal-input-canary' }), { soulId: 'guide' });
    } finally {
      unsubscribe();
    }
    expect(proposal).toMatchObject({ disposition: 'action', actionKind: 'idle' });
    expectValidProposal(proposal, sourceAttempt);
    expect(events).toHaveLength(0);
    expect(brain.activeBrainCount).toBe(0);
    expect(brain.budgetState()).toEqual(beforeBudget);
    expect(readdirSync(projectRoot, { recursive: true }).sort()).toEqual(before);

    proposalPhase = false;
    const legacy = await brain.decide(snapshot({ eventId: 'legacy-after', text: 'legacy-input' }), { soulId: 'guide' });
    expect(legacy?.seq).toBe(1);
    const legacyPrompt = JSON.stringify(requests.at(-1)?.messages);
    expect(legacyPrompt).not.toContain('proposal-input-canary');
    expect(legacyPrompt).not.toContain('proposal-output-canary');
    expect(legacyPrompt).not.toContain('proposal-mood-canary');
    expect(legacyPrompt).not.toContain('proposal-memory-canary');
    expect(readdirSync(projectRoot, { recursive: true }).some((name) => String(name).includes('decisions-'))).toBe(true);
  });

  test('prunes after the 24-hour tombstone and rejects provider reconstruction', async () => {
    let now = 1;
    let calls = 0;
    const { brain } = await prepared({ now: () => now, complete: async () => { calls++; return response({ utterance: { lines: ['ok'] } }); } });
    const a = attempt({ deadlineAt: 10 });
    const terminal = await brain.propose(a, snapshot(), { soulId: 'guide' });
    expect(calls).toBe(1);
    now = 10 + 24 * 60 * 60_000;
    expect(await brain.propose(a, snapshot(), { soulId: 'guide' })).toEqual(terminal);
    expect(calls).toBe(1);
    now += 1;
    await expect(brain.propose(a, snapshot(), { soulId: 'guide' })).rejects.toThrow('attempt-expired');
    expect(calls).toBe(1);
  });

  test('invalid attempt or snapshot throws before creating a cache entry', async () => {
    let calls = 0;
    const { brain } = await prepared({ complete: async () => { calls++; return response({ utterance: { lines: ['ok'] } }); } });
    const sourceAttempt = attempt();
    await expect(brain.propose({ bad: true }, snapshot(), { soulId: 'guide' })).rejects.toThrow();
    await expect(brain.propose(sourceAttempt, { bad: true }, { soulId: 'guide' })).rejects.toThrow();
    const valid = await brain.propose(sourceAttempt, snapshot(), { soulId: 'guide' });
    expectValidProposal(valid, sourceAttempt);
    expect(calls).toBe(1);
  });
});
