import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpcBrainService } from '../src/npc-brain/service';
import {
  npcBatchDecisionJsonSchema,
  npcDecisionJsonSchema,
  NPC_MODEL_BATCH_CAP,
  parseNpcBatchDecisionInternal,
  parseNpcDecisionInternal,
} from '../src/npc-brain/protocol';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), 'npc-strict-schema-'));
  roots.push(value);
  return value;
}

function snapshot() {
  return {
    v: 1, eventId: 'strict-event-1', game: 'demo', npcId: 'guide', t: 1,
    trigger: 'player_message', text: 'hello',
    self: { pos: { x: 0, y: 0 }, activity: 'idle' },
    nearby: [], events: [], affordances: [{ action: 'idle' }],
  };
}

describe('NPC strict structured-output schema', () => {
  test('lists every object property as required and represents optional values as nullable', () => {
    expect(npcDecisionJsonSchema.required).toEqual(['intent', 'utterance', 'emotion', 'memoryOps']);
    const properties = npcDecisionJsonSchema.properties as Record<string, any>;
    for (const key of ['intent', 'utterance', 'emotion', 'memoryOps']) {
      expect(properties[key].anyOf).toEqual(expect.arrayContaining([{ type: 'null' }]));
    }

    const intent = properties.intent.anyOf.find((item: any) => item.type === 'object');
    expect(intent.required).toEqual(['action', 'params', 'ttlSec']);
    const intentParams = intent.properties.params;
    expect(intentParams.anyOf).toEqual(expect.arrayContaining([{ type: 'null' }]));

    const emotion = properties.emotion.anyOf.find((item: any) => item.type === 'object');
    expect(emotion.required).toEqual(['mood', 'towards']);
    expect(emotion.properties.towards.anyOf).toEqual(expect.arrayContaining([{ type: 'null' }]));

    expect(npcBatchDecisionJsonSchema.required).toEqual(['decisions']);
    const batchItem = (npcBatchDecisionJsonSchema.properties as Record<string, any>).decisions.items;
    expect(batchItem.required).toEqual(['npcId', 'decision']);
    expect(batchItem.properties.decision).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: npcDecisionJsonSchema.required,
    }));
    expect(batchItem.properties.decision).not.toBe(npcDecisionJsonSchema);
    expect((npcBatchDecisionJsonSchema.properties as Record<string, any>).decisions.maxItems)
      .toBe(NPC_MODEL_BATCH_CAP);
    expect(batchItem.properties.decision.properties.intent.anyOf[0].properties.action)
      .not.toHaveProperty('minLength');
    expect(batchItem.properties.decision.properties.utterance.anyOf[0].properties.lines.items)
      .not.toHaveProperty('maxLength');

    const forbidden = new Set([
      'min', 'max', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum',
    ]);
    const visit = (value: unknown, path = 'batch'): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (path === 'batch.properties.decisions' && key === 'maxItems') continue;
        expect(forbidden.has(key), `${path}.${key} must not be sent to batch generation`).toBe(false);
        visit(child, `${path}.${key}`);
      }
    };
    visit(npcBatchDecisionJsonSchema);
  });

  test('normalizes strict nulls while preserving legacy omitted-field inputs', () => {
    expect(parseNpcDecisionInternal({ utterance: { lines: ['hello'] } })).toEqual({
      utterance: { lines: ['hello'] },
    });
    expect(parseNpcDecisionInternal({
      intent: null,
      utterance: { lines: ['hello'] },
      emotion: { mood: 'calm', towards: null },
      memoryOps: null,
    })).toEqual({
      utterance: { lines: ['hello'] },
      emotion: { mood: 'calm' },
    });
    expect(parseNpcBatchDecisionInternal({
      decisions: [{
        npcId: 'guide',
        decision: { intent: null, utterance: { lines: ['hello'] }, emotion: null, memoryOps: null },
      }],
    })).toEqual({
      decisions: [{ npcId: 'guide', decision: { utterance: { lines: ['hello'] } } }],
    });
    expect(() => parseNpcDecisionInternal({
      intent: { action: null, params: null, ttlSec: 30 },
      utterance: null,
      emotion: null,
      memoryOps: null,
    })).toThrow();
  });

  test('accepts strict nullable gateway output and emits the existing NPC wire shape', async () => {
    let request: any;
    const brain = new NpcBrainService({
      projectRoot: root(),
      complete: async (value) => {
        request = value;
        return {
          text: JSON.stringify({
            intent: null,
            utterance: { lines: ['hello'] },
            emotion: null,
            memoryOps: null,
          }),
          model: value.model,
          transport: 'mock',
          latencyMs: 1,
        };
      },
    });

    await expect(brain.decide(snapshot())).resolves.toEqual({
      v: 1,
      npcId: 'guide',
      seq: 1,
      utterance: { lines: ['hello'] },
    });
    expect(request.responseFormat).toEqual({
      name: 'npc_decision',
      schema: npcDecisionJsonSchema,
      strict: true,
    });
  });
});
