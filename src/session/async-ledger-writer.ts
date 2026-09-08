// @desc AsyncLedgerWriter — per-agent serial async append queue for the event ledger.
//
// WHY: EventLedger.append previously did a synchronous appendFileSync (plus a
// synchronous writeFileSync per inline-media part) on EVERY EventBus event.
// That blocks the gateway event loop on every frame — the "发图顿一下 /
// 越用越卡" symptom. This writer turns each append into an enqueueTask() that
// returns immediately; the actual disk I/O happens asynchronously.
//
// ORDERING GUARANTEE: a ledger is a strictly sequential log. Each writer keeps
// a single in-flight promise chain (`_tail`) so tasks run one-after-another in
// the exact order they were enqueued — never interleaved, never reordered.
// Media externalization (async writeFile) happens INSIDE the queued task,
// before the JSON line is appended, so the on-disk order matches enqueue order.
//
// BACKPRESSURE: enqueue is fire-and-forget but bounded. If the pending
// best-effort queue is already at HIGH_WATER (slow disk / huge burst), we
// cancel the OLDEST still-queued best-effort task and bump a dropped counter
// so the NEWEST frame is kept — recent diagnostic/conversation frames matter
// more under pathological load. Required tasks are never cancelled.
//
// FLUSH ON EXIT: all writers register in a module-level set; flushAllLedgerWriters()
// awaits every pending queue so the SIGTERM/SIGINT path (main.ts) can drain
// buffered events before the process exits.

import { appendFile, writeFile, mkdir } from "node:fs/promises";

const HIGH_WATER = 10_000;

type Task = () => Promise<void>;
export type EventDurability = "required" | "best-effort";

interface QueuedTask {
  readonly run: Task;
  readonly durability: EventDurability;
  cancelled: boolean;
  resolve?: () => void;
  reject?: (error: unknown) => void;
}

const _allWriters = new Set<AsyncLedgerWriter>();

/** Append a line to `filePath`, ensuring `dir` exists. Async; used inside
 *  serial writer tasks so callers get on-disk ordering == enqueue ordering. */
export async function appendLine(dir: string, filePath: string, line: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, line, "utf-8");
}

/** Externalize one inline-media buffer to disk. Async replacement for the old
 *  synchronous writeFileSync in _persistInlineMedia. */
export async function writeMediaFile(dir: string, filePath: string, data: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, data);
}

export class AsyncLedgerWriter {
  /** Serial promise chain — every enqueued task awaits the previous one. */
  private _tail: Promise<void> = Promise.resolve();
  /** Pending (not yet started) tasks, in order. Drained head-first by the chain. */
  private _queue: QueuedTask[] = [];
  /** Tasks dropped under backpressure since construction. */
  private _dropped = 0;
  private readonly highWater: number;

  constructor(
    private readonly label: string,
    opts: { highWater?: number } = {},
  ) {
    this.highWater = opts.highWater ?? HIGH_WATER;
    if (!Number.isInteger(this.highWater) || this.highWater < 1) {
      throw new Error("AsyncLedgerWriter highWater must be a positive integer");
    }
    _allWriters.add(this);
  }

  /**
   * Run an async task as part of the serial chain. Tasks execute strictly in
   * enqueue order. Best-effort returns immediately; required awaits I/O and
   * propagates write errors.
   */
  enqueueTask(
    task: Task,
    durability: EventDurability = "best-effort",
  ): Promise<void> {
    if (durability === "best-effort") {
      while (this.queuedBestEffortCount() >= this.highWater) {
        const victim = this._queue.find(
          (entry) => entry.durability === "best-effort" && !entry.cancelled,
        );
        if (!victim) break;
        victim.cancelled = true;
        this._dropped++;
        if (this._dropped % 1000 === 1) {
          try {
            process.stderr.write(
              `[ledger:${this.label}] backpressure — dropped ${this._dropped} oldest best-effort events\n`,
            );
          } catch {}
        }
      }
    }

    const entry: QueuedTask = {
      run: task,
      durability,
      cancelled: false,
    };
    let requiredPromise: Promise<void> | undefined;
    if (durability === "required") {
      requiredPromise = new Promise<void>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
    }
    this._queue.push(entry);
    this._tail = this._tail.then(async () => {
      const head = this._queue.shift();
      if (!head || head.cancelled) {
        head?.resolve?.();
        return;
      }
      try {
        await head.run();
        head.resolve?.();
      } catch (err) {
        if (head.durability === "required") {
          head.reject?.(err);
          return;
        }
        try {
          process.stderr.write(
            `[ledger:${this.label}] write failed: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        } catch {}
      }
    });
    return requiredPromise ?? Promise.resolve();
  }

  /** Await all currently-pending writes. */
  async flush(): Promise<void> {
    await this._tail;
  }

  get pending(): number {
    return this._queue.filter((entry) => !entry.cancelled).length;
  }
  get dropped(): number { return this._dropped; }

  dispose(): void {
    _allWriters.delete(this);
  }

  private queuedBestEffortCount(): number {
    return this._queue.filter(
      (entry) => entry.durability === "best-effort" && !entry.cancelled,
    ).length;
  }
}

/** Flush every live ledger writer — called from the process exit path. */
export async function flushAllLedgerWriters(): Promise<void> {
  await Promise.all([..._allWriters].map(w => w.flush().catch(() => {})));
}
