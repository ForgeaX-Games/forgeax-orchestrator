/** Per-session 事件总线 —— observer 广播 + handoff 队列路由。
 *
 *  比 agenteam ref 88 行版本简化：
 *  - 砍 IPC 跨进程派发分支（forgeax 单进程，没 worker）
 *  - 砍 logger getConsoleLogger 依赖（logger 模块 C7 才进来；observer error 暂走 console.warn）
 *
 *  保留：
 *  - 5 种 handoff（silent / passive / turn / innerLoop / steer），由 RuntimeController 解释
 *  - publish() 给 event 挂 block / isBlocked 通道（hook handler 可以短路后续 observer）
 *  - emit() = publish + route，broadcast (`to: "*"`) 自动排除 emitter 自身
 *  - emitToSelf() / hook() 是 RuntimeAgentHost.boundEventBus 提供的语义包装，raw bus 不实现
 *
 *  Session.dispose 时由 caller 遍历 dispose 函数清 observers；本类不持有定时器 / FS watcher。 */

import type { Event, EventQueueAPI } from "./types";
import { randomUUID } from "node:crypto";

type ObserverHandler = (event: Event, emitterId?: string) => void;

/** EventBus 类只暴露「raw」事件总线（publish/emit/observe/observeAgent + register/unregister）。
 *  `emitToSelf` / `hook` 这两个 agent-scope 语义糖由 RuntimeAgentHost 的 boundEventBus
 *  包 me 后提供 —— raw bus 不知道 emitter 是谁，也不该构造 agent-scope source。 */
export class EventBus {
  private observers = new Set<ObserverHandler>();
  /** Only used by the legacy BaseAgent/Scheduler compatibility path. Runtime
   * routing remains owned by RuntimeSupervisor because its controllers carry
   * instance identity and lifecycle state. */
  private readonly agentQueueMap = new Map<string, EventQueueAPI>();

  /** Session generation —— 一次性 id;seq 只在本 generation 内可比(多 tab 同步 §3.1)。
   *  server 重启/session 重开 = 换代,客户端 cursor 按 (sgen, seq) 对齐,换代即走全量恢复,
   *  因此不需要任何计数器持久化/恢复。 */
  readonly sgen = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private _seq = 0;

  /** 当前 seq 水位 —— WsHub 的 hello / turn-snapshot 帧用。 */
  get seq(): number { return this._seq; }

  // ─── Observer registration ────────────────────────────────────────────

  observe(handler: ObserverHandler): () => void {
    this.observers.add(handler);
    return () => { this.observers.delete(handler); };
  }

  observeAgent(agentId: string, handler: (event: Event) => void): () => void {
    const filtered: ObserverHandler = (event, emitterId) => {
      if (emitterId === agentId) handler(event);
    };
    return this.observe(filtered);
  }

  register(agentId: string, queue: EventQueueAPI): void {
    this.agentQueueMap.set(agentId, queue);
  }

  unregister(agentId: string): void {
    this.agentQueueMap.delete(agentId);
  }

  // ─── publish — observers only, no queue routing ───────────────────────

  publish(event: Event, emitterId?: string): void {
    event.eventId ??= randomUUID();
    event.seq = ++this._seq;
    event.sgen = this.sgen;
    let blocked = false;
    event.block = (reason?: string) => { blocked = true; event.blockReason = reason; };
    event.isBlocked = () => blocked;

    for (const h of this.observers) {
      try {
        h(event, emitterId);
      } catch (err) {
        // 不能用 console.error —— logger bridge 落地后会形成自循环；用 stderr.write 直写。
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[event-bus] observer error on "${event.type}": ${msg}\n`);
      }
    }
  }

  /** Compatibility alias. Runtime routing belongs to RuntimeSupervisor. */
  emit(event: Event, emitterId?: string): void {
    this.publish(event, emitterId);
    if (event.isBlocked?.() || !event.to) return;
    if (event.to === "*") {
      for (const [agentId, queue] of this.agentQueueMap) {
        if (agentId !== emitterId) queue.push(event);
      }
      return;
    }
    this.agentQueueMap.get(event.to)?.push(event);
  }

  // NOTE: raw EventBus does NOT expose `hook(type, payload)` — it would be over-
  // implementation. `hook` is RuntimeAgentHost.boundEventBus 的 convenience wrapper
  // that publishes with `source: agent:<id>`; raw bus 保持 dumb，跟 ref 一致。

}
