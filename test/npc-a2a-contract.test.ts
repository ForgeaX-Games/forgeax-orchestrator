import { describe, expect, test } from 'bun:test';
import {
  ActionCommitRecordV1Schema,
  ActionExecutionReceiptV1Schema,
  A2A_RECEIPT_TRANSITION_EVENT_SCHEMA,
  NpcInstanceRefV1Schema,
  ConversationRefV1Schema,
  ConversationDeliveryV1Schema,
  ConversationRecordV1Schema,
  NpcActionAttemptV1Schema,
  NpcActionProposalV1Schema,
  NpcConversationEventV1Schema,
  canonicalizeA2aJson,
  deriveActionCommitId,
  deriveActionCommitRecordHash,
  deriveArgumentsHash,
  deriveAttemptId,
  deriveAttemptIdempotencyHash,
  deriveConversationId,
  deriveConversationIdempotencyHash,
  deriveDeliveryId,
  deriveDeliveryIdempotencyHash,
  deriveEventId,
  deriveEventIdempotencyHash,
  derivePairKey,
  deriveProposalHash,
  deriveProposalId,
  deriveReceiptImmutableIdentityHash,
  deriveTargetTriggerId,
  deriveUtteranceId,
  classifyAttemptReplay,
  classifyConversationReplay,
  classifyDeliveryReplay,
  classifyProposalReplay,
  classifyActionCommitReplay,
  classifyReceiptReplay,
  classifyEventReplay,
  parseActionCommitRecordV1,
  parseConversationRecordV1,
  parseNpcActionAttemptV1,
  parseNpcActionProposalV1,
  parseNpcConversationEventV1,
  parseActionExecutionReceiptV1,
  parseConversationDeliveryV1,
  validateAttemptRouteForAdmission,
  validateCommitAgainstAttemptAndProposal,
  validateConversationTransition,
  validateDeliveryAgainstEvent,
  validateDeliveryTransition,
  validateEventAgainstCommitAndReceipt,
  validateProposalAgainstAttempt,
  validateReceiptAgainstCommit,
  validateReceiptTransition,
  type ActionCommitRecordV1,
  type ActionExecutionReceiptV1,
  type ConversationDeliveryV1,
  type ConversationRecordV1,
  type NpcActionAttemptV1,
  type NpcActionProposalV1,
  type NpcConversationEventV1,
} from '../src/npc-brain/a2a-contract';

const subject = { worldId: 'world', worldEpoch: 1, npcId: 'alice', instanceId: 'alice-1', instanceEpoch: 2 } as const;
const target = { worldId: 'world', worldEpoch: 1, npcId: 'bob', instanceId: 'bob-1', instanceEpoch: 1 } as const;
const pairKey = derivePairKey(subject, target);
const conversation = { conversationId: deriveConversationId('root', subject, target), pairKey, causalRootId: 'root' } as const;

function makeAttempt(): NpcActionAttemptV1 {
  const value: any = { schemaVersion: 1 as const, attemptId: deriveAttemptId(subject, 'trigger', 3), triggerId: 'trigger', triggerSeq: 3, subject,
    conversationRoute: { conversation, target, routeVersion: 4, expiresAt: 100 }, priorityClass: 'speech' as const, snapshotVersion: 'snapshot',
    allowedActionKinds: ['talk'], admittedConflictKeys: ['conversation'], baseConflictEpochs: { conversation: 7 }, admittedAt: 10, deadlineAt: 90,
  };
  return { ...value, idempotencyHash: deriveAttemptIdempotencyHash(value) };
}
function makeProposal(attempt: NpcActionAttemptV1): NpcActionProposalV1 {
  const value: any = { schemaVersion: 1 as const, attemptId: attempt.attemptId, proposalId: deriveProposalId(attempt.attemptId), subject,
    observedSnapshotVersion: attempt.snapshotVersion, disposition: 'action' as const, actionKind: 'talk', payload: { text: 'hello' }, draftUtterance: 'hello', completedAt: 11 };
  return { ...value, proposalHash: deriveProposalHash(value) };
}
function makeCommit(attempt: NpcActionAttemptV1, proposal: NpcActionProposalV1): ActionCommitRecordV1 {
  const value: any = { schemaVersion: 1 as const, actionCommitId: deriveActionCommitId(attempt.attemptId), attemptId: attempt.attemptId, subject,
    actionKind: 'talk', canonicalArguments: { text: 'hello' }, argumentsHash: deriveArgumentsHash({ text: 'hello' }), proposalHash: proposal.proposalHash,
    acceptedSnapshotVersion: attempt.snapshotVersion, conflictKeys: attempt.admittedConflictKeys, reservedConflictEpochs: attempt.baseConflictEpochs,
    speech: { conversation, target, routeVersion: 4, expiresAt: 100, normalizedPublicText: 'hello' }, createdAt: 12 };
  return { ...value, recordHash: deriveActionCommitRecordHash(value) };
}
function makeReceipt(commit: ActionCommitRecordV1, status: ActionExecutionReceiptV1['status'] = 'reserved'): ActionExecutionReceiptV1 {
  const value: ActionExecutionReceiptV1 = { schemaVersion: 1, actionCommitId: commit.actionCommitId, actionCommitRecordHash: commit.recordHash,
    immutableIdentityHash: '', revision: 0, attemptId: commit.attemptId, subject, conflictKeys: commit.conflictKeys, reservedConflictEpochs: commit.reservedConflictEpochs,
    status, postExecutionProjection: status === 'reserved' ? 'not_applicable' : 'pending' };
  return { ...value, immutableIdentityHash: deriveReceiptImmutableIdentityHash(value) };
}

