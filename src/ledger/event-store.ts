/** event-store —— ledger JSONL 解析器 + sentinel 反向复活的薄包装。
 *
 *  与 agenteam ref 1:1 对齐；只把 sessionDir 参数语义换成 blobsDir：
 *  - blobsDir 给定 → walkAndReinflate 复活每个 event payload 的 sentinel。
 *    框架内部消费者（context-window replay / provider prepare / compaction）走这条。
 *  - blobsDir 不给 → sentinel 原样保留。
 *    外部展示侧（renderer / fetch_session_events 命令）走这条，避免大块 base64 进
 *    内存。要看具体内容用 `fetch_blob(sha256)` 单独捞。 */

import type { StoredEvent } from "./types";
import type { Event } from "../core/types";
import type {
  InstanceEventBinding,
  ResolvedEventStorePaths,
} from "./types";
import {
  parseEvents,
  LedgerBlobMissingError,
} from "./event-codec";
import { EventLedger } from "./event-ledger";
import {
  AsyncLedgerWriter,
  type EventDurability,
} from "../session/async-ledger-writer";

export type { StoredEvent };

export { LedgerBlobMissingError };
export { parseEvents };

/**
 * Per-instance history facade. It owns durability/backpressure policy while
 * EventLedger remains the synchronous shard/blob codec.
 */
export class EventStore {
  readonly ledger: EventLedger;
  private readonly writer: AsyncLedgerWriter;
  private _historyDegraded = false;

  constructor(
    readonly binding: InstanceEventBinding,
    readonly paths: ResolvedEventStorePaths,
  ) {
    this.ledger = new EventLedger(binding, paths);
    this.writer = new AsyncLedgerWriter(binding.storeId);
  }

  async append(
    event: StoredEvent,
    durability: EventDurability,
  ): Promise<void> {
    try {
      await this.writer.enqueueTask(
        async () => this.ledger.appendStored(event),
        durability,
      );
    } catch (error) {
      if (durability === "required") this._historyDegraded = true;
      throw error;
    }
  }

  async appendEvent(
    event: Event,
    emitterId: string | undefined,
    durability: EventDurability,
  ): Promise<void> {
    try {
      await this.writer.enqueueTask(
        async () => { this.ledger.append(event, emitterId); },
        durability,
      );
    } catch (error) {
      if (durability === "required") this._historyDegraded = true;
      throw error;
    }
  }

  readAllEvents(): Promise<StoredEvent[]> {
    return this.ledger.readAllEvents();
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  dispose(): void {
    this.writer.dispose();
  }

  get historyDegraded(): boolean {
    return this._historyDegraded;
  }

  get droppedBestEffort(): number {
    return this.writer.dropped;
  }
}
