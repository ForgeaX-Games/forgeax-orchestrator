import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentRecord, LayeredMemoryRef, SoulSource } from '../soul/types';
import { npcSoulMemoryRoot, safeNpcId } from './safe-id';

export interface StandaloneAgentRecord extends AgentRecord {
  models?: unknown;
  packDir: string;
}

/**
 * Native-pack loader for deployment C. It intentionally knows only filesystem
 * Soul packs and layered memory; legacy persona synthesis and the development
 * agent/session stack are outside the standalone process.
 */
export async function loadStandaloneSoulRecord(
  agentId: string,
  options: { projectRoot?: string; game?: string } = {},
): Promise<StandaloneAgentRecord> {
  safeNpcId(agentId);
  if (!options.projectRoot) throw new Error('standalone Soul loader requires projectRoot');
  const projectRoot = resolve(options.projectRoot);
  const found = findPack(projectRoot, agentId);
  if (!found) {
    throw new Error(
      `Soul pack ${agentId} not found under .forgeax/souls-builtin or .forgeax/souls-imported`,
    );
  }
  const memory: LayeredMemoryRef = {
    root: npcSoulMemoryRoot(projectRoot, agentId),
    ...(options.game ? { game: options.game } : {}),
  };
  seedMemory(found.dir, memory.root);
  const manifest = readJson(join(found.dir, 'manifest.json'));
  const agent = readJson(join(found.dir, 'agent.json'));
  const persona = readPersona(found.dir);
  if (!persona) throw new Error(`Soul pack ${agentId} has no persona markdown`);
  return {
    agentId,
    source: found.source,
    trustTier: found.source === 'builtin' ? 'own' : 'imported',
    persona,
    skills: [],
    tools: [],
    models: agent?.models ?? manifest?.models,
    packDir: found.dir,
    memory,
    warnings: [],
  };
}

function findPack(
  projectRoot: string,
  agentId: string,
): { dir: string; source: SoulSource } | undefined {
  const candidates: Array<{ dir: string; source: SoulSource }> = [
    {
      dir: join(projectRoot, '.forgeax/souls-imported', agentId),
      source: 'user-imported',
    },
    {
      dir: join(projectRoot, '.forgeax/souls-builtin', agentId),
      source: 'builtin',
    },
  ];
  return candidates.find(({ dir }) => existsSync(join(dir, 'persona')));
}

function readPersona(packDir: string): string {
  const personaDir = join(packDir, 'persona');
  const files = readdirSync(personaDir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((left, right) => Number(right === 'identity.md') - Number(left === 'identity.md')
      || left.localeCompare(right));
  return files.map((name) => readFileSync(join(personaDir, name), 'utf8').trim())
    .filter(Boolean)
    .join('\n\n');
}

function seedMemory(packDir: string, target: string): void {
  const source = join(packDir, 'memory');
  if (!existsSync(source) || existsSync(join(target, 'MEMORY.md'))) return;
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}
