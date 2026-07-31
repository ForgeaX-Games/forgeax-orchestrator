import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npcDecisionWireSchema } from '../src/npc-brain/protocol';

export type AttemptKind = 'success' | 'timeout' | 'provider-error' | 'invalid' | 'fallback' | 'thinking';

export interface LiveCandidate {
  endpoint: string;
  game: string;
  npcId: string;
  expectedModel: string;
  candidateSha: string;
}

export interface LiveAttempt {
  schema: 'forgeax.npc.live-attempt';
  version: 1;
  runId: string;
  attempt: number;
  eventId: string;
  kind: AttemptKind;
  elapsedMs: number;
  reason?: string;
  decision?: unknown;
  candidate: LiveCandidate;
  recordedAt: string;
}

export function classifyAttempt(
  body: unknown,
  elapsedMs: number,
  attempt: number,
  eventId: string,
  candidate: LiveCandidate,
  runId = 'fixture',
): LiveAttempt {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const reason = [value.reason, value.error].find((item): item is string => typeof item === 'string');
  const timeout = value.timeout === true || reason?.toLowerCase().includes('timeout') === true;
  let kind: AttemptKind;
  if (timeout) kind = 'timeout';
  else if (value.thinking === true || value.cache === true) kind = 'thinking';
  else if (value.fallback === true) kind = 'fallback';
  else if (value.providerError === true || value.error !== undefined) kind = 'provider-error';
  else if (value.ok !== true || !npcDecisionWireSchema.safeParse(value.decision).success) kind = 'invalid';
  else kind = 'success';
  return {
    schema: 'forgeax.npc.live-attempt',
    version: 1,
    runId,
    attempt,
    eventId,
    kind,
    elapsedMs,
    ...(reason ? { reason } : {}),
    ...(value.decision !== undefined ? { decision: value.decision } : {}),
    candidate,
    recordedAt: new Date().toISOString(),
  };
}

export function appendAttempt(path: string, row: LiveAttempt): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
}

