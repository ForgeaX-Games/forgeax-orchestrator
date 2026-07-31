export interface BatchCollectorConfig<I, O> {
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  flush: (items: readonly I[]) => Promise<readonly O[]>;
}

interface Pending<I, O> {
  input: I;
  resolve: (outputs: readonly O[]) => void;
  reject: (error: unknown) => void;
}

/** Collects arrivals into a real wall-clock batch and invokes flush exactly once. */
export class NpcBatchCollector<I, O> {
  readonly #windowMs: number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #flush: BatchCollectorConfig<I, O>['flush'];
  #pending: Array<Pending<I, O>> = [];
  #timer?: unknown;

  constructor(config: BatchCollectorConfig<I, O>) {
    this.#windowMs = config.windowMs ?? 100;
    this.#setTimer = config.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#flush = config.flush;
  }

  add(input: I): Promise<readonly O[]> {
    return new Promise((resolve, reject) => {
      this.#pending.push({ input, resolve, reject });
      if (this.#timer !== undefined) return;
      this.#timer = this.#setTimer(() => {
        this.#timer = undefined;
        void this.flush().catch(() => undefined);
      }, this.#windowMs);
    });
  }

  async flush(): Promise<readonly O[]> {
    const pending = this.#pending;
    this.#pending = [];
    if (pending.length === 0) return [];
    try {
      const outputs = await this.#flush(pending.map(({ input }) => input));
      for (const item of pending) item.resolve(outputs);
      return outputs;
    } catch (error) {
      for (const item of pending) item.reject(error);
      throw error;
    }
  }

  get size(): number {
    return this.#pending.length;
  }
}
