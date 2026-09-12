import { describe, expect, test } from "bun:test";
import {
  ProgressController,
  type ProgressEvidence,
  type ProgressSnapshot,
} from "./progress-control";

const artifact: ProgressEvidence = {
  id: "scene-check",
  digest: "sha256:old",
  inputFingerprint: "input-a",
  artifact: true,
};

function restoredSnapshot(): ProgressSnapshot {
  const controller = new ProgressController({
    phase: "playable-loop",
    initialCheckBatch: 1,
  }, { now: () => 100 });
  controller.observe({
    kind: "progress",
    inputFingerprint: "input-a",
    at: 110,
    evidence: [artifact],
  });
  return controller.snapshot();
}

describe("ProgressController", () => {
  test("restores validated evidence when the relevant input is unchanged", () => {
    const controller = new ProgressController({
      phase: "playable-loop",
      initialCheckBatch: 2,
    }, { now: () => 500 });
    const result = controller.restore(restoredSnapshot(), {
      inputFingerprint: "input-a",
      at: 500,
    });

    expect(result.restored).toBe(true);
    expect(result.inputChanged).toBe(false);
    expect(result.snapshot.validatedEvidence).toHaveLength(1);
    expect(result.recheck.required).toBe(false);
  });

  test("invalidates old validation on input change but preserves completed artifacts", () => {
    const controller = new ProgressController({
      phase: "playable-loop",
      initialCheckBatch: 1,
    }, { now: () => 500 });
    const result = controller.restore(restoredSnapshot(), {
      inputFingerprint: "input-b",
      at: 500,
    });

    expect(result.inputChanged).toBe(true);
    expect(result.snapshot.validatedEvidence).toHaveLength(0);
    expect(result.snapshot.completedArtifacts).toEqual([artifact]);
    expect(result.snapshot.staleEvidenceIds).toEqual(["scene-check"]);
    expect(result.recheck).toEqual({
      required: true,
      checks: ["scene-check"],
      remaining: 0,
    });
  });

  test("does not reuse persisted validation when the resumed input is unknown", () => {
    const controller = new ProgressController({
      phase: "playable-loop",
      initialCheckBatch: 1,
    }, { now: () => 500 });
    const result = controller.restore(restoredSnapshot(), { at: 500 });

    expect(result.inputChanged).toBe(true);
    expect(result.snapshot.validatedEvidence).toHaveLength(0);
    expect(result.snapshot.completedArtifacts).toEqual([artifact]);
    expect(result.recheck.checks).toEqual(["scene-check"]);
  });

  test("does not count a valid wait or authorization hold as no progress", () => {
    const controller = new ProgressController({
      phase: "playable-loop",
      noProgressLimit: 3,
      phaseBudgetMs: 10,
    }, { now: () => 0 });

    controller.observe({ kind: "work", signature: "poll", at: 1 });
    const waiting = controller.observe({
      kind: "wait",
      waitKind: "authorization",
      at: 2,
    });
    const afterLongWait = controller.observe({ kind: "work", signature: "poll", at: 1002 });

    expect(waiting.snapshot.status).toBe("waiting");
    expect(afterLongWait.action).toBe("continue");
    expect(afterLongWait.snapshot.status).toBe("running");
    expect(afterLongWait.snapshot.noProgressStreak).toBe(2);
    expect(afterLongWait.snapshot.activeWorkMs).toBe(2);
  });

  test("pauses a repeated no-progress loop without erasing state", () => {
    const metrics: string[] = [];
    const controller = new ProgressController({
      phase: "playable-loop",
      noProgressLimit: 3,
    }, {
      now: () => 0,
      emitMetric: (metric) => metrics.push(metric.type),
    });

    controller.observe({ kind: "work", signature: "invalid-write", at: 1 });
    controller.observe({ kind: "work", signature: "invalid-write", at: 2 });
    const paused = controller.observe({
      kind: "work",
      signature: "invalid-write",
      inputFingerprint: "input-a",
      at: 3,
      evidence: [artifact],
    });

    expect(paused.action).toBe("pause");
    expect(paused.reason).toBe("no_progress");
    expect(paused.snapshot.status).toBe("paused");
    expect(paused.snapshot.completedArtifacts).toEqual([artifact]);
    expect(metrics).toContain("progress.paused");
  });

  test("pauses on active-work budget and preserves evidence", () => {
    const controller = new ProgressController({
      phase: "visual-polish",
      phaseBudgetMs: 5,
    }, { now: () => 0 });
    controller.observe({
      kind: "progress",
      inputFingerprint: "input-a",
      at: 1,
      evidence: [artifact],
    });
    const paused = controller.observe({ kind: "work", signature: "next", at: 6 });

    expect(paused.action).toBe("pause");
    expect(paused.reason).toBe("phase_budget_exceeded");
    expect(paused.snapshot.completedArtifacts).toEqual([artifact]);
    expect(paused.snapshot.activeWorkMs).toBe(6);
  });

  test("requires an explicit continuation and keeps prior work accounting", () => {
    const controller = new ProgressController({
      phase: "playable-loop",
      noProgressLimit: 1,
    }, { now: () => 0 });
    controller.observe({ kind: "work", signature: "stuck", at: 1 });
    expect(controller.snapshot().status).toBe("paused");

    const resumed = controller.continue({ at: 10 });
    expect(resumed.action).toBe("continue");
    expect(resumed.snapshot.status).toBe("waiting");
    expect(resumed.snapshot.continuationCount).toBe(1);
    expect(resumed.snapshot.activeWorkMs).toBe(1);

    const progress = controller.observe({ kind: "progress", at: 11 });
    expect(progress.action).toBe("continue");
    expect(progress.snapshot.status).toBe("running");
  });

  test("explicitly renews an exhausted time budget, including across restore", () => {
    const controller = new ProgressController({ phase: "test", phaseBudgetMs: 5 }, { now: () => 0 });
    expect(controller.observe({ kind: "work", at: 6 }).action).toBe("pause");
    const renewed = controller.continue({ at: 100 });
    expect(renewed.snapshot.activeWorkMs).toBe(6);
    expect(renewed.snapshot.budgetWindowStartMs).toBe(6);
    // A duplicate acknowledgement must not grant more time or change accounting.
    expect(controller.continue({ at: 200 }).snapshot.continuationCount).toBe(1);
    const restored = new ProgressController({ phase: "test", phaseBudgetMs: 5 }, { now: () => 300 });
    restored.restore(controller.snapshot(), { at: 300 });
    restored.startTurn();
    expect(restored.observe({ kind: "progress", at: 301 }).action).toBe("continue");
    expect(restored.observe({ kind: "work", at: 305 }).action).toBe("pause");
    expect(restored.snapshot().activeWorkMs).toBe(11);
  });

  test("idle time between turns is excluded without clearing loop history", () => {
    let now = 0;
    const controller = new ProgressController({ phase: "test", phaseBudgetMs: 10 }, { now: () => now });
    controller.observe({ kind: "work", at: 1 });
    controller.observe({ kind: "wait", waitKind: "user", at: 2 });
    now = 10000;
    controller.startTurn();
    const next = controller.observe({ kind: "work", at: 10001 });
    expect(next.action).toBe("continue");
    expect(next.snapshot.activeWorkMs).toBe(3);
    expect(next.snapshot.noProgressStreak).toBe(2);
  });

  test("charges work completed before entering a wait", () => {
    const controller = new ProgressController({ phase: "test", phaseBudgetMs: 5 }, { now: () => 0 });
    expect(controller.observe({ kind: "wait", waitKind: "tool", at: 6 }).reason)
      .toBe("phase_budget_exceeded");
  });

  test("out-of-order observations cannot double-count elapsed time", () => {
    const controller = new ProgressController({ phase: "test" }, { now: () => 0 });
    controller.observe({ kind: "progress", at: 10 });
    controller.observe({ kind: "progress", at: 5 });
    expect(controller.observe({ kind: "progress", at: 11 }).snapshot.activeWorkMs).toBe(11);
    expect(() => controller.observe({ kind: "progress", at: NaN })).toThrow("finite");
  });

  test("host input resolver supplies current input when restoring evidence", async () => {
    let input = "input-a";
    const controller = new ProgressController({
      phase: "playable-loop", resolveInputFingerprint: async () => input,
    });
    const persisted = restoredSnapshot();
    expect(controller.restore(persisted, {
      inputFingerprint: await controller.resolveInputFingerprint(),
    }).snapshot.validatedEvidence).toHaveLength(1);
    input = "input-b";
    expect(controller.restore(persisted, {
      inputFingerprint: await controller.resolveInputFingerprint(),
    }).snapshot.validatedEvidence).toHaveLength(0);
  });

  test("changing phase cannot silently lift a persisted pause", () => {
    const previous = new ProgressController({ phase: "first", noProgressLimit: 1 });
    previous.observe({ kind: "work" });
    const next = new ProgressController({ phase: "second" });
    next.restore(previous.snapshot());
    expect(next.canStartTurn()).toBe(false);
    expect(() => next.startTurn()).toThrow("explicit continue required");
  });
});
