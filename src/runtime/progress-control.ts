/**
 * Generic, host-injected progress control for long-running agent work.
 *
 * The orchestrator owns only the state machine: persistence-safe snapshots,
 * active-work budgeting, repeat/no-progress detection, stale-evidence handling,
 * and an explicit continuation transition. A product host supplies the phase,
 * thresholds, and event classifier. With no policy injected this module is
 * completely inert, so standalone consumers keep their existing behavior.
 */

export type ProgressStatus = "running" | "waiting" | "paused";

export type ProgressPauseReason =
  | "phase_budget_exceeded"
  | "policy_error"
  | "no_progress";

export type ProgressObservationKind = "progress" | "work" | "wait";

export type ProgressWaitKind = "tool" | "authorization" | "subtask" | "user";

export interface ProgressEvidence {
  /** Host-owned stable identity for a validated result or completed artifact. */
  readonly id: string;
  /** Host-owned digest. The controller never interprets file paths or payloads. */
  readonly digest: string;
  /** Input identity against which this evidence was validated. */
  readonly inputFingerprint: string;
  /** Completed artifacts are retained across input changes, but become stale. */
  readonly artifact?: boolean;
}

export interface ProgressObservation {
  readonly kind: ProgressObservationKind;
  /** Same signature means the host observed the same attempted work again. */
  readonly signature?: string;
  /** A changed input invalidates only reusable validation, not saved artifacts. */
  readonly inputFingerprint?: string;
  /** Testable event time; production hosts may omit it and use the clock. */
  readonly at?: number;
  /** Waits are excluded from active-work duration and no-progress counters. */
  readonly waitKind?: ProgressWaitKind;
  /** Evidence is accepted only for the current input fingerprint. */
  readonly evidence?: readonly ProgressEvidence[];
}

export interface ProgressPolicyContext {
  readonly sessionId: string;
  readonly agentId: string;
  /** Opaque product scope; the orchestrator does not interpret it. */
  readonly scope?: string;
}

/** Minimal event shape exposed to a classifier; the core EventBus remains an
 * implementation detail and non-Studio hosts may adapt their own event type. */
export interface ProgressEvent {
  readonly source?: string;
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly ts: number;
}

export interface ProgressEventContext extends ProgressPolicyContext {
  readonly event: ProgressEvent;
  readonly snapshot: ProgressSnapshot;
}

export type ProgressEventClassifier =
  (context: ProgressEventContext) => ProgressObservation | undefined;

export interface ProgressPolicy {
  /** Product-owned phase identity, e.g. "playable-loop" or "visual-polish". */
  readonly phase: string;
  /** Active work budget. Waiting/authorization/subtask time is excluded. */
  readonly phaseBudgetMs?: number;
  /** Consecutive non-progress work observations before pausing. */
  readonly noProgressLimit?: number;
  /** Maximum number of compact first rechecks after evidence is invalidated. */
  readonly initialCheckBatch?: number;
  /** Host-owned mapping from lifecycle events to progress/wait/work facts. */
  readonly classify?: ProgressEventClassifier;
  /** Read current inputs from the host, never from a persisted summary/client. */
  readonly resolveInputFingerprint?: () => string | undefined | Promise<string | undefined>;
}

export type ProgressPolicyProvider =
  (context: ProgressPolicyContext) => ProgressPolicy | undefined;

export interface ProgressSnapshot {
  readonly version: 1;
  readonly phase: string;
  readonly status: ProgressStatus;
  readonly pauseReason?: ProgressPauseReason;
  readonly waitKind?: ProgressWaitKind;
  readonly inputFingerprint?: string;
  readonly activeWorkMs: number;
  /** Cumulative work at the last explicitly renewed time-budget window. */
  readonly budgetWindowStartMs?: number;
  readonly lastObservedAt: number;
  readonly lastProgressAt?: number;
  readonly noProgressStreak: number;
  readonly repeatSignature?: string;
  readonly repeatCount: number;
  readonly continuationCount: number;
  /** Evidence that is currently valid for inputFingerprint. */
  readonly validatedEvidence: readonly ProgressEvidence[];
  /** Durable output identity retained even when its validation becomes stale. */
  readonly completedArtifacts: readonly ProgressEvidence[];
  /** Evidence IDs that must be rechecked before an old result is reused. */
  readonly staleEvidenceIds: readonly string[];
  /** Ordered candidate IDs for the host's next compact check batch. */
  readonly pendingRecheckIds: readonly string[];
}

