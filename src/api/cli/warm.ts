/** POST /api/cli/warm — optional rented-kernel transport warm-up (no model turn).
 *
 * The chat composer calls this after session/agent/provider selection settles.
 * The handler composes the same capability surface as a real turn (`prewarm:
 * true`) and invokes `kernel.prewarm` when implemented; otherwise it returns a
 * successful no-op so the UI stays provider-agnostic.
 */

import type { Context } from "hono";
import type { AgentKernel, TurnRequest } from "@forgeax/agent-runtime";
import { getSessionManager } from "../../core/session-manager";
import { resolveTemplateTrust } from "../../agents/agent-template-catalog";
import { composeTurnRequest } from "../../kernel/compose-turn-request";
import { resolveKernel } from "../../kernel/resolve-kernel";
import { toKernelErrorPayload } from "../../kernel/kernel-unavailable";
import { kernelEnabled } from "../../kernel/kernel-mode";
import { deriveThreadId } from "../../lib/thread-id";
import { defaultProjectRoot } from "@forgeax/platform-io";
import { hostToolSurfaceForAgent } from "../lib/host-tools-for-agent";
import {
  normalizeChatModelOverride,
  shouldDeferNativeProjectMcpPrewarm,
} from "./chat";

interface WarmBody {
  sessionId?: string;
  agentId?: string;
  threadId?: string;
  providerOverride?: string;
  model?: string;
}

type KernelWithPrewarm = AgentKernel & {
  prewarm?: (
    req: TurnRequest,
  ) => Promise<{ warmed: boolean; reused: boolean }>;
};

function normalizeKernelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed === "forgeax" ? "forgeax-core" : trimmed;
}

function resolveWarmTrustTier(
  sessionId: string,
  agentId: string,
): "own" | "imported" | undefined {
  try {
    const session = getSessionManager().peek(sessionId);
    const node = session?.tree.resolve(agentId);
    if (!session || !node) return undefined;
    return resolveTemplateTrust(
      session.templateCatalog,
      node.template.templateRef,
    );
  } catch {
    return undefined;
  }
}

export async function handleCliWarm(c: Context) {
  if (!kernelEnabled()) {
    return c.json({ ok: true, skipped: true, reason: "kernel_disabled" });
  }

  let body: WarmBody;
  try {
    body = (await c.req.json()) as WarmBody;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const sessionId = body.sessionId?.trim();
  const agentId = body.agentId?.trim() || "forge";
  const kernelId = normalizeKernelId(body.providerOverride);
  if (!sessionId) {
    return c.json(
      { ok: false, error: "sessionId (non-empty string) required" },
      400,
    );
  }
  if (!kernelId) {
    return c.json(
      { ok: false, error: "providerOverride (non-empty string) required" },
      400,
    );
  }

  let selectedKernel: AgentKernel;
  try {
    selectedKernel = resolveKernel(agentId, kernelId);
  } catch (error) {
    return c.json(await toKernelErrorPayload(null, error), 503);
  }

  const trustTier = resolveWarmTrustTier(sessionId, agentId);
  if (
    shouldDeferNativeProjectMcpPrewarm(
      selectedKernel.id,
      trustTier,
      defaultProjectRoot(),
    )
  ) {
    return c.json({ ok: true, deferred: true, reason: "native_project_mcp" });
  }

  const hostToolSurface = hostToolSurfaceForAgent(sessionId, agentId);
  const selectedModel = normalizeChatModelOverride(body.model);
  let turnReq: TurnRequest;
  try {
    turnReq = await composeTurnRequest({
      message: "",
      agentId,
      kernel: selectedKernel,
      sessionId,
      threadId: deriveThreadId(sessionId, agentId),
      prewarm: true,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(hostToolSurface.specs.length
        ? { extraTools: hostToolSurface.specs }
        : {}),
      visibleAgentManagementTools: hostToolSurface.visibleAgentManagementTools,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }

  const prewarm = (selectedKernel as KernelWithPrewarm).prewarm;
  if (typeof prewarm !== "function") {
    return c.json({
      ok: true,
      warmed: false,
      reused: false,
      noop: true,
      providerId: selectedKernel.id,
    });
  }

  try {
    const result = await prewarm.call(selectedKernel, turnReq);
    return c.json({
      ok: true,
      providerId: selectedKernel.id,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message, providerId: selectedKernel.id }, 503);
  }
}
