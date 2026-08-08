/** EventLedger —— per-agent append-only WAL，5MB shard 自动滚。
 *
 *  与 agenteam ref 280 行的差异（plan §3.4）：
 *  - **构造参数**：`(sid, agentPath, paths)` 而非 `agentId`；ledger / blobs 路径走
 *    `paths.session(sid).agent(agentPath).{root, eventLedgerBlobs}`。
 *    shard 文件名沿用 `events-<N>.jsonl`（5MB 拆分用，不是切 ledger）。
 *  - **砍 currentSessionId 指针 + newSession / switchSession**：forgeax 一棵 agent 一份
 *    ledger，没切换语义；要换历史另起 sid。
 *  - **砍 xml-renderer.scheduleRender**：xml.ts 本轮延后（plan §3.4）。
 *  - **rotation 边界**：与 ref 一致（5MB / 每 20 次 append 检测一次）。
 *
 *  线程模型：单进程内部使用，append 同步写盘；rotate 内部 _rotating flag 防重入。
 *  Caller（Session.ledgers map 持有者）需在 dispose 时停止使用，本类不主动 close。 */

import { mkdirSync, statSync, appendFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "../core/types";
import type { PathManagerAPI } from "../fs/types";
import { parseEvents } from "./event-store";
import { walkAndExternalize } from "./event-blob";
import type { StoredEvent } from "./types";
import { randomUUID } from "node:crypto";

export interface LedgerCursor {
  shard: number;
  line: number;
  eventId: string;
}

export interface LedgerHistoryMeta {
  eventId?: string;
  turnId?: string;
  origin?: { kernelId: string; laneId: string; epoch: number };
}

const MAX_SHARD_BYTES = 5 * 1024 * 1024;
const SIZE_CHECK_INTERVAL = 20;
const SHARD_RE = /^events-(\d+)\.jsonl$/;

export class EventLedger {
  private readonly eventsDir: string;
  private readonly blobsDir: string;
  private _currentShard = 1;
  private _appendCount = 0;
  private _rotating = false;
  // True once we've confirmed eventsDir exists. _initShardIndex() already
  // mkdirs at construction, but a paranoid append() previously re-created
  // it on every event — that's a stat-class syscall on every WS event.
  // Keep the safety net but skip it after the first successful append.
  private _dirEnsured = false;
  private _currentLine = 0;
  /** 本 (sid, agentPath) 已记录的 user_input 条数 —— 轮次序数的来源。
   *  转录是**同步**的(transcribeKernelTurn),而 readAllEvents() 是 async,
   *  所以计数必须在这里同步维护;`_initShardIndex` 本来就同步读当前分片全文,
   *  顺手把它数出来,计数即可跨进程重启存活(不重启也不会从 1 重来)。 */
  private _userInputCount = 0;

  constructor(
    public readonly sid: string,
    public readonly agentPath: string,
    paths: PathManagerAPI,
  ) {
    const layer = paths.session(sid).agent(agentPath);
    this.eventsDir = layer.eventsDir();
    this.blobsDir = layer.eventLedgerBlobs();
    this._initShardIndex();
  }

  // ─── Shard info ─────────────────────────────────────────────────────────

  get shardCount(): number {
    return this._currentShard;
  }

  private _shardPath(n: number): string {
    return join(this.eventsDir, `events-${n}.jsonl`);
  }

  private _currentShardPath(): string {
    return this._shardPath(this._currentShard);
  }

  /** Sorted list of existing shard paths（按 N 升序，缺号容错）。 */
  private _listShardPaths(): string[] {
    if (!existsSync(this.eventsDir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(this.eventsDir);
    } catch {
      return [];
    }
    const shards: Array<[number, string]> = [];
    for (const f of entries) {
      const m = SHARD_RE.exec(f);
      if (m) shards.push([parseInt(m[1], 10), join(this.eventsDir, f)]);
    }
    shards.sort((a, b) => a[0] - b[0]);
    return shards.map(([, p]) => p);
  }

  // ─── Event I/O ─────────────────────────────────────────────────────────

  /** 持久化一条 bus Event 到当前 shard。
   *  emitterId 由 EventBus 在 emit 时捕获，原样落盘。
   *  payload 在外置前 deep-clone，确保 in-memory observer 看到的对象不被改写。 */
  append(event: Event, emitterId?: string, history?: LedgerHistoryMeta): LedgerCursor {
    const eventId = history?.eventId ?? randomUUID();
    const stored: StoredEvent = {
      type: event.type,
      ts: event.ts,
      source: event.source,
      to: event.to,
      emitterId,
      priority: event.priority,
      handoff: event.handoff,
      ...(typeof event.seq === "number" ? { seq: event.seq, sgen: event.sgen } : {}),
      payload: event.payload && typeof event.payload === "object"
        ? structuredClone(event.payload as Record<string, unknown>)
        : event.payload,
      history: {
        eventId,
        ...(history?.turnId ? { turnId: history.turnId } : {}),
        ...(history?.origin ? { origin: history.origin } : {}),
      },
    };
    if (stored.payload && typeof stored.payload === "object") {
      walkAndExternalize(stored.payload, this.blobsDir);
    }
    if (!this._dirEnsured) {
      mkdirSync(this.eventsDir, { recursive: true });
      this._dirEnsured = true;
    }
    appendFileSync(this._currentShardPath(), JSON.stringify(stored) + "\n", "utf-8");
    if (event.type === "user_input") this._userInputCount += 1;
    const cursor = { shard: this._currentShard, line: ++this._currentLine, eventId };

    this._appendCount++;
    if (this._appendCount >= SIZE_CHECK_INTERVAL) {
      this._appendCount = 0;
      this._maybeRotate();
    }
    return cursor;
  }

  /** 下一轮的序数(= 已记录 user_input 数 + 1)。同步、O(1)。 */
  nextTurnOrdinal(): number {
    return this._userInputCount + 1;
  }

  async readAllWithCursors(): Promise<Array<{ event: StoredEvent; cursor: LedgerCursor }>> {
    const out: Array<{ event: StoredEvent; cursor: LedgerCursor }> = [];
    for (const path of this._listShardPaths()) {
      const shardMatch = /events-(\d+)\.jsonl$/.exec(path);
      const shard = shardMatch ? Number(shardMatch[1]) : 1;
      let raw: string;
      try { raw = await readFile(path, "utf-8"); } catch { continue; }
      const lines = raw.split("\n").filter(Boolean);
      const parsed = parseEvents(raw, this.blobsDir);
      for (let i = 0; i < parsed.length; i++) {
        const event = parsed[i];
        const legacyId = `legacy:${shard}:${i + 1}`;
        const eventId = event.history?.eventId ?? legacyId;
        out.push({ event, cursor: { shard, line: i + 1, eventId } });
      }
      void lines;
    }
    return out;
  }

  async readAllEvents(): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    for (const path of this._listShardPaths()) {
      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch (err) {
        process.stderr.write(`[ledger] ${this.agentPath}: skip unreadable shard ${path}: ${(err as Error).message}\n`);
        continue;
      }
      // parseEvents 可能抛 LedgerBlobMissingError —— 当 WAL 完整性错误向上抛，
      // 不静默丢整 shard（会丢最近上下文）。
      all.push(...parseEvents(raw, this.blobsDir));
    }
    return all;
  }

  /** 倒序读 shard，直到 isEnough(accumulated) 为 true 或全部读完；用于 summary 边界反扫。 */
  async readFromTail(isEnough: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]> {
    const paths = this._listShardPaths();
    const result: StoredEvent[] = [];
    for (let i = paths.length - 1; i >= 0; i--) {
      let raw: string;
      try {
        raw = await readFile(paths[i], "utf-8");
      } catch (err) {
        process.stderr.write(`[ledger] ${this.agentPath}: skip unreadable shard ${paths[i]}: ${(err as Error).message}\n`);
        continue;
      }
      const batch = parseEvents(raw, this.blobsDir);
      result.unshift(...batch);
      if (isEnough(result)) break;
    }
    return result;
  }

  // ─── Init helpers ──────────────────────────────────────────────────────

  private _initShardIndex(): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
    } catch { /* exists */ }

    let max = 0;
    try {
      for (const f of readdirSync(this.eventsDir)) {
        const m = SHARD_RE.exec(f);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch { /* empty dir */ }
    this._currentShard = max > 0 ? max : 1;
    try {
      const raw = readFileSync(this._currentShardPath(), "utf-8");
      this._currentLine = raw.split("\n").filter(Boolean).length;
    } catch { this._currentLine = 0; }
    // 轮序基线:**逐行解析 + 跨全部分片**,两条都是被实测逼出来的。
    //  ① 子串判据会误加:工具返回体里嵌套 {type:'user_input'} 对象时(agent 回读
    //     自己的轨迹账本就会产生这种返回,而那正是本项目的目标场景),序列化后
    //     `"type":"user_input"` 未被转义,`includes` 命中 —— 实测轮序从 [1,2] 变成
    //     [1,3]。必须比较解析后的 event.type。
    //  ② 只数当前分片会在 5MB 轮转后把轮序重置回 1,产生重复轮号,离线按轮切分
    //     直接错乱。构造时读全部分片一次(每个 ledger 实例只发生一次)换取全局单调。
    this._userInputCount = 0;
    for (const path of this._listShardPaths()) {
      let raw: string;
      try { raw = readFileSync(path, "utf-8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          if ((JSON.parse(line) as { type?: unknown }).type === "user_input") this._userInputCount += 1;
        } catch { /* 半行/损坏行不计数,宁可少算也不误加 */ }
      }
    }
  }

  private _maybeRotate(): void {
    if (this._rotating) return;
    try {
      const size = statSync(this._currentShardPath()).size;
      if (size < MAX_SHARD_BYTES) return;
    } catch {
      return;
    }
    this._rotating = true;
    this._currentShard++;
    process.stderr.write(`[ledger] ${this.agentPath}: shard rotated to events-${this._currentShard}.jsonl\n`);
    this._rotating = false;
  }
}