export interface ProgressRecheckPlan {
  readonly required: boolean;
  readonly checks: readonly string[];
  readonly remaining: number;
}

export interface ProgressDecision {
  readonly action: "continue" | "pause";
  readonly reason?: ProgressPauseReason;
  readonly changed: boolean;
  readonly snapshot: ProgressSnapshot;
  readonly recheck: ProgressRecheckPlan;
}

export interface ProgressRestoreResult {
  readonly restored: boolean;
  readonly inputChanged: boolean;
  readonly snapshot: ProgressSnapshot;
  readonly recheck: ProgressRecheckPlan;
  readonly reason?: "invalid_snapshot" | "phase_changed";
}

export interface ProgressMetric {
  readonly type:
    | "progress.input-invalidated"
    | "progress.paused"
    | "progress.resumed";
  readonly snapshot: ProgressSnapshot;
  readonly reason?: ProgressPauseReason;
}

export interface ProgressControllerOptions {
  readonly now?: () => number;
  /**
   * Generic metric seam consumed by the host's telemetry contract. The
   * orchestrator deliberately does not emit a duplicate TelemetryRecord.
   */
  readonly emitMetric?: (metric: ProgressMetric) => void;
}

function finitePositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function integerPositive(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function cloneEvidence(evidence: readonly ProgressEvidence[]): ProgressEvidence[] {
  return evidence.map((item) => ({
    id: item.id,
    digest: item.digest,
    inputFingerprint: item.inputFingerprint,
    ...(item.artifact ? { artifact: true } : {}),
  }));
}

function isEvidence(value: unknown): value is ProgressEvidence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProgressEvidence>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.digest === "string"
    && candidate.digest.length > 0
    && typeof candidate.inputFingerprint === "string"
    && candidate.inputFingerprint.length > 0
    && (candidate.artifact === undefined || typeof candidate.artifact === "boolean");
}

function snapshotKey(snapshot: ProgressSnapshot): string {
  return JSON.stringify(snapshot);
}

function isSnapshot(value: unknown): value is ProgressSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProgressSnapshot>;
  return candidate.version === 1
    && typeof candidate.phase === "string"
    && (candidate.status === "running"
      || candidate.status === "waiting"
      || candidate.status === "paused")
    && typeof candidate.activeWorkMs === "number"
    && Number.isFinite(candidate.activeWorkMs)
    && candidate.activeWorkMs >= 0
    && (candidate.budgetWindowStartMs === undefined
      || (Number.isFinite(candidate.budgetWindowStartMs)
        && candidate.budgetWindowStartMs >= 0
        && candidate.budgetWindowStartMs <= candidate.activeWorkMs))
    && typeof candidate.lastObservedAt === "number"
    && Number.isFinite(candidate.lastObservedAt)
    && typeof candidate.noProgressStreak === "number"
    && Number.isFinite(candidate.noProgressStreak)
    && typeof candidate.repeatCount === "number"
    && Number.isFinite(candidate.repeatCount)
    && typeof candidate.continuationCount === "number"
    && Number.isFinite(candidate.continuationCount)
    && Array.isArray(candidate.validatedEvidence)
    && candidate.validatedEvidence.every(isEvidence)
    && Array.isArray(candidate.completedArtifacts)
    && candidate.completedArtifacts.every(isEvidence)
    && Array.isArray(candidate.staleEvidenceIds)
    && candidate.staleEvidenceIds.every((item) => typeof item === "string")
    && Array.isArray(candidate.pendingRecheckIds)
    && candidate.pendingRecheckIds.every((item) => typeof item === "string");
}

/**
 * Deterministic progress state machine. It is intentionally independent from
 * EventBus, ledgers, file paths, and product stages so it can be restored and
 * tested with a small injected fixture.
 */
