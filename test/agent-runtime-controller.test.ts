import { describe, expect, test } from "bun:test";
import type { FrozenAgentTemplate } from "../src/agents/template-types";
import { AgentExecutionBinding } from "../src/runtime/agent-execution";
import {
  AgentRuntimeController,
  type AgentTurnResult,
  type RuntimeTurnBatch,
} from "../src/runtime/agent-runtime-controller";
import { RuntimeConfigBinding } from "../src/runtime/runtime-config";
import type { AgentInstance } from "../src/runtime/types";

function instance(lifetime: "resident" | "ephemeral" = "resident"): AgentInstance {
  const template = Object.freeze({
    templateRef: "tpl_test",
    definitionRevision: "def_1",
    definition: { id: "tester" },
    runtimeConfigDefaults: {},
    resources: { skills: [], kits: [], memorySeeds: [] },
    execution: {
      revision: "exec_1",
      skills: [],
      kits: [],
    },
  } satisfies FrozenAgentTemplate);
  return {
    sid: "sid-1",
    instanceId: "instance-1",
    runtimeEpochId: "epoch-1",
    templateRef: template.templateRef,
    parentInstanceId: null,
    lifetime,
    template,
    runtime: {
      workspaceRoot: "/tmp",
      runtimeStateRoot: "/tmp/runtime-state/instance-1",
      runtimeStateRef: "memory:test",
    },
    runtimeConfig: new RuntimeConfigBinding({
      revision: "cfg_1",
      value: {},
    }),
    execution: new AgentExecutionBinding(template.execution),
    events: {
      ownerInstanceId: "instance-1",
      runtimeEpochId: "epoch-1",
      storeId: "store-1",
      locator: { relativeDir: "runtime-events/ephemeral/instance-1" },
    },
    createdAt: 1,
    state: "registered",
  };
}

test.each(['before', 'after'])('host feedback arriving %s Stop cannot restart a paid turn', async (timing) => {
  const calls: unknown[] = [];
  let release!: () => void;
  const finishing = new Promise<void>(resolve => { release = resolve; });
  const controller = new AgentRuntimeController(instance(), {
    execute: async (_instance, input) => {
      calls.push(input);
      if (calls.length === 1) await finishing;
      return { final: false };
    },
  });
  controller.start();
  const active = controller.enqueue({ source: 'user' });
  if (timing === 'after') controller.stopTurn();
  const feedback = controller.enqueueFeedback({ source: 'studio-runtime', handoff: 'steer', payload: { content: 'failure' } });
  if (timing === 'before') controller.stopTurn();
  release();
  await active;
  await controller.waitForQuiescence();
  expect(calls).toHaveLength(1);
  await controller.enqueue({ source: 'user', payload: { content: 'continue' } });
  await feedback;
  expect(calls).toHaveLength(2);
  expect((calls[1] as RuntimeTurnBatch).inputs[0]).toMatchObject({ source: 'studio-runtime', handoff: 'silent' });
  await controller.dispose();
});

