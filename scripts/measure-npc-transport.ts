import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startStandaloneNpcBrain } from '../src/npc-brain/standalone';

const projectRoot = resolve(process.argv[2] ?? '../..');
const samples = Number(process.argv[3] ?? 100);
const dataDir = mkdtempSync(join(tmpdir(), 'npc-transport-'));
const pack = join(dataDir, '.forgeax/souls-builtin/bench.guide');
mkdirSync(join(pack, 'persona'), { recursive: true });
writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ id: 'bench.guide' }));
writeFileSync(join(pack, 'persona/identity.md'), 'A deterministic transport benchmark guide.');

const service = startStandaloneNpcBrain({
  dataDir,
  authToken: 'deterministic-transport-secret',
  port: 0,
  maxCallsPerMinute: Math.max(1_000, samples + 10),
  maxTokensPerMinute: 10_000_000,
  maxConcurrent: 1,
  complete: async (request) => ({
    text: JSON.stringify({ intent: { action: 'wait', ttlSec: 1 } }),
    model: request.model,
    transport: 'deterministic',
    latencyMs: 0,
    usage: { totalTokens: 0 },
  }),
});

try {
  const opened = await fetch(`${service.url}/api/npc/session`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer deterministic-transport-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ game: 'bench', playerId: 'p1', npcIds: ['guide'] }),
  }).then((response) => response.json()) as any;
  const latencies: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = Bun.nanoseconds();
    const response = await fetch(`${service.url}/api/npc/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opened.token}`,
        'x-npc-session': opened.sessionId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        v: 1,
        eventId: `transport-${index}`,
        game: 'bench',
        npcId: 'guide',
        t: index,
        trigger: 'player_message',
        text: 'wait',
        self: { pos: { x: 0, y: 0 }, activity: 'idle' },
        nearby: [{ kind: 'player', id: 'p1', pos: { x: 1, y: 0 }, facts: [] }],
        events: [],
        affordances: [{ action: 'wait' }],
      }),
    });
    const body = await response.json() as any;
    if (!response.ok || !body.decision) throw new Error(`transport sample ${index} failed`);
    latencies.push((Bun.nanoseconds() - started) / 1_000_000);
  }
  latencies.sort((left, right) => left - right);
  const evidence = {
    kind: 'deterministic-transport-only',
    samples,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    minMs: latencies[0],
    maxMs: latencies.at(-1),
    note: 'Excludes external provider latency; does not satisfy the live-provider PRD gate.',
  };
  const path = join(projectRoot, '.forgeax/npc-brain/evidence/transport-latency-20260724.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...evidence, path }, null, 2)}\n`);
} finally {
  service.stop();
  rmSync(dataDir, { recursive: true, force: true });
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}