export class ProgressController {
  private readonly now: () => number;
  private readonly emitMetric?: (metric: ProgressMetric) => void;
  private readonly phaseBudgetMs?: number;
  private readonly noProgressLimit?: number;
  private readonly initialCheckBatch: number;
  private state: ProgressSnapshot;

  constructor(
    private readonly policy: ProgressPolicy,
    options: ProgressControllerOptions = {},
  ) {
    if (!policy.phase.trim()) throw new Error("progress policy phase must not be empty");
    this.phaseBudgetMs = finitePositive(policy.phaseBudgetMs);
    this.noProgressLimit = integerPositive(policy.noProgressLimit);
    this.initialCheckBatch = integerPositive(policy.initialCheckBatch) ?? 3;
    this.now = options.now ?? Date.now;
    this.emitMetric = options.emitMetric;
    const now = this.now();
    this.state = {
      version: 1,
      phase: policy.phase,
      status: "running",
      activeWorkMs: 0,
      lastObservedAt: now,
      noProgressStreak: 0,
      repeatCount: 0,
      continuationCount: 0,
      validatedEvidence: [],
      completedArtifacts: [],
      staleEvidenceIds: [],
      pendingRecheckIds: [],
    };
  }

  snapshot(): ProgressSnapshot {
    return {
      ...this.state,
      ...(this.state.pauseReason ? { pauseReason: this.state.pauseReason } : {}),
      ...(this.state.waitKind ? { waitKind: this.state.waitKind } : {}),
      ...(this.state.inputFingerprint
        ? { inputFingerprint: this.state.inputFingerprint }
        : {}),
      ...(this.state.lastProgressAt !== undefined
        ? { lastProgressAt: this.state.lastProgressAt }
        : {}),
      ...(this.state.repeatSignature
        ? { repeatSignature: this.state.repeatSignature }
        : {}),
      validatedEvidence: cloneEvidence(this.state.validatedEvidence),
      completedArtifacts: cloneEvidence(this.state.completedArtifacts),
      staleEvidenceIds: [...this.state.staleEvidenceIds],
      pendingRecheckIds: [...this.state.pendingRecheckIds],
    };
  }

  /** Whether a new turn is allowed without an explicit continuation. */
  canStartTurn(): boolean {
    return this.state.status !== "paused";
  }

  resolveInputFingerprint(): Promise<string | undefined> {
    return Promise.resolve(this.policy.resolveInputFingerprint?.());
  }

  /** Called before execution, after any idle time or restored process downtime. */
  startTurn(): void {
    if (!this.canStartTurn()) throw new Error("progress paused: explicit continue required");
    this.state = { ...this.state, status: "running", waitKind: undefined, lastObservedAt: this.now() };
  }

  recheckPlan(): ProgressRecheckPlan {
    const checks = this.state.pendingRecheckIds.slice(0, this.initialCheckBatch);
    return {
      required: this.state.pendingRecheckIds.length > 0,
      checks,
      remaining: Math.max(0, this.state.pendingRecheckIds.length - checks.length),
    };
  }

  classify(context: Omit<ProgressEventContext, "snapshot">): ProgressObservation | undefined {
    return this.policy.classify?.({ ...context, snapshot: this.snapshot() });
  }

