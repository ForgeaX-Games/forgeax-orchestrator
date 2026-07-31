import { resolve } from 'node:path';

const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Protocol identifier that is safe to interpolate as one filesystem segment. */
export function safeNpcId(value: string): string {
  if (!BOUNDED_ID.test(value) || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(`NPC Brain: unsafe identifier ${JSON.stringify(value)}`);
  }
  return value;
}

/** NPC-only dotted Soul ids must not expand the Soul engine's legacy slug grammar. */
export function npcSoulMemoryRoot(projectRoot: string, soulId: string): string {
  return resolve(projectRoot, '.forgeax', 'souls', safeNpcId(soulId), 'memory');
}

/** Deployment-C isolates each player's life history while sharing the read-only pack. */
export function npcPlayerMemoryRoot(projectRoot: string, soulId: string, playerId: string): string {
  return resolve(
    projectRoot,
    '.forgeax',
    'souls',
    safeNpcId(soulId),
    'players',
    safeNpcId(playerId),
    'memory',
  );
}
