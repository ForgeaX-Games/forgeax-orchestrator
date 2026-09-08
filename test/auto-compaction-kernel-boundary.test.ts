import { expect, test } from "bun:test";
import autoCompaction, {
  isKernelManagedAssistantPayload,
} from "../builtin/kits/compact/plugins/auto_compaction";

test("recognizes assistant messages whose context is owned by a kernel", () => {
  expect(isKernelManagedAssistantPayload({ kernelId: "claude-code" })).toBe(true);
  expect(isKernelManagedAssistantPayload({ providerId: "codex-appserver" })).toBe(true);
  expect(isKernelManagedAssistantPayload({ kernelId: "  ", providerId: "" })).toBe(false);
  expect(isKernelManagedAssistantPayload({ model: "claude-sonnet-4" })).toBe(false);
});

test("does not run legacy auto compaction for kernel-managed turns", async () => {
  let observer: ((event: unknown, emitterId?: string) => void) | undefined;
  const published: unknown[] = [];
  const ctx = {
    agentPath: "forge",
    signal: new AbortController().signal,
    ledger: {},
    resolveModels: () => ({ model: "claude-fable-5" }),
    getAgentJson: () => ({
      models: { model: "claude-fable-5" },
      kits: { config: { compact: { threshold: 0 } } },
    }),
    eventBus: {
      observe: (next: (event: unknown, emitterId?: string) => void) => {
        observer = next;
        return () => {};
      },
      publish: (event: unknown) => published.push(event),
    },
  };

  const plugin = autoCompaction(ctx as never);
  plugin.start?.();
  observer?.({
    type: "hook:assistantMessage",
    payload: {
      kernelId: "claude-code",
      providerId: "claude-code",
      model: "default",
      usage: { inputTokens: 298_991, outputTokens: 348 },
    },
  }, "forge");
  await Bun.sleep(10);

  expect(published).toEqual([]);
  plugin.stop?.();
});
