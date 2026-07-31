import { z } from 'zod';
import {
  NPC_LIMITS,
  NPC_PROTOCOL_VERSION,
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
  type NpcBudgetState,
  type NpcDecisionWire,
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
  affordanceSchema,
  emotionSchema,
  intentSchema,
  npcAttachFrameSchema,
  npcBudgetFrameSchema,
  npcBudgetStateSchema,
  npcDecisionFrameSchema,
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

export const npcBatchDecisionInternalSchema = z.object({
  decisions: z.array(z.object({
    npcId: boundedId,
    decision: npcDecisionInternalSchema,
  }).strict()).max(NPC_LIMITS.maxBatchSize),
}).strict();

export type {
  NpcBudgetState,
  NpcDecisionWire,
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

export const npcDecisionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', minLength: 1, maxLength: 128 },
        params: { type: 'object', additionalProperties: { type: 'string', maxLength: 128 } },
        ttlSec: { type: 'integer', minimum: 1, maximum: 300 },
      },
      required: ['action', 'ttlSec'],
    },
    utterance: {
      type: 'object', additionalProperties: false,
      properties: { lines: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 48 } } },
      required: ['lines'],
    },
    emotion: {
      type: 'object', additionalProperties: false,
      properties: { mood: { type: 'string', minLength: 1, maxLength: 40 }, towards: { type: 'object', additionalProperties: { type: 'number', minimum: -1, maximum: 1 } } },
      required: ['mood'],
    },
    memoryOps: {
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
    },
  },
};

export const npcBatchDecisionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisions: {
      type: 'array',
      maxItems: NPC_LIMITS.maxBatchSize,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          npcId: { type: 'string', minLength: 1, maxLength: 128 },
          decision: npcDecisionJsonSchema,
        },
        required: ['npcId', 'decision'],
      },
    },
  },
  required: ['decisions'],
};
