import type { LayeredMemoryRef, MemoryFact, MemorySection, MemoryTier } from './types';

export function soulMemoryRoot(projectRoot: string, agentId: string): string;
export function isMemorySlug(value: unknown): value is string;
export function readLayeredMemory(ref: LayeredMemoryRef): {
  identity: MemorySection[];
  traits: MemorySection[];
  episodes: MemorySection[];
};
export function readLayeredMemoryAsync(ref: LayeredMemoryRef): Promise<{
  identity: MemorySection[];
  traits: MemorySection[];
  episodes: MemorySection[];
}>;
export function readMemoryIndexAsync(root: string): Promise<string>;
export function readMemoryIndex(root: string): string;
export function composeStableMemory(ref: LayeredMemoryRef): string;
export function composeStableMemoryAsync(ref: LayeredMemoryRef): Promise<string>;
export function composeEpisodicRecall(ref: LayeredMemoryRef): string;
export function composeEpisodicRecallAsync(ref: LayeredMemoryRef): Promise<string>;
export function composeReincarnationNotice(ref: LayeredMemoryRef): string;
export function composeReincarnationNoticeAsync(ref: LayeredMemoryRef): Promise<string>;
export function firstPastLifeMemoryAsync(ref: LayeredMemoryRef): Promise<{ text: string } | undefined>;
export function searchMemory(
  ref: LayeredMemoryRef,
  query: string,
  limit?: number,
): { query: string; matches: Array<{ tier: MemoryTier; game?: string; file: string; text: string }> };
export function searchMemoryAsync(
  ref: LayeredMemoryRef,
  query: string,
  limit?: number,
): Promise<{ query: string; matches: Array<{ tier: MemoryTier; game?: string; file: string; text: string }> }>;
export interface PlannedMemoryEntry {
  tier: MemoryTier;
  game?: string;
  file: string;
  body: string;
}
export function planMemoryEntry(
  ref: LayeredMemoryRef,
  entry: { tier: MemoryTier; game?: string; title?: string; text: string },
  reservedFiles?: Set<string>,
): PlannedMemoryEntry;
export function planMemoryEntryAsync(
  ref: LayeredMemoryRef,
  entry: { tier: MemoryTier; game?: string; title?: string; text: string },
  reservedFiles?: Set<string>,
): Promise<PlannedMemoryEntry>;
export function planClassifiedMemoryFacts(ref: LayeredMemoryRef, facts: MemoryFact[]): PlannedMemoryEntry[];
export function planClassifiedMemoryFactsAsync(ref: LayeredMemoryRef, facts: MemoryFact[]): Promise<PlannedMemoryEntry[]>;
export function materializePlannedMemoryEntry(
  ref: LayeredMemoryRef,
  plan: PlannedMemoryEntry,
  options?: { durable?: boolean },
): void;
export function materializePlannedMemoryEntryAsync(
  ref: LayeredMemoryRef,
  plan: PlannedMemoryEntry,
  options?: { durable?: boolean },
): Promise<void>;
export function rebuildMemoryIndex(root: string, options?: { durable?: boolean }): string;
export function rebuildMemoryIndexAsync(root: string, options?: { durable?: boolean }): Promise<string>;
export function writeMemoryEntry(
  ref: LayeredMemoryRef,
  entry: { tier: MemoryTier; game?: string; title?: string; text: string },
): string;
export function classifyAndWrite(
  ref: LayeredMemoryRef,
  facts: MemoryFact[],
): Array<{ tier: MemoryTier; game?: string; file: string }>;
