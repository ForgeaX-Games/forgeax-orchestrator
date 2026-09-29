import { createHash } from 'node:crypto';
import { z, type SafeParseReturnType, type ZodIssue } from 'zod';

/** The versioned canonical encoding used by all private digital-life A2A records. */
export const FORGEAX_A2A_CANONICAL_JSON_VERSION = 'forgeax.digital-life.a2a.canonical-json/v1';
export const A2A_CANONICAL_JSON_VERSION = FORGEAX_A2A_CANONICAL_JSON_VERSION;
export const FORGEAX_A2A_ATTEMPT_HASH_NAMESPACE = 'forgeax.digital-life.a2a.attempt-hash/v1';
export const FORGEAX_A2A_PROPOSAL_HASH_NAMESPACE = 'forgeax.digital-life.a2a.proposal-hash/v1';
export const FORGEAX_A2A_CONVERSATION_RECORD_HASH_NAMESPACE = 'forgeax.digital-life.a2a.conversation-record-hash/v1';
export const FORGEAX_A2A_ARGUMENTS_HASH_NAMESPACE = 'forgeax.digital-life.a2a.arguments-hash/v1';
export const FORGEAX_A2A_ACTION_COMMIT_RECORD_HASH_NAMESPACE = 'forgeax.digital-life.a2a.action-commit-record-hash/v1';
export const FORGEAX_A2A_RECEIPT_IDENTITY_HASH_NAMESPACE = 'forgeax.digital-life.a2a.receipt-identity-hash/v1';
export const FORGEAX_A2A_CONVERSATION_EVENT_HASH_NAMESPACE = 'forgeax.digital-life.a2a.conversation-event-hash/v1';
export const FORGEAX_A2A_DELIVERY_HASH_NAMESPACE = 'forgeax.digital-life.a2a.delivery-hash/v1';

const SCHEMA_VERSION = 1 as const;
const GENERATED_KINDS = ['pair', 'conversation', 'attempt', 'proposal', 'action-commit', 'event', 'utterance', 'delivery', 'target-trigger'] as const;
type GeneratedKind = typeof GENERATED_KINDS[number];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATED_PATTERN = /^fxdl:v1:(pair|conversation|attempt|proposal|action-commit|event|utterance|delivery|target-trigger):[0-9a-f]{64}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function isScalarString(value: unknown, nonEmpty = false): value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0) || value !== value.normalize('NFC')) return false;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
  }
  return true;
}

function isOpaqueRef(value: unknown): value is string {
  if (!isScalarString(value, true) || [...value].length > 256) return false;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) return false;
  }
  return true;
}

const opaqueRef = z.custom<string>(isOpaqueRef, 'expected a non-empty NFC scalar reference');
const textValue = z.custom<string>((v) => isScalarString(v), 'expected an NFC Unicode scalar string');
const protocolId = z.custom<string>((v) => typeof v === 'string' && isScalarString(v) && ID_PATTERN.test(v) && !v.includes('..') && !v.includes('/') && !v.includes('\\'), 'invalid protocol id');
const generatedIdSchema = (kind: GeneratedKind) => z.custom<string>((v) => typeof v === 'string' && GENERATED_PATTERN.test(v) && v.startsWith(`fxdl:v1:${kind}:`), `invalid ${kind} id`);
const hash = z.string().regex(HASH_PATTERN);
const nonNegativeSafeInt = z.number().refine((n) => Number.isSafeInteger(n) && n >= 0, 'expected a non-negative safe integer');
const canonicalJson = z.custom<CanonicalJson>(isCanonicalJson, 'expected canonical JSON data');
const actionKind = protocolId;
export const ProtocolIdV1Schema = protocolId;
export const OpaqueRefV1Schema = opaqueRef;
export const CanonicalJsonSchema = canonicalJson;
export type ProtocolIdV1 = z.infer<typeof ProtocolIdV1Schema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isCanonicalJson(value: unknown, seen = new Set<object>()): value is CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value === null || typeof value !== 'string' || isScalarString(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes('length') || Object.getOwnPropertySymbols(value).length > 0) return false;
      for (const key in value) if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !('value' in d) || !d.enumerable || !isCanonicalJson(d.value, seen)) return false;
      }
      return true;
    }
    if (!isPlainObject(value)) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    for (const key in value) if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
    for (const key of Object.getOwnPropertyNames(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || !('value' in d) || !isScalarString(key) || !isCanonicalJson(d.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function compareCodePoints(a: string, b: string): number {
  const aa = [...a].map((x) => x.codePointAt(0)!);
  const bb = [...b].map((x) => x.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}

function encodeCanonical(value: CanonicalJson, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value === 0 ? 0 : value);
  if (seen.has(value as object)) throw new TypeError('canonical JSON cannot contain cycles');
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) items.push(encodeCanonical(value[i]!, seen));
      return `[${items.join(',')}]`;
    }
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeCanonical((value as Record<string, CanonicalJson>)[key]!, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value as object);
  }
}

/** Encode JSON data with the protocol's strict, deterministic rules. */
export function canonicalizeA2aJson(value: unknown): string {
  if (!isCanonicalJson(value)) throw new TypeError('value is not canonical JSON');
  return encodeCanonical(value);
}

export const canonicalJsonStringify = canonicalizeA2aJson;

export function hashCanonicalA2aValue(namespace: string, value: unknown): string {
  if (!isScalarString(namespace, true)) throw new TypeError('invalid hash namespace');
  const bytes = Buffer.from(canonicalizeA2aJson({ namespace, value: value as CanonicalJson }), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function generatedId(kind: GeneratedKind, parts: readonly CanonicalJson[]): string {
  const namespace = `forgeax.digital-life.a2a.${kind}/v1`;
  const digest = createHash('sha256').update(Buffer.from(canonicalizeA2aJson({ namespace, parts }), 'utf8')).digest('hex');
  return `fxdl:v1:${kind}:${digest}`;
}

export const NpcInstanceRefV1Schema = z.object({
  worldId: protocolId, worldEpoch: nonNegativeSafeInt, npcId: protocolId, instanceId: protocolId, instanceEpoch: nonNegativeSafeInt,
}).strict();
export type NpcInstanceRefV1 = z.infer<typeof NpcInstanceRefV1Schema>;

export const ConversationRefV1Schema = z.object({ conversationId: generatedIdSchema('conversation'), pairKey: generatedIdSchema('pair'), causalRootId: protocolId }).strict();
export type ConversationRefV1 = z.infer<typeof ConversationRefV1Schema>;

const routeSchema = z.object({ conversation: ConversationRefV1Schema, target: NpcInstanceRefV1Schema, routeVersion: nonNegativeSafeInt, expiresAt: nonNegativeSafeInt }).strict();
const epochMap = z.record(nonNegativeSafeInt).refine((m) => Object.keys(m).every((k) => protocolId.safeParse(k).success), 'invalid conflict epoch key');
const setIds = z.array(protocolId).superRefine((values, ctx) => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set-like array contains duplicate' });
    seen.add(value);
  }
  if ([...values].sort(compareCodePoints).some((v, i) => v !== values[i])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set-like array is not code-point sorted' });
});

const conversationRecordBaseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), conversation: ConversationRefV1Schema, worldId: protocolId, worldEpoch: nonNegativeSafeInt,
  participants: z.tuple([NpcInstanceRefV1Schema, NpcInstanceRefV1Schema]), routeVersion: nonNegativeSafeInt,
  status: z.enum(['active', 'closed', 'expired']), revision: nonNegativeSafeInt, createdAt: nonNegativeSafeInt, expiresAt: nonNegativeSafeInt,
  idempotencyHash: hash, counters: z.object({ turns: nonNegativeSafeInt, causalDepth: nonNegativeSafeInt, modelCalls: nonNegativeSafeInt }).strict(),
}).strict();
export type ConversationRecordV1 = z.infer<typeof ConversationRecordV1Schema>;

const npcActionAttemptBaseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), attemptId: generatedIdSchema('attempt'), triggerId: protocolId, triggerSeq: nonNegativeSafeInt,
  subject: NpcInstanceRefV1Schema, conversationRoute: routeSchema.optional(), sourceConversationEventId: generatedIdSchema('event').optional(),
  priorityClass: z.enum(['urgent', 'normal', 'speech']), snapshotVersion: protocolId, allowedActionKinds: setIds,
  admittedConflictKeys: setIds, baseConflictEpochs: epochMap, admittedAt: nonNegativeSafeInt, deadlineAt: nonNegativeSafeInt, idempotencyHash: hash,
}).strict();
export type NpcActionAttemptV1 = z.infer<typeof npcActionAttemptBaseSchema>;

const proposalCommon = { schemaVersion: z.literal(SCHEMA_VERSION), attemptId: generatedIdSchema('attempt'), proposalId: generatedIdSchema('proposal'), subject: NpcInstanceRefV1Schema, observedSnapshotVersion: protocolId, proposalHash: hash, completedAt: nonNegativeSafeInt };
const npcActionProposalBaseSchema = z.union([
  z.object({ ...proposalCommon, disposition: z.literal('action'), actionKind, payload: canonicalJson, draftUtterance: textValue.optional(), candidateEmotion: canonicalJson.optional() }).strict(),
  z.object({ ...proposalCommon, disposition: z.literal('no_action'), reasonCode: protocolId }).strict(),
]);
export type NpcActionProposalV1 = z.infer<typeof npcActionProposalBaseSchema>;

const speechSchema = z.object({ conversation: ConversationRefV1Schema, target: NpcInstanceRefV1Schema, routeVersion: nonNegativeSafeInt, expiresAt: nonNegativeSafeInt, inReplyToUtteranceId: generatedIdSchema('utterance').optional(), normalizedPublicText: textValue }).strict();
const trustedEffectInputSchema = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), effectRef: opaqueRef.optional(), canonicalFacts: z.array(canonicalJson).optional() }).strict();
const actionCommitRecordBaseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), actionCommitId: generatedIdSchema('action-commit'), attemptId: generatedIdSchema('attempt'), subject: NpcInstanceRefV1Schema,
  actionKind, canonicalArguments: canonicalJson, argumentsHash: hash, proposalHash: hash, acceptedSnapshotVersion: protocolId,
  conflictKeys: setIds, reservedConflictEpochs: epochMap, speech: speechSchema.optional(), trustedEffectInput: trustedEffectInputSchema.optional(), createdAt: nonNegativeSafeInt, recordHash: hash,
}).strict();
export type ActionCommitRecordV1 = z.infer<typeof actionCommitRecordBaseSchema>;

export const ActionExecutionStatusV1Schema = z.enum(['reserved', 'dispatching', 'executing', 'executed', 'not_executed', 'execution_unknown', 'reconciled_executed', 'reconciled_not_executed']);
export type ActionExecutionStatusV1 = z.infer<typeof ActionExecutionStatusV1Schema>;
const reconciliationSchema = z.object({ source: opaqueRef, evidenceRef: opaqueRef.optional(), reconciledAt: nonNegativeSafeInt }).strict();
const escalationSchema = z.object({ state: z.enum(['required', 'acknowledged']), owner: opaqueRef, reasonCode: protocolId, raisedAt: nonNegativeSafeInt }).strict();
const actionExecutionReceiptBaseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), actionCommitId: generatedIdSchema('action-commit'), actionCommitRecordHash: hash, immutableIdentityHash: hash,
  revision: nonNegativeSafeInt, actionCommitSeq: nonNegativeSafeInt.optional(), attemptId: generatedIdSchema('attempt'), subject: NpcInstanceRefV1Schema,
  conflictKeys: setIds, reservedConflictEpochs: epochMap, status: ActionExecutionStatusV1Schema,
  postExecutionProjection: z.enum(['not_applicable', 'pending', 'complete']), executorRequestRef: opaqueRef.optional(), authoritativeWorldVersion: opaqueRef.optional(), completedAt: nonNegativeSafeInt.optional(), reconciliation: reconciliationSchema.optional(), escalation: escalationSchema.optional(),
}).strict();
export type ActionExecutionReceiptV1 = z.infer<typeof actionExecutionReceiptBaseSchema>;

const npcConversationEventBaseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), eventId: generatedIdSchema('event'), utteranceId: generatedIdSchema('utterance'), conversation: ConversationRefV1Schema,
  worldId: protocolId, worldEpoch: nonNegativeSafeInt, speaker: NpcInstanceRefV1Schema, target: NpcInstanceRefV1Schema, sourceAttemptId: generatedIdSchema('attempt'), parentActionCommitId: generatedIdSchema('action-commit'),
  inReplyToUtteranceId: generatedIdSchema('utterance').optional(), routeVersion: nonNegativeSafeInt, createdAt: nonNegativeSafeInt, expiresAt: nonNegativeSafeInt, publicText: textValue, idempotencyHash: hash,
}).strict();
export type NpcConversationEventV1 = z.infer<typeof npcConversationEventBaseSchema>;

const conversationDeliveryBaseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), deliveryId: generatedIdSchema('delivery'), eventId: generatedIdSchema('event'), target: NpcInstanceRefV1Schema, targetTriggerId: generatedIdSchema('target-trigger'),
  status: z.enum(['pending', 'dispatching', 'admitted', 'rejected', 'expired', 'consumed']), targetAttemptId: generatedIdSchema('attempt').optional(), idempotencyHash: hash, revision: nonNegativeSafeInt, updatedAt: nonNegativeSafeInt,
}).strict();
export type ConversationDeliveryV1 = z.infer<typeof conversationDeliveryBaseSchema>;

export function instanceSortKey(ref: NpcInstanceRefV1): Uint8Array {
  return Buffer.from(canonicalizeA2aJson([ref.worldId, ref.worldEpoch, ref.npcId, ref.instanceId, ref.instanceEpoch]), 'utf8');
}

function compareInstances(a: NpcInstanceRefV1, b: NpcInstanceRefV1): number {
  return Buffer.compare(Buffer.from(instanceSortKey(a)), Buffer.from(instanceSortKey(b)));
}

export function canonicalParticipantPair(a: NpcInstanceRefV1, b: NpcInstanceRefV1): readonly [NpcInstanceRefV1, NpcInstanceRefV1] {
  if (compareInstances(a, b) === 0) throw new Error('duplicate participants');
  return compareInstances(a, b) < 0 ? [a, b] : [b, a];
}

export function derivePairKey(a: NpcInstanceRefV1, b: NpcInstanceRefV1): string {
  return generatedId('pair', canonicalParticipantPair(a, b));
}
export const pairKey = derivePairKey;
export function deriveConversationId(causalRootId: string, a: NpcInstanceRefV1, b: NpcInstanceRefV1): string {
  if (!protocolId.safeParse(causalRootId).success) throw new Error('invalid causal root id');
  return generatedId('conversation', [causalRootId, canonicalParticipantPair(a, b)]);
}
export const conversationId = deriveConversationId;
export function deriveAttemptId(subject: NpcInstanceRefV1, triggerId: string, triggerSeq: number): string {
  if (!protocolId.safeParse(triggerId).success || !nonNegativeSafeInt.safeParse(triggerSeq).success) throw new Error('invalid attempt derivation input');
  return generatedId('attempt', [subject.worldId, subject.worldEpoch, subject, triggerId, triggerSeq]);
}
export const attemptId = deriveAttemptId;
function requireGenerated(value: string, kind: GeneratedKind): string { return generatedIdSchema(kind).parse(value); }
export function deriveProposalId(attemptIdValue: string): string { return generatedId('proposal', [requireGenerated(attemptIdValue, 'attempt')]); }
export function deriveActionCommitId(attemptIdValue: string): string { return generatedId('action-commit', [requireGenerated(attemptIdValue, 'attempt')]); }
export function deriveEventId(actionCommitIdValue: string): string { return generatedId('event', [requireGenerated(actionCommitIdValue, 'action-commit')]); }
export function deriveUtteranceId(actionCommitIdValue: string): string { return generatedId('utterance', [requireGenerated(actionCommitIdValue, 'action-commit')]); }
export function deriveDeliveryId(eventIdValue: string, target: NpcInstanceRefV1): string { return generatedId('delivery', [requireGenerated(eventIdValue, 'event'), target]); }
export function deriveTargetTriggerId(deliveryIdValue: string): string { return generatedId('target-trigger', [requireGenerated(deliveryIdValue, 'delivery')]); }

