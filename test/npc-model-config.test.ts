import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NPC_FALLBACK,
  DEFAULT_NPC_MODEL,
  NPC_MAX_TOKENS_CAP,
  NPC_TIMEOUT_MS_CAP,
  resolveNpcModel,
} from '../src/npc-brain/model-config';

let TMP = '';

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'fx-npc-model-'));
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function root(name: string): string {
  const path = join(TMP, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe('resolveNpcModel precedence', () => {
  test('defaults to PRD model and fallback when no config exists', () => {
    const resolved = resolveNpcModel({ projectRoot: root('default'), env: {} });
    expect(resolved.model).toBe(DEFAULT_NPC_MODEL);
    expect(resolved.fallback).toEqual([...DEFAULT_NPC_FALLBACK]);
    expect(resolved.source).toBe('default');
    expect(resolved.maxTokens).toBe(NPC_MAX_TOKENS_CAP);
    expect(resolved.timeoutMs).toBe(NPC_TIMEOUT_MS_CAP);
    expect(resolved.showThinking).toBe(false);
    expect(resolved.reasoningEffort).toBeUndefined();
  });

  test('FORGEAX_NPC_MODEL overrides product default but keeps host default fallback', () => {
    const resolved = resolveNpcModel({
      projectRoot: root('env'),
      env: { FORGEAX_NPC_MODEL: 'env-npc-model' },
    });
    expect(resolved.model).toBe('env-npc-model');
    expect(resolved.fallback).toEqual([...DEFAULT_NPC_FALLBACK]);
    expect(resolved.source).toBe('env');
  });

  test('.forgeax/npc-brain.json beats env and carries fallback plus enforceable budget', () => {
    const projectRoot = root('global');
    writeJson(join(projectRoot, '.forgeax', 'npc-brain.json'), {
      model: 'global-model',
      fallback: ['global-fallback-a', 'global-fallback-b'],
      budget: { maxCallsPerMinute: 12, maxConcurrent: 3 },
    });

    const resolved = resolveNpcModel({
      projectRoot,
      env: { FORGEAX_NPC_MODEL: 'env-model' },
    });
    expect(resolved.model).toBe('global-model');
    expect(resolved.fallback).toEqual(['global-fallback-a', 'global-fallback-b']);
    expect(resolved.source).toBe('global');
    expect(resolved.budget).toEqual({ maxCallsPerMinute: 12, maxConcurrent: 3 });
  });

  test('rejects dollar budgets that the provider cannot authoritatively meter', () => {
    const projectRoot = root('unsupported-cost');
    writeJson(join(projectRoot, '.forgeax', 'npc-brain.json'), {
      model: 'global-model',
      budget: { maxCostUsd: 1.5 },
    });
    expect(() => resolveNpcModel({ projectRoot })).toThrow('maxCostUsd is unsupported');
  });

  test('game forge.json::npc beats global config', () => {
    const projectRoot = root('game');
    writeJson(join(projectRoot, '.forgeax', 'npc-brain.json'), {
      model: 'global-model',
      fallback: ['global-fallback'],
    });
    writeJson(join(projectRoot, '.forgeax', 'games', 'town', 'forge.json'), {
      id: 'town',
      npc: { model: 'game-model', fallback: ['game-fallback'], maxTokens: 300 },
    });

    const resolved = resolveNpcModel({ projectRoot, game: 'town', env: {} });
    expect(resolved.model).toBe('game-model');
    expect(resolved.fallback).toEqual(['game-fallback']);
    expect(resolved.source).toBe('game');
    expect(resolved.maxTokens).toBe(300);
  });

  test('single-NPC soul agent.json-style models.model beats game config', () => {
    const projectRoot = root('soul-models');
    writeJson(join(projectRoot, '.forgeax', 'games', 'town', 'forge.json'), {
      id: 'town',
      npc: { model: 'game-model', fallback: ['game-fallback'] },
    });

    const resolved = resolveNpcModel({
      projectRoot,
      game: 'town',
      soulModels: { model: ['soul-main', 'soul-fallback-a', 'soul-fallback-b'] },
      env: {},
    });
    expect(resolved.model).toBe('soul-main');
    expect(resolved.fallback).toEqual(['soul-fallback-a', 'soul-fallback-b']);
    expect(resolved.source).toBe('soul');
  });

  test('soul pack agent.json and manifest.json model fields are both supported', () => {
    const projectRoot = root('soul-pack');
    const agentPack = join(projectRoot, 'agent-pack');
    mkdirSync(agentPack, { recursive: true });
    writeJson(join(agentPack, 'agent.json'), {
      models: { model: ['agent-json-main', 'agent-json-fallback'] },
    });
    writeJson(join(agentPack, 'manifest.json'), {
      models: { model: ['manifest-main', 'manifest-fallback'] },
    });

    const fromAgentJson = resolveNpcModel({
      projectRoot,
      soulRecord: { packDir: agentPack },
      env: {},
    });
    expect(fromAgentJson.model).toBe('agent-json-main');
    expect(fromAgentJson.fallback).toEqual(['agent-json-fallback']);

    const manifestOnly = join(projectRoot, 'manifest-pack');
    mkdirSync(manifestOnly, { recursive: true });
    writeJson(join(manifestOnly, 'manifest.json'), {
      models: { model: ['manifest-main', 'manifest-fallback'] },
    });
    const fromManifest = resolveNpcModel({
      projectRoot,
      soulRecord: { packDir: manifestOnly },
      env: {},
    });
    expect(fromManifest.model).toBe('manifest-main');
    expect(fromManifest.fallback).toEqual(['manifest-fallback']);
  });
});

describe('resolveNpcModel fail-fast parsing', () => {
  test('invalid .forgeax/npc-brain.json throws clear error', () => {
    const projectRoot = root('bad-global');
    mkdirSync(join(projectRoot, '.forgeax'), { recursive: true });
    writeFileSync(join(projectRoot, '.forgeax', 'npc-brain.json'), '{not-json');

    expect(() => resolveNpcModel({ projectRoot, env: {} }))
      .toThrow(/NPC model config: invalid \.forgeax\/npc-brain\.json/);
  });

  test('invalid forge.json throws clear error', () => {
    const projectRoot = root('bad-forge-json');
    const gameDir = join(projectRoot, '.forgeax', 'games', 'broken');
    mkdirSync(gameDir, { recursive: true });
    writeFileSync(join(gameDir, 'forge.json'), '{bad');

    expect(() => resolveNpcModel({ projectRoot, game: 'broken', env: {} }))
      .toThrow(/NPC model config: invalid game forge\.json/);
  });

  test('malformed forge.json::npc throws clear error', () => {
    const projectRoot = root('bad-forge-npc');
    writeJson(join(projectRoot, '.forgeax', 'games', 'broken', 'forge.json'), {
      id: 'broken',
      npc: { model: 42 },
    });

    expect(() => resolveNpcModel({ projectRoot, game: 'broken', env: {} }))
      .toThrow(/forge\.json::npc.*model must be a string or string array/);
  });
});

describe('resolveNpcModel host clamp', () => {
  test('host clamp caps expensive settings and records downgrade reasons', () => {
    const resolved = resolveNpcModel({
      projectRoot: root('clamp'),
      soulModels: {
        model: 'thinking-model',
        fallback: ['thinking-model', 'safe-fallback'],
        maxTokens: 9000,
        timeout: -1,
        reasoningEffort: 'high',
        showThinking: true,
      },
      env: {},
    });

    expect(resolved.model).toBe('thinking-model');
    expect(resolved.fallback).toEqual(['safe-fallback']);
    expect(resolved.maxTokens).toBe(NPC_MAX_TOKENS_CAP);
    expect(resolved.timeoutMs).toBe(NPC_TIMEOUT_MS_CAP);
    expect(resolved.showThinking).toBe(false);
    expect(resolved.reasoningEffort).toBeUndefined();
    expect(resolved.downgradeReasons).toEqual([
      'maxTokens 9000 exceeds NPC host cap 500; capped',
      'timeout -1 disables the model timeout; capped to 12000ms',
      'reasoningEffort high disabled for NPC Brain non-thinking calls',
      'showThinking true disabled for NPC Brain non-thinking calls',
    ]);
  });
});