describe('digital-life A2A B0 contract', () => {
  test('canonical JSON is property-order independent and rejects non-canonical values', () => {
    expect(canonicalizeA2aJson({ b: 1, a: ['x', null] })).toBe('{"a":["x",null],"b":1}');
    expect(canonicalizeA2aJson(-0)).toBe('0');
    expect(() => canonicalizeA2aJson({ x: undefined })).toThrow();
    expect(() => canonicalizeA2aJson({ x: '\ud800' })).toThrow();
    const sparse: unknown[] = []; sparse.length = 1;
    expect(() => canonicalizeA2aJson(sparse)).toThrow();
  });

  test('all nine records parse only with derived identity and hash fields', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal);
    const receipt = makeReceipt(commit); const event: NpcConversationEventV1 = {
      schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation,
      worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId,
      routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '',
    };
    event.idempotencyHash = deriveEventIdempotencyHash(event);
    const delivery: ConversationDeliveryV1 = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target,
      targetTriggerId: '', status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 21 };
    delivery.targetTriggerId = deriveTargetTriggerId(delivery.deliveryId); delivery.idempotencyHash = deriveDeliveryIdempotencyHash(delivery);
    const recordValue: any = { schemaVersion: 1 as const, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target] as const,
      routeVersion: 4, status: 'active' as const, revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    const record: ConversationRecordV1 = { ...recordValue, idempotencyHash: deriveConversationIdempotencyHash(recordValue) };
    expect(parseConversationRecordV1(record)).toEqual(record); expect(parseNpcActionAttemptV1(attempt)).toEqual(attempt); expect(parseNpcActionProposalV1(proposal)).toEqual(proposal);
    expect(parseActionCommitRecordV1(commit)).toEqual(commit); expect(parseActionExecutionReceiptV1(receipt)).toEqual(receipt); expect(parseNpcConversationEventV1(event)).toEqual(event); expect(parseConversationDeliveryV1(delivery)).toEqual(delivery);
    expect(NpcActionAttemptV1Schema.safeParse({ ...attempt, attemptId: deriveAttemptId(subject, 'other', 3) }).success).toBe(false);
    expect(NpcActionProposalV1Schema.safeParse({ ...proposal, payload: undefined }).success).toBe(false);
    expect(ActionCommitRecordV1Schema.safeParse({ ...commit, argumentsHash: deriveArgumentsHash({ changed: true }) }).success).toBe(false);
    expect(ActionExecutionReceiptV1Schema.safeParse({ ...receipt, actionCommitId: deriveActionCommitId(deriveAttemptId(target, 'trigger', 3)) }).success).toBe(false);
    expect(NpcConversationEventV1Schema.safeParse({ ...event, utteranceId: deriveUtteranceId(deriveActionCommitId(deriveAttemptId(target, 'other-trigger', 1))) }).success).toBe(false);
    expect(ConversationDeliveryV1Schema.safeParse({ ...delivery, targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, subject)) }).success).toBe(false);
    expect(classifyAttemptReplay(attempt, attempt)).toBe('same_primary_id_same_immutable_hash');
    expect(classifyAttemptReplay(attempt, { ...attempt, priorityClass: 'urgent', idempotencyHash: deriveAttemptIdempotencyHash({ ...attempt, priorityClass: 'urgent' }) })).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyConversationReplay(record, { ...record, revision: 1, status: 'closed' })).toBe('same_primary_id_same_immutable_hash');
    expect(classifyDeliveryReplay(delivery, { ...delivery, revision: 1, status: 'dispatching' })).toBe('same_primary_id_same_immutable_hash');
  });

  test('record-link validators fail closed on adjacent mismatches', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const reserved = makeReceipt(commit);
    expect(validateAttemptRouteForAdmission(attempt, { bad: true })).toMatchObject({ ok: false });
    const { conversationRoute: _route, ...noRouteFields } = attempt;
    const noRouteAttempt: any = { ...noRouteFields, idempotencyHash: '' }; noRouteAttempt.idempotencyHash = deriveAttemptIdempotencyHash(noRouteAttempt);
    expect(validateAttemptRouteForAdmission(noRouteAttempt, undefined)).toMatchObject({ ok: true });
    expect(validateProposalAgainstAttempt({ ...proposal, observedSnapshotVersion: 'other', proposalHash: deriveProposalHash({ ...proposal, observedSnapshotVersion: 'other' }) }, attempt)).toMatchObject({ ok: false });
    expect(validateCommitAgainstAttemptAndProposal({ ...commit, proposalHash: deriveProposalHash(proposal) }, attempt, proposal)).toMatchObject({ ok: true });
    const emptyProposal: any = { ...proposal, draftUtterance: '' }; emptyProposal.proposalHash = deriveProposalHash(emptyProposal);
    const emptyCommit: any = { ...commit, proposalHash: emptyProposal.proposalHash, speech: { ...commit.speech, normalizedPublicText: '' }, recordHash: '' }; emptyCommit.recordHash = deriveActionCommitRecordHash(emptyCommit);
    expect(validateCommitAgainstAttemptAndProposal(emptyCommit, attempt, emptyProposal)).toMatchObject({ ok: true });
    expect(validateReceiptAgainstCommit(reserved, { ...commit, createdAt: 99, recordHash: deriveActionCommitRecordHash({ ...commit, createdAt: 99 }) })).toMatchObject({ ok: false });
    const executed: ActionExecutionReceiptV1 = { ...reserved, status: 'executed', revision: 1, executorRequestRef: 'request-1', completedAt: 20, actionCommitSeq: 1, postExecutionProjection: 'pending' };
    executed.immutableIdentityHash = deriveReceiptImmutableIdentityHash(executed);
    expect(validateReceiptTransition({ ...reserved, status: 'dispatching', revision: 0, executorRequestRef: 'request-1' }, executed)).toMatchObject({ ok: false });
    expect(validateReceiptTransition({ ...reserved, status: 'dispatching', revision: 0, executorRequestRef: 'request-1' }, executed, { kind: 'executor_outcome', outcome: 'executed' })).toMatchObject({ ok: false });
    expect(validateReceiptTransition({ ...reserved, status: 'dispatching', revision: 0, executorRequestRef: 'request-1' }, executed, { kind: 'executor_outcome', outcome: 'executed' }, commit)).toMatchObject({ ok: true });
    const unrelated = { ...commit, createdAt: 99, recordHash: '' } as any; unrelated.recordHash = deriveActionCommitRecordHash(unrelated);
    expect(validateReceiptTransition({ ...reserved, status: 'dispatching', revision: 0, executorRequestRef: 'request-1' }, executed, { kind: 'executor_outcome', outcome: 'executed' }, unrelated)).toMatchObject({ ok: false });
    const event: NpcConversationEventV1 = { schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation,
      worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId, routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '' };
    event.idempotencyHash = deriveEventIdempotencyHash(event);
    expect(validateReceiptAgainstCommit(executed, commit)).toMatchObject({ ok: true });
    expect(validateEventAgainstCommitAndReceipt(event, commit, executed)).toMatchObject({ ok: true });
    const delivery: ConversationDeliveryV1 = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target, targetTriggerId: '', status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 20 };
    delivery.targetTriggerId = deriveTargetTriggerId(delivery.deliveryId); delivery.idempotencyHash = deriveDeliveryIdempotencyHash(delivery);
    expect(validateDeliveryAgainstEvent(delivery, event)).toMatchObject({ ok: true });
  });

  test('conversation, receipt, and delivery transitions enforce revision and event authority', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const reserved = makeReceipt(commit);
    const recordValue: any = { schemaVersion: 1 as const, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target] as const, routeVersion: 4, status: 'active' as const, revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    const record = { ...recordValue, idempotencyHash: deriveConversationIdempotencyHash(recordValue) };
    const closed = { ...record, status: 'closed' as const, revision: 1 };
    expect(validateConversationTransition(record, closed)).toMatchObject({ ok: true });
    expect(validateConversationTransition(record, { ...closed, revision: 3 })).toMatchObject({ ok: false });
    const dispatching = { ...reserved, status: 'dispatching' as const, revision: 1, executorRequestRef: 'request-1' };
    expect(validateReceiptTransition(reserved, dispatching, { kind: 'dispatch_persisted' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(dispatching, { ...dispatching, revision: 2, executorRequestRef: 'request-2' }, { kind: 'execution_started' })).toMatchObject({ ok: false });
    expect(validateReceiptTransition(reserved, { ...reserved, revision: 1 }, { kind: 'mark_unknown', reason: 'timeout' })).toMatchObject({ ok: false });
    const deliveryBase: ConversationDeliveryV1 = { schemaVersion: 1, deliveryId: deriveDeliveryId(deriveEventId(commit.actionCommitId), target), eventId: deriveEventId(commit.actionCommitId), target, targetTriggerId: '', status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 1 };
    deliveryBase.targetTriggerId = deriveTargetTriggerId(deliveryBase.deliveryId); deliveryBase.idempotencyHash = deriveDeliveryIdempotencyHash(deliveryBase);
    expect(validateDeliveryTransition(deliveryBase, { ...deliveryBase, revision: 1, status: 'dispatching', updatedAt: 2 })).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(deliveryBase, { ...deliveryBase, revision: 3, status: 'dispatching', updatedAt: 2 })).toMatchObject({ ok: false });
  });

  test('canonical golden matrix rejects every non-JSON shape and preserves shared references', () => {
    const scalarCases: unknown[] = [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1, '\ud800', 'e\u0301'];
    for (const value of scalarCases) expect(() => canonicalizeA2aJson(value)).toThrow();
    const nullAndMissing = canonicalizeA2aJson({ present: null });
    expect(nullAndMissing).toBe('{"present":null}');
    expect(() => canonicalizeA2aJson({ present: undefined })).toThrow();
    const accessor: any = {};
    Object.defineProperty(accessor, 'x', { enumerable: true, get: () => { throw new Error('must not run'); } });
    expect(() => canonicalizeA2aJson(accessor)).toThrow();
    const hidden: any = { x: 1 }; Object.defineProperty(hidden, 'secret', { value: 2, enumerable: false });
    expect(() => canonicalizeA2aJson(hidden)).toThrow();
    const symbolKey: any = { x: 1 }; symbolKey[Symbol('hidden')] = 2;
    expect(() => canonicalizeA2aJson(symbolKey)).toThrow();
    expect(() => canonicalizeA2aJson(Object.create({ inherited: 1 }))).toThrow();
    const arraySubclass = new (class extends Array<number> {}) (1, 2);
    expect(() => canonicalizeA2aJson(arraySubclass)).toThrow();
    const overriddenMap: any[] = [1, 2]; overriddenMap.map = () => { throw new Error('map must not run'); };
    expect(() => canonicalizeA2aJson(overriddenMap)).toThrow();
    const sparse: any[] = []; sparse.length = 2; sparse[1] = 1;
    expect(() => canonicalizeA2aJson(sparse)).toThrow();
    const shared: any = { x: 1 };
    expect(canonicalizeA2aJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    shared.self = shared;
    expect(() => canonicalizeA2aJson(shared)).toThrow();
    expect(canonicalizeA2aJson({ '\ue000': 1, '\u{10000}': 2 })).toBe('{"":1,"𐀀":2}');
  });

  test('set arrays, epoch maps, IDs, and all DTO boundaries are strict', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const receipt = makeReceipt(commit);
    expect(NpcInstanceRefV1Schema.safeParse({ ...subject, unknown: 1 }).success).toBe(false);
    expect(ConversationRefV1Schema.safeParse({ ...conversation, conversationId: pairKey }).success).toBe(false);
    expect(NpcActionAttemptV1Schema.safeParse({ ...attempt, allowedActionKinds: ['talk', 'talk'] }).success).toBe(false);
    expect(NpcActionAttemptV1Schema.safeParse({ ...attempt, allowedActionKinds: ['talk', 'act'] }).success).toBe(false);
    expect(NpcActionAttemptV1Schema.safeParse({ ...attempt, baseConflictEpochs: { other: 1 } }).success).toBe(false);
    expect(NpcActionProposalV1Schema.safeParse({ ...proposal, proposalId: attempt.attemptId }).success).toBe(false);
    expect(ActionCommitRecordV1Schema.safeParse({ ...commit, actionCommitId: attempt.attemptId }).success).toBe(false);
    expect(ActionExecutionReceiptV1Schema.safeParse({ ...receipt, actionCommitId: attempt.attemptId }).success).toBe(false);
    expect(ActionExecutionReceiptV1Schema.safeParse({ ...receipt, extra: true }).success).toBe(false);
    const recordValue: any = { schemaVersion: 1, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target], routeVersion: 4, status: 'active', revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    const record: any = { ...recordValue, idempotencyHash: deriveConversationIdempotencyHash(recordValue) };
    const event: any = { schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation, worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId, routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '' }; event.idempotencyHash = deriveEventIdempotencyHash(event);
    const delivery: any = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target, targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, target)), status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 1 }; delivery.idempotencyHash = deriveDeliveryIdempotencyHash(delivery);
    const dtoCases: Array<[any, any, string, string]> = [
      [NpcInstanceRefV1Schema, subject, 'worldId', 'worldEpoch'], [ConversationRefV1Schema, conversation, 'conversationId', 'pairKey'], [ConversationRecordV1Schema, record, 'conversation', 'unknown'],
      [NpcActionAttemptV1Schema, attempt, 'attemptId', 'unknown'], [NpcActionProposalV1Schema, proposal, 'proposalId', 'proposalId'], [ActionCommitRecordV1Schema, commit, 'actionCommitId', 'actionCommitId'],
      [ActionExecutionReceiptV1Schema, receipt, 'actionCommitId', 'actionCommitId'], [NpcConversationEventV1Schema, event, 'eventId', 'eventId'], [ConversationDeliveryV1Schema, delivery, 'deliveryId', 'deliveryId'],
    ];
    for (const [schema, value, missing, wrongKind] of dtoCases) {
      const absent = { ...value }; delete absent[missing];
      expect(schema.safeParse(absent).success, `${missing} required`).toBe(false);
      expect(schema.safeParse({ ...value, unknown: true }).success, `${missing} strict`).toBe(false);
      const wrong = { ...value, [wrongKind]: attempt.attemptId };
      expect(schema.safeParse(wrong).success, `${missing} wrong kind`).toBe(false);
    }
    const allIds = [attempt.attemptId, proposal.proposalId, commit.actionCommitId, deriveEventId(commit.actionCommitId), deriveUtteranceId(commit.actionCommitId), deriveDeliveryId(deriveEventId(commit.actionCommitId), target), deriveTargetTriggerId(deriveDeliveryId(deriveEventId(commit.actionCommitId), target)), pairKey, conversation.conversationId];
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const id of allIds) expect(/^fxdl:v1:[a-z-]+:[0-9a-f]{64}$/.test(id)).toBe(true);
    expect(allIds).toEqual([
      'fxdl:v1:attempt:97f9e62f65c8281158a2006d56917d9fa8c8101294fc7d267e3853d9a52062d4',
      'fxdl:v1:proposal:e9177ccb61f006d1d609b7cd4fadbc3e37756d613be8cc884042245e6df6cd6c',
      'fxdl:v1:action-commit:3eb434de83d1b907277c164b0c21a2e6ea2dae41499f9724b4cb65d2fdfb5bfb',
      'fxdl:v1:event:b207055a494256f214e7fa245b0f06d3a704552946ce14b41c791e025ee761bf',
      'fxdl:v1:utterance:144197ede35a49071703dec29f4011b08ae24e7bfe8ff532b705b97ddb5afc18',
      'fxdl:v1:delivery:187aa5cdbe621d214c66b9419f4d0d3a3eb50beece3ad1d66682a806b71b3ae7',
      'fxdl:v1:target-trigger:1bf03fc944f849089b2135c88cc2950ef12e499f1f9c99b18e3f64bcf3f5c2a4',
      'fxdl:v1:pair:106cc777bbc6d1163164a6cfa82113852d1099f34e7c81cf9354df16e39380d0',
      'fxdl:v1:conversation:9cffd107bcd3a96459778a36247a3eb65f46252f995e84cc972c0b2202930cb8',
    ]);
    expect(derivePairKey(target, subject)).toBe(pairKey);
    expect(deriveConversationId('root', target, subject)).toBe(conversation.conversationId);
  });

  test('all replay classifiers distinguish different IDs, idempotency, and rehashed conflicts', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const receipt = makeReceipt(commit);
    const event: NpcConversationEventV1 = { schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation, worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId, routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '' };
    event.idempotencyHash = deriveEventIdempotencyHash(event);
    const delivery: ConversationDeliveryV1 = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target, targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, target)), status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 1 };
    delivery.idempotencyHash = deriveDeliveryIdempotencyHash(delivery);
    const { conversationRoute: _route, ...otherAttemptFields } = attempt;
    const otherAttempt = { ...otherAttemptFields, attemptId: deriveAttemptId(target, 'other', 9), triggerId: 'other', triggerSeq: 9, subject: target, idempotencyHash: '' } as any; otherAttempt.idempotencyHash = deriveAttemptIdempotencyHash(otherAttempt);
    const otherProposal = { ...proposal, attemptId: otherAttempt.attemptId, proposalId: deriveProposalId(otherAttempt.attemptId), subject: target, proposalHash: '' } as any; otherProposal.proposalHash = deriveProposalHash(otherProposal);
    expect(classifyAttemptReplay(attempt, otherAttempt)).toBe('different_primary_id');
    expect(classifyProposalReplay(proposal, otherProposal)).toBe('different_primary_id');
    const otherCommitFields = { ...commit, actionCommitId: deriveActionCommitId(otherAttempt.attemptId), attemptId: otherAttempt.attemptId, subject: target, proposalHash: otherProposal.proposalHash, speech: undefined, recordHash: '' } as any;
    delete otherCommitFields.speech; otherCommitFields.recordHash = deriveActionCommitRecordHash(otherCommitFields);
    expect(classifyActionCommitReplay(commit, otherCommitFields)).toBe('different_primary_id');
    const otherReceipt = { ...receipt, actionCommitId: otherCommitFields.actionCommitId, attemptId: otherAttempt.attemptId, subject: target, actionCommitRecordHash: otherCommitFields.recordHash, immutableIdentityHash: '' } as any; otherReceipt.immutableIdentityHash = deriveReceiptImmutableIdentityHash(otherReceipt);
    expect(classifyReceiptReplay(receipt, otherReceipt)).toBe('different_primary_id');
    const otherEvent = { ...event, parentActionCommitId: otherCommitFields.actionCommitId, eventId: deriveEventId(otherCommitFields.actionCommitId), utteranceId: deriveUtteranceId(otherCommitFields.actionCommitId), sourceAttemptId: otherAttempt.attemptId, speaker: target, target: subject, idempotencyHash: '' } as any; otherEvent.idempotencyHash = deriveEventIdempotencyHash(otherEvent);
    expect(classifyEventReplay(event, otherEvent)).toBe('different_primary_id');
    const otherDelivery = { ...delivery, deliveryId: deriveDeliveryId(event.eventId, subject), target: subject, targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, subject)), idempotencyHash: '' } as any; otherDelivery.idempotencyHash = deriveDeliveryIdempotencyHash(otherDelivery);
    expect(classifyDeliveryReplay(delivery, otherDelivery)).toBe('different_primary_id');
    const changedProposal: any = { ...proposal, draftUtterance: 'changed' }; changedProposal.proposalHash = deriveProposalHash(changedProposal);
    expect(classifyProposalReplay(proposal, changedProposal)).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyActionCommitReplay(commit, { ...commit, createdAt: 13, recordHash: deriveActionCommitRecordHash({ ...commit, createdAt: 13 }) })).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyEventReplay(event, { ...event, publicText: 'changed', idempotencyHash: deriveEventIdempotencyHash({ ...event, publicText: 'changed' }) })).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyDeliveryReplay(delivery, { ...delivery, status: 'dispatching', revision: 1 })).toBe('same_primary_id_same_immutable_hash');
    for (const change of [
      { eventId: deriveEventId(deriveActionCommitId(otherAttempt.attemptId)) },
      { target: subject },
      { targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(deriveEventId(deriveActionCommitId(otherAttempt.attemptId)), target)) },
    ]) {
      const tampered: any = { ...delivery, ...change, idempotencyHash: '' }; tampered.idempotencyHash = deriveDeliveryIdempotencyHash(tampered);
      expect(ConversationDeliveryV1Schema.safeParse(tampered).success).toBe(false);
      expect(() => classifyDeliveryReplay(delivery, tampered)).toThrow();
    }
  });

  test('mutable same-ID classifiers require immutable hash congruence before transitions', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const receipt = makeReceipt(commit);
    const recordValue: any = { schemaVersion: 1, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target], routeVersion: 4, status: 'active', revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    const record: any = { ...recordValue, idempotencyHash: deriveConversationIdempotencyHash(recordValue) };
    const routeChanged: any = { ...record, routeVersion: 5, idempotencyHash: '' }; routeChanged.idempotencyHash = deriveConversationIdempotencyHash(routeChanged);
    const createdChanged: any = { ...record, createdAt: 1, idempotencyHash: '' }; createdChanged.idempotencyHash = deriveConversationIdempotencyHash(createdChanged);
    expect(ConversationRecordV1Schema.safeParse(routeChanged).success).toBe(true);
    expect(ConversationRecordV1Schema.safeParse(createdChanged).success).toBe(true);
    expect(classifyConversationReplay(record, routeChanged)).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyConversationReplay(record, createdChanged)).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyConversationReplay(record, { ...record, status: 'closed', revision: 1 })).toBe('same_primary_id_same_immutable_hash');
    const commitChanged: any = { ...receipt, actionCommitRecordHash: 'sha256:' + '1'.repeat(64), immutableIdentityHash: '' }; commitChanged.immutableIdentityHash = deriveReceiptImmutableIdentityHash(commitChanged);
    expect(ActionExecutionReceiptV1Schema.safeParse(commitChanged).success).toBe(true);
    expect(classifyReceiptReplay(receipt, commitChanged)).toBe('same_primary_id_different_immutable_hash_conflict');
    expect(classifyReceiptReplay(receipt, { ...receipt, status: 'reserved', revision: 1 })).toBe('same_primary_id_same_immutable_hash');
  });

  test('receipt transition matrix is fail-closed and covers every legal edge', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const reserved = makeReceipt(commit);
    const dispatching = { ...reserved, status: 'dispatching' as const, revision: 1, executorRequestRef: 'executor-1' };
    const executing = { ...dispatching, status: 'executing' as const, revision: 2 };
    const executed = { ...executing, status: 'executed' as const, revision: 3, actionCommitSeq: 1, completedAt: 30, postExecutionProjection: 'pending' as const };
    const projected = { ...executed, revision: 4, postExecutionProjection: 'complete' as const };
    const cancelled = { ...reserved, status: 'not_executed' as const, revision: 1, completedAt: 20 };
    const notExecuted = { ...executing, status: 'not_executed' as const, revision: 3, completedAt: 30, postExecutionProjection: 'not_applicable' as const };
    const unknown = { ...executing, status: 'execution_unknown' as const, revision: 3 };
    const escalated = { ...unknown, revision: 4, escalation: { state: 'required' as const, owner: 'ops', reasonCode: 'timeout', raisedAt: 31 } };
    const acknowledged = { ...escalated, revision: 5, escalation: { ...escalated.escalation, state: 'acknowledged' as const } };
    const reconciledExecuted = { ...unknown, status: 'reconciled_executed' as const, revision: 4, actionCommitSeq: 2, completedAt: 40, postExecutionProjection: 'pending' as const, reconciliation: { source: 'probe', reconciledAt: 40 } };
    const reconciledNotExecuted = { ...unknown, status: 'reconciled_not_executed' as const, revision: 4, completedAt: 40, postExecutionProjection: 'not_applicable' as const, reconciliation: { source: 'probe', reconciledAt: 40 } };
    const dispatchedExecuted = { ...dispatching, status: 'executed' as const, revision: 2, actionCommitSeq: 1, completedAt: 30, postExecutionProjection: 'pending' as const };
    const dispatchedNotExecuted = { ...dispatching, status: 'not_executed' as const, revision: 2, completedAt: 30, postExecutionProjection: 'not_applicable' as const };
    const dispatchedUnknown = { ...dispatching, status: 'execution_unknown' as const, revision: 2 };
    const unrelatedCommit: any = { ...commit, createdAt: 99, recordHash: '' }; unrelatedCommit.recordHash = deriveActionCommitRecordHash(unrelatedCommit);
    expect(validateReceiptTransition(reserved, reserved)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(reserved, dispatching, { kind: 'dispatch_persisted' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(dispatching, executing, { kind: 'execution_started' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(executing, executed, { kind: 'executor_outcome', outcome: 'executed' }, commit)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(dispatching, dispatchedExecuted, { kind: 'executor_outcome', outcome: 'executed' }, commit)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(dispatching, dispatchedNotExecuted, { kind: 'executor_outcome', outcome: 'not_executed' }, commit)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(dispatching, dispatchedUnknown, { kind: 'mark_unknown', reason: 'disconnect' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(executed, projected, { kind: 'projection_completed' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(reserved, cancelled, { kind: 'predispatch_cancelled' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(executing, notExecuted, { kind: 'executor_outcome', outcome: 'not_executed' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(executing, notExecuted, { kind: 'executor_outcome', outcome: 'not_executed' }, commit)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(executing, notExecuted, { kind: 'executor_outcome', outcome: 'not_executed' }, unrelatedCommit)).toMatchObject({ ok: false });
    expect(validateReceiptTransition(executing, unknown, { kind: 'mark_unknown', reason: 'timeout' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(unknown, escalated, { kind: 'escalation_raised' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(escalated, acknowledged, { kind: 'escalation_acknowledged' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(unknown, reconciledExecuted, { kind: 'reconcile_outcome', outcome: 'executed' }, commit)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(unknown, reconciledNotExecuted, { kind: 'reconcile_outcome', outcome: 'not_executed' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(unknown, reconciledNotExecuted, { kind: 'reconcile_outcome', outcome: 'not_executed' }, commit)).toMatchObject({ ok: true });
    expect(validateReceiptTransition(unknown, reconciledNotExecuted, { kind: 'reconcile_outcome', outcome: 'not_executed' }, unrelatedCommit)).toMatchObject({ ok: false });
    const reconciledExecutedAck = { ...reconciledExecuted, revision: 6, escalation: { state: 'acknowledged' as const, owner: 'ops', reasonCode: 'timeout', raisedAt: 31 } };
    const recExecutedEscalated = { ...reconciledExecuted, revision: 5, escalation: { state: 'required' as const, owner: 'ops', reasonCode: 'timeout', raisedAt: 31 } };
    const recNotExecutedAck = { ...reconciledNotExecuted, revision: 6, escalation: { state: 'acknowledged' as const, owner: 'ops', reasonCode: 'timeout', raisedAt: 31 } };
    const recNotExecutedEscalated = { ...reconciledNotExecuted, revision: 5, escalation: { state: 'required' as const, owner: 'ops', reasonCode: 'timeout', raisedAt: 31 } };
    expect(validateReceiptTransition(recExecutedEscalated, reconciledExecutedAck, { kind: 'escalation_acknowledged' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(reconciledExecuted, recExecutedEscalated, { kind: 'escalation_raised' })).toMatchObject({ ok: false });
    expect(validateReceiptTransition(reconciledNotExecuted, recNotExecutedEscalated, { kind: 'escalation_raised' })).toMatchObject({ ok: false });
    expect(validateReceiptTransition(recNotExecutedEscalated, recNotExecutedAck, { kind: 'escalation_acknowledged' })).toMatchObject({ ok: true });
    expect(validateReceiptTransition(recExecutedEscalated, { ...reconciledExecutedAck, postExecutionProjection: 'complete', revision: 6 }, { kind: 'escalation_acknowledged' })).toMatchObject({ ok: false });
    for (const event of [{ kind: 'execution_started' }, { kind: 'projection_completed' }, { kind: 'escalation_acknowledged' }, { kind: 'executor_outcome', outcome: 'not_executed' }]) {
      expect(validateReceiptTransition(reserved, dispatching, event as any)).toMatchObject({ ok: false });
    }
    expect(validateReceiptTransition(dispatching, executing, { kind: 'execution_started', extra: true })).toMatchObject({ ok: false });
    expect(validateReceiptTransition(dispatching, { ...executing, revision: 4 }, { kind: 'execution_started' })).toMatchObject({ ok: false });
    expect(validateReceiptTransition(executing, { ...executed, executorRequestRef: 'executor-2' }, { kind: 'executor_outcome', outcome: 'executed' }, commit)).toMatchObject({ ok: false });
    expect(ActionExecutionReceiptV1Schema.safeParse({ ...reserved, status: 'dispatching', postExecutionProjection: 'pending', executorRequestRef: 'executor-1' }).success).toBe(false);
    for (const state of ['reserved', 'dispatching', 'executing', 'not_executed', 'execution_unknown', 'reconciled_not_executed'] as const) {
      expect(ActionExecutionReceiptV1Schema.safeParse({ ...reserved, status: state, postExecutionProjection: 'pending', ...(state !== 'reserved' ? { executorRequestRef: 'executor-1' } : {}) }).success).toBe(false);
    }
    expect(ActionExecutionReceiptV1Schema.safeParse({ ...reserved, status: 'execution_unknown', executorRequestRef: 'executor-1', escalation: { state: 'required', owner: 'ops', reasonCode: 'timeout', raisedAt: 1 } }).success).toBe(true);
    for (const event of [
      { kind: 'dispatch_persisted' }, { kind: 'execution_started' }, { kind: 'predispatch_cancelled' }, { kind: 'executor_outcome', outcome: 'executed' },
      { kind: 'executor_outcome', outcome: 'not_executed' }, { kind: 'mark_unknown', reason: 'timeout' }, { kind: 'reconcile_outcome', outcome: 'executed' },
      { kind: 'reconcile_outcome', outcome: 'not_executed' }, { kind: 'projection_completed' }, { kind: 'escalation_raised' }, { kind: 'escalation_acknowledged' },
    ]) expect(A2A_RECEIPT_TRANSITION_EVENT_SCHEMA.safeParse({ ...event, extra: true }).success).toBe(false);
  });

  test('every adjacent link rejects fully rehashed field and route swaps', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const reserved = makeReceipt(commit);
    const recordValue: any = { schemaVersion: 1, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target], routeVersion: 4, status: 'active', revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    const record: any = { ...recordValue, idempotencyHash: deriveConversationIdempotencyHash(recordValue) };
    expect(validateAttemptRouteForAdmission(attempt, record)).toMatchObject({ ok: true });
    const alternateTarget = { worldId: 'world', worldEpoch: 1, npcId: 'charlie', instanceId: 'charlie-1', instanceEpoch: 1 };
    const alternateConversation = { conversationId: deriveConversationId('root', subject, alternateTarget), pairKey: derivePairKey(subject, alternateTarget), causalRootId: 'root' };
    const swappedRouteAttempt: any = { ...attempt, conversationRoute: { conversation: alternateConversation, target: alternateTarget, routeVersion: 4, expiresAt: 100 }, idempotencyHash: '' }; swappedRouteAttempt.idempotencyHash = deriveAttemptIdempotencyHash(swappedRouteAttempt);
    expect(validateAttemptRouteForAdmission(swappedRouteAttempt, record)).toMatchObject({ ok: false });
    for (const change of [
      { attemptId: deriveAttemptId(target, 'other', 3), proposalId: deriveProposalId(deriveAttemptId(target, 'other', 3)), subject: target },
      { subject: target }, { observedSnapshotVersion: 'other-snapshot' },
    ]) {
      const changed: any = { ...proposal, ...change, proposalHash: '' }; changed.proposalHash = deriveProposalHash(changed);
      expect(validateProposalAgainstAttempt(changed, attempt)).toMatchObject({ ok: false });
    }
    const actionProposal: any = { ...proposal, actionKind: 'other-action', proposalHash: '' }; actionProposal.proposalHash = deriveProposalHash(actionProposal);
    const changedActionCommit: any = { ...commit, actionKind: 'other-action', proposalHash: actionProposal.proposalHash, recordHash: '' }; changedActionCommit.recordHash = deriveActionCommitRecordHash(changedActionCommit);
    expect(validateCommitAgainstAttemptAndProposal(changedActionCommit, attempt, proposal)).toMatchObject({ ok: false });
    const changedConflicts: any = { ...commit, conflictKeys: ['other'], reservedConflictEpochs: { other: 1 }, recordHash: '' }; changedConflicts.recordHash = deriveActionCommitRecordHash(changedConflicts);
    expect(validateCommitAgainstAttemptAndProposal(changedConflicts, attempt, proposal)).toMatchObject({ ok: false });
    const changedSpeech: any = { ...commit, speech: { ...commit.speech, routeVersion: 9 }, recordHash: '' }; changedSpeech.recordHash = deriveActionCommitRecordHash(changedSpeech);
    expect(validateCommitAgainstAttemptAndProposal(changedSpeech, attempt, proposal)).toMatchObject({ ok: false });
    for (const change of [{ actionCommitRecordHash: 'sha256:' + '1'.repeat(64) }, { subject: target }, { conflictKeys: ['other'], reservedConflictEpochs: { other: 1 } }]) {
      const changed: any = { ...reserved, ...change, immutableIdentityHash: '' }; changed.immutableIdentityHash = deriveReceiptImmutableIdentityHash(changed);
      expect(validateReceiptAgainstCommit(changed, commit)).toMatchObject({ ok: false });
    }
    const event: any = { schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation, worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId, routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '' }; event.idempotencyHash = deriveEventIdempotencyHash(event);
    const executed: any = { ...reserved, status: 'executed', revision: 1, executorRequestRef: 'request', completedAt: 20, actionCommitSeq: 1, postExecutionProjection: 'pending' }; executed.immutableIdentityHash = deriveReceiptImmutableIdentityHash(executed);
    for (const change of [{ sourceAttemptId: deriveAttemptId(target, 'other', 1) }, { routeVersion: 9 }, { publicText: 'changed' }]) {
      const changed: any = { ...event, ...change, idempotencyHash: '' }; changed.idempotencyHash = deriveEventIdempotencyHash(changed);
      expect(validateEventAgainstCommitAndReceipt(changed, commit, executed)).toMatchObject({ ok: false });
    }
    const delivery: any = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target, targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, target)), status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 1 }; delivery.idempotencyHash = deriveDeliveryIdempotencyHash(delivery);
    const swappedDelivery: any = { ...delivery, target: subject, deliveryId: deriveDeliveryId(event.eventId, subject), targetTriggerId: '', idempotencyHash: '' }; swappedDelivery.targetTriggerId = deriveTargetTriggerId(swappedDelivery.deliveryId); swappedDelivery.idempotencyHash = deriveDeliveryIdempotencyHash(swappedDelivery);
    expect(validateDeliveryAgainstEvent(swappedDelivery, event)).toMatchObject({ ok: false });
    const alternateEventId = deriveEventId(deriveActionCommitId(deriveAttemptId(target, 'other', 1)));
    const changedDelivery: any = { ...delivery, eventId: alternateEventId, deliveryId: deriveDeliveryId(alternateEventId, target), targetTriggerId: '', idempotencyHash: '' }; changedDelivery.targetTriggerId = deriveTargetTriggerId(changedDelivery.deliveryId); changedDelivery.idempotencyHash = deriveDeliveryIdempotencyHash(changedDelivery);
    expect(validateDeliveryAgainstEvent(changedDelivery, event)).toMatchObject({ ok: false });
  });

  test('delivery transition matrix covers retry, admission, terminal, and time invariants', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const event: any = { schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation, worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId, routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '' }; event.idempotencyHash = deriveEventIdempotencyHash(event);
    const base: ConversationDeliveryV1 = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target, targetTriggerId: '', status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 1 }; base.targetTriggerId = deriveTargetTriggerId(base.deliveryId); base.idempotencyHash = deriveDeliveryIdempotencyHash(base);
    const dispatching = { ...base, status: 'dispatching' as const, revision: 1, updatedAt: 2 };
    const retried = { ...dispatching, revision: 2, updatedAt: 3 };
    const admitted = { ...retried, status: 'admitted' as const, revision: 3, updatedAt: 4, targetAttemptId: attempt.attemptId };
    const consumed = { ...admitted, status: 'consumed' as const, revision: 4, updatedAt: 5 };
    const rejected = { ...dispatching, status: 'rejected' as const, revision: 2, updatedAt: 3 };
    const expired = { ...base, status: 'expired' as const, revision: 1, updatedAt: 2 };
    expect(validateDeliveryTransition(base, base)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(base, dispatching)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(dispatching, retried)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(retried, admitted)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(admitted, consumed)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(dispatching, rejected)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(base, expired)).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(dispatching, { ...dispatching, status: 'expired', revision: 2, updatedAt: 3 })).toMatchObject({ ok: true });
    expect(validateDeliveryTransition(base, { ...dispatching, revision: 3 })).toMatchObject({ ok: false });
    expect(validateDeliveryTransition(dispatching, { ...retried, updatedAt: 1 })).toMatchObject({ ok: false });
    expect(validateDeliveryTransition(rejected, { ...rejected, revision: 3, status: 'dispatching' })).toMatchObject({ ok: false });
    expect(validateDeliveryTransition(admitted, { ...consumed, targetAttemptId: deriveAttemptId(target, 'other', 1) })).toMatchObject({ ok: false });
  });

  test('conversation transition matrix enforces active progression, terminal states, counters, and CAS', () => {
    const value: any = { schemaVersion: 1, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target], routeVersion: 4, status: 'active', revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    value.idempotencyHash = deriveConversationIdempotencyHash(value);
    const active = { ...value, revision: 1, counters: { turns: 1, causalDepth: 1, modelCalls: 1 } };
    const expired = { ...value, status: 'expired', revision: 1 };
    const closed = { ...value, status: 'closed', revision: 1 };
    expect(validateConversationTransition(value, active)).toMatchObject({ ok: true });
    expect(validateConversationTransition(value, expired)).toMatchObject({ ok: true });
    expect(validateConversationTransition(value, closed)).toMatchObject({ ok: true });
    expect(validateConversationTransition(value, { ...value, revision: 0, counters: { turns: 1, causalDepth: 0, modelCalls: 0 } })).toMatchObject({ ok: false });
    expect(validateConversationTransition(value, { ...value, revision: 1, counters: { turns: 0, causalDepth: 0, modelCalls: 7 } })).toMatchObject({ ok: false });
    expect(validateConversationTransition(value, { ...value, revision: 2 })).toMatchObject({ ok: false });
    expect(validateConversationTransition(value, { ...value, status: 'closed', revision: 0 })).toMatchObject({ ok: false });
    expect(validateConversationTransition(closed, { ...closed, revision: 2, status: 'active' })).toMatchObject({ ok: false });
    expect(validateConversationTransition(expired, { ...expired, revision: 2, status: 'expired' })).toMatchObject({ ok: false });
    expect(validateConversationTransition(value, { ...value, revision: 1, counters: { turns: 0, causalDepth: 0, modelCalls: 0 }, expiresAt: 99 })).toMatchObject({ ok: false });
  });

  test('hash projections freeze include/exclude boundaries', () => {
    const attempt = makeAttempt(); const proposal = makeProposal(attempt); const commit = makeCommit(attempt, proposal); const receipt = makeReceipt(commit);
    expect(deriveAttemptIdempotencyHash({ ...attempt, attemptId: deriveAttemptId(target, 'other', 1) })).toBe(deriveAttemptIdempotencyHash(attempt));
    expect(deriveAttemptIdempotencyHash({ ...attempt, priorityClass: 'urgent' })).not.toBe(attempt.idempotencyHash);
    expect(deriveProposalHash({ ...proposal, proposalId: deriveProposalId(deriveAttemptId(target, 'other', 1)) })).toBe(proposal.proposalHash);
    expect(deriveProposalHash({ ...(proposal as any), payload: { changed: true } } as any)).not.toBe(proposal.proposalHash);
    const recordValue: any = { schemaVersion: 1, conversation, worldId: 'world', worldEpoch: 1, participants: [subject, target], routeVersion: 4, status: 'active', revision: 0, createdAt: 0, expiresAt: 100, counters: { turns: 0, causalDepth: 0, modelCalls: 0 } };
    const record: any = { ...recordValue, idempotencyHash: deriveConversationIdempotencyHash(recordValue) };
    expect(deriveConversationIdempotencyHash({ ...record, status: 'closed', revision: 4, counters: { turns: 1, causalDepth: 1, modelCalls: 1 } })).toBe(record.idempotencyHash);
    expect(deriveConversationIdempotencyHash({ ...record, createdAt: 1 })).not.toBe(record.idempotencyHash);
    expect(deriveActionCommitRecordHash({ ...commit, actionCommitId: deriveActionCommitId(attempt.attemptId) })).toBe(commit.recordHash);
    expect(deriveActionCommitRecordHash({ ...commit, createdAt: 13 })).not.toBe(commit.recordHash);
    expect(deriveReceiptImmutableIdentityHash({ ...receipt, revision: 3, status: 'reserved' })).toBe(receipt.immutableIdentityHash);
    const event: any = { schemaVersion: 1, eventId: deriveEventId(commit.actionCommitId), utteranceId: deriveUtteranceId(commit.actionCommitId), conversation, worldId: 'world', worldEpoch: 1, speaker: subject, target, sourceAttemptId: attempt.attemptId, parentActionCommitId: commit.actionCommitId, routeVersion: 4, createdAt: 20, expiresAt: 100, publicText: 'hello', idempotencyHash: '' }; event.idempotencyHash = deriveEventIdempotencyHash(event);
    expect(deriveEventIdempotencyHash({ ...event, eventId: deriveEventId(commit.actionCommitId) })).toBe(event.idempotencyHash);
    expect(deriveEventIdempotencyHash({ ...event, publicText: 'changed' })).not.toBe(event.idempotencyHash);
    const delivery: any = { schemaVersion: 1, deliveryId: deriveDeliveryId(event.eventId, target), eventId: event.eventId, target, targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, target)), status: 'pending', idempotencyHash: '', revision: 0, updatedAt: 1 }; delivery.idempotencyHash = deriveDeliveryIdempotencyHash(delivery);
    expect(deriveDeliveryIdempotencyHash({ ...delivery, status: 'dispatching', revision: 2 })).toBe(delivery.idempotencyHash);
    const mutations: Array<[string, any, (v: any) => string]> = [
      ['attempt.triggerId', { triggerId: 'other' }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.triggerSeq', { triggerSeq: 4 }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.subject', { subject: target }, (v) => deriveAttemptIdempotencyHash(v)],
      ['attempt.route', { conversationRoute: { ...attempt.conversationRoute, routeVersion: 5 } }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.source', { sourceConversationEventId: deriveEventId(commit.actionCommitId) }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.priority', { priorityClass: 'urgent' }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.snapshot', { snapshotVersion: 'other-snapshot' }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.actions', { allowedActionKinds: ['act'] }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.conflicts', { admittedConflictKeys: ['other'], baseConflictEpochs: { other: 1 } }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.admittedAt', { admittedAt: 11 }, (v) => deriveAttemptIdempotencyHash(v)], ['attempt.deadlineAt', { deadlineAt: 91 }, (v) => deriveAttemptIdempotencyHash(v)],
      ['proposal.schema', { schemaVersion: 2 }, (v) => deriveProposalHash(v)], ['proposal.attempt', { attemptId: otherAttemptId(attempt) }, (v) => deriveProposalHash(v)], ['proposal.subject', { subject: target }, (v) => deriveProposalHash(v)], ['proposal.snapshot', { observedSnapshotVersion: 'other-snapshot' }, (v) => deriveProposalHash(v)], ['proposal.completed', { completedAt: 12 }, (v) => deriveProposalHash(v)], ['proposal.disposition', { disposition: 'no_action', reasonCode: 'busy' }, (v) => deriveProposalHash(v)], ['proposal.actionKind', { actionKind: 'act' }, (v) => deriveProposalHash(v)], ['proposal.payload', { payload: { changed: true } }, (v) => deriveProposalHash(v)], ['proposal.draft', { draftUtterance: 'changed' }, (v) => deriveProposalHash(v)], ['proposal.emotion', { candidateEmotion: { mood: 'calm' } }, (v) => deriveProposalHash(v)],
      ['conversation.schema', { schemaVersion: 2 }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.ref', { conversation: { ...conversation, causalRootId: 'other-root' } }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.world', { worldId: 'other-world' }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.epoch', { worldEpoch: 2 }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.participants', { participants: [target, subject] }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.routeVersion', { routeVersion: 5 }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.created', { createdAt: 1 }, (v) => deriveConversationIdempotencyHash(v)], ['conversation.expires', { expiresAt: 101 }, (v) => deriveConversationIdempotencyHash(v)],
      ['commit.schema', { schemaVersion: 2 }, (v) => deriveActionCommitRecordHash(v)], ['commit.attempt', { attemptId: otherAttemptId(attempt) }, (v) => deriveActionCommitRecordHash(v)], ['commit.subject', { subject: target }, (v) => deriveActionCommitRecordHash(v)], ['commit.actionKind', { actionKind: 'act' }, (v) => deriveActionCommitRecordHash(v)], ['commit.arguments', { canonicalArguments: { changed: true } }, (v) => deriveActionCommitRecordHash(v)], ['commit.argumentsHash', { argumentsHash: deriveArgumentsHash({ changed: true }) }, (v) => deriveActionCommitRecordHash(v)], ['commit.proposalHash', { proposalHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveActionCommitRecordHash(v)], ['commit.snapshot', { acceptedSnapshotVersion: 'other-snapshot' }, (v) => deriveActionCommitRecordHash(v)], ['commit.conflicts', { conflictKeys: ['other'], reservedConflictEpochs: { other: 1 } }, (v) => deriveActionCommitRecordHash(v)], ['commit.speech', { speech: { ...commit.speech, routeVersion: 5 } }, (v) => deriveActionCommitRecordHash(v)], ['commit.effect', { trustedEffectInput: { schemaVersion: 1, effectRef: 'effect-1' } }, (v) => deriveActionCommitRecordHash(v)], ['commit.created', { createdAt: 13 }, (v) => deriveActionCommitRecordHash(v)],
      ['receipt.schema', { schemaVersion: 2 }, (v) => deriveReceiptImmutableIdentityHash(v)], ['receipt.commitId', { actionCommitId: deriveActionCommitId(otherAttemptId(attempt)) }, (v) => deriveReceiptImmutableIdentityHash(v)], ['receipt.commitHash', { actionCommitRecordHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveReceiptImmutableIdentityHash(v)], ['receipt.attempt', { attemptId: otherAttemptId(attempt) }, (v) => deriveReceiptImmutableIdentityHash(v)], ['receipt.subject', { subject: target }, (v) => deriveReceiptImmutableIdentityHash(v)], ['receipt.conflicts', { conflictKeys: ['other'], reservedConflictEpochs: { other: 1 } }, (v) => deriveReceiptImmutableIdentityHash(v)],
      ['event.schema', { schemaVersion: 2 }, (v) => deriveEventIdempotencyHash(v)], ['event.utterance', { utteranceId: deriveUtteranceId(deriveActionCommitId(otherAttemptId(attempt))) }, (v) => deriveEventIdempotencyHash(v)], ['event.conversation', { conversation: { ...conversation, causalRootId: 'other-root' } }, (v) => deriveEventIdempotencyHash(v)], ['event.world', { worldId: 'other-world' }, (v) => deriveEventIdempotencyHash(v)], ['event.epoch', { worldEpoch: 2 }, (v) => deriveEventIdempotencyHash(v)], ['event.speaker', { speaker: target }, (v) => deriveEventIdempotencyHash(v)], ['event.target', { target: subject }, (v) => deriveEventIdempotencyHash(v)], ['event.sourceAttempt', { sourceAttemptId: otherAttemptId(attempt) }, (v) => deriveEventIdempotencyHash(v)], ['event.parentCommit', { parentActionCommitId: deriveActionCommitId(otherAttemptId(attempt)) }, (v) => deriveEventIdempotencyHash(v)], ['event.reply', { inReplyToUtteranceId: deriveUtteranceId(deriveActionCommitId(otherAttemptId(attempt))) }, (v) => deriveEventIdempotencyHash(v)], ['event.routeVersion', { routeVersion: 5 }, (v) => deriveEventIdempotencyHash(v)], ['event.created', { createdAt: 21 }, (v) => deriveEventIdempotencyHash(v)], ['event.expires', { expiresAt: 101 }, (v) => deriveEventIdempotencyHash(v)], ['event.text', { publicText: 'changed' }, (v) => deriveEventIdempotencyHash(v)],
      ['delivery.schema', { schemaVersion: 2 }, (v) => deriveDeliveryIdempotencyHash(v)], ['delivery.event', { eventId: deriveEventId(deriveActionCommitId(otherAttemptId(attempt))) }, (v) => deriveDeliveryIdempotencyHash(v)], ['delivery.target', { target: subject }, (v) => deriveDeliveryIdempotencyHash(v)], ['delivery.trigger', { targetTriggerId: deriveTargetTriggerId(deriveDeliveryId(event.eventId, subject)) }, (v) => deriveDeliveryIdempotencyHash(v)],
    ];
    for (const [name, change, hashOf] of mutations) {
      const base = name.startsWith('attempt.') ? attempt : name.startsWith('proposal.') ? proposal : name.startsWith('conversation.') ? record : name.startsWith('commit.') ? commit : name.startsWith('receipt.') ? receipt : name.startsWith('event.') ? event : delivery;
      expect(hashOf({ ...base, ...change }), name).not.toBe(hashOf(base));
    }
    const excluded: Array<[string, any, (v: any) => string, any]> = [
      ['attempt.attemptId', { attemptId: otherAttemptId(attempt) }, (v) => deriveAttemptIdempotencyHash(v), attempt],
      ['attempt.idempotencyHash', { idempotencyHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveAttemptIdempotencyHash(v), attempt], ['proposal.proposalId', { proposalId: deriveProposalId(otherAttemptId(attempt)) }, (v) => deriveProposalHash(v), proposal], ['proposal.proposalHash', { proposalHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveProposalHash(v), proposal],
      ['conversation.status', { status: 'closed' }, (v) => deriveConversationIdempotencyHash(v), record], ['conversation.revision', { revision: 4 }, (v) => deriveConversationIdempotencyHash(v), record], ['conversation.counters', { counters: { turns: 1, causalDepth: 1, modelCalls: 1 } }, (v) => deriveConversationIdempotencyHash(v), record], ['conversation.idempotencyHash', { idempotencyHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveConversationIdempotencyHash(v), record],
      ['commit.actionCommitId', { actionCommitId: deriveActionCommitId(otherAttemptId(attempt)) }, (v) => deriveActionCommitRecordHash(v), commit], ['commit.recordHash', { recordHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveActionCommitRecordHash(v), commit],
      ['receipt.immutableIdentityHash', { immutableIdentityHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.revision', { revision: 4 }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.actionCommitSeq', { actionCommitSeq: 1 }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.status', { status: 'dispatching' }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.projection', { postExecutionProjection: 'pending' }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.executor', { executorRequestRef: 'executor-1' }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.world', { authoritativeWorldVersion: 'world-v2' }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.completed', { completedAt: 22 }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.reconciliation', { reconciliation: { source: 'probe', reconciledAt: 22 } }, (v) => deriveReceiptImmutableIdentityHash(v), receipt], ['receipt.escalation', { escalation: { state: 'required', owner: 'ops', reasonCode: 'timeout', raisedAt: 22 } }, (v) => deriveReceiptImmutableIdentityHash(v), receipt],
      ['event.eventId', { eventId: deriveEventId(deriveActionCommitId(otherAttemptId(attempt))) }, (v) => deriveEventIdempotencyHash(v), event], ['event.idempotencyHash', { idempotencyHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveEventIdempotencyHash(v), event],
      ['delivery.deliveryId', { deliveryId: deriveDeliveryId(event.eventId, subject) }, (v) => deriveDeliveryIdempotencyHash(v), delivery], ['delivery.idempotencyHash', { idempotencyHash: 'sha256:' + '1'.repeat(64) }, (v) => deriveDeliveryIdempotencyHash(v), delivery], ['delivery.status', { status: 'dispatching' }, (v) => deriveDeliveryIdempotencyHash(v), delivery], ['delivery.targetAttemptId', { targetAttemptId: attempt.attemptId }, (v) => deriveDeliveryIdempotencyHash(v), delivery], ['delivery.revision', { revision: 4 }, (v) => deriveDeliveryIdempotencyHash(v), delivery], ['delivery.updatedAt', { updatedAt: 9 }, (v) => deriveDeliveryIdempotencyHash(v), delivery],
    ];
    for (const [name, change, hashOf, base] of excluded) expect(hashOf({ ...base, ...change }), name).toBe(hashOf(base));
    const noAction: any = { schemaVersion: 1, attemptId: attempt.attemptId, proposalId: proposal.proposalId, subject, observedSnapshotVersion: attempt.snapshotVersion, disposition: 'no_action', reasonCode: 'busy', completedAt: 11 };
    const noActionHash = deriveProposalHash(noAction);
    expect(deriveProposalHash({ ...noAction, reasonCode: 'other-reason' })).not.toBe(noActionHash);
    function otherAttemptId(a: NpcActionAttemptV1): string { return deriveAttemptId(target, 'other', a.triggerSeq); }
  });
});