function projectionAttempt(a: NpcActionAttemptV1): CanonicalJson {
  return { schemaVersion: a.schemaVersion, triggerId: a.triggerId, triggerSeq: a.triggerSeq, subject: a.subject, ...(a.conversationRoute ? { conversationRoute: a.conversationRoute } : {}), ...(a.sourceConversationEventId ? { sourceConversationEventId: a.sourceConversationEventId } : {}), priorityClass: a.priorityClass, snapshotVersion: a.snapshotVersion, allowedActionKinds: a.allowedActionKinds, admittedConflictKeys: a.admittedConflictKeys, baseConflictEpochs: a.baseConflictEpochs, admittedAt: a.admittedAt, deadlineAt: a.deadlineAt };
}
function projectionProposal(p: NpcActionProposalV1): CanonicalJson {
  const common = { schemaVersion: p.schemaVersion, attemptId: p.attemptId, subject: p.subject, observedSnapshotVersion: p.observedSnapshotVersion, completedAt: p.completedAt, disposition: p.disposition };
  return p.disposition === 'action' ? { ...common, actionKind: p.actionKind, payload: p.payload, ...(p.draftUtterance !== undefined ? { draftUtterance: p.draftUtterance } : {}), ...(p.candidateEmotion !== undefined ? { candidateEmotion: p.candidateEmotion } : {}) } : { ...common, reasonCode: p.reasonCode };
}
function projectionConversation(r: ConversationRecordV1): CanonicalJson { return { schemaVersion: r.schemaVersion, conversation: r.conversation, worldId: r.worldId, worldEpoch: r.worldEpoch, participants: r.participants, routeVersion: r.routeVersion, createdAt: r.createdAt, expiresAt: r.expiresAt }; }
function projectionCommit(c: ActionCommitRecordV1): CanonicalJson { return { schemaVersion: c.schemaVersion, attemptId: c.attemptId, subject: c.subject, actionKind: c.actionKind, canonicalArguments: c.canonicalArguments, argumentsHash: c.argumentsHash, proposalHash: c.proposalHash, acceptedSnapshotVersion: c.acceptedSnapshotVersion, conflictKeys: c.conflictKeys, reservedConflictEpochs: c.reservedConflictEpochs, ...(c.speech ? { speech: c.speech } : {}), ...(c.trustedEffectInput ? { trustedEffectInput: c.trustedEffectInput } : {}), createdAt: c.createdAt }; }
function projectionReceipt(r: ActionExecutionReceiptV1): CanonicalJson { return { schemaVersion: r.schemaVersion, actionCommitId: r.actionCommitId, actionCommitRecordHash: r.actionCommitRecordHash, attemptId: r.attemptId, subject: r.subject, conflictKeys: r.conflictKeys, reservedConflictEpochs: r.reservedConflictEpochs }; }
function projectionEvent(e: NpcConversationEventV1): CanonicalJson { return { schemaVersion: e.schemaVersion, utteranceId: e.utteranceId, conversation: e.conversation, worldId: e.worldId, worldEpoch: e.worldEpoch, speaker: e.speaker, target: e.target, sourceAttemptId: e.sourceAttemptId, parentActionCommitId: e.parentActionCommitId, ...(e.inReplyToUtteranceId ? { inReplyToUtteranceId: e.inReplyToUtteranceId } : {}), routeVersion: e.routeVersion, createdAt: e.createdAt, expiresAt: e.expiresAt, publicText: e.publicText }; }
function projectionDelivery(d: ConversationDeliveryV1): CanonicalJson { return { schemaVersion: d.schemaVersion, eventId: d.eventId, target: d.target, targetTriggerId: d.targetTriggerId }; }

export function deriveAttemptIdempotencyHash(a: NpcActionAttemptV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_ATTEMPT_HASH_NAMESPACE, projectionAttempt(a)); }
export function deriveProposalHash(p: NpcActionProposalV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_PROPOSAL_HASH_NAMESPACE, projectionProposal(p)); }
export function deriveConversationIdempotencyHash(r: ConversationRecordV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_CONVERSATION_RECORD_HASH_NAMESPACE, projectionConversation(r)); }
export function deriveArgumentsHash(value: unknown): string { return hashCanonicalA2aValue(FORGEAX_A2A_ARGUMENTS_HASH_NAMESPACE, value); }
export function deriveActionCommitRecordHash(c: ActionCommitRecordV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_ACTION_COMMIT_RECORD_HASH_NAMESPACE, projectionCommit(c)); }
export function deriveReceiptImmutableIdentityHash(r: ActionExecutionReceiptV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_RECEIPT_IDENTITY_HASH_NAMESPACE, projectionReceipt(r)); }
export function deriveEventIdempotencyHash(e: NpcConversationEventV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_CONVERSATION_EVENT_HASH_NAMESPACE, projectionEvent(e)); }
export function deriveDeliveryIdempotencyHash(d: ConversationDeliveryV1): string { return hashCanonicalA2aValue(FORGEAX_A2A_DELIVERY_HASH_NAMESPACE, projectionDelivery(d)); }
export const deriveAttemptHash = deriveAttemptIdempotencyHash;
export const deriveConversationRecordHash = deriveConversationIdempotencyHash;
export const deriveActionCommitHash = deriveActionCommitRecordHash;
export const deriveReceiptHash = deriveReceiptImmutableIdentityHash;
export const deriveEventHash = deriveEventIdempotencyHash;
export const deriveDeliveryHash = deriveDeliveryIdempotencyHash;

