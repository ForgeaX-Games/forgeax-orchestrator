import type { NpcBudgetState, PerceptionSnapshot } from './protocol';

export type CognitiveLevel = 'offstage' | 'ambient' | 'spotlight';
export type DecisionPriority = 'heartbeat' | 'promoted' | 'combat' | 'player';
export type ScheduleOutcome<T> = { accepted: true; value: T } | { accepted: false; reason: 'offstage' | 'ambient_cache_miss' | 'calls_budget' | 'tokens_budget' | 'queue_drop' };

export interface GovernorLimits {
  callsPerMinute: number;
  tokensPerMinute: number;
  maxConcurrent: number;
}

export interface GovernorConfig extends Partial<GovernorLimits> {
  batchWindowMs?: number;
  maxQueued?: number;
  demotionRetentionMs?: number;
  maxActiveBrains?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
}

interface BudgetWindow {
  startedAt: number;
  calls: number;
  tokens: number;
}

interface Presence {
  level: CognitiveLevel;
  lastActiveAt: number;
  detachedAt?: number;
}

interface Scheduled<T> {
  game: string;
  level: 'spotlight';
  priority: DecisionPriority;
  batchKey?: string;
  estimatedTokens: number;
  gameLimits?: Partial<GovernorLimits>;
  run: () => Promise<T>;
  resolve: (outcome: ScheduleOutcome<T>) => void;
  reject: (error: unknown) => void;
  order: number;
}

const DEFAULT_LIMITS: GovernorLimits = {
  callsPerMinute: 30,
  tokensPerMinute: 120_000,
  maxConcurrent: 4,
};

export class NpcGovernor {
  readonly #limits: GovernorLimits;
  readonly #batchWindowMs: number;
  readonly #maxQueued: number;
  readonly #demotionRetentionMs: number;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delay: number) => unknown;
  readonly #presence = new Map<string, Presence>();
  readonly #ambientCache = new Map<string, { signature: string; value: unknown; expiresAt: number }>();
  readonly #gameBudgets = new Map<string, BudgetWindow>();
  readonly #queue: Scheduled<unknown>[] = [];
  #globalBudget: BudgetWindow;
  #concurrent = 0;
  #timerPending = false;
  #order = 0;

