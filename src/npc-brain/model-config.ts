import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

// The live pro samples missed the PRD P50 gate (2.5s), so the shipping default
// follows the specified downgrade policy. Pro remains available as an explicit
// Soul/game/global override.
export const DEFAULT_NPC_MODEL = 'deepseek-v4-flash-openai';
export const DEFAULT_NPC_FALLBACK: readonly string[] = [];
export const NPC_MAX_TOKENS_CAP = 500;
export const NPC_TIMEOUT_MS_CAP = 12_000;
const GAME_MANIFEST_NAME = ['forge', 'json'].join('.');

export type NpcModelSource = 'soul' | 'game' | 'global' | 'env' | 'default';
export type NpcReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface NpcBudgetConfig {
  maxCallsPerMinute?: number;
  maxTokensPerMinute?: number;
  maxConcurrent?: number;
}

export interface NpcResolvedModel {
  model: string;
  /** Ordered fallback chain passed after the primary model. */
  fallback: string[];
  source: NpcModelSource;
  sourcePath?: string;
  /** Host-enforced single-shot output cap for NPC Brain calls. */
  maxTokens: number;
  /** Host-enforced single-shot timeout cap for NPC Brain calls. */
  timeoutMs: number;
  /** Carried through when configured; Brain still clamps thinking-related fields off. */
  temperature?: number;
  showThinking: false;
  reasoningEffort?: undefined;
  budget?: NpcBudgetConfig;
  /** Human-readable audit trail for host clamp downgrades. */
  downgradeReasons: string[];
}

export interface ResolveNpcModelInput {
  projectRoot: string;
  /** Game slug, absolute game directory, or absolute game-manifest path. */
  game?: string | null;
  /** Direct per-soul `models` object, or the raw `models.model` value. */
  soulModels?: unknown;
  /** Optional loader-side record; supports `models`, `manifest`, or a pack dir/path. */
  soulRecord?: unknown;
  env?: Record<string, string | undefined>;
}

interface ModelCandidate {
  model: string;
  fallback?: string[];
  fallbackExplicit: boolean;
  source: NpcModelSource;
  sourcePath?: string;
  maxTokens?: number | null;
  timeout?: number | null;
  timeoutMs?: number | null;
  temperature?: number | null;
  reasoningEffort?: NpcReasoningEffort | string | null;
  showThinking?: boolean;
  budget?: NpcBudgetConfig;
}

interface RawModelConfig {
  model?: unknown;
  fallback?: unknown;
  fallbackModels?: unknown;
  maxTokens?: unknown;
  timeout?: unknown;
  timeoutMs?: unknown;
  temperature?: unknown;
  reasoningEffort?: unknown;
  showThinking?: unknown;
  budget?: unknown;
}

/**
 * Resolve the model preference for one NPC Brain call.
 *
 * Precedence is PRD §3.3: per-soul agent.json/manifest model > game manifest npc.model
 * > `.forgeax/npc-brain.json` > FORGEAX_NPC_MODEL > product default. Host clamp runs last
 * and records every downgrade so the decision log can audit why a preference was changed.
 */
export function resolveNpcModel(input: ResolveNpcModelInput): NpcResolvedModel {
  const projectRoot = resolve(input.projectRoot);
  const candidate =
    resolveSoulCandidate(input.soulModels, input.soulRecord)
    ?? resolveGameCandidate(projectRoot, input.game)
    ?? resolveGlobalCandidate(projectRoot)
    ?? resolveEnvCandidate(input.env ?? process.env)
    ?? defaultCandidate();
  return applyHostClamp(candidate);
}

export function resolveNpcGlobalBudget(projectRoot: string): NpcBudgetConfig | undefined {
  const path = join(resolve(projectRoot), '.forgeax', 'npc-brain.json');
  if (!existsSync(path)) return undefined;
  const config = asRecord(readRequiredJson(path, '.forgeax/npc-brain.json'));
  if (!config) throw new Error(`NPC model config: .forgeax/npc-brain.json at ${path} must be a JSON object`);
  return parseBudget(config.budget, '.forgeax/npc-brain.json');
}