function isSamePair(a: NpcInstanceRefV1, b: NpcInstanceRefV1, expected: readonly [NpcInstanceRefV1, NpcInstanceRefV1]): boolean { return equal(a, expected[0]) && equal(b, expected[1]); }
function issue(path: (string | number)[], message: string): ZodIssue { return { code: z.ZodIssueCode.custom, path, message }; }
function integrityIssues(value: unknown, kind: string): ZodIssue[] {
  const out: ZodIssue[] = [];
  if (kind === 'conversation') {
    const r = value as ConversationRecordV1;
    try {
      const pair = canonicalParticipantPair(r.participants[0], r.participants[1]);
      if (!isSamePair(r.participants[0], r.participants[1], pair)) out.push(issue(['participants'], 'participants are not canonical pair order'));
      if (r.participants.some((p) => p.worldId !== r.worldId || p.worldEpoch !== r.worldEpoch)) out.push(issue(['participants'], 'participant world identity mismatch'));
      if (r.conversation.pairKey !== derivePairKey(...r.participants)) out.push(issue(['conversation', 'pairKey'], 'pairKey mismatch'));
      if (r.conversation.conversationId !== deriveConversationId(r.conversation.causalRootId, ...r.participants)) out.push(issue(['conversation', 'conversationId'], 'conversationId mismatch'));
    } catch { out.push(issue(['participants'], 'invalid participant pair')); }
    if (r.createdAt > r.expiresAt) out.push(issue(['expiresAt'], 'expiresAt precedes createdAt'));
    if (r.counters.turns > 6 || r.counters.causalDepth > 6 || r.counters.modelCalls > 6) out.push(issue(['counters'], 'counter exceeds 6'));
    if (r.idempotencyHash !== deriveConversationIdempotencyHash(r)) out.push(issue(['idempotencyHash'], 'idempotencyHash mismatch'));
  } else if (kind === 'attempt') {
    const a = value as NpcActionAttemptV1;
    if (a.attemptId !== deriveAttemptId(a.subject, a.triggerId, a.triggerSeq)) out.push(issue(['attemptId'], 'attemptId mismatch'));
    if (Object.keys(a.baseConflictEpochs).sort(compareCodePoints).join('\0') !== [...a.admittedConflictKeys].sort(compareCodePoints).join('\0')) out.push(issue(['baseConflictEpochs'], 'conflict epoch keys mismatch'));
    if (a.deadlineAt < a.admittedAt) out.push(issue(['deadlineAt'], 'deadlineAt precedes admittedAt'));
    if (a.conversationRoute && (a.conversationRoute.target.worldId !== a.subject.worldId || a.conversationRoute.target.worldEpoch !== a.subject.worldEpoch || equal(a.conversationRoute.target, a.subject) || a.conversationRoute.expiresAt <= a.admittedAt)) out.push(issue(['conversationRoute'], 'invalid conversation route'));
    if (a.conversationRoute) {
      try {
        if (a.conversationRoute.conversation.pairKey !== derivePairKey(a.subject, a.conversationRoute.target) || a.conversationRoute.conversation.conversationId !== deriveConversationId(a.conversationRoute.conversation.causalRootId, a.subject, a.conversationRoute.target)) out.push(issue(['conversationRoute', 'conversation'], 'conversation identity mismatch'));
      } catch { out.push(issue(['conversationRoute', 'conversation'], 'invalid conversation identity')); }
    }
    if (!a.conversationRoute && a.sourceConversationEventId !== undefined) out.push(issue(['sourceConversationEventId'], 'source event requires a route'));
    if (a.idempotencyHash !== deriveAttemptIdempotencyHash(a)) out.push(issue(['idempotencyHash'], 'idempotencyHash mismatch'));
  } else if (kind === 'proposal') {
    const p = value as NpcActionProposalV1;
    if (p.proposalId !== deriveProposalId(p.attemptId)) out.push(issue(['proposalId'], 'proposalId mismatch'));
    if (p.proposalHash !== deriveProposalHash(p)) out.push(issue(['proposalHash'], 'proposalHash mismatch'));
  } else if (kind === 'commit') {
    const c = value as ActionCommitRecordV1;
    if (c.actionCommitId !== deriveActionCommitId(c.attemptId)) out.push(issue(['actionCommitId'], 'actionCommitId mismatch'));
    if (c.argumentsHash !== deriveArgumentsHash(c.canonicalArguments)) out.push(issue(['argumentsHash'], 'argumentsHash mismatch'));
    if (Object.keys(c.reservedConflictEpochs).sort(compareCodePoints).join('\0') !== [...c.conflictKeys].sort(compareCodePoints).join('\0')) out.push(issue(['reservedConflictEpochs'], 'conflict epoch keys mismatch'));
    if (c.recordHash !== deriveActionCommitRecordHash(c)) out.push(issue(['recordHash'], 'recordHash mismatch'));
    if (c.speech && (c.speech.target.worldId !== c.subject.worldId || c.speech.target.worldEpoch !== c.subject.worldEpoch || c.speech.expiresAt < c.createdAt)) out.push(issue(['speech'], 'invalid speech route'));
    if (c.speech) {
      try {
        if (c.speech.conversation.pairKey !== derivePairKey(c.subject, c.speech.target) || c.speech.conversation.conversationId !== deriveConversationId(c.speech.conversation.causalRootId, c.subject, c.speech.target)) out.push(issue(['speech', 'conversation'], 'conversation identity mismatch'));
      } catch { out.push(issue(['speech', 'conversation'], 'invalid conversation identity')); }
    }
  } else if (kind === 'receipt') {
    const r = value as ActionExecutionReceiptV1;
    if (r.actionCommitId !== deriveActionCommitId(r.attemptId)) out.push(issue(['actionCommitId'], 'actionCommitId mismatch'));
    if (Object.keys(r.reservedConflictEpochs).sort(compareCodePoints).join('\0') !== [...r.conflictKeys].sort(compareCodePoints).join('\0')) out.push(issue(['reservedConflictEpochs'], 'conflict epoch keys mismatch'));
    const terminalExecuted = r.status === 'executed' || r.status === 'reconciled_executed';
    if (terminalExecuted && r.actionCommitSeq === undefined) out.push(issue(['actionCommitSeq'], 'executed receipt requires actionCommitSeq'));
    if (!terminalExecuted && r.actionCommitSeq !== undefined) out.push(issue(['actionCommitSeq'], 'non-executed receipt cannot have actionCommitSeq'));
    if (r.status.startsWith('reconciled_') && !r.reconciliation) out.push(issue(['reconciliation'], 'reconciled receipt requires reconciliation'));
    if (!r.status.startsWith('reconciled_') && r.reconciliation) out.push(issue(['reconciliation'], 'non-reconciled receipt cannot have reconciliation'));
    if (r.status === 'reserved' && r.executorRequestRef !== undefined) out.push(issue(['executorRequestRef'], 'reserved receipt cannot have executor ref'));
    if ((r.status === 'dispatching' || r.status === 'executing' || r.status === 'execution_unknown' || r.status === 'executed' || r.status.startsWith('reconciled_')) && r.executorRequestRef === undefined) out.push(issue(['executorRequestRef'], 'dispatched receipt requires executor ref'));
    if (!['executed', 'not_executed', 'reconciled_executed', 'reconciled_not_executed'].includes(r.status) && r.completedAt !== undefined) out.push(issue(['completedAt'], 'in-flight receipt cannot be complete'));
    if ((r.status === 'executed' || r.status === 'not_executed' || r.status.startsWith('reconciled_')) && r.completedAt === undefined) out.push(issue(['completedAt'], 'terminal receipt requires completedAt'));
    if (!['executed', 'reconciled_executed'].includes(r.status) && r.postExecutionProjection !== 'not_applicable') out.push(issue(['postExecutionProjection'], 'non-executed receipt cannot project'));
    if (r.escalation && !['execution_unknown', 'reconciled_executed', 'reconciled_not_executed'].includes(r.status)) out.push(issue(['escalation'], 'escalation requires unknown or reconciled status'));
    if (r.immutableIdentityHash !== deriveReceiptImmutableIdentityHash(r)) out.push(issue(['immutableIdentityHash'], 'immutableIdentityHash mismatch'));
  } else if (kind === 'event') {
    const e = value as NpcConversationEventV1;
    if (e.eventId !== deriveEventId(e.parentActionCommitId)) out.push(issue(['eventId'], 'eventId mismatch'));
    if (e.utteranceId !== deriveUtteranceId(e.parentActionCommitId)) out.push(issue(['utteranceId'], 'utteranceId mismatch'));
    if (e.speaker.worldId !== e.worldId || e.target.worldId !== e.worldId || e.speaker.worldEpoch !== e.worldEpoch || e.target.worldEpoch !== e.worldEpoch || equal(e.speaker, e.target)) out.push(issue(['speaker'], 'event participant mismatch'));
    if (e.expiresAt < e.createdAt) out.push(issue(['expiresAt'], 'expiresAt precedes createdAt'));
    try {
      if (e.conversation.pairKey !== derivePairKey(e.speaker, e.target) || e.conversation.conversationId !== deriveConversationId(e.conversation.causalRootId, e.speaker, e.target)) out.push(issue(['conversation'], 'conversation identity mismatch'));
    } catch { out.push(issue(['conversation'], 'invalid conversation identity')); }
    if (e.idempotencyHash !== deriveEventIdempotencyHash(e)) out.push(issue(['idempotencyHash'], 'idempotencyHash mismatch'));
  } else if (kind === 'delivery') {
    const d = value as ConversationDeliveryV1;
    if (d.deliveryId !== deriveDeliveryId(d.eventId, d.target)) out.push(issue(['deliveryId'], 'deliveryId mismatch'));
    if (d.targetTriggerId !== deriveTargetTriggerId(d.deliveryId)) out.push(issue(['targetTriggerId'], 'targetTriggerId mismatch'));
    const needsAttempt = d.status === 'admitted' || d.status === 'consumed';
    if (needsAttempt !== (d.targetAttemptId !== undefined)) out.push(issue(['targetAttemptId'], 'targetAttemptId presence mismatch'));
    if (d.idempotencyHash !== deriveDeliveryIdempotencyHash(d)) out.push(issue(['idempotencyHash'], 'idempotencyHash mismatch'));
  }
  return out;
}

