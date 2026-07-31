export interface WorkingMemoryEntry {
  snapshot: unknown;
  decision: unknown;
}

export interface WorkingMemorySummary {
  text: string;
  boundary: number;
  createdAt: number;
}

export interface WorkingMemoryConfig {
  softTokens?: number;
  hardTokens?: number;
  cooldownMs?: number;
  maxPromptEntries?: number;
  now?: () => number;
  summarize: (entries: readonly WorkingMemoryEntry[]) => Promise<string>;
  validateSummary?: (summary: string, entries: readonly WorkingMemoryEntry[]) => boolean;
  onCompressionFailure?: (failures: number) => void;
}

export interface WorkingMemoryView {
  summary?: string;
  omittedEntries: number;
  entries: readonly WorkingMemoryEntry[];
  estimatedTokens: number;
}

const DEFAULT_SOFT_TOKENS = 4_000;
const DEFAULT_HARD_TOKENS = 6_000;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Session-local append-only working memory. Compression only advances a derived
 * boundary; raw entries are retained until episode settlement destroys the owner.
 */
export class NpcWorkingMemory {
  readonly #raw: WorkingMemoryEntry[] = [];
  readonly #summaries: WorkingMemorySummary[] = [];
  readonly #softTokens: number;
  readonly #hardTokens: number;
  readonly #cooldownMs: number;
  readonly #maxPromptEntries: number;
  readonly #now: () => number;
  readonly #summarize: WorkingMemoryConfig['summarize'];
  readonly #validateSummary?: WorkingMemoryConfig['validateSummary'];
  readonly #onCompressionFailure?: WorkingMemoryConfig['onCompressionFailure'];
  #boundary = 0;
  #lastCompressionAt = Number.NEGATIVE_INFINITY;
  #compression?: Promise<void>;
  #consecutiveFailures = 0;
  #mechanicalFallback = false;
  #disposed = false;

  constructor(config: WorkingMemoryConfig) {
    this.#softTokens = Math.max(1, config.softTokens ?? DEFAULT_SOFT_TOKENS);
    this.#hardTokens = Math.max(this.#softTokens, config.hardTokens ?? DEFAULT_HARD_TOKENS);
    this.#cooldownMs = Math.max(0, config.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.#maxPromptEntries = Math.max(1, config.maxPromptEntries ?? 24);
    this.#now = config.now ?? Date.now;
    this.#summarize = config.summarize;
    this.#validateSummary = config.validateSummary;
    this.#onCompressionFailure = config.onCompressionFailure;
  }

  append(entry: WorkingMemoryEntry): void {
    if (this.#disposed) return;
    this.#raw.push(entry);
    this.#scheduleCompression();
  }

  view(): WorkingMemoryView {
    const summary = this.#summaries.at(-1)?.text;
    let start = this.#boundary;
    let entries = this.#raw.slice(start);
    let estimatedTokens = estimateTokens({ summary, entries });
    let omittedEntries = start;
    while ((estimatedTokens > this.#hardTokens || entries.length > this.#maxPromptEntries) && entries.length > 0) {
      entries = entries.slice(1);
      start += 1;
      omittedEntries = start;
      estimatedTokens = estimateTokens({ summary, entries });
    }
    const mechanicalPrefix = omittedEntries > this.#boundary
      ? `Earlier ${omittedEntries - this.#boundary} working-memory entries were mechanically omitted.`
      : undefined;
    const combinedSummary = [summary, mechanicalPrefix].filter(Boolean).join('\n') || undefined;
    return {
      ...(combinedSummary ? { summary: combinedSummary } : {}),
      omittedEntries,
      entries,
      estimatedTokens: Math.min(estimatedTokens, this.#hardTokens),
    };
  }

  get rawEntries(): readonly WorkingMemoryEntry[] {
    return this.#raw;
  }

  get summaries(): readonly WorkingMemorySummary[] {
    return this.#summaries;
  }

  get compressionPending(): boolean {
    return this.#compression !== undefined;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  get mechanicalFallback(): boolean {
    return this.#mechanicalFallback;
  }

  dispose(): void {
    this.#disposed = true;
  }

  async settled(): Promise<void> {
    await this.#compression;
  }

  #scheduleCompression(): void {
    if (this.#compression || this.#mechanicalFallback) return;
    if (this.#now() - this.#lastCompressionAt < this.#cooldownMs) return;
    if (estimateTokens(this.#raw.slice(this.#boundary)) <= this.#softTokens) return;
    const boundary = this.#raw.length;
    const prefix = this.#raw.slice(this.#boundary, boundary);
    this.#lastCompressionAt = this.#now();
    this.#compression = this.#compress(prefix, boundary).finally(() => {
      this.#compression = undefined;
      if (!this.#disposed && this.#consecutiveFailures === 0) this.#scheduleCompression();
    });
  }

  async #compress(prefix: readonly WorkingMemoryEntry[], boundary: number): Promise<void> {
    try {
      const text = (await this.#summarize(prefix)).trim();
      if (!text || text.length > 8_000 || this.#validateSummary?.(text, prefix) === false) {
        throw new Error('invalid working-memory summary');
      }
      if (this.#disposed) return;
      this.#summaries.push({ text, boundary, createdAt: this.#now() });
      this.#boundary = Math.max(this.#boundary, boundary);
      this.#consecutiveFailures = 0;
    } catch {
      if (this.#disposed) return;
      this.#consecutiveFailures += 1;
      this.#onCompressionFailure?.(this.#consecutiveFailures);
      if (this.#consecutiveFailures >= 3) this.#mechanicalFallback = true;
    }
  }
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