  constructor(config: GovernorConfig = {}) {
    this.#limits = {
      callsPerMinute: config.callsPerMinute ?? DEFAULT_LIMITS.callsPerMinute,
      tokensPerMinute: config.tokensPerMinute ?? DEFAULT_LIMITS.tokensPerMinute,
      maxConcurrent: config.maxConcurrent ?? DEFAULT_LIMITS.maxConcurrent,
    };
    this.#batchWindowMs = config.batchWindowMs ?? 100;
    this.#maxQueued = config.maxQueued ?? 256;
    this.#demotionRetentionMs = config.demotionRetentionMs ?? 10 * 60_000;
    this.#now = config.now ?? Date.now;
    this.#setTimer = config.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#globalBudget = this.#newWindow();
  }

  classify(snapshot: PerceptionSnapshot): CognitiveLevel {
    const current = this.#now();
    const key = this.#presenceKey(snapshot.game, snapshot.npcId);
    const presence = this.#presence.get(key);
    if (snapshot.trigger === 'player_message' || snapshot.trigger === 'event'
      || snapshot.trigger === 'spotlight' || snapshot.trigger === 'attach') {
      this.#presence.set(key, { level: 'spotlight', lastActiveAt: current });
      return 'spotlight';
    }
    if (snapshot.trigger === 'heartbeat'
      && !snapshot.nearby.some((entity) => entity.kind === 'player')) return 'offstage';
    if (presence?.level === 'spotlight' && presence.detachedAt === undefined) {
      presence.lastActiveAt = current;
      return 'spotlight';
    }
    if (presence?.detachedAt !== undefined
      && current - presence.detachedAt < this.#demotionRetentionMs) return 'ambient';
    return 'offstage';
  }

  attach(game: string, npcId: string): void {
    this.#presence.set(this.#presenceKey(game, npcId), {
      level: 'spotlight',
      lastActiveAt: this.#now(),
    });
  }

  detach(game: string, npcId: string): void {
    const key = this.#presenceKey(game, npcId);
    const current = this.#presence.get(key);
    this.#presence.set(key, {
      level: 'ambient',
      lastActiveAt: current?.lastActiveAt ?? this.#now(),
      detachedAt: this.#now(),
    });
  }

  ambientDecision<T>(snapshot: PerceptionSnapshot): T | undefined {
    const signature = this.#situationSignature(snapshot);
    const cached = this.#ambientCache.get(this.#presenceKey(snapshot.game, snapshot.npcId));
    if (!cached || cached.expiresAt <= this.#now() || cached.signature !== signature) return undefined;
    return cached.value as T;
  }

  rememberAmbientDecision<T>(snapshot: PerceptionSnapshot, value: T, ttlMs = 10 * 60_000): void {
    this.#ambientCache.set(this.#presenceKey(snapshot.game, snapshot.npcId), {
      signature: this.#situationSignature(snapshot),
      value,
      expiresAt: this.#now() + ttlMs,
    });
  }

  schedule<T>(input: {
    game: string;
    level: CognitiveLevel;
    priority?: DecisionPriority;
    batchKey?: string;
    estimatedTokens: number;
    gameLimits?: Partial<GovernorLimits>;
    run: () => Promise<T>;
  }): Promise<ScheduleOutcome<T>> {
    if (input.level === 'offstage') return Promise.resolve({ accepted: false, reason: 'offstage' });
    if (input.level === 'ambient') return Promise.resolve({ accepted: false, reason: 'ambient_cache_miss' });
    const level = input.level;
    return new Promise((resolve, reject) => {
      const item: Scheduled<T> = {
        ...input,
        level,
        priority: input.priority ?? 'heartbeat',
        resolve,
        reject,
        order: this.#order++,
      };
      if (!this.#makeQueueSpace(item.priority)) {
        resolve({ accepted: false, reason: 'queue_drop' });
        return;
      }
      this.#queue.push(item as Scheduled<unknown>);
      this.#armDrain();
    });
  }

  batchKey(snapshot: PerceptionSnapshot): string | undefined {
    if (!snapshot.scene || !snapshot.visibilityGroup) return undefined;
    return `${snapshot.game}:${snapshot.scene}:${snapshot.visibilityGroup}`;
  }

  prune(): void {
    const before = this.#now() - this.#demotionRetentionMs;
    for (const [key, value] of this.#presence) {
      if ((value.detachedAt ?? value.lastActiveAt) < before) this.#presence.delete(key);
    }
    for (const [key, value] of this.#ambientCache) {
      if (value.expiresAt <= this.#now()) this.#ambientCache.delete(key);
    }
  }

  get trackedNpcCount() { return this.#presence.size; }
  get callsInWindow() { this.#refreshWindows(); return this.#globalBudget.calls; }
  get tokensInWindow() { this.#refreshWindows(); return this.#globalBudget.tokens; }
  get concurrent() { return this.#concurrent; }
  get queued() { return this.#queue.length; }

  budgetState(game?: string, gameLimits?: Partial<GovernorLimits>): NpcBudgetState {
    this.#refreshWindows();
    const gameBudget = game ? this.#gameBudget(game) : undefined;
    const callsLimit = Math.min(
      this.#limits.callsPerMinute,
      gameLimits?.callsPerMinute ?? Number.POSITIVE_INFINITY,
    );
    const callsUsed = Math.min(callsLimit, Math.max(this.#globalBudget.calls, gameBudget?.calls ?? 0));
    const tokensLimit = Math.min(
      this.#limits.tokensPerMinute,
      gameLimits?.tokensPerMinute ?? Number.POSITIVE_INFINITY,
    );
    const tokensUsed = Math.min(tokensLimit, Math.max(this.#globalBudget.tokens, gameBudget?.tokens ?? 0));
    const remainingRatio = Math.min(
      (callsLimit - callsUsed) / Math.max(1, callsLimit),
      (tokensLimit - tokensUsed) / Math.max(1, tokensLimit),
    );
    return {
      state: remainingRatio <= 0 ? 'exhausted' : remainingRatio <= 0.2 ? 'throttled' : 'ok',
      limit: callsLimit,
      used: callsUsed,
      remaining: callsLimit - callsUsed,
      calls: { limit: callsLimit, used: callsUsed, remaining: callsLimit - callsUsed },
      tokens: { limit: tokensLimit, used: tokensUsed, remaining: tokensLimit - tokensUsed },
      resetsAt: this.#globalBudget.startedAt + 60_000,
    };
  }

  #armDrain(): void {
    if (this.#timerPending) return;
    this.#timerPending = true;
    if (this.#batchWindowMs <= 0) {
      queueMicrotask(() => {
        this.#timerPending = false;
        this.#drain();
      });
      return;
    }
    this.#setTimer(() => {
      this.#timerPending = false;
      this.#drain();
    }, this.#batchWindowMs);
  }

  #drain(): void {
    this.#refreshWindows();
    this.#queue.sort((a, b) => priority(b.priority) - priority(a.priority) || a.order - b.order);
    while (this.#concurrent < this.#limits.maxConcurrent && this.#queue.length > 0) {
      const index = this.#queue.findIndex((item) => this.#fits(item));
      if (index < 0) {
        this.#rejectPermanentlyOverBudget();
        break;
      }
      const item = this.#queue.splice(index, 1)[0]!;
      const rejection = this.#budgetRejection(item);
      if (rejection) {
        item.resolve({ accepted: false, reason: rejection });
        continue;
      }
      this.#reserve(item);
      this.#concurrent += 1;
      item.run().then(
        (value) => item.resolve({ accepted: true, value }),
        (error) => item.reject(error),
      ).finally(() => {
        this.#concurrent -= 1;
        this.#drain();
      });
    }
  }

  #makeQueueSpace(itemPriority: DecisionPriority): boolean {
    if (this.#queue.length < this.#maxQueued) return true;
    const lowIndex = this.#queue.findIndex((item) => priority(item.priority) < priority(itemPriority));
    if (lowIndex < 0) return false;
    const [dropped] = this.#queue.splice(lowIndex, 1);
    dropped?.resolve({ accepted: false, reason: 'queue_drop' });
    return true;
  }

  #fits(item: Scheduled<unknown>): boolean {
    const maxConcurrent = Math.min(this.#limits.maxConcurrent, item.gameLimits?.maxConcurrent ?? Number.POSITIVE_INFINITY);
    return this.#concurrent < maxConcurrent;
  }

  #budgetRejection(item: Scheduled<unknown>): 'calls_budget' | 'tokens_budget' | undefined {
    const game = this.#gameBudget(item.game);
    const callsLimit = Math.min(this.#limits.callsPerMinute, item.gameLimits?.callsPerMinute ?? Number.POSITIVE_INFINITY);
    const tokensLimit = Math.min(this.#limits.tokensPerMinute, item.gameLimits?.tokensPerMinute ?? Number.POSITIVE_INFINITY);
    if (this.#globalBudget.calls >= this.#limits.callsPerMinute || game.calls >= callsLimit) return 'calls_budget';
    if (this.#globalBudget.tokens + item.estimatedTokens > this.#limits.tokensPerMinute
      || game.tokens + item.estimatedTokens > tokensLimit) return 'tokens_budget';
    return undefined;
  }

  #reserve(item: Scheduled<unknown>): void {
    const game = this.#gameBudget(item.game);
    this.#globalBudget.calls += 1;
    this.#globalBudget.tokens += item.estimatedTokens;
    game.calls += 1;
    game.tokens += item.estimatedTokens;
  }

  #rejectPermanentlyOverBudget(): void {
    for (let index = this.#queue.length - 1; index >= 0; index--) {
      const item = this.#queue[index]!;
      const rejection = this.#budgetRejection(item);
      if (!rejection) continue;
      this.#queue.splice(index, 1);
      item.resolve({ accepted: false, reason: rejection });
    }
  }

  #refreshWindows(): void {
    const now = this.#now();
    if (now - this.#globalBudget.startedAt >= 60_000) this.#globalBudget = this.#newWindow();
    for (const [game, budget] of this.#gameBudgets) {
      if (now - budget.startedAt >= 60_000) this.#gameBudgets.set(game, this.#newWindow());
    }
  }

  #gameBudget(game: string): BudgetWindow {
    let budget = this.#gameBudgets.get(game);
    if (!budget) {
      budget = this.#newWindow();
      this.#gameBudgets.set(game, budget);
    }
    return budget;
  }

  #newWindow(): BudgetWindow {
    return { startedAt: this.#now(), calls: 0, tokens: 0 };
  }

  #presenceKey(game: string, npcId: string): string {
    return `${game}:${npcId}`;
  }

  #situationSignature(snapshot: PerceptionSnapshot): string {
    return JSON.stringify({
      scene: snapshot.scene,
      visibilityGroup: snapshot.visibilityGroup,
      activity: snapshot.self.activity,
      mood: snapshot.self.mood,
      nearby: snapshot.nearby.map(({ kind, id }) => [kind, id]),
      affordances: snapshot.affordances.map(({ action }) => action),
    });
  }
}

function priority(value: DecisionPriority): number {
  return { heartbeat: 0, promoted: 1, combat: 2, player: 3 }[value];
}