function integritySchema<T extends z.ZodTypeAny>(schema: T, kind: string): T {
  return schema.superRefine((value, ctx) => {
    if (containsExplicitUndefined(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'explicit undefined is not protocol JSON' });
      return;
    }
    try { for (const i of integrityIssues(value, kind)) ctx.addIssue(i); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'record integrity failure' }); }
  }) as unknown as T;
}

function containsExplicitUndefined(value: unknown, seen = new Set<object>()): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => containsExplicitUndefined(item, seen));
    return Object.keys(value).some((key) => containsExplicitUndefined((value as Record<string, unknown>)[key], seen));
  } finally { seen.delete(value); }
}

// The exported schemas are integrity boundaries, not syntax-only decoders.
export const ConversationRecordV1Schema = integritySchema(conversationRecordBaseSchema, 'conversation');
export const NpcActionAttemptV1Schema = integritySchema(npcActionAttemptBaseSchema, 'attempt');
export const NpcActionProposalV1Schema = integritySchema(npcActionProposalBaseSchema, 'proposal');
export const ActionCommitRecordV1Schema = integritySchema(actionCommitRecordBaseSchema, 'commit');
export const ActionExecutionReceiptV1Schema = integritySchema(actionExecutionReceiptBaseSchema, 'receipt');
export const NpcConversationEventV1Schema = integritySchema(npcConversationEventBaseSchema, 'event');
export const ConversationDeliveryV1Schema = integritySchema(conversationDeliveryBaseSchema, 'delivery');

// Lower-case aliases match the existing orchestrator schema naming convention.
export const npcInstanceRefV1Schema = NpcInstanceRefV1Schema;
export const conversationRefV1Schema = ConversationRefV1Schema;
export const conversationRecordV1Schema = ConversationRecordV1Schema;
export const npcActionAttemptV1Schema = NpcActionAttemptV1Schema;
export const npcActionProposalV1Schema = NpcActionProposalV1Schema;
export const actionCommitRecordV1Schema = ActionCommitRecordV1Schema;
export const actionExecutionReceiptV1Schema = ActionExecutionReceiptV1Schema;
export const npcConversationEventV1Schema = NpcConversationEventV1Schema;
export const conversationDeliveryV1Schema = ConversationDeliveryV1Schema;
export const npcInstanceRefSchema = NpcInstanceRefV1Schema;
export const conversationRefSchema = ConversationRefV1Schema;
export const conversationRecordSchema = ConversationRecordV1Schema;
export const npcActionAttemptSchema = NpcActionAttemptV1Schema;
export const npcActionProposalSchema = NpcActionProposalV1Schema;
export const actionCommitRecordSchema = ActionCommitRecordV1Schema;
export const actionExecutionReceiptSchema = ActionExecutionReceiptV1Schema;
export const npcConversationEventSchema = NpcConversationEventV1Schema;
export const conversationDeliverySchema = ConversationDeliveryV1Schema;

function parseWith<T>(schema: z.ZodType<T>, kind: string, value: unknown): T {
  const parsed = schema.parse(value);
  // Keep an explicit second boundary for callers that pass schema-like values through casts.
  const issues = integrityIssues(parsed, kind);
  if (issues.length) throw new z.ZodError(issues);
  return parsed;
}
export const parseNpcInstanceRefV1 = (v: unknown): NpcInstanceRefV1 => NpcInstanceRefV1Schema.parse(v);
export const parseConversationRefV1 = (v: unknown): ConversationRefV1 => ConversationRefV1Schema.parse(v);
export const parseConversationRecordV1 = (v: unknown): ConversationRecordV1 => parseWith(ConversationRecordV1Schema, 'conversation', v);
export const parseNpcActionAttemptV1 = (v: unknown): NpcActionAttemptV1 => parseWith(NpcActionAttemptV1Schema, 'attempt', v);
export const parseNpcActionProposalV1 = (v: unknown): NpcActionProposalV1 => parseWith(NpcActionProposalV1Schema, 'proposal', v);
export const parseActionCommitRecordV1 = (v: unknown): ActionCommitRecordV1 => parseWith(ActionCommitRecordV1Schema, 'commit', v);
export const parseActionExecutionReceiptV1 = (v: unknown): ActionExecutionReceiptV1 => parseWith(ActionExecutionReceiptV1Schema, 'receipt', v);
export const parseNpcConversationEventV1 = (v: unknown): NpcConversationEventV1 => parseWith(NpcConversationEventV1Schema, 'event', v);
export const parseConversationDeliveryV1 = (v: unknown): ConversationDeliveryV1 => parseWith(ConversationDeliveryV1Schema, 'delivery', v);
export const parseNpcInstanceRef = parseNpcInstanceRefV1;
export const parseConversationRef = parseConversationRefV1;
export const parseConversationRecord = parseConversationRecordV1;
export const parseNpcActionAttempt = parseNpcActionAttemptV1;
export const parseNpcActionProposal = parseNpcActionProposalV1;
export const parseActionCommitRecord = parseActionCommitRecordV1;
export const parseActionExecutionReceipt = parseActionExecutionReceiptV1;
export const parseNpcConversationEvent = parseNpcConversationEventV1;
export const parseConversationDelivery = parseConversationDeliveryV1;
export const safeParseNpcInstanceRefV1 = (v: unknown) => NpcInstanceRefV1Schema.safeParse(v);
export const safeParseConversationRefV1 = (v: unknown) => ConversationRefV1Schema.safeParse(v);
export function safeParseConversationRecordV1(v: unknown): SafeParseReturnType<unknown, ConversationRecordV1> { return ConversationRecordV1Schema.safeParse(v); }
export function safeParseNpcActionAttemptV1(v: unknown): SafeParseReturnType<unknown, NpcActionAttemptV1> { return NpcActionAttemptV1Schema.safeParse(v); }
export function safeParseNpcActionProposalV1(v: unknown): SafeParseReturnType<unknown, NpcActionProposalV1> { return NpcActionProposalV1Schema.safeParse(v); }
export function safeParseActionCommitRecordV1(v: unknown): SafeParseReturnType<unknown, ActionCommitRecordV1> { return ActionCommitRecordV1Schema.safeParse(v); }
export function safeParseActionExecutionReceiptV1(v: unknown): SafeParseReturnType<unknown, ActionExecutionReceiptV1> { return ActionExecutionReceiptV1Schema.safeParse(v); }
export function safeParseNpcConversationEventV1(v: unknown): SafeParseReturnType<unknown, NpcConversationEventV1> { return NpcConversationEventV1Schema.safeParse(v); }
export function safeParseConversationDeliveryV1(v: unknown): SafeParseReturnType<unknown, ConversationDeliveryV1> { return ConversationDeliveryV1Schema.safeParse(v); }
export const safeParseNpcInstanceRef = safeParseNpcInstanceRefV1;
export const safeParseConversationRef = safeParseConversationRefV1;
export const safeParseConversationRecord = safeParseConversationRecordV1;
export const safeParseNpcActionAttempt = safeParseNpcActionAttemptV1;
export const safeParseNpcActionProposal = safeParseNpcActionProposalV1;
export const safeParseActionCommitRecord = safeParseActionCommitRecordV1;
export const safeParseActionExecutionReceipt = safeParseActionExecutionReceiptV1;
export const safeParseNpcConversationEvent = safeParseNpcConversationEventV1;
export const safeParseConversationDelivery = safeParseConversationDeliveryV1;