  observe(observation: ProgressObservation): ProgressDecision {
    const before = snapshotKey(this.snapshot());
    const timestamp = observation.at ?? this.now();
    if (!Number.isFinite(timestamp)) throw new Error("progress observation time must be finite");
    const at = Math.max(timestamp, this.state.lastObservedAt);
    this.updateInput(observation.inputFingerprint);

    if (this.state.status === "paused") {
      return this.decision(before, "pause", this.state.pauseReason);
    }

    const previousStatus = this.state.status;
    if (previousStatus !== "waiting") {
      this.state = {
        ...this.state,
        activeWorkMs: this.state.activeWorkMs + Math.max(0, at - this.state.lastObservedAt),
        lastObservedAt: at,
      };
    } else {
      // Time spent in a valid wait/authorization/subtask is not active work.
      this.state = { ...this.state, lastObservedAt: at };
    }

    if (observation.kind === "wait") {
      this.state = {
        ...this.state,
        status: "waiting",
        waitKind: observation.waitKind ?? "tool",
        pauseReason: undefined,
      };
      if (this.budgetExceeded()) return this.pauseInternal(before, "phase_budget_exceeded");
      return this.decision(before, "continue");
    }

    this.state = {
      ...this.state,
      status: "running",
      waitKind: undefined,
      pauseReason: undefined,
    };
    this.acceptEvidence(observation.evidence);

    if (observation.kind === "progress") {
      this.state = {
        ...this.state,
        lastProgressAt: at,
        noProgressStreak: 0,
        repeatSignature: undefined,
        repeatCount: 0,
      };
    } else {
      const signature = observation.signature ?? "<unspecified>";
      const same = signature === this.state.repeatSignature;
      this.state = {
        ...this.state,
        noProgressStreak: this.state.noProgressStreak + 1,
        repeatSignature: signature,
        repeatCount: same ? this.state.repeatCount + 1 : 1,
      };
    }

    if (this.budgetExceeded()) {
      return this.pauseInternal(before, "phase_budget_exceeded");
    }
    if (
      this.noProgressLimit !== undefined
      && (this.state.noProgressStreak >= this.noProgressLimit
        || this.state.repeatCount >= this.noProgressLimit)
    ) {
      return this.pauseInternal(before, "no_progress");
    }
    return this.decision(before, "continue");
  }

  /** Explicit user/host acknowledgement to continue after a controlled pause. */
  continue(options: { inputFingerprint?: string; at?: number } = {}): ProgressDecision {
    const before = snapshotKey(this.snapshot());
    if (this.state.status !== "paused") return this.decision(before, "continue");
    this.updateInput(options.inputFingerprint);
    const at = options.at ?? this.now();
    this.state = {
      ...this.state,
      ...(this.state.pauseReason === "phase_budget_exceeded"
        ? { budgetWindowStartMs: this.state.activeWorkMs }
        : {}),
      status: "waiting",
      pauseReason: undefined,
      waitKind: "user",
      noProgressStreak: 0,
      repeatSignature: undefined,
      repeatCount: 0,
      continuationCount: this.state.continuationCount + 1,
      lastObservedAt: at,
    };
    this.emitMetric?.({ type: "progress.resumed", snapshot: this.snapshot() });
    return this.decision(before, "continue");
  }

  /** Product hosts may explicitly pause without discarding any state. */
  pause(reason: ProgressPauseReason): ProgressDecision {
    const before = snapshotKey(this.snapshot());
    return this.pauseInternal(before, reason);
  }

  /** Restore only a versioned snapshot; never trust an unrecognised shape. */
  restore(
    persisted: unknown,
    options: { inputFingerprint?: string; at?: number } = {},
  ): ProgressRestoreResult {
    const at = options.at ?? this.now();
    if (!isSnapshot(persisted)) {
      return {
        restored: false,
        inputChanged: false,
        snapshot: this.snapshot(),
        recheck: this.recheckPlan(),
        reason: "invalid_snapshot",
      };
    }

    const phaseChanged = persisted.phase !== this.policy.phase;
    if (phaseChanged) {
      this.state = {
        ...this.state,
        ...(persisted.status === "paused"
          ? { status: "paused" as const, pauseReason: persisted.pauseReason }
          : {}),
        completedArtifacts: cloneEvidence(persisted.completedArtifacts),
        staleEvidenceIds: unique([
          ...persisted.staleEvidenceIds,
          ...persisted.validatedEvidence.map((item) => item.id),
          ...persisted.completedArtifacts.map((item) => item.id),
        ]),
        pendingRecheckIds: unique([
          ...persisted.staleEvidenceIds,
          ...persisted.validatedEvidence.map((item) => item.id),
          ...persisted.completedArtifacts.map((item) => item.id),
        ]),
        lastObservedAt: at,
      };
      return {
        restored: false,
        inputChanged: true,
        snapshot: this.snapshot(),
        recheck: this.recheckPlan(),
        reason: "phase_changed",
      };
    }

    this.state = {
      ...persisted,
      lastObservedAt: at,
      validatedEvidence: cloneEvidence(persisted.validatedEvidence),
      completedArtifacts: cloneEvidence(persisted.completedArtifacts),
      staleEvidenceIds: unique(persisted.staleEvidenceIds),
      pendingRecheckIds: unique(persisted.pendingRecheckIds),
    };
    // Without a current input fingerprint we cannot prove that persisted
    // validation still applies. Preserve artifacts, but require the host to
    // recheck validation when it resumes with the first current input/event.
    const inputUnknown = options.inputFingerprint === undefined
      && persisted.inputFingerprint !== undefined;
    if (inputUnknown) {
      const evidenceIds = [
        ...this.state.validatedEvidence.map((item) => item.id),
        ...this.state.completedArtifacts.map((item) => item.id),
      ];
      this.state = {
        ...this.state,
        inputFingerprint: undefined,
        validatedEvidence: [],
        staleEvidenceIds: unique([...this.state.staleEvidenceIds, ...evidenceIds]),
        pendingRecheckIds: unique([...this.state.pendingRecheckIds, ...evidenceIds]),
      };
    }
    const inputChanged = this.updateInput(options.inputFingerprint, false) || inputUnknown;
    return {
      restored: true,
      inputChanged,
      snapshot: this.snapshot(),
      recheck: this.recheckPlan(),
    };
  }

