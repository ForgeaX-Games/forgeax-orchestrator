import { z } from 'zod';
import {
  NPC_LIMITS,
  NPC_PROTOCOL_VERSION,
  NPC_DECISION_DEADLINE_PRESETS_MS,
  NPC_DEFAULT_DECISION_DEADLINE_PRESET,
  Affordance as affordanceSchema,
  NpcDecisionWire as npcDecisionWireSchema,
  NpcEmotion as emotionSchema,
  NpcIntent as intentSchema,
  NpcUtterance as utteranceSchema,
  PerceptionSnapshot as perceptionSnapshotSchema,
  ResumeRequest as resumeRequestSchema,
  npcAttachFrameSchema,
  npcBudgetFrameSchema,
  npcBudgetStateSchema,
  npcDecisionFrameSchema,
  npcDecisionDeadlineSchema,
  npcDecisionsFrameSchema,
  npcDetachFrameSchema,
  npcEpisodeSummarySchema,
  npcErrorFrameSchema,
  npcHeartbeatFrameSchema,
  npcSessionRequestSchema,
  npcSessionResponseSchema,
  npcSessionReadyFrameSchema,
  npcSnapshotsFrameSchema,
  npcSoulBindingSchema,
  parseNpcWireEnvelope,
  resolveNpcDecisionDeadlineMs,
  type NpcBudgetState,
  type NpcDecisionWire,
  type NpcDecisionDeadline,
  type NpcEpisodeSummary,
  type NpcSessionRequest,
  type NpcSoulBinding,
  type NpcSessionResponse,
  type NpcWireEnvelope,
  type PerceptionSnapshot,
  type ResumeRequest,
} from '@forgeax/types/npc-protocol';

export {
  NPC_LIMITS,
  NPC_PROTOCOL_VERSION,
  NPC_DECISION_DEADLINE_PRESETS_MS,
  NPC_DEFAULT_DECISION_DEADLINE_PRESET,
  affordanceSchema,
  emotionSchema,
  intentSchema,
  npcAttachFrameSchema,
  npcBudgetFrameSchema,
  npcBudgetStateSchema,
  npcDecisionFrameSchema,
  npcDecisionDeadlineSchema,
  npcDecisionsFrameSchema,
  npcDecisionWireSchema,
  npcDetachFrameSchema,
  npcEpisodeSummarySchema,
  npcErrorFrameSchema,
  npcHeartbeatFrameSchema,
  npcSessionRequestSchema,
  npcSessionResponseSchema,
  npcSessionReadyFrameSchema,
  npcSnapshotsFrameSchema,
  npcSoulBindingSchema,
  parseNpcWireEnvelope,
  resolveNpcDecisionDeadlineMs,
  perceptionSnapshotSchema,
  resumeRequestSchema,
  utteranceSchema,
};

const boundedId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const memoryOperationSchema = z.object({
  kind: z.enum(['episode', 'trait']),
  text: z.string().min(1).max(500),
  sourceEventId: boundedId,
}).strict();

export const npcDecisionInternalSchema = z.object({
  intent: intentSchema.optional(),
  utterance: utteranceSchema.optional(),
  emotion: emotionSchema.optional(),
  memoryOps: z.array(memoryOperationSchema).max(8).optional(),
}).strict();

/**
 * The protocol may carry larger snapshot/decision batches, but a single
 * structured-output request is intentionally smaller.  This is a provider
 * compatibility cap, not a wire-protocol limit: callers chunk larger work
 * before model admission and the Zod parser remains the authority below.
 */
export const NPC_MODEL_BATCH_CAP = 8;

export const npcBatchDecisionInternalSchema = z.object({
  decisions: z.array(z.object({
    npcId: boundedId,
    decision: npcDecisionInternalSchema,
  }).strict()).max(NPC_MODEL_BATCH_CAP),
}).strict();

export type {
  NpcBudgetState,
  NpcDecisionWire,
  NpcDecisionDeadline,
  NpcEpisodeSummary,
  NpcSessionRequest,
  NpcSoulBinding,
  NpcSessionResponse,
  NpcWireEnvelope,
  PerceptionSnapshot,
  ResumeRequest,
};
export type NpcDecisionInternal = z.infer<typeof npcDecisionInternalSchema>;
export type NpcBatchDecisionInternal = z.infer<typeof npcBatchDecisionInternalSchema>;
export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

/**
 * OpenAI-compatible strict JSON schemas do not have optional object
 * properties: every property must be listed in `required`.  The wire schema
 * and the internal Zod schema intentionally keep these fields optional, so
 * the structured-output schema below represents absence as `null`.  Keep the
 * conversion at the boundary instead of weakening the internal validators.
 */