export function resolveNpcGameBudget(
  projectRoot: string,
  game: string,
): NpcBudgetConfig | undefined {
  const path = findForgeJson(resolve(projectRoot), game);
  if (!path) return undefined;
  const config = asRecord(readRequiredJson(path, `game ${GAME_MANIFEST_NAME}`));
  const npc = asRecord(config?.npc);
  if (!npc) return undefined;
  return parseBudget(npc.budget, `${GAME_MANIFEST_NAME}::npc at ${path}`);
}

function resolveSoulCandidate(soulModels: unknown, soulRecord: unknown): ModelCandidate | null {
  if (soulModels !== undefined) {
    return candidateFromModelConfig(soulModels, 'soul models', 'soul') ?? null;
  }

  const record = asRecord(soulRecord);
  if (!record) return null;

  const direct = candidateFromModelConfig(record.models, 'soulRecord.models', 'soul');
  if (direct) return direct;

  const manifest = candidateFromModelConfig(
    asRecord(record.manifest)?.models ?? record.manifest,
    'soulRecord.manifest',
    'soul',
  );
  if (manifest) return manifest;

  const dir = stringField(record, 'packDir') ?? stringField(record, 'dir') ?? stringField(record, 'root');
  if (!dir) return null;

  const agentJson = readOptionalJson(join(dir, 'agent.json'), 'soul agent.json');
  const fromAgent = candidateFromModelConfig(asRecord(agentJson)?.models, 'soul agent.json::models', 'soul', join(dir, 'agent.json'));
  if (fromAgent) return fromAgent;

  const manifestJson = readOptionalJson(join(dir, 'manifest.json'), 'soul manifest.json');
  return candidateFromModelConfig(asRecord(manifestJson)?.models, 'soul manifest.json::models', 'soul', join(dir, 'manifest.json'));
}

function resolveGameCandidate(projectRoot: string, game: string | null | undefined): ModelCandidate | null {
  const forgeJson = findForgeJson(projectRoot, game);
  if (!forgeJson) return null;
  const parsed = readRequiredJson(forgeJson, `game ${GAME_MANIFEST_NAME}`);
  const root = asRecord(parsed);
  if (!root) throw new Error(`NPC model config: game ${GAME_MANIFEST_NAME} at ${forgeJson} must be a JSON object`);
  if (root.npc === undefined) return null;
  const npc = asRecord(root.npc);
  if (!npc) throw new Error(`NPC model config: ${GAME_MANIFEST_NAME}::npc at ${forgeJson} must be an object`);
  return candidateFromModelConfig(npc, `${GAME_MANIFEST_NAME}::npc at ${forgeJson}`, 'game', forgeJson);
}

function resolveGlobalCandidate(projectRoot: string): ModelCandidate | null {
  const path = join(projectRoot, '.forgeax', 'npc-brain.json');
  if (!existsSync(path)) return null;
  const parsed = readRequiredJson(path, '.forgeax/npc-brain.json');
  const cfg = asRecord(parsed);
  if (!cfg) throw new Error(`NPC model config: .forgeax/npc-brain.json at ${path} must be a JSON object`);
  return candidateFromModelConfig(cfg, `.forgeax/npc-brain.json at ${path}`, 'global', path);
}

function resolveEnvCandidate(env: Record<string, string | undefined>): ModelCandidate | null {
  const raw = env.FORGEAX_NPC_MODEL?.trim();
  if (!raw) return null;
  return {
    model: raw,
    source: 'env',
    fallbackExplicit: false,
  };
}

function defaultCandidate(): ModelCandidate {
  return {
    model: DEFAULT_NPC_MODEL,
    fallback: [...DEFAULT_NPC_FALLBACK],
    fallbackExplicit: true,
    source: 'default',
  };
}

