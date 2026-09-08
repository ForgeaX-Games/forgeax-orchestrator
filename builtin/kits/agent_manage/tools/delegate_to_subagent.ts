/**
 * delegate_to_subagent — hand a task to either an existing runtime Agent or a
 * new ephemeral child resolved from a registered templateRef.
 *
 * The tool never creates an Agent directory, never chooses a lifetime and
 * never reaches into SessionManager for spawn. Dynamic creation is only
 * available through the instance-bound `ctx.runtime.createChild` authority,
 * then sends the task as an explicit message. Completion is still delivered
 * back to the delegator via Session.delegations + _bindDelegationCallback
 * (sub-agent → parent on hook:turnEnd).
 */

import type { ToolDefinition, ToolOutput, Event } from "../../../../src/core/types";
import { getSessionManager } from "../../../../src/core/session-registry";
import type { Session } from "../../../../src/core/session";
import { randomUUID } from "node:crypto";
import type { RuntimeTree } from "../../../../src/runtime/runtime-tree";

// ─── Runaway / cycle guard ────────────────────────────────────────────────────

/** 纯函数：检查一次 delegation 是否应该被拦截。
 *
 *  block=true 的三种情形：
 *  1. target 已经有一个未完成的 pending delegation（target busy）。
 *  2. 当前 session 并发委托数 >= maxConcurrent（默认 8）。
 *  3. 循环（delegator === target，或 delegator 以 target+"/" 开头，即子 agent
 *     往祖先 agent 委托，会形成 A→B→A 的 ping-pong）。
 *
 *  导出为 pure helper，方便单测不依赖任何 IO。 */