export function validateNpcInstanceRefIntegrity(v: unknown): ValidationResult { return NpcInstanceRefV1Schema.safeParse(v).success ? ok() : fail('invalid instance ref'); }
export function validateConversationRefAgainstParticipants(ref: ConversationRefV1, a: NpcInstanceRefV1, b: NpcInstanceRefV1, causalRootId = ref.causalRootId): ValidationResult { try { return ref.pairKey === derivePairKey(a, b) && ref.conversationId === deriveConversationId(causalRootId, a, b) ? ok() : fail('conversation identity mismatch'); } catch { return fail('conversation identity mismatch'); } }
export function validateConversationRecordIntegrity(v: unknown): ValidationResult { const r = ConversationRecordV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'conversation').length === 0 ? ok(r.data) : fail('conversation record integrity failure'); }
export function validateAttemptIntegrity(v: unknown): ValidationResult { const r = NpcActionAttemptV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'attempt').length === 0 ? ok(r.data) : fail('attempt integrity failure'); }
export function validateProposalIntegrity(v: unknown): ValidationResult { const r = NpcActionProposalV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'proposal').length === 0 ? ok(r.data) : fail('proposal integrity failure'); }
export function validateActionCommitRecordIntegrity(v: unknown): ValidationResult { const r = ActionCommitRecordV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'commit').length === 0 ? ok(r.data) : fail('commit integrity failure'); }
export function validateReceiptIntegrity(v: unknown): ValidationResult { const r = ActionExecutionReceiptV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'receipt').length === 0 ? ok(r.data) : fail('receipt integrity failure'); }
export function validateEventIntegrity(v: unknown): ValidationResult { const r = NpcConversationEventV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'event').length === 0 ? ok(r.data) : fail('event integrity failure'); }
export function validateDeliveryIntegrity(v: unknown): ValidationResult { const r = ConversationDeliveryV1Schema.safeParse(v); return r.success && integrityIssues(r.data, 'delivery').length === 0 ? ok(r.data) : fail('delivery integrity failure'); }
export const validateConversationEventIntegrity = validateEventIntegrity;
export const validateActionCommitIntegrity = validateActionCommitRecordIntegrity;

export type ValidationResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
const ok = <T>(data?: T): ValidationResult<T> => ({ ok: true, ...(data === undefined ? {} : { data }) });
const fail = (error: string): ValidationResult => ({ ok: false, error });
function parsed<T>(schema: z.ZodType<T>, value: unknown): T | undefined { const r = schema.safeParse(value); return r.success ? r.data : undefined; }
function equal(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalizeA2aJson(a) === canonicalizeA2aJson(b);
}

export function validateAttemptRouteForAdmission(draftAttemptValue: unknown, currentRecordValue: unknown, priorEventValue?: unknown): ValidationResult {
  const attempt = parsed(NpcActionAttemptV1Schema, draftAttemptValue); const prior = priorEventValue === undefined ? undefined : parsed(NpcConversationEventV1Schema, priorEventValue);
  if (!attempt || (priorEventValue !== undefined && !prior)) return fail('invalid route input');
  const route = attempt.conversationRoute;
  if (!route) return attempt.sourceConversationEventId === undefined && prior === undefined ? ok() : fail('first turn has source event');
  const record = parsed(ConversationRecordV1Schema, currentRecordValue);
  if (!record) return fail('routed attempt requires current conversation record');
  if (record.status !== 'active' || record.worldId !== attempt.subject.worldId || record.worldEpoch !== attempt.subject.worldEpoch || record.routeVersion !== route.routeVersion || record.expiresAt !== route.expiresAt || !equal(record.conversation, route.conversation) || !isSamePair(record.participants[0], record.participants[1], canonicalParticipantPair(attempt.subject, route.target)) || record.createdAt > attempt.admittedAt || attempt.admittedAt >= record.expiresAt) return fail('current conversation route mismatch');
  const reply = attempt.sourceConversationEventId !== undefined;
  if (reply) {
    if (!prior || prior.eventId !== attempt.sourceConversationEventId || !equal(prior.target, attempt.subject) || !equal(prior.speaker, route.target) || !equal(prior.conversation, route.conversation) || prior.worldId !== attempt.subject.worldId || prior.worldEpoch !== attempt.subject.worldEpoch || prior.routeVersion !== route.routeVersion || prior.expiresAt !== route.expiresAt || prior.createdAt > attempt.admittedAt || attempt.admittedAt >= prior.expiresAt) return fail('prior conversation event mismatch');
  } else if (prior) return fail('first turn cannot have prior event');
  return ok();
}

export function validateProposalAgainstAttempt(proposalValue: unknown, attemptValue: unknown): ValidationResult {
  const proposal = parsed(NpcActionProposalV1Schema, proposalValue); const attempt = parsed(NpcActionAttemptV1Schema, attemptValue);
  if (!proposal || !attempt || proposal.attemptId !== attempt.attemptId || !equal(proposal.subject, attempt.subject) || proposal.observedSnapshotVersion !== attempt.snapshotVersion) return fail('proposal linkage mismatch');
  if (proposal.disposition === 'action' && !attempt.allowedActionKinds.includes(proposal.actionKind)) return fail('action kind is not admitted');
  return ok();
}

export function validateCommitAgainstAttemptAndProposal(commitValue: unknown, attemptValue: unknown, proposalValue: unknown, priorEventValue?: unknown): ValidationResult {
  const c = parsed(ActionCommitRecordV1Schema, commitValue); const a = parsed(NpcActionAttemptV1Schema, attemptValue); const p = parsed(NpcActionProposalV1Schema, proposalValue); const prior = priorEventValue === undefined ? undefined : parsed(NpcConversationEventV1Schema, priorEventValue);
  if (!c || !a || !p || !validateProposalAgainstAttempt(p, a).ok || p.disposition !== 'action' || c.attemptId !== a.attemptId || !equal(c.subject, a.subject) || c.proposalHash !== p.proposalHash || c.acceptedSnapshotVersion !== a.snapshotVersion || c.actionKind !== p.actionKind || !equal(c.conflictKeys, a.admittedConflictKeys) || !equal(c.reservedConflictEpochs, a.baseConflictEpochs)) return fail('commit linkage mismatch');
  if (c.speech) {
    const route = a.conversationRoute;
    if (p.draftUtterance === undefined || !route || !equal(c.speech.conversation, route.conversation) || !equal(c.speech.target, route.target) || c.speech.routeVersion !== route.routeVersion || c.speech.expiresAt !== route.expiresAt || (a.sourceConversationEventId ? (!prior || prior.eventId !== a.sourceConversationEventId || c.speech.inReplyToUtteranceId !== prior.utteranceId) : c.speech.inReplyToUtteranceId !== undefined)) return fail('speech route mismatch');
  }
  return ok();
}

export function validateReceiptAgainstCommit(receiptValue: unknown, commitValue: unknown): ValidationResult {
  const r = parsed(ActionExecutionReceiptV1Schema, receiptValue); const c = parsed(ActionCommitRecordV1Schema, commitValue);
  return r && c && r.actionCommitId === c.actionCommitId && r.actionCommitRecordHash === c.recordHash && r.attemptId === c.attemptId && equal(r.subject, c.subject) && equal(r.conflictKeys, c.conflictKeys) && equal(r.reservedConflictEpochs, c.reservedConflictEpochs) ? ok() : fail('receipt linkage mismatch');
}

