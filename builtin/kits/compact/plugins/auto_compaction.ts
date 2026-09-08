import type { AgentContext, Event } from "../../../../src/core/types";
import type { PluginSource } from "../../../../src/kits/types";
import { getModelSpec } from "../../../../src/llm/provider";
import { compactCurrentSession } from "../../../../src/context-window/summary-compaction";

const DEFAULT_THRESHOLD = 0.85;
const MAX_CONSECUTIVE_FAILURES = 3;

export function isKernelManagedAssistantPayload(payload: Record<string, unknown>): boolean {
  return (
    (typeof payload.kernelId === "string" && payload.kernelId.trim().length > 0)
    || (typeof payload.providerId === "string" && payload.providerId.trim().length > 0)
  );
}

export default function autoCompaction(ctx: AgentContext): PluginSource {
  const config = ctx.getAgentJson().kits?.config?.compact as Record<string, unknown> | undefined;
  const threshold = (config?.threshold as number | undefined) ?? DEFAULT_THRESHOLD;

  let unsub: (() => void) | null = null;
  let compacting = false;
  let consecutiveFailures = 0;

  function emitStatusMessage(content: string): void {
    ctx.eventBus.publish({
      source: "plugin:auto_compaction",
      type: "compaction_status",
      payload: { content },
      ts: Date.now(),
    });
  }

  function resolveModelName(llmMsgModel: string | undefined): string | undefined {
    if (llmMsgModel) return llmMsgModel;
    const m = ctx.getAgentJson().models?.model;
    if (m) return Array.isArray(m) ? m[0] : m;
    try {
      const resolved = ctx.resolveModels?.();
      const rm = resolved?.model;
      if (rm) return Array.isArray(rm) ? rm[0] : rm ?? undefined;
    } catch { /* ignore */ }
    return undefined;
  }

  async function runCompaction(totalTokens: number, contextWindow: number, utilization: number): Promise<void> {
    if (compacting) return;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    if (!ctx.ledger || !ctx.resolveModels) return;

    compacting = true;
    try {
      const result = await compactCurrentSession({
        agentId: ctx.agentPath,
        ledger: ctx.ledger,
        eventBus: ctx.eventBus,
        resolveModels: ctx.resolveModels,
        signal: ctx.signal,
      });

      if (result.ok === false) {
        consecutiveFailures++;
        console.warn(`auto_compaction skipped: ${result.reason} (failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        emitStatusMessage(`[auto_compaction] skipped: ${result.reason}`);
        return;
      }

      consecutiveFailures = 0;
      console.log(
        `auto_compaction done | msgs: ${result.originalMessageCount} → ${result.newMessageCount}` +
        ` | armed at ${(utilization * 100).toFixed(1)}% (${totalTokens}/${contextWindow})` +
        (result.summarizeUsage ? ` | summary output: ${result.summarizeUsage.outputTokens}` : ""),
      );
      emitStatusMessage(
        `[auto_compaction] compacted ${result.originalMessageCount} → ${result.newMessageCount} messages.`,
      );
    } catch (err: unknown) {
      consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`auto_compaction failed: ${msg} (failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      emitStatusMessage(`[auto_compaction] failed: ${msg}`);
    } finally {
      compacting = false;
    }
  }

  return {
    name: "auto_compaction",
    description: "Monitors LLM usage and compacts when context window utilization exceeds threshold.",
    condition() {
      return !!ctx.ledger && !!ctx.resolveModels;
    },
    start() {
      if (!ctx.ledger || !ctx.resolveModels) return;

      unsub = ctx.eventBus.observe((event: Event, emitterId?: string) => {
        if (emitterId !== ctx.agentPath) return;
        if (event.type !== "hook:assistantMessage") return;
        if (compacting) return;

        const payload = event.payload as Record<string, unknown>;
        // CLI/app-server kernels own their context window and publish canonical
        // compact_boundary events back through the kernel bridge. Running the
        // legacy in-process summarizer as well both duplicates that policy and,
        // in desktop Kit bundles, tries to use an unrelated provider registry.
        if (isKernelManagedAssistantPayload(payload)) return;
        const usage = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        if (!usage) return;

        // usage 是当前 turn 的完整上下文消耗。不要跨 turn 累加，也不要把
        // cacheRead 再加一次（cached tokens 已包含在 inputTokens 中）。
        const totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (totalTokens <= 0) return;

        const modelName = resolveModelName(payload.model as string | undefined);
        if (!modelName) return;

        const spec = getModelSpec(modelName);
        const contextWindow = spec.contextWindow;
        if (!contextWindow || contextWindow <= 0) return;

        const utilization = totalTokens / contextWindow;
        if (utilization > threshold) {
          void runCompaction(totalTokens, contextWindow, utilization);
        }
      });
    },
    stop() {
      if (unsub) {
        unsub();
        unsub = null;
      }
    },
  };
}
