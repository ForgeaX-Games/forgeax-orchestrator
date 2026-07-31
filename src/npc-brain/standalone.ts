import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { createNpcRouter } from '../api/npc';
import { NpcBrainService, type NpcBrainConfig } from './service';
import {
  NpcRuntime,
  createNpcWebSocketHandler,
  type NpcWsClientData,
} from './runtime';
import { loadStandaloneSoulRecord } from './standalone-soul-loader';

export interface StandaloneNpcBrainConfig {
  dataDir: string;
  authToken: string;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  model?: string;
  fallbackModels?: string[];
  maxCallsPerMinute?: number;
  maxTokensPerMinute?: number;
  maxConcurrent?: number;
  /** Injectable deterministic transport for tests and offline acceptance. */
  complete?: NpcBrainConfig['complete'];
}

export interface StandaloneNpcBrainServer {
  runtime: NpcRuntime;
  server: ReturnType<typeof Bun.serve<NpcWsClientData>>;
  url: string;
  stop(): Promise<void>;
}

export function resolveStandaloneNpcBrainConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): StandaloneNpcBrainConfig {
  const flags = parseFlags(argv);
  const dataDir = flags['data-dir'] ?? env.FORGEAX_NPC_BRAIN_DATA_DIR;
  const authToken = flags['auth-token'] ?? env.FORGEAX_NPC_BRAIN_AUTH_TOKEN;
  if (!dataDir) throw new Error('NPC Brain standalone requires --data-dir or FORGEAX_NPC_BRAIN_DATA_DIR');
  if (!authToken || authToken.length < 16) {
    throw new Error('NPC Brain standalone auth token must contain at least 16 characters');
  }
  return {
    dataDir: resolve(dataDir),
    authToken,
    host: flags.host ?? env.FORGEAX_NPC_BRAIN_HOST ?? '127.0.0.1',
    port: boundedInteger(flags.port ?? env.FORGEAX_NPC_BRAIN_PORT, 18930, 0, 65_535),
    allowedOrigins: splitList(flags['allowed-origins'] ?? env.FORGEAX_NPC_BRAIN_ALLOWED_ORIGINS),
    model: flags.model ?? env.FORGEAX_NPC_MODEL,
    fallbackModels: splitList(flags.fallback ?? env.FORGEAX_NPC_FALLBACK),
    maxCallsPerMinute: boundedInteger(
      flags['max-calls-per-minute'] ?? env.FORGEAX_NPC_MAX_CALLS_PER_MINUTE,
      30,
      1,
      10_000,
    ),
    maxTokensPerMinute: boundedInteger(
      flags['max-tokens-per-minute'] ?? env.FORGEAX_NPC_MAX_TOKENS_PER_MINUTE,
      120_000,
      1,
      100_000_000,
    ),
    maxConcurrent: boundedInteger(
      flags['max-concurrent'] ?? env.FORGEAX_NPC_MAX_CONCURRENT,
      4,
      1,
      128,
    ),
  };
}

export function startStandaloneNpcBrain(
  input: StandaloneNpcBrainConfig,
): StandaloneNpcBrainServer {
  const config = normalizeConfig(input);
  const brain = new NpcBrainService({
    projectRoot: config.dataDir,
    model: config.model,
    fallbackModels: config.fallbackModels,
    budget: {
      maxCallsPerMinute: config.maxCallsPerMinute,
      maxTokensPerMinute: config.maxTokensPerMinute,
      maxConcurrent: config.maxConcurrent,
    },
    loadAgentRecord: loadStandaloneSoulRecord,
    memoryScope: (game, playerId) => `${game}:${playerId}`,
    complete: config.complete,
  });
  const runtime = new NpcRuntime({ projectRoot: config.dataDir, brain });
  const app = new Hono();
  app.route('/api/npc', createNpcRouter({ projectRoot: config.dataDir, runtime }));
  const ws = createNpcWebSocketHandler(runtime);

  const server = Bun.serve<NpcWsClientData>({
    hostname: config.host,
    port: config.port,
    websocket: ws,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (!originAllowed(origin, config.allowedOrigins)) {
        return new Response('forbidden origin', { status: 403 });
      }
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin);
      if (url.pathname === '/healthz') {
        return cors(Response.json({
          ok: true,
          service: 'forgeax-npc-brain',
          protocol: 1,
          dataDir: config.dataDir,
          budget: {
            maxCallsPerMinute: config.maxCallsPerMinute,
            maxTokensPerMinute: config.maxTokensPerMinute,
            maxConcurrent: config.maxConcurrent,
          },
        }), origin);
      }
      if (url.pathname === '/api/npc/session' && !sameSecret(bearer(request), config.authToken)) {
        return cors(Response.json({ ok: false, error: 'unauthorized' }, { status: 401 }), origin);
      }
      if (url.pathname === '/api/npc/ws') {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('upgrade required', { status: 426 });
        }
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const token = url.searchParams.get('token') ?? bearer(request);
        if (!runtime.authorize(sessionId, token)) return new Response('unauthorized', { status: 401 });
        if (bunServer.upgrade(request, {
          data: { id: crypto.randomUUID(), npc: { sessionId: sessionId!, token: token! } },
        })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      return cors(await app.fetch(request), origin);
    },
  });
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return {
    runtime,
    server,
    url: `http://${host}:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function normalizeConfig(input: StandaloneNpcBrainConfig) {
  if (!input.authToken || input.authToken.length < 16) {
    throw new Error('NPC Brain standalone auth token must contain at least 16 characters');
  }
  return {
    ...input,
    dataDir: resolve(input.dataDir),
    host: input.host ?? '127.0.0.1',
    port: input.port ?? 18930,
    allowedOrigins: input.allowedOrigins ?? [],
    fallbackModels: input.fallbackModels ?? [],
    maxCallsPerMinute: input.maxCallsPerMinute ?? 30,
    maxTokensPerMinute: input.maxTokensPerMinute ?? 120_000,
    maxConcurrent: input.maxConcurrent ?? 4,
  };
}

function parseFlags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith('--')) throw new Error(`Unknown NPC Brain argument: ${item}`);
    const [rawName, inline] = item.slice(2).split('=', 2);
    const value = inline ?? argv[++index];
    if (!rawName || !value || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`);
    out[rawName] = value;
  }
  return out;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer in [${min}, ${max}], received ${raw}`);
  }
  return value;
}

function splitList(raw: string | undefined): string[] {
  return raw?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function bearer(request: Request): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
}

function sameSecret(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  return !origin || allowed.length === 0 || allowed.includes(origin);
}

function cors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  response.headers.set('access-control-allow-origin', origin);
  response.headers.set('access-control-allow-headers', 'authorization,content-type,x-npc-session');
  response.headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.headers.set('vary', 'Origin');
  return response;
}

if (import.meta.main) {
  try {
    const service = startStandaloneNpcBrain(resolveStandaloneNpcBrainConfig());
    process.stdout.write(`[forgeax-npc-brain] listening ${service.url}\n`);
  } catch (error) {
    process.stderr.write(`[forgeax-npc-brain] ${(error as Error).message}\n`);
    process.exit(1);
  }
}