  private updateInput(inputFingerprint: string | undefined, emit = true): boolean {
    if (!inputFingerprint || inputFingerprint === this.state.inputFingerprint) return false;
    const previous = this.state.inputFingerprint;
    const changed = previous !== undefined && previous !== inputFingerprint;
    const evidenceIds = [
      ...this.state.validatedEvidence.map((item) => item.id),
      ...this.state.completedArtifacts.map((item) => item.id),
    ];
    this.state = {
      ...this.state,
      inputFingerprint,
      ...(changed
        ? {
            validatedEvidence: [],
            staleEvidenceIds: unique([...this.state.staleEvidenceIds, ...evidenceIds]),
            pendingRecheckIds: unique([
              ...this.state.pendingRecheckIds,
              ...evidenceIds,
            ]),
          }
        : {}),
    };
    if (changed && emit) {
      this.emitMetric?.({
        type: "progress.input-invalidated",
        snapshot: this.snapshot(),
      });
    }
    return changed;
  }

  private budgetExceeded(): boolean {
    return this.phaseBudgetMs !== undefined
      && this.state.activeWorkMs - (this.state.budgetWindowStartMs ?? 0) >= this.phaseBudgetMs;
  }

  private acceptEvidence(evidence: readonly ProgressEvidence[] | undefined): void {
    if (!evidence || evidence.length === 0) return;
    let validated = [...this.state.validatedEvidence];
    let artifacts = [...this.state.completedArtifacts];
    let stale = new Set(this.state.staleEvidenceIds);
    let pending = new Set(this.state.pendingRecheckIds);
    for (const item of evidence) {
      if (!item.id || !item.digest || item.inputFingerprint !== this.state.inputFingerprint) continue;
      validated = [...validated.filter((existing) => existing.id !== item.id), { ...item }];
      if (item.artifact) {
        artifacts = [...artifacts.filter((existing) => existing.id !== item.id), { ...item }];
      }
      stale.delete(item.id);
      pending.delete(item.id);
    }
    this.state = {
      ...this.state,
      validatedEvidence: validated,
      completedArtifacts: artifacts,
      staleEvidenceIds: [...stale],
      pendingRecheckIds: [...pending],
    };
  }

  private decision(
    before: string,
    action: "continue" | "pause",
    reason?: ProgressPauseReason,
  ): ProgressDecision {
    const snapshot = this.snapshot();
    return {
      action,
      ...(reason ? { reason } : {}),
      changed: before !== snapshotKey(snapshot),
      snapshot,
      recheck: this.recheckPlan(),
    };
  }

  private pauseInternal(before: string, reason: ProgressPauseReason): ProgressDecision {
    this.state = {
      ...this.state,
      status: "paused",
      pauseReason: reason,
      waitKind: undefined,
    };
    const snapshot = this.snapshot();
    this.emitMetric?.({
      type: "progress.paused",
      snapshot,
      reason,
    });
    return {
      action: "pause",
      reason,
      changed: before !== snapshotKey(snapshot),
      snapshot,
      recheck: this.recheckPlan(),
    };
  }
}