export function normalizeNpcDecisionJson(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const decision = { ...(value as Record<string, unknown>) };
  for (const key of ['intent', 'utterance', 'emotion', 'memoryOps']) {
    if (decision[key] === null) delete decision[key];
  }
  if (decision.intent && typeof decision.intent === 'object' && !Array.isArray(decision.intent)) {
    const intent = { ...(decision.intent as Record<string, unknown>) };
    if (intent.params === null) delete intent.params;
    decision.intent = intent;
  }
  if (decision.emotion && typeof decision.emotion === 'object' && !Array.isArray(decision.emotion)) {
    const emotion = { ...(decision.emotion as Record<string, unknown>) };
    if (emotion.towards === null) delete emotion.towards;
    decision.emotion = emotion;
  }
  return decision;
}

export function parseNpcDecisionInternal(value: unknown): NpcDecisionInternal {
  return npcDecisionInternalSchema.parse(normalizeNpcDecisionJson(value));
}

export function parseNpcBatchDecisionInternal(value: unknown): NpcBatchDecisionInternal {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const batch = value as Record<string, unknown>;
    if (Array.isArray(batch.decisions)) {
      value = {
        ...batch,
        decisions: batch.decisions.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          const entry = { ...(item as Record<string, unknown>) };
          entry.decision = normalizeNpcDecisionJson(entry.decision);
          return entry;
        }),
      };
    }
  }
  return npcBatchDecisionInternalSchema.parse(value);
}

export function toWireDecision(
  npcId: string,
  seq: number,
  decision: NpcDecisionInternal,
  fallback = false,
): NpcDecisionWire {
  return npcDecisionWireSchema.parse({
    v: NPC_PROTOCOL_VERSION,
    npcId,
    seq,
    intent: decision.intent,
    utterance: decision.utterance,
    emotion: decision.emotion,
    ...(fallback ? { fallback: true } : {}),
  });
}

const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({
  anyOf: [schema, { type: 'null' }],
});

const intentJsonSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', minLength: 1, maxLength: 128 },
    params: nullable({ type: 'object', additionalProperties: { type: 'string', maxLength: 128 } }),
    ttlSec: { type: 'integer', minimum: 1, maximum: 300 },
  },
  required: ['action', 'params', 'ttlSec'],
};

const utteranceJsonSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: { lines: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 48 } } },
  required: ['lines'],
};

const emotionJsonSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    mood: { type: 'string', minLength: 1, maxLength: 40 },
    towards: nullable({ type: 'object', additionalProperties: { type: 'number', minimum: -1, maximum: 1 } }),
  },
  required: ['mood', 'towards'],
};

export const npcDecisionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: nullable(intentJsonSchema),
    utterance: nullable(utteranceJsonSchema),
    emotion: nullable(emotionJsonSchema),
    memoryOps: nullable({
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['episode', 'trait'] },
          text: { type: 'string', minLength: 1, maxLength: 500 },
          sourceEventId: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['kind', 'text', 'sourceEventId'],
      },
    }),
  },
  required: ['intent', 'utterance', 'emotion', 'memoryOps'],
};

/**
 * Derive the batch generation schema from the single-decision schema.  Some
 * gateways (notably Gemini's structured-output compiler) turn every nested
 * length/range bound into a large state machine.  Batch generation therefore
 * removes only generation-time bounds; the complete internal Zod schema above
 * still rejects malformed or oversized provider output locally.
 */
function withoutGenerationBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGenerationBounds);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'min' || key === 'max' || key === 'minLength' || key === 'maxLength'
      || key === 'minItems' || key === 'maxItems' || key === 'minimum' || key === 'maximum') continue;
    result[key] = withoutGenerationBounds(child);
  }
  return result;
}

export const npcBatchDecisionGenerationDecisionJsonSchema = withoutGenerationBounds(npcDecisionJsonSchema) as Record<string, unknown>;

export const npcBatchDecisionGenerationJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisions: {
      type: 'array',
      maxItems: NPC_MODEL_BATCH_CAP,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          npcId: { type: 'string' },
          decision: npcBatchDecisionGenerationDecisionJsonSchema,
        },
        required: ['npcId', 'decision'],
      },
    },
  },
  required: ['decisions'],
};

/** Backward-compatible name for callers that consume the model batch schema. */
export const npcBatchDecisionJsonSchema = npcBatchDecisionGenerationJsonSchema;