function candidateFromModelConfig(
  value: unknown,
  label: string,
  source: NpcModelSource,
  sourcePath?: string,
): ModelCandidate | null {
  if (value === undefined || value === null) return null;

  const cfg = normalizeModelConfig(value, label);
  const parsedModel = parseModelValue(cfg.model, label);
  const parsedFallback = parseFallbackValue(cfg.fallback ?? cfg.fallbackModels, label);
  const budget = parseBudget(cfg.budget, label);

  if (!parsedModel.model) {
    if (parsedFallback.explicit) throw new Error(`NPC model config: ${label} declares fallback without model`);
    return null;
  }

  return {
    model: parsedModel.model,
    fallback: [...parsedModel.fallback, ...parsedFallback.values],
    fallbackExplicit: parsedModel.fallback.length > 0 || parsedFallback.explicit,
    source,
    ...(sourcePath ? { sourcePath } : {}),
    maxTokens: optionalNumber(cfg.maxTokens, `${label}.maxTokens`, { positive: true, integer: true }),
    timeout: optionalNumber(cfg.timeout, `${label}.timeout`, { allowMinusOne: true, positive: true, integer: true }),
    timeoutMs: optionalNumber(cfg.timeoutMs, `${label}.timeoutMs`, { positive: true, integer: true }),
    temperature: optionalNumber(cfg.temperature, `${label}.temperature`, { min: 0, max: 2 }),
    reasoningEffort: optionalNpcReasoningEffort(cfg.reasoningEffort, `${label}.reasoningEffort`),
    showThinking: optionalBoolean(cfg.showThinking, `${label}.showThinking`),
    ...(budget ? { budget } : {}),
  };
}

function normalizeModelConfig(value: unknown, label: string): RawModelConfig {
  if (typeof value === 'string' || Array.isArray(value)) return { model: value };
  const cfg = asRecord(value);
  if (!cfg) throw new Error(`NPC model config: ${label} must be a model string, model array, or object`);
  return cfg as RawModelConfig;
}

function parseModelValue(value: unknown, label: string): { model?: string; fallback: string[] } {
  if (value === undefined || value === null) return { fallback: [] };
  if (typeof value === 'string') {
    const model = value.trim();
    if (!model) throw new Error(`NPC model config: ${label}.model must not be empty`);
    return { model, fallback: [] };
  }
  if (!Array.isArray(value)) throw new Error(`NPC model config: ${label}.model must be a string or string array`);
  const clean = value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`NPC model config: ${label}.model[${index}] must be a string`);
    const trimmed = entry.trim();
    if (!trimmed) throw new Error(`NPC model config: ${label}.model[${index}] must not be empty`);
    return trimmed;
  });
  if (clean.length === 0) throw new Error(`NPC model config: ${label}.model array must not be empty`);
  return { model: clean[0], fallback: clean.slice(1) };
}

function parseFallbackValue(value: unknown, label: string): { explicit: boolean; values: string[] } {
  if (value === undefined || value === null) return { explicit: false, values: [] };
  if (!Array.isArray(value)) throw new Error(`NPC model config: ${label}.fallback must be a string array`);
  return {
    explicit: true,
    values: value.map((entry, index) => {
      if (typeof entry !== 'string') throw new Error(`NPC model config: ${label}.fallback[${index}] must be a string`);
      const trimmed = entry.trim();
      if (!trimmed) throw new Error(`NPC model config: ${label}.fallback[${index}] must not be empty`);
      return trimmed;
    }),
  };
}

function parseBudget(value: unknown, label: string): NpcBudgetConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const budget = asRecord(value);
  if (!budget) throw new Error(`NPC model config: ${label}.budget must be an object`);
  const out: NpcBudgetConfig = {};
  if (budget.maxCostUsd !== undefined) {
    throw new Error(`NPC model config: ${label}.budget.maxCostUsd is unsupported because the gateway exposes no authoritative cost usage; use calls/tokens limits`);
  }
  const maxCallsPerMinute = optionalNumber(budget.maxCallsPerMinute, `${label}.budget.maxCallsPerMinute`, { min: 0, integer: true });
  const maxTokensPerMinute = optionalNumber(budget.maxTokensPerMinute, `${label}.budget.maxTokensPerMinute`, { min: 0, integer: true });
  const maxConcurrent = optionalNumber(budget.maxConcurrent, `${label}.budget.maxConcurrent`, { min: 0, integer: true });
  if (maxCallsPerMinute !== undefined) out.maxCallsPerMinute = maxCallsPerMinute;
  if (maxTokensPerMinute !== undefined) out.maxTokensPerMinute = maxTokensPerMinute;
  if (maxConcurrent !== undefined) out.maxConcurrent = maxConcurrent;
  return Object.keys(out).length ? out : undefined;
}