describe("AgentRuntimeController handoff", () => {
  test("user stop preserves peer results without automatically starting another turn", async () => {
    const calls: unknown[] = [];
    const controller = new AgentRuntimeController(instance(), {
      execute: async (_instance, input, _bindings, signal) => {
        calls.push(input);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("stopped");
        }
        return { final: false };
      },
    });
    controller.start();
    const active = controller.enqueue({ source: "user" }).catch(() => undefined);
    const callback = controller.enqueue({ source: "agent", handoff: "turn", payload: { content: "artifact" } });
    controller.stopTurn();
    await active;
    await controller.waitForQuiescence();
    expect(calls).toHaveLength(1);
    const continuation = controller.enqueue({ source: "user", payload: { content: "continue" } });
    await Promise.all([callback, continuation]);
    expect(calls).toHaveLength(2);
    expect((calls[1] as RuntimeTurnBatch).inputs).toEqual([
      { source: "agent", handoff: "silent", payload: { content: "artifact" } },
      { source: "user", payload: { content: "continue" } },
    ]);
    await controller.dispose();
  });

  test("stop cancels an unstarted assignment but retains queued human input", async () => {
    const calls: unknown[] = [];
    const controller = new AgentRuntimeController(instance(), {
      execute: async (_instance, input, _bindings, signal) => {
        calls.push(input);
        if (calls.length === 1) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { final: false };
      },
    });
    controller.start();
    const active = controller.enqueue({ source: "user" });
    const assignment = controller.enqueue({ source: "agent", type: "user_input" }).catch((error) => error.message);
    const human = controller.enqueue({ source: "user", type: "user_input", payload: { content: "next" } });
    controller.stopTurn("user stopped");
    await Promise.all([active, human]);
    expect(await assignment).toBe("user stopped");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ source: "user", payload: { content: "next" } });
    await controller.dispose();
  });

  test("dispose rejects synchronous admission from an abort listener", async () => {
    let rejected = false;
    const controller = new AgentRuntimeController(instance(), {
      execute: async (_instance, _input, _bindings, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          try { controller.acceptTurn({ source: "agent" }); } catch { rejected = true; }
          resolve();
        }, { once: true }));
        return { final: false };
      },
    });
    controller.start();
    const active = controller.enqueue({ source: "user" });
    await controller.dispose();
    await active;
    expect(rejected).toBe(true);
    expect(controller.pendingTurns).toBe(0);
  });

  test("silent 只积累，由下一条 turn 触发同一批执行", async () => {
    const calls: unknown[] = [];
    const controller = new AgentRuntimeController(instance(), {
      execute: async (_instance, input) => {
        calls.push(input);
        return { final: false, output: "ok" };
      },
    });
    controller.start();

    const silent = controller.enqueue({
      source: "system",
      type: "background",
      payload: { content: "context" },
      handoff: "silent",
      ts: 1,
    });
    await Bun.sleep(2);
    expect(calls).toHaveLength(0);

    const turn = controller.enqueue({
      source: "user",
      type: "user_input",
      payload: { content: "go" },
      handoff: "turn",
      ts: 2,
    });
    const [silentResult, turnResult] = await Promise.all([silent, turn]);
    expect(silentResult.output).toBe("ok");
    expect(turnResult.output).toBe("ok");
    expect(calls).toHaveLength(1);
    const batch = calls[0] as RuntimeTurnBatch;
    expect(batch.kind).toBe("runtime-turn-batch");
    expect(batch.inputs).toHaveLength(2);
    await controller.dispose();
  });

  test("agent_command 独立执行，不与等待中的 user_input 合并", async () => {
    const runtimeInstance = instance();
    runtimeInstance.runtimeConfig.stage({
      revision: "cfg_coalesce",
      value: { coalesceMs: 10 },
    });
    const calls: unknown[] = [];
    const controller = new AgentRuntimeController(runtimeInstance, {
      execute: async (_instance, input) => {
        calls.push(input);
        return { final: false, output: "ok" };
      },
    });
    controller.start();

    const userTurn = controller.enqueue({
      source: "user",
      type: "user_input",
      payload: { content: "hello" },
      handoff: "turn",
      ts: 1,
    });
    const commandTurn = controller.enqueue({
      source: "user",
      type: "agent_command",
      payload: { toolName: "compact", args: {} },
      handoff: "turn",
      ts: 2,
    });

    await Promise.all([userTurn, commandTurn]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ type: "agent_command" });
    expect(calls[1]).toMatchObject({ type: "user_input" });
    expect(calls.some((input) =>
      (input as { kind?: unknown }).kind === "runtime-turn-batch"
    )).toBe(false);
    await controller.dispose();
  });

  test("Session mutation 可取消 coalesce 等待，不执行空 turn", async () => {
    const runtimeInstance = instance();
    runtimeInstance.runtimeConfig.stage({
      revision: "cfg_coalesce_cancel",
      value: { coalesceMs: 1_000 },
    });
    const calls: unknown[] = [];
    const controller = new AgentRuntimeController(runtimeInstance, {
      execute: async (_instance, input) => {
        calls.push(input);
        return { final: false };
      },
    });
    controller.start();

    const turn = controller.enqueue({
      source: "user",
      type: "user_input",
      payload: { content: "must not run" },
      handoff: "turn",
      ts: 1,
    });
    const settled = turn.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Bun.sleep(2);
    controller.interruptAndClear("session reload");

    const result = await settled;
    expect(result.ok).toBe(false);
    expect(String("error" in result ? result.error : "")).toContain(
      "session reload",
    );
    await controller.waitForQuiescence();
    expect(calls).toHaveLength(0);
    expect(controller.pendingTurns).toBe(0);
    expect(controller.instance.state).toBe("idle");
    await controller.dispose();
  });

  test("interruptTurn 可中断尚在 coalesce 的 pending turn", async () => {
    const runtimeInstance = instance();
    runtimeInstance.runtimeConfig.stage({
      revision: "cfg_coalesce_interrupt",
      value: { coalesceMs: 1_000 },
    });
    let calls = 0;
    const controller = new AgentRuntimeController(runtimeInstance, {
      execute: async () => {
        calls++;
        return { final: false };
      },
    });
    controller.start();

    const settled = controller.enqueue({
      source: "user",
      type: "user_input",
      payload: { content: "interrupt me" },
      handoff: "turn",
      ts: 1,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Bun.sleep(2);
    controller.interruptTurn("user interrupt");

    const result = await settled;
    expect(result.ok).toBe(false);
    expect(String("error" in result ? result.error : "")).toContain(
      "user interrupt",
    );
    await controller.waitForQuiescence();
    expect(calls).toBe(0);
    expect(controller.instance.state).toBe("idle");
    await controller.dispose();
  });

  test("steer 到达时唤醒 coalesce，并与等待输入一起执行", async () => {
    const runtimeInstance = instance();
    runtimeInstance.runtimeConfig.stage({
      revision: "cfg_coalesce_steer",
      value: { coalesceMs: 1_000 },
    });
    const calls: unknown[] = [];
    const controller = new AgentRuntimeController(runtimeInstance, {
      execute: async (_instance, input) => {
        calls.push(input);
        return { final: false, output: "ok" };
      },
    });
    controller.start();

    const waiting = controller.enqueue({
      source: "user",
      type: "user_input",
      payload: { content: "first" },
      handoff: "turn",
      ts: 1,
    });
    await Bun.sleep(2);
    const steering = controller.enqueue({
      source: "user",
      type: "user_input",
      payload: { content: "steer" },
      handoff: "steer",
      ts: 2,
    });

    await Promise.race([
      Promise.all([waiting, steering]),
      Bun.sleep(250).then(() => {
        throw new Error("steer did not wake coalesce");
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "runtime-turn-batch",
      inputs: [{ handoff: "turn" }, { handoff: "steer" }],
    });
    await controller.dispose();
  });

  test("resident turn 中断不结束实例，可继续下一轮", async () => {
    let attempts = 0;
    const controller = new AgentRuntimeController(instance("resident"), {
      execute: async (_instance, _input, _bindings, signal) => {
        attempts++;
        if (attempts > 1) return { final: false, output: "recovered" };
        return new Promise<AgentTurnResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error(String(signal.reason))),
            { once: true },
          );
        });
      },
    });
    controller.start();
    const interrupted = controller.enqueue("first");
    await Bun.sleep(2);
    controller.interruptTurn("test interrupt");
    await expect(interrupted).rejects.toThrow("test interrupt");
    expect(controller.instance.state).toBe("idle");
    await expect(controller.enqueue("second")).resolves.toEqual({
      final: false,
      output: "recovered",
    });
    await controller.dispose();
  });

  test("resident 非 abort 异常不永久 failed，可继续下一轮", async () => {
    let attempts = 0;
    const controller = new AgentRuntimeController(instance("resident"), {
      execute: async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return { final: false, output: "ok" };
      },
    });
    controller.start();
    await expect(controller.enqueue("first")).rejects.toThrow("boom");
    expect(controller.instance.state).toBe("idle");
    await expect(controller.enqueue("second")).resolves.toEqual({
      final: false,
      output: "ok",
    });
    await controller.dispose();
  });

  test("ephemeral 非 abort 异常会 failed", async () => {
    const controller = new AgentRuntimeController(instance("ephemeral"), {
      execute: async () => {
        throw new Error("boom");
      },
    });
    controller.start();
    let terminal: string | undefined;
    controller.onTerminal((event) => {
      terminal = event.kind;
    });
    await expect(controller.enqueue("first")).rejects.toThrow("boom");
    expect(controller.instance.state).toBe("failed");
    expect(terminal).toBe("failed");
    await expect(controller.enqueue("second")).rejects.toThrow(/does not accept turns/);
    await controller.dispose();
  });

  test("acceptTurn 同步报告拒绝，enqueue 保持旧的 rejected-Promise 契约", async () => {
    const controller = new AgentRuntimeController(instance("resident"), {
      execute: async () => ({ final: false }),
    });
    controller.start();
    controller.cancel("test cancellation");

    expect(() => controller.acceptTurn("new input")).toThrow(
      /does not accept turns/,
    );
    await expect(controller.enqueue("new input")).rejects.toThrow(
      /does not accept turns/,
    );
    await controller.dispose();
  });

  test("运行中 stage 的 RuntimeConfig 不污染当前 turn，只在下一轮 pin", async () => {
    const runtimeInstance = instance("resident");
    const revisions: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controller = new AgentRuntimeController(runtimeInstance, {
      execute: async (_instance, _input, bindings) => {
        revisions.push(bindings.runtimeConfig.revision);
        if (revisions.length === 1) await firstGate;
        return { final: false };
      },
    });
    controller.start();

    const first = controller.enqueue("first");
    while (revisions.length === 0) await Bun.sleep(1);
    runtimeInstance.runtimeConfig.stage({
      revision: "cfg_2",
      value: { timezone: "Asia/Hong_Kong" },
    });
    expect(revisions).toEqual(["cfg_1"]);
    releaseFirst();
    await first;
    await controller.enqueue("second");
    expect(revisions).toEqual(["cfg_1", "cfg_2"]);
    await controller.dispose();
  });
});

test('feedback steers active work and idle feedback waits for explicit continuation', async () => {
  const calls: unknown[] = [];
  const controller = new AgentRuntimeController(instance(), {
    execute: async (_instance, input, _bindings, signal) => {
      calls.push(input);
      if (calls.length === 1) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { final: false };
    },
  });
  controller.start();
  const first = controller.enqueue({ source: 'user' });
  await controller.enqueueFeedback({ source: 'host', handoff: 'steer' });
  await first;
  await controller.waitForQuiescence();
  expect(calls).toHaveLength(2);
  const idle = controller.enqueueFeedback({ source: 'host', handoff: 'steer' });
  await controller.waitForQuiescence();
  expect(calls).toHaveLength(2);
  await controller.enqueue({ source: 'user' });
  await idle;
  expect(calls).toHaveLength(3);
  await controller.dispose();
});
