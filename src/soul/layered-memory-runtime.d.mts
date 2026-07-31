import type { LayeredMemoryRef, MemoryFact, MemorySection, MemoryTier } from './types';

export function soulMemoryRoot(projectRoot: string, agentId: string): string;
export function readLayeredMemory(ref: LayeredMemoryRef): {
  identity: MemorySection[];
  traits: MemorySection[];
  episodes: MemorySection[];
};
export function readMemoryIndex(root: string): string;
export function composeStableMemory(ref: LayeredMemoryRef): string;
export function composeEpisodicRecall(ref: LayeredMemoryRef): string;
export function composeReincarnationNotice(ref: LayeredMemoryRef): string;
export function searchMemory(
  ref: LayeredMemoryRef,
  query: string,
  limit?: number,
): { query: string; matches: Array<{ tier: MemoryTier; game?: string; file: string; text: string }> };
export function writeMemoryEntry(
  ref: LayeredMemoryRef,
  entry: { tier: MemoryTier; game?: string; title?: string; text: string },
): string;
export function classifyAndWrite(
  ref: LayeredMemoryRef,
  facts: MemoryFact[],
): Array<{ tier: MemoryTier; game?: string; file: string }>;