export function validateEventAgainstCommitAndReceipt(eventValue: unknown, commitValue: unknown, receiptValue: unknown): ValidationResult {
  const e = parsed(NpcConversationEventV1Schema, eventValue); const c = parsed(ActionCommitRecordV1Schema, commitValue); const r = parsed(ActionExecutionReceiptV1Schema, receiptValue);
  if (!e || !c || !r || !['executed', 'reconciled_executed'].includes(r.status) || !c.speech || !validateReceiptAgainstCommit(r, c).ok) return fail('event prerequisites mismatch');
  const s = c.speech;
  return e.eventId === deriveEventId(c.actionCommitId) && e.utteranceId === deriveUtteranceId(c.actionCommitId) && e.parentActionCommitId === c.actionCommitId && e.sourceAttemptId === c.attemptId && equal(e.conversation, s.conversation) && equal(e.speaker, c.subject) && equal(e.target, s.target) && e.routeVersion === s.routeVersion && e.expiresAt === s.expiresAt && e.publicText === s.normalizedPublicText && (e.inReplyToUtteranceId === s.inReplyToUtteranceId) ? ok() : fail('event linkage mismatch');
}
export function validateDeliveryAgainstEvent(deliveryValue: unknown, eventValue: unknown): ValidationResult {
  const d = parsed(ConversationDeliveryV1Schema, deliveryValue); const e = parsed(NpcConversationEventV1Schema, eventValue);
  return d && e && d.eventId === e.eventId && equal(d.target, e.target) && d.deliveryId === deriveDeliveryId(e.eventId, e.target) && d.targetTriggerId === deriveTargetTriggerId(d.deliveryId) ? ok() : fail('delivery linkage mismatch');
}

export type ReplayClassification = 'different_primary_id' | 'same_primary_id_same_immutable_hash' | 'same_primary_id_different_immutable_hash_conflict';
function classify(primary: string, hashName: string, left: unknown, right: unknown, schema: z.ZodTypeAny, kind: string): ReplayClassification {
  const l = parsed(schema, left); const r = parsed(schema, right); if (!l || !r || integrityIssues(l, kind).length || integrityIssues(r, kind).length) throw new Error('cannot classify unvalidated records');
  const lh = (l as Record<string, unknown>)[hashName]; const rh = (r as Record<string, unknown>)[hashName];
  const primaryOf = (v: Record<string, unknown>) => primary === 'conversationId' ? (v.conversation as Record<string, unknown>).conversationId : v[primary];
  return primaryOf(l as Record<string, unknown>) !== primaryOf(r as Record<string, unknown>) ? 'different_primary_id' : lh === rh ? 'same_primary_id_same_immutable_hash' : 'same_primary_id_different_immutable_hash_conflict';
}
export const classifyAttemptReplay = (a: unknown, b: unknown) => classify('attemptId', 'idempotencyHash', a, b, NpcActionAttemptV1Schema, 'attempt');
export const classifyProposalReplay = (a: unknown, b: unknown) => classify('proposalId', 'proposalHash', a, b, NpcActionProposalV1Schema, 'proposal');
export const classifyActionCommitReplay = (a: unknown, b: unknown) => classify('actionCommitId', 'recordHash', a, b, ActionCommitRecordV1Schema, 'commit');
export const classifyConversationReplay = (a: unknown, b: unknown) => classify('conversationId', 'idempotencyHash', a, b, ConversationRecordV1Schema, 'conversation');
export const classifyReceiptReplay = (a: unknown, b: unknown) => classify('actionCommitId', 'immutableIdentityHash', a, b, ActionExecutionReceiptV1Schema, 'receipt');
export const classifyEventReplay = (a: unknown, b: unknown) => classify('eventId', 'idempotencyHash', a, b, NpcConversationEventV1Schema, 'event');
export const classifyDeliveryReplay = (a: unknown, b: unknown) => classify('deliveryId', 'idempotencyHash', a, b, ConversationDeliveryV1Schema, 'delivery');
export const classifyConversationRecordReplay = classifyConversationReplay;
export const classifyNpcActionAttemptReplay = classifyAttemptReplay;
export const classifyNpcActionProposalReplay = classifyProposalReplay;
export const classifyActionCommitRecordReplay = classifyActionCommitReplay;
export const classifyNpcConversationEventReplay = classifyEventReplay;
export const classifyConversationDeliveryReplay = classifyDeliveryReplay;

function immutableEqual(a: Record<string, unknown>, b: Record<string, unknown>, excluded: readonly string[]): boolean { const strip = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => !excluded.includes(k))); return equal(strip(a), strip(b)); }
export function validateConversationTransition(previousValue: unknown, nextValue: unknown): ValidationResult {
  const p = parsed(ConversationRecordV1Schema, previousValue); const n = parsed(ConversationRecordV1Schema, nextValue); if (!p || !n) return fail('invalid conversation transition input');
  if (p.conversation.conversationId !== n.conversation.conversationId || p.idempotencyHash !== n.idempotencyHash || !immutableEqual(p as unknown as Record<string, unknown>, n as unknown as Record<string, unknown>, ['status', 'revision', 'counters'])) return fail('conversation immutable fields changed');
  if (equal(p, n)) return ok();
  if (n.revision !== p.revision + 1 || n.counters.turns < p.counters.turns || n.counters.causalDepth < p.counters.causalDepth || n.counters.modelCalls < p.counters.modelCalls || n.counters.turns > 6 || n.counters.causalDepth > 6 || n.counters.modelCalls > 6) return fail('invalid conversation revision/counters');
  if (p.status !== 'active' || !['active', 'closed', 'expired'].includes(n.status)) return fail('conversation status is terminal');
  return ok();
}

export type ReceiptTransitionEvent =
  | { kind: 'dispatch_persisted' } | { kind: 'execution_started' } | { kind: 'predispatch_cancelled' }
  | { kind: 'executor_outcome'; outcome: 'executed' | 'not_executed' }
  | { kind: 'mark_unknown'; reason: 'timeout' | 'disconnect' | 'crash' | 'missing_response' | 'ambiguous' }
  | { kind: 'reconcile_outcome'; outcome: 'executed' | 'not_executed' }
  | { kind: 'projection_completed' } | { kind: 'escalation_raised' } | { kind: 'escalation_acknowledged' };
const receiptEventSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('dispatch_persisted') }).strict(), z.object({ kind: z.literal('execution_started') }).strict(), z.object({ kind: z.literal('predispatch_cancelled') }).strict(), z.object({ kind: z.literal('executor_outcome'), outcome: z.enum(['executed', 'not_executed']) }).strict(), z.object({ kind: z.literal('mark_unknown'), reason: z.enum(['timeout', 'disconnect', 'crash', 'missing_response', 'ambiguous']) }).strict(), z.object({ kind: z.literal('reconcile_outcome'), outcome: z.enum(['executed', 'not_executed']) }).strict(), z.object({ kind: z.literal('projection_completed') }).strict(), z.object({ kind: z.literal('escalation_raised') }).strict(), z.object({ kind: z.literal('escalation_acknowledged') }).strict()]);
function receiptMutableDiff(p: ActionExecutionReceiptV1, n: ActionExecutionReceiptV1): string[] {
  const keys = new Set([...Object.keys(p), ...Object.keys(n)]);
  return [...keys].filter((k) => k !== 'revision' && !equal((p as Record<string, unknown>)[k], (n as Record<string, unknown>)[k]));
}
export function validateReceiptTransition(previousValue: unknown, nextValue: unknown, eventValue?: unknown, commitValue?: unknown): ValidationResult {
  const p = parsed(ActionExecutionReceiptV1Schema, previousValue); const n = parsed(ActionExecutionReceiptV1Schema, nextValue); const ev = eventValue === undefined ? undefined : receiptEventSchema.safeParse(eventValue);
  if (!p || !n || (eventValue !== undefined && !ev?.success)) return fail('invalid receipt transition input');
  if (p.actionCommitId !== n.actionCommitId || p.actionCommitRecordHash !== n.actionCommitRecordHash || p.immutableIdentityHash !== n.immutableIdentityHash || !equal(p.attemptId, n.attemptId) || !equal(p.subject, n.subject) || !equal(p.conflictKeys, n.conflictKeys) || !equal(p.reservedConflictEpochs, n.reservedConflictEpochs)) return fail('receipt immutable identity changed');
  if (equal(p, n)) return eventValue === undefined ? ok() : fail('event cannot accompany no-op receipt write');
  if (n.revision !== p.revision + 1 || eventValue === undefined) return fail('receipt transition requires revision plus one and one event');
  const event = (ev as { success: true; data: ReceiptTransitionEvent }).data;
  const diff = receiptMutableDiff(p, n);
  const sameStatus = p.status === n.status;
  const only = (allowed: string[]) => diff.every((k) => allowed.includes(k));
  const writeOnce = (key: keyof ActionExecutionReceiptV1) => p[key] === undefined || equal(p[key], n[key]);
  const commit = commitValue === undefined ? undefined : parsed(ActionCommitRecordV1Schema, commitValue);
  if (commitValue !== undefined && !commit) return fail('invalid transition commit');
  if (event.kind === 'dispatch_persisted') return p.status === 'reserved' && n.status === 'dispatching' && p.executorRequestRef === undefined && n.executorRequestRef !== undefined && only(['status', 'executorRequestRef']) ? ok() : fail('invalid dispatch persisted edge');
  if (event.kind === 'execution_started') return p.status === 'dispatching' && n.status === 'executing' && only(['status']) ? ok() : fail('invalid execution started edge');
  if (event.kind === 'predispatch_cancelled') return p.status === 'reserved' && n.status === 'not_executed' && p.executorRequestRef === undefined && n.executorRequestRef === undefined && n.completedAt !== undefined && only(['status', 'completedAt']) ? ok() : fail('invalid predispatch cancellation edge');
  if (event.kind === 'mark_unknown') return (p.status === 'dispatching' || p.status === 'executing') && n.status === 'execution_unknown' && only(['status']) ? ok() : fail('invalid unknown edge');
  if (event.kind === 'executor_outcome') {
    if (!(p.status === 'dispatching' || p.status === 'executing') || n.status !== (event.outcome === 'executed' ? 'executed' : 'not_executed') || n.completedAt === undefined) return fail('invalid executor outcome edge');
    if (event.outcome === 'executed' && (n.actionCommitSeq === undefined || !writeOnce('actionCommitSeq'))) return fail('executed outcome requires write-once sequence');
    if (event.outcome === 'not_executed' && n.actionCommitSeq !== undefined) return fail('not executed outcome cannot have sequence');
    if (event.outcome === 'not_executed' && n.postExecutionProjection !== 'not_applicable') return fail('not-executed action cannot project');
    if (n.postExecutionProjection === 'complete') return fail('terminal outcome cannot complete projection in same transition');
    if (!writeOnce('completedAt') || !writeOnce('authoritativeWorldVersion') || p.completedAt !== undefined || (event.outcome === 'executed' && p.actionCommitSeq !== undefined)) return fail('executor outcome replaces write-once field');
    if (event.outcome === 'executed' && (!commit || !validateActionCommitRecordIntegrity(commit).ok || !validateReceiptAgainstCommit(n, commit).ok)) return fail('executed outcome requires matching commit');
    if (event.outcome === 'not_executed' && commit && (!validateActionCommitRecordIntegrity(commit).ok || !validateReceiptAgainstCommit(n, commit).ok)) return fail('not-executed outcome commit mismatch');
    if (commit) {
      const expectedProjection = event.outcome === 'executed' && commit.speech ? 'pending' : 'not_applicable';
      if (n.postExecutionProjection !== expectedProjection) return fail('commit-derived projection mismatch');
    }
    return only(['status', 'completedAt', 'actionCommitSeq', 'authoritativeWorldVersion', 'postExecutionProjection']) ? ok() : fail('invalid executor mutable delta');
  }
  if (event.kind === 'reconcile_outcome') {
    if (p.status !== 'execution_unknown' || n.status !== (event.outcome === 'executed' ? 'reconciled_executed' : 'reconciled_not_executed') || !n.reconciliation || n.completedAt === undefined) return fail('invalid reconciliation edge');
    if (event.outcome === 'executed' && (n.actionCommitSeq === undefined || !writeOnce('actionCommitSeq'))) return fail('reconciled executed requires write-once sequence');
    if (event.outcome === 'not_executed' && n.actionCommitSeq !== undefined) return fail('reconciled not executed cannot have sequence');
    if (event.outcome === 'not_executed' && n.postExecutionProjection !== 'not_applicable') return fail('reconciled not-executed action cannot project');
    if (n.postExecutionProjection === 'complete') return fail('reconciled outcome cannot complete projection in same transition');
    if (p.reconciliation !== undefined || p.completedAt !== undefined || !writeOnce('completedAt') || !writeOnce('authoritativeWorldVersion')) return fail('reconciliation replaces write-once field');
    if (event.outcome === 'executed' && (!commit || !validateActionCommitRecordIntegrity(commit).ok || !validateReceiptAgainstCommit(n, commit).ok)) return fail('reconciled executed outcome requires matching commit');
    if (event.outcome === 'not_executed' && commit && (!validateActionCommitRecordIntegrity(commit).ok || !validateReceiptAgainstCommit(n, commit).ok)) return fail('reconciled not-executed outcome commit mismatch');
    if (commit) {
      const expectedProjection = event.outcome === 'executed' && commit.speech ? 'pending' : 'not_applicable';
      if (n.postExecutionProjection !== expectedProjection) return fail('commit-derived projection mismatch');
    }
    return only(['status', 'reconciliation', 'completedAt', 'actionCommitSeq', 'authoritativeWorldVersion', 'postExecutionProjection']) ? ok() : fail('invalid reconciliation mutable delta');
  }
  if (event.kind === 'projection_completed') return (p.status === 'executed' || p.status === 'reconciled_executed') && sameStatus && p.postExecutionProjection === 'pending' && n.postExecutionProjection === 'complete' && only(['postExecutionProjection']) ? ok() : fail('invalid projection completion edge');
  if (event.kind === 'escalation_raised') return p.status === 'execution_unknown' && sameStatus && p.escalation === undefined && n.escalation?.state === 'required' && only(['escalation']) ? ok() : fail('invalid escalation raise edge');
  if (event.kind === 'escalation_acknowledged') return (p.status === 'execution_unknown' || p.status === 'reconciled_executed' || p.status === 'reconciled_not_executed') && sameStatus && p.escalation?.state === 'required' && n.escalation?.state === 'acknowledged' && equal(p.escalation.owner, n.escalation.owner) && equal(p.escalation.reasonCode, n.escalation.reasonCode) && p.escalation.raisedAt === n.escalation.raisedAt && only(['escalation']) ? ok() : fail('invalid escalation acknowledgement edge');
  return fail('unsupported receipt transition');
}

export function validateDeliveryTransition(previousValue: unknown, nextValue: unknown): ValidationResult {
  const p = parsed(ConversationDeliveryV1Schema, previousValue); const n = parsed(ConversationDeliveryV1Schema, nextValue); if (!p || !n) return fail('invalid delivery transition input');
  if (p.deliveryId !== n.deliveryId || p.eventId !== n.eventId || !equal(p.target, n.target) || p.targetTriggerId !== n.targetTriggerId || p.idempotencyHash !== n.idempotencyHash) return fail('delivery immutable identity changed');
  if (equal(p, n)) return ok();
  if (n.revision !== p.revision + 1 || n.updatedAt < p.updatedAt) return fail('invalid delivery revision/time');
  if (p.status === 'pending' && !['dispatching', 'expired'].includes(n.status)) return fail('invalid pending edge');
  else if (p.status === 'dispatching' && !['dispatching', 'admitted', 'rejected', 'expired'].includes(n.status)) return fail('invalid dispatching edge');
  else if (p.status === 'admitted' && n.status !== 'consumed') return fail('invalid admitted edge');
  else if (['rejected', 'expired', 'consumed'].includes(p.status)) return fail('delivery status is terminal');
  const needs = n.status === 'admitted' || n.status === 'consumed';
  return needs === (n.targetAttemptId !== undefined) && (p.targetAttemptId === undefined || p.targetAttemptId === n.targetAttemptId) ? ok() : fail('invalid target attempt identity');
}

export const A2A_RECEIPT_TRANSITION_EVENT_SCHEMA = receiptEventSchema;
export const A2A_GENERATED_ID_PATTERN = GENERATED_PATTERN;
export const A2A_HASH_PATTERN = HASH_PATTERN;