function applyHostClamp(candidate: ModelCandidate): NpcResolvedModel {
  const downgradeReasons: string[] = [];
  const fallback = dedupeFallback(
    candidate.model,
    candidate.fallbackExplicit ? candidate.fallback ?? [] : [...DEFAULT_NPC_FALLBACK],
  );

  let maxTokens = candidate.maxTokens ?? NPC_MAX_TOKENS_CAP;
  if (maxTokens > NPC_MAX_TOKENS_CAP) {
    downgradeReasons.push(`maxTokens ${maxTokens} exceeds NPC host cap ${NPC_MAX_TOKENS_CAP}; capped`);
    maxTokens = NPC_MAX_TOKENS_CAP;
  }

  const rawTimeout = candidate.timeoutMs ?? candidate.timeout ?? NPC_TIMEOUT_MS_CAP;
  let timeoutMs = rawTimeout === -1 ? NPC_TIMEOUT_MS_CAP : rawTimeout;
  if (rawTimeout === -1) {
    downgradeReasons.push(`timeout -1 disables the model timeout; capped to ${NPC_TIMEOUT_MS_CAP}ms`);
  } else if (timeoutMs > NPC_TIMEOUT_MS_CAP) {
    downgradeReasons.push(`timeout ${timeoutMs}ms exceeds NPC host cap ${NPC_TIMEOUT_MS_CAP}ms; capped`);
    timeoutMs = NPC_TIMEOUT_MS_CAP;
  }

  if (candidate.reasoningEffort !== undefined && candidate.reasoningEffort !== null) {
    downgradeReasons.push(`reasoningEffort ${String(candidate.reasoningEffort)} disabled for NPC Brain non-thinking calls`);
  }
  if (candidate.showThinking === true) {
    downgradeReasons.push('showThinking true disabled for NPC Brain non-thinking calls');
  }

  return {
    model: candidate.model,
    fallback,
    source: candidate.source,
    ...(candidate.sourcePath ? { sourcePath: candidate.sourcePath } : {}),
    maxTokens,
    timeoutMs,
    ...(candidate.temperature !== undefined && candidate.temperature !== null ? { temperature: candidate.temperature } : {}),
    showThinking: false,
    ...(candidate.budget ? { budget: candidate.budget } : {}),
    downgradeReasons,
  };
}

function dedupeFallback(model: string, fallback: string[]): string[] {
  const seen = new Set([model]);
  const out: string[] = [];
  for (const item of fallback) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function findForgeJson(projectRoot: string, game: string | null | undefined): string | null {
  if (!game) return null;
  if (isAbsolute(game)) {
    const path = basename(game) === GAME_MANIFEST_NAME ? game : join(game, GAME_MANIFEST_NAME);
    return existsSync(path) ? path : null;
  }
  const candidates = [
    join(projectRoot, '.forgeax', 'games', game, GAME_MANIFEST_NAME),
    join(projectRoot, 'games', game, GAME_MANIFEST_NAME),
    join(projectRoot, game, GAME_MANIFEST_NAME),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function readOptionalJson(path: string, label: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  return readRequiredJson(path, label);
}

function readRequiredJson(path: string, label: string): unknown {
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`NPC model config: invalid ${label} at ${path}: ${message}`);
  }
}

function optionalNumber(
  value: unknown,
  label: string,
  opts: { positive?: boolean; allowMinusOne?: boolean; integer?: boolean; min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`NPC model config: ${label} must be a finite number`);
  if (opts.integer && !Number.isInteger(value)) throw new Error(`NPC model config: ${label} must be an integer`);
  if (opts.allowMinusOne && value === -1) return value;
  if (opts.positive && value <= 0) throw new Error(`NPC model config: ${label} must be positive`);
  if (opts.min !== undefined && value < opts.min) throw new Error(`NPC model config: ${label} must be >= ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) throw new Error(`NPC model config: ${label} must be <= ${opts.max}`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`NPC model config: ${label} must be a boolean`);
  return value;
}

function optionalNpcReasoningEffort(value: unknown, label: string): NpcReasoningEffort | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`NPC model config: ${label} must be a string or null`);
  const allowed = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  if (!allowed.has(value)) throw new Error(`NPC model config: ${label} has unsupported value ${value}`);
  return value as NpcReasoningEffort;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