export function nearestRank(values: readonly number[], quantile: number): number {
  if (!values.length) throw new Error('cannot calculate percentile of an empty set');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

export function summarizeAttempts(rows: readonly LiveAttempt[], candidate: LiveCandidate): Record<string, unknown> {
  const successful = rows.filter((row) => row.kind === 'success');
  const durations = successful.map((row) => row.elapsedMs);
  const counts = Object.fromEntries(
    (['success', 'timeout', 'provider-error', 'invalid', 'fallback', 'thinking'] as AttemptKind[])
      .map((kind) => [kind, rows.filter((row) => row.kind === kind).length]),
  );
  const p50Ms = durations.length ? nearestRank(durations, 0.5) : null;
  const p95Ms = durations.length ? nearestRank(durations, 0.95) : null;
  return {
    schema: 'forgeax.npc.live-summary',
    version: 1,
    candidate,
    attempts: rows.length,
    successes: successful.length,
    failures: rows.length - successful.length,
    counts,
    p50Ms,
    p95Ms,
    prdGate: {
      minimumSuccesses: 20,
      p50LimitMs: 2_500,
      p95LimitMs: 6_000,
      passed: successful.length >= 20 && p50Ms !== null && p50Ms <= 2_500 && p95Ms !== null && p95Ms <= 6_000,
    },
  };
}

async function main(): Promise<void> {
  const projectRoot = resolve(process.argv[2] ?? '../..');
  const requiredSuccesses = boundedInteger(process.env.FORGEAX_NPC_LIVE_SAMPLES ?? process.argv[3] ?? '20', 20, 200);
  const maxAttempts = boundedInteger(
    process.env.FORGEAX_NPC_LIVE_MAX_ATTEMPTS ?? String(requiredSuccesses * 3),
    requiredSuccesses,
    600,
  );
  const endpoint = (process.env.FORGEAX_NPC_LIVE_ENDPOINT ?? 'http://127.0.0.1:18900/api/npc').replace(/\/$/, '');
  const serviceToken = process.env.FORGEAX_NPC_LIVE_AUTH_TOKEN ?? '';
  const game = process.env.FORGEAX_NPC_LIVE_GAME ?? 'paopaotang';
  const npcId = process.env.FORGEAX_NPC_LIVE_NPC_ID ?? 'A';
  const expectedModel = process.env.FORGEAX_NPC_LIVE_EXPECT_MODEL ?? 'deepseek-v4-flash-openai';
  const candidateSha = process.env.FORGEAX_NPC_LIVE_CANDIDATE_SHA ?? gitHead(projectRoot);
  const candidate = { endpoint, game, npcId, expectedModel, candidateSha };
  const runId = `npc-live-${new Date().toISOString()}`;
  const evidenceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../evidence');
  const ledgerPath = process.env.FORGEAX_NPC_LIVE_LEDGER ?? join(evidenceDir, 'npc-live-attempts.jsonl');
  const summaryPath = process.env.FORGEAX_NPC_LIVE_SUMMARY ?? join(evidenceDir, 'npc-live-summary.json');
  const auditFile = process.env.FORGEAX_NPC_LIVE_AUDIT_FILE
    ?? join(projectRoot, '.forgeax/npc-brain', game, `decisions-${dateStamp()}.jsonl`);

  const sessionResponse = await fetch(`${endpoint}/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
    },
    body: JSON.stringify({ game, npcIds: [npcId], playerId: 'npc-live-latency' }),
  });
  const session = await jsonResponse(sessionResponse, 'session') as {
    sessionId?: string;
    token?: string;
    loaded?: Array<{ npcId: string; soulId: string; trustTier?: string }>;
  };
  if (!session.sessionId || !session.token) {
    throw new Error('NPC live latency: session response omitted sessionId/token');
  }

  const rows: LiveAttempt[] = [];
  while (rows.filter((row) => row.kind === 'success').length < requiredSuccesses && rows.length < maxAttempts) {
    const attempt = rows.length + 1;
    const eventId = `live-latency-${Date.now()}-${attempt}`;
    const startedAt = performance.now();
    let body: unknown;
    try {
      const response = await fetch(`${endpoint}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.token}`,
          'x-npc-session': session.sessionId,
        },
        body: JSON.stringify({
          v: 1,
          eventId,
          game,
          npcId,
          playerId: 'npc-live-latency',
          t: attempt - 1,
          trigger: 'player_message',
          text: 'Say one brief hello.',
          self: { pos: { x: 0, y: 0 }, activity: 'idle' },
          nearby: [],
          events: [],
          affordances: [{ action: 'idle' }],
        }),
      });
      body = response.ok
        ? await jsonResponse(response, `chat attempt ${attempt}`)
        : { ok: false, providerError: true, error: `HTTP ${response.status}: ${await response.text()}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      body = { ok: false, providerError: true, error: message, timeout: message.toLowerCase().includes('timeout') };
    }
    const row = classifyAttempt(body, performance.now() - startedAt, attempt, eventId, candidate, runId);
    appendAttempt(ledgerPath, row);
    rows.push(row);
  }

  const successfulEventIds = new Set(rows.filter((row) => row.kind === 'success').map((row) => row.eventId));
  if (!existsSync(auditFile)) throw new Error(`NPC live latency: local audit file not found at ${auditFile}`);
  const audit = readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      eventId?: string;
      model?: string;
      transport?: string;
      fallback?: boolean;
      thinking?: boolean;
      cache?: boolean;
    })
    .filter((entry) => entry.eventId && successfulEventIds.has(entry.eventId));
  if (audit.length !== successfulEventIds.size) {
    throw new Error(`NPC live latency: expected ${successfulEventIds.size} successful audit rows, found ${audit.length}`);
  }
  const observedModels = [...new Set(audit.map((entry) => entry.model).filter(Boolean))];
  const observedTransports = [...new Set(audit.map((entry) => entry.transport).filter(Boolean))];
  if (observedModels.length !== 1 || observedModels[0] !== expectedModel) {
    throw new Error(`NPC live latency: expected model ${expectedModel}, observed ${observedModels.join(', ') || 'none'}`);
  }
  if (
    audit.some((entry) => entry.fallback || entry.thinking || entry.cache)
    || observedTransports.length !== 1
    || observedTransports[0] === 'mock'
  ) {
    throw new Error(`NPC live latency: non-live audit rows detected (transports: ${observedTransports.join(', ') || 'none'})`);
  }

  const attemptSummary = summarizeAttempts(rows, candidate) as Record<string, unknown> & {
    prdGate: { passed: boolean };
  };
  const summary = {
    ...attemptSummary,
    runId,
    measuredAt: new Date().toISOString(),
    requiredSuccesses,
    maxAttempts,
    loaded: session.loaded,
    observedModels,
    observedTransports,
    ledgerPath,
    auditFile,
  };
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  if (!summary.prdGate.passed) process.exitCode = 1;
}

async function jsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`NPC live latency: ${label} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`NPC live latency: ${label} returned non-JSON: ${text.slice(0, 500)}`);
  }
}

function boundedInteger(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`NPC live latency: value must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function gitHead(projectRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

if (import.meta.main) await main();