export function delegationGuard(opts: {
  delegations: Map<string, { delegator: string }>;
  delegator: string;
  target: string;
  maxConcurrent?: number;
  tree?: Pick<RuntimeTree, "get" | "parentOf">;
  delegatorInstanceId?: string;
  targetInstanceId?: string;
}): { block: boolean; reason?: string } {
  const {
    delegations,
    delegator,
    target,
    maxConcurrent = 8,
    tree,
    delegatorInstanceId,
    targetInstanceId,
  } = opts;

  // 1) target 已经有未完成的 pending delegation
  if (delegations.has(target)) {
    return { block: true, reason: `agent '${target}' already has an outstanding pending delegation (target busy)` };
  }

  // 2) 并发委托数超限
  if (delegations.size >= maxConcurrent) {
    return { block: true, reason: `too many concurrent delegations (${delegations.size} >= ${maxConcurrent})` };
  }

  // 3) Cycle detection must use RuntimeTree instance ancestry. Ephemeral
  // addresses are opaque ids, so string-prefix checks cannot detect an
  // ephemeral child delegating back to a resident ancestor. Keep the lexical
  // fallback for legacy callers that do not have runtime identities.
  const hasRuntimeIdentity = Boolean(
    tree && delegatorInstanceId && targetInstanceId,
  );
  let cycle: boolean;
  if (hasRuntimeIdentity) {
    try {
      cycle = isAncestor(tree!, targetInstanceId!, delegatorInstanceId!);
    } catch (error) {
      return {
        block: true,
        reason: `invalid RuntimeTree topology: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    cycle = delegator === target || delegator.startsWith(target + "/");
  }
  if (cycle) {
    return { block: true, reason: `cycle detected: '${delegator}' delegating to ancestor '${target}'` };
  }

  return { block: false };
}

function isAncestor(
  tree: Pick<RuntimeTree, "get" | "parentOf">,
  ancestorInstanceId: string,
  descendantInstanceId: string,
): boolean {
  let current = tree.get(descendantInstanceId);
  const visited = new Set<string>();
  while (current?.parentInstanceId) {
    if (visited.has(current.instanceId)) return false;
    visited.add(current.instanceId);
    if (current.parentInstanceId === ancestorInstanceId) return true;
    current = tree.parentOf(current.instanceId);
  }
  return false;
}

/** Count one slot per live ephemeral child or pending/reserved delegation.
 * A pending entry targeting a live ephemeral child is the same slot as that
 * child, so it is deliberately not counted twice. */
function activeSessionDelegationSlots(session: Session): number {
  const liveEphemeralIds = new Set(
    session.runtimeTree
      .list()
      .filter((instance) => instance.lifetime === "ephemeral" && instance.state !== "disposed")
      .map((instance) => instance.instanceId),
  );
  let slots = liveEphemeralIds.size;
  for (const info of session.delegations.values()) {
    if (info.targetInstanceId && liveEphemeralIds.has(info.targetInstanceId)) continue;
    slots += 1;
  }
  return slots;
}

export default {
  name: "delegate_to_subagent",
  description:
    "Delegate to an existing runtime Agent by `agent`, or spawn an ephemeral " +
    "child from a registered `templateRef`. Dynamic children live only in the " +
    "RuntimeTree and are released after their final turn and descendants finish. " +
    "When the teammate finishes its turn you'll automatically receive a short " +
    "completion note as your next inbound message.",
  guidance:
    "**delegate_to_subagent**: This is the ONLY way to involve another " +
    "agent from inside an LLM turn. Use `list_subagents` to inspect live " +
    "children and registered template refs. Never create or edit agents/ folders. " +
    "Returns a short ack — do NOT wait for or quote their reply here; a " +
    "completion callback arrives automatically when they finish.",
  input_schema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Optional address of an Agent that already exists in RuntimeTree " +
          "(or a known plugin/marketplace persona that will be lazily materialized).",
      },
      templateRef: {
        type: "string",
        description:
          "Optional registered templateRef. When supplied, creates a new " +
          "ephemeral child of the calling Agent.",
      },
      message: {
        type: "string",
        description:
          "The task / question for the teammate. Write it as if you were " +
          "the user typing in their chat tab — they'll reply in their own " +
          "voice, not yours.",
      },
    },
    required: ["message"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const agentId = String(args.agent ?? "").trim();
    const templateRef = String(args.templateRef ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!agentId && !templateRef) {
      return "Error: missing 'agent' (existing runtime address) or 'templateRef'.";
    }
    if (agentId && templateRef) {
      return "Error: pass either 'agent' or 'templateRef', not both.";
    }
    if (!message) return "Error: missing 'message' to send.";
    if (agentId && agentId === ctx.agentPath) {
      return `Error: cannot delegate to self ('${agentId}').`;
    }
    if (!ctx.runtime) {
      return "Error: this Agent has no runtime message authority.";
    }

    const sid = ctx.runtime.sid || ctx.tree.sid;

    if (templateRef) {
      const templates = ctx.runtime.listTemplates();
      if (!templates.some((entry) => entry.templateRef === templateRef)) {
        return `Error: unknown templateRef '${templateRef}'. Call list_subagents for registered templates.`;
      }
      if (ctx.runtime.listChildren().filter((child) => child.state !== "disposed").length >= 8) {
        return "Error: delegation blocked — too many concurrent child Agents (8 >= 8).";
      }
      // Reserve the session-wide slot synchronously before the first await.
      // JavaScript cannot interleave another call between this set and
      // createChild(), so the check + reservation is one atomic event-loop
      // operation. The provisional key is replaced by the real child id after
      // creation; all existing completion/failure/remove paths then release
      // the same entry by that id.
      const session = getSessionManager().peek(sid);
      if (!session) {
        return `Error: session ${sid} is no longer open — cannot delegate.`;
      }
      let activeSlots: number;
      try {
        activeSlots = activeSessionDelegationSlots(session);
      } catch (error) {
        return `Error: delegation blocked — invalid RuntimeTree topology: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (activeSlots >= 8) {
        return `Error: delegation blocked — too many concurrent delegations (${activeSlots} >= 8)`;
      }
      const delegationId = randomUUID();
      const reservationKey = `delegation-reservation:${delegationId}`;
      session.delegations.set(reservationKey, {
        delegator: ctx.agentPath,
        brief: message.length > 80 ? message.slice(0, 80) + "…" : message,
        ts: Date.now(),
        delegationId,
      });

      let child: { readonly instanceId: string };
      try {
        child = await ctx.runtime.createChild(templateRef);
      } catch (error) {
        session.delegations.delete(reservationKey);
        throw error;
      }
      const sourceEventId = randomUUID();
      const turnId = `delegation:${delegationId}`;
      const targetInstance = session.runtimeTree.get(child.instanceId);
      const delegation = {
        delegator: ctx.agentPath,
        brief: message.length > 80 ? message.slice(0, 80) + "…" : message,
        ts: Date.now(),
        delegationId,
        targetInstanceId: child.instanceId,
        ...(targetInstance ? { targetRuntimeEpochId: targetInstance.runtimeEpochId } : {}),
        sourceEventId,
        turnId,
      };
      // Register before delivery: a fast in-memory child can finish before an
      // async acceptance receipt resumes this Tool. Roll back if the target
      // Controller rejects the input so "target busy" never gets stuck.
      // No user code runs between delete/set, so the reservation is consumed
      // without opening a second quota window.
      session.delegations.delete(reservationKey);
      session.delegations.set(child.instanceId, delegation);
      try {
        await ctx.runtime.sendToAgent(child.instanceId, {
          eventId: sourceEventId,
          source: "agent",
          type: "user_input",
          payload: {
            content: message,
            originAgent: ctx.agentPath,
            delegatedBy: ctx.agentPath,
            delegationId,
            turnId,
          },
          handoff: "turn",
          ts: Date.now(),
        });
      } catch (error) {
        session.delegations.delete(child.instanceId);
        throw error;
      }
      return (
        `Delegated to ephemeral child ${child.instanceId} from template ` +
        `${templateRef}. The child's reply streams into its own tab; when it ` +
        `finishes the turn, you'll automatically receive a short completion ` +
        `note as your next inbound message — do NOT wait for or quote their ` +
        `reply here, just acknowledge the handoff.`
      );
    }

    if (!ctx.tree.get(agentId)) {
      // Not live yet — try the same lazy-materialization bridge `POST /messages`
      // uses, so a known plugin/marketplace persona that's never been addressed
      // in this session can still be delegated to on first mention.
      try {
        const selectedModel = ctx.getAgentJson().models?.model;
        await ctx.runtime.ensureResident(
          agentId,
          selectedModel
            ? { model: Array.isArray(selectedModel) ? [...selectedModel] : selectedModel }
            : undefined,
        );
      } catch {
        // Unknown persona (or no runtime authority) — fall through to the error below.
      }
    }
    if (!ctx.tree.get(agentId)) {
      return (
        `Error: no agent registered in RuntimeTree with address '${agentId}', and ` +
        "it doesn't match a known resident/plugin persona either. " +
        "Register a template and delegate with templateRef to create an ephemeral child."
      );
    }

    // Guard BEFORE routing so a blocked call never touches the event bus.
    const session = getSessionManager().peek(sid);
    if (!session) {
      return `Error: session ${sid} is no longer open — cannot delegate.`;
    }
    const check = delegationGuard({
      delegations: session.delegations,
      delegator: ctx.agentPath,
      target: agentId,
      tree: session.runtimeTree,
      delegatorInstanceId: ctx.runtime.instanceId,
      targetInstanceId: session.tree.resolve(agentId)?.instanceId,
    });
    if (check.block) {
      return `Error: delegation blocked — ${check.reason}`;
    }

    const targetInstance = session.tree.resolve(agentId);
    const delegationId = randomUUID();
    const sourceEventId = randomUUID();
    const turnId = `delegation:${delegationId}`;
    const event: Event = {
      eventId: sourceEventId,
      source: "agent",
      type: "user_input",
      payload: {
        content: message,
        originAgent: ctx.agentPath,
        delegatedBy: ctx.agentPath,
        delegationId,
        turnId,
      },
      to: agentId,
      handoff: "turn",
      ts: Date.now(),
    };
    session.delegations.set(agentId, {
      delegator: ctx.agentPath,
      brief: message.length > 80 ? message.slice(0, 80) + "…" : message,
      ts: Date.now(),
      delegationId,
      ...(targetInstance ? {
        targetInstanceId: targetInstance.instanceId,
        targetRuntimeEpochId: targetInstance.runtimeEpochId,
      } : {}),
      sourceEventId,
      turnId,
    });
    try {
      await ctx.runtime.sendToAgent(agentId, event);
    } catch (error) {
      session.delegations.delete(agentId);
      throw error;
    }

    return (
      `Delegated to ${agentId}. Their reply will stream into the ${agentId} ` +
      `chat tab — the user can switch tabs to read it. When ${agentId} ` +
      `finishes the turn, you'll automatically receive a short completion ` +
      `note as your next inbound message; do NOT wait for or quote their ` +
      `reply here, just acknowledge the handoff.`
    );
  },
  compactResult(args) {
    return `[delegate_to_subagent target="${args.templateRef ?? args.agent}"]`;
  },
  formatDisplay(args) {
    const agent = String(args.templateRef ?? args.agent ?? "?");
    const msg = String(args.message ?? "");
    const preview = msg.length > 60 ? msg.slice(0, 60) + "…" : msg;
    return `→ ${agent}: ${preview}`;
  },
  serial: true,
} satisfies ToolDefinition;
