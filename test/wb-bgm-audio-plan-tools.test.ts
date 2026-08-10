import { describe, expect, test } from 'bun:test';
import applyAudioPlan from '../builtin/kits/bgm/tools/apply-audio-plan';
import applyAudioProject from '../builtin/kits/bgm/tools/apply-audio-project';
import attachAudio from '../builtin/kits/bgm/tools/attach-audio';
import listAudio from '../builtin/kits/bgm/tools/list-audio';
import getAudioProject from '../builtin/kits/bgm/tools/get-audio-project';
import inspectAudioEvents from '../builtin/kits/bgm/tools/inspect-audio-events';
import patchAudioProject from '../builtin/kits/bgm/tools/patch-audio-project';
import resolveAudioPlan from '../builtin/kits/bgm/tools/resolve-audio-plan';
import searchAudio from '../builtin/kits/bgm/tools/search-audio';
import searchBgm from '../builtin/kits/bgm/tools/search-bgm';
import searchAudioV2 from '../builtin/kits/bgm/tools/search-audio-v2';
import verifyAudioProject from '../builtin/kits/bgm/tools/verify-audio-project';
import { BGM_TOOL_SPECS } from '../src/lib/wb-bgm/tool-specs';
import type { AgentContext } from '../src/core/types';

const context = {} as AgentContext;

describe('wb-bgm native-agent audio plan surface', () => {
  test('catalog exposes structured BGM search plus the batch SFX flow', () => {
    expect(BGM_TOOL_SPECS.map((tool) => tool.name)).toEqual([
      'search-bgm',
      'resolve-audio-plan',
      'apply-audio-plan',
      'inspect-audio-events',
      'get-audio-project',
      'patch-audio-project',
      'apply-audio-project',
      'verify-audio-project',
    ]);
    expect(searchAudio.input_schema.properties.kind).toMatchObject({
      enum: ['bgm'],
    });
    expect(searchBgm.input_schema.properties.scene).toMatchObject({
      enum: expect.arrayContaining(['boss_combat', 'exploration_ambient']),
    });
  });

  test('native tools hide the old SFX step-by-step flow', () => {
    expect(searchBgm.condition?.(context, searchBgm) ?? true).toBe(true);
    expect(resolveAudioPlan.condition?.(context, resolveAudioPlan) ?? true).toBe(true);
    expect(applyAudioPlan.condition?.(context, applyAudioPlan) ?? true).toBe(true);
    expect(inspectAudioEvents.condition?.(context, inspectAudioEvents) ?? true).toBe(true);
    expect(getAudioProject.condition?.(context, getAudioProject) ?? true).toBe(true);
    expect(patchAudioProject.condition?.(context, patchAudioProject) ?? true).toBe(true);
    expect(applyAudioProject.condition?.(context, applyAudioProject) ?? true).toBe(true);
    expect(verifyAudioProject.condition?.(context, verifyAudioProject) ?? true).toBe(true);

    expect(searchAudioV2.condition?.(context, searchAudioV2)).toBe(false);
    expect(attachAudio.condition?.(context, attachAudio)).toBe(false);
    expect(listAudio.condition?.(context, listAudio)).toBe(false);
  });

  test('apply schema accepts resolve output without an intermediate list call', () => {
    expect(applyAudioPlan.description).toContain('不要在调用前再调用list-audio');
    expect(applyAudioPlan.input_schema.required).toEqual([
      'slug',
      'planId',
      'items',
    ]);
    expect(resolveAudioPlan.input_schema.required).toEqual(['projectId', 'items']);
  });

  test('binding tools expose revision-safe drafting and explicit apply inputs', () => {
    expect(inspectAudioEvents.input_schema.required).toEqual(['slug']);
    expect(getAudioProject.input_schema.required).toEqual(['slug']);
    expect(patchAudioProject.input_schema.required).toEqual(['slug', 'expectedRevision']);
    expect(patchAudioProject.input_schema.properties).toHaveProperty('upsertBindings');
    expect(patchAudioProject.input_schema.properties).toHaveProperty('removeEventIds');
    expect(applyAudioProject.input_schema.required).toEqual(['slug', 'expectedRevision']);
    expect(verifyAudioProject.input_schema.required).toEqual(['slug']);
  });
});
