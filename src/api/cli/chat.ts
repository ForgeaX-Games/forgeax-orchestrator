/** POST /api/cli/chat —— 兼容旧 interface 的 SSE 桥。
 *
 *  R3 阶段定位（参考 docs/features/internal-loop-completion-plan.md §5）：
 *  - 带 `sessionId` 的请求进入统一 RuntimeController / AgentInstance 生命周期，
 *    本路由只把 Runtime EventBus 投影回旧 ChatEvent SSE 协议。
 *  - 不带 `sessionId`、无法寻址 RuntimeTree 的独立调用暂保留直接 Kernel fallback。
 *  - 标 `Deprecation: true` + `Sunset: forgeax-v1.0` —— RuntimeTree 的统一
 *    Kernel 路径完全接管且旧客户端迁完后，这条兼容协议整体下线。
 *  - 多轮上下文由 RuntimeHost 的 ContextSnapshot 提供；Kernel 可以继续维护私有
 *    thread/session，并自行决定如何使用宿主提供的上下文。
 *
 *  请求体（与旧 chat.ts 子集兼容）：
 *    {
 *      message: string,           // 必填
 *      threadId?: string,         // UUID v4；缺则 provider 每次起独立 session（无续上下文）
 *      agentId?: string,          // 带 sessionId 时用于寻址 RuntimeTree 实例；简单名且树里
 *                                 // 没有 → 尝试 ensureResidentAgent（对齐 POST /messages）；
 *                                 // 仍解析不到 → 404（不会静默摔到别的 resident）；
 *                                 // 不带 sessionId 时仅用于日志
 *      providerOverride?: string  // UI 选的内核 id(claude-code / codex / forgeax-core);内核路径据此 resolveKernel
 *    }
 *
 *  响应：text/event-stream，每条事件 `event: <type>\ndata: <json>\n\n`。
 *  事件类型来自 ChatEvent union（token / thinking / tool-call / tool-result / done / error）。
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  getDefaultProvider,
  getProvider,
  listProviders,
  resolveProvider,
} from "../../cli-providers/registry";
import type { ChatEvent, ChatRequest } from "../../cli-providers/types";
import { AgentMaterializationError, type Session } from "../../core/session";
import type { Event } from "../../core/types";
import { deprecation } from "../lib/deprecation";
import { getSessionManager } from "../../core/session-manager";
import { getCheckpointManager } from "../../checkpoint/checkpoint-manager";
import { getPathManager } from "../../fs/path-manager";
import { readFile } from "node:fs/promises";
import { CliEventBridge } from "../../observatory/cli-event-bridge";
import { denyPermissionsForSession } from "../../core/permission-registry";
// M1 内核路径(FORGEAX_KERNEL=kernel):chat → 内核契约 → wire,前端零改。
import { composeTurnRequest, type ComposeInput } from "../../kernel/compose-turn-request";
import { runWithHistoryResync } from "../../kernel/history-resync";
import {
  hostToolSurfaceForAgent,
} from "../lib/host-tools-for-agent";
import { resolveKernel, listAvailableKernels } from "../../kernel/resolve-kernel";
import { toKernelErrorPayload } from "../../kernel/kernel-unavailable";
import { toWireEvents, newWireFoldState } from "../../kernel/to-wire-events";
import type { AgentKernel } from "@forgeax/agent-runtime";
import { kernelEnabled } from "../../kernel/kernel-mode";
import { isValidSummonAgentId } from "../../kernel/summon-agent";
import { transcribeKernelTurn } from "../../kernel/transcribe-turn";
import { hostTelemetryEnabled } from "../../kernel/host-telemetry";
import {
  startCliKernelTurn,
  unwrapMcpResultEnvelope,
  type CliKernelTurnTrace,
} from "../../kernel/cli-kernel-trace";
import { tt, ttEnabled } from "../../lib/turn-trace";
import { formatCacheHitRatio } from "../../lib/cache-ratio";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { prepareUserAttachmentPayload } from "../../message/materialize-user-attachments";
import { orchestrationProfileOf } from "../../kernel/kernel-profile";
import { Hook } from "../../hooks/types";
import { hasProjectMcpServers, projectMcpExecutionMode } from "../../kernel/project-mcp";
import { defaultProjectRoot } from "@forgeax/platform-io";

interface ChatBody {
  message?: string;
  /** Client-generated id used by the initiating UI to suppress its WS echo. */
  clientMsgId?: string;
  agentId?: string;
  threadId?: string;
  sessionId?: string;
  providerOverride?: string;
  /** Composer-selected model for this rented-kernel turn. */
  model?: string;
  /** Doc 05 section 7 -- per-call id for `POST /api/cli/cancel`. */
  callId?: string;
  /** Doc 05 section 7 -- per-call deadline; the provider auto-aborts and
   *  surfaces `code: 'driver-timeout'` on expiry. */
  timeoutMs?: number;
  /** 多模态附件(图片)。每项 `{ kind:'image', mediaType, data?(base64) | path?(host 文件) }`。
   *  透传进 composeTurnRequest → TurnRequest.input.attachments → 原生内核 facade 组 image block。 */
  attachments?: Array<Record<string, unknown>>;
  /** 本轮期望回复语言(UI 结算)。透传进 composeTurnRequest → dynamicSuffix 指令。 */
  replyLanguage?: "en" | "zh";
  /** UI specialist hint; null explicitly clears it. */
  summonAgentId?: string | null;
  /** Browser ui.request W3C parent span for the CLI kernel trace. */
  traceparent?: string;
}

interface CancelBody {
  callId?: string;
  providerOverride?: string;
}

export function normalizeChatModelOverride(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  return model.trim() || undefined;
}

export function normalizeClientMessageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

const DEPRECATION_NOTICE = deprecation({
  sunset: "forgeax-v1.0",
  reason: "cli-provider bridge is temporary; migrate to Kernel-backed RuntimeTree agents",
  migration: "/api/sessions/:sid/messages",
});

/** Native project-MCP ownership is acquired by the first real turn. Prewarm
 * must not create a competing owner or force an asynchronous handoff. */
export function shouldDeferNativeProjectMcpPrewarm(
  kernelId: string,
  trustTier: "own" | "imported" | undefined,
  projectRoot: string = defaultProjectRoot(),
): boolean {
  return projectMcpExecutionMode(kernelId, trustTier) === "native"
    && hasProjectMcpServers(projectRoot);
}

const runtimeCliCalls = new Map<
  string,
  { session: Session; agentPath: string }
>();

class RuntimeChatEventQueue {
  private readonly items: ChatEvent[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  push(event: ChatEvent): void {
    if (this.ended) return;
    this.items.push(event);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async next(): Promise<ChatEvent | undefined> {
    while (this.items.length === 0 && !this.ended) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.items.shift();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}

async function runSessionRuntimeChat(
  c: Context,
  body: ChatBody & { sessionId: string },
  message: string,
) {
  const session = await getSessionManager().open(body.sessionId);
  const requestedAgent = body.agentId?.trim();
  // Explicit agentId: try the same lazy-materialization bridge POST /messages
  // uses for simple persona names. Nested paths / fullIds still require an
  // already-live node. Never silently fall through to a different resident.
  if (requestedAgent) {
    let resolved = session.tree.resolve(requestedAgent);
    if (!resolved && !requestedAgent.includes("/") && !requestedAgent.includes("#")) {
      try {
        await session.ensureResidentAgent(requestedAgent);
        resolved = session.tree.resolve(requestedAgent);
      } catch (error) {
        if (error instanceof AgentMaterializationError) {
          return c.json(
            { ok: false, error: error.message, code: "no_agent" },
            error.status,
          );
        }
        throw error;
      }
    }
    if (!resolved) {
      return c.json(
        { ok: false, error: `runtime agent not found: ${requestedAgent}`, code: "no_agent" },
        404,
      );
    }
  }
  const targetInstance =
    (requestedAgent ? session.tree.resolve(requestedAgent) : undefined) ??
    session.runtimeTree.list().find((instance) => instance.lifetime === "resident");
  if (!targetInstance) {
    return c.json(
      { ok: false, error: "session has no runtime agent", code: "no_agent" },
      409,
    );
  }
  const agentPath = session.tree.addressOf(targetInstance);
  await session.initializeAgentHost(agentPath);

  const kernelId = normalizeKernelId(body.providerOverride) ??
    targetInstance.template.definition.kernelId;
  let selectedKernel: AgentKernel;
  try {
    selectedKernel = resolveKernel(agentPath, kernelId);
  } catch (error) {
    return c.json(await toKernelErrorPayload(null, error), 503);
  }

  const callId =
    typeof body.callId === "string" && body.callId.trim()
      ? body.callId.trim()
      : randomUUID();
  const checkpoint = getCheckpointManager();
  try {
    await checkpoint.finalizePending(session);
  } catch (error) {
    console.warn(
      `[cli/chat] finalizePending failed: ${(error as Error).message}`,
    );
  }
  try {
    await checkpoint.snapshotForMessage(session, callId);
  } catch (error) {
    console.warn(
      `[cli/chat] snapshotForMessage failed: ${(error as Error).message}`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = prepareUserAttachmentPayload({
      content: message,
      payload: {
        ...(Array.isArray(body.attachments) && body.attachments.length
          ? { attachments: body.attachments }
          : {}),
      },
      uploadDir: resolvePath(
        getPathManager().session(body.sessionId).root(),
        "uploads",
      ),
      nativeAttachmentKinds:
        orchestrationProfileOf(selectedKernel).nativeAttachmentKinds,
    });
  } catch (error) {
    payload = {
      content: message,
      contextContent:
        `${message}\n\n[Attachments could not be prepared: ${
          error instanceof Error ? error.message : String(error)
        }]`,
    };
  }
  const selectedModel = normalizeChatModelOverride(body.model);
  const clientMsgId = normalizeClientMessageId(body.clientMsgId);
  payload = {
    ...payload,
    msgId: callId,
    ...(clientMsgId ? { clientMsgId } : {}),
    kernelId: selectedKernel.id,
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(body.replyLanguage ? { replyLanguage: body.replyLanguage } : {}),
  };
  const input: Event = {
    source: "user",
    type: "user_input",
    payload,
    to: agentPath,
    handoff: "turn",
    ts: Date.now(),
  };

  return streamSSE(c, async (sse) => {
    const queue = new RuntimeChatEventQueue();
    let usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        }
      | undefined;
    let timedOut = false;
    const unsubscribe = session.eventBus.observe((event, emitterId) => {
      if (emitterId !== agentPath) return;
      const eventPayload = (event.payload ?? {}) as Record<string, unknown>;
      if (eventPayload.turnId !== callId) return;
      const providerId =
        typeof eventPayload.providerId === "string"
          ? eventPayload.providerId
          : selectedKernel.id;

      if (event.type === Hook.StreamLLM) {
        const chunk = eventPayload.chunk as
          | Record<string, unknown>
          | undefined;
        if (chunk?.type === "text" && typeof chunk.text === "string") {
          queue.push({ type: "token", text: chunk.text, providerId });
        } else if (
          chunk?.type === "thinking" &&
          typeof chunk.text === "string"
        ) {
          queue.push({ type: "thinking", text: chunk.text, providerId });
        } else if (
          chunk?.type === "tool_call" &&
          typeof chunk.id === "string" &&
          typeof chunk.name === "string"
        ) {
          queue.push({
            type: "tool-call",
            callId: chunk.id,
            name: chunk.name,
            args: parseToolArgs(chunk.arguments),
            providerId,
          });
        } else if (
          chunk?.type === "tool_call_delta" &&
          typeof chunk.id === "string" &&
          typeof chunk.name === "string"
        ) {
          queue.push({
            type: "tool-call-delta",
            callId: chunk.id,
            name: chunk.name,
            argumentsDelta:
              typeof chunk.arguments_delta === "string"
                ? chunk.arguments_delta
                : "",
            providerId,
          });
        } else if (chunk?.type === "usage") {
          usage = {
            inputTokens:
              typeof chunk.inputTokens === "number"
                ? chunk.inputTokens
                : undefined,
            outputTokens:
              typeof chunk.outputTokens === "number"
                ? chunk.outputTokens
                : undefined,
          };
        }
        return;
      }

      if (event.type === Hook.ToolResult) {
        const callId =
          typeof eventPayload.callId === "string"
            ? eventPayload.callId
            : typeof eventPayload.toolCallId === "string"
              ? eventPayload.toolCallId
              : "";
        if (callId) {
          queue.push({
            type: "tool-result",
            callId,
            ok: eventPayload.ok !== false && !eventPayload.error,
            ...(eventPayload.result !== undefined
              ? { result: eventPayload.result }
              : {}),
            ...(eventPayload.error
              ? { error: String(eventPayload.error) }
              : {}),
            providerId,
          });
        }
        return;
      }

      if (event.type === Hook.AssistantMessage) {
        const turnUsage = eventPayload.usage as
          | Record<string, unknown>
          | undefined;
        if (turnUsage) {
          usage = {
            inputTokens: numberOrUndefined(turnUsage.inputTokens),
            outputTokens: numberOrUndefined(turnUsage.outputTokens),
            cacheReadTokens: numberOrUndefined(turnUsage.cacheReadTokens),
            cacheCreationTokens: numberOrUndefined(
              turnUsage.cacheWriteTokens ??
                turnUsage.cacheCreationTokens,
            ),
          };
        }
        return;
      }

      if (event.type === Hook.TurnEnd) {
        if (timedOut) {
          queue.push({
            type: "error",
            code: "driver-timeout",
            message: `runtime turn timed out after ${body.timeoutMs}ms`,
            providerId,
          });
        } else if (eventPayload.error) {
          queue.push({
            type: "error",
            code: "turn_failed",
            message: String(eventPayload.error),
            providerId,
          });
        } else {
          queue.push({
            type: "done",
            stopReason:
              eventPayload.aborted === true ? "cancelled" : "end_turn",
            ...(usage ? { usage } : {}),
            providerId,
          });
        }
        queue.end();
      }
    });

    const onAbort = () => {
      session.interruptRuntime(agentPath, "CLI SSE request aborted");
    };
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
    const timeout =
      typeof body.timeoutMs === "number" && body.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            session.interruptRuntime(
              agentPath,
              `runtime turn timed out after ${body.timeoutMs}ms`,
            );
          }, body.timeoutMs)
        : undefined;

    runtimeCliCalls.set(callId, { session, agentPath });
    session.eventBus.publish(input);
    const completion = session.enqueueAgent(agentPath, input).catch((error) => {
      queue.push({
        type: "error",
        code: "turn_failed",
        message: error instanceof Error ? error.message : String(error),
        providerId: selectedKernel.id,
      });
      queue.end();
    });

    try {
      while (true) {
        const event = await queue.next();
        if (!event) break;
        await sse.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      }
      await completion;
    } finally {
      if (timeout) clearTimeout(timeout);
      runtimeCliCalls.delete(callId);
      unsubscribe();
      c.req.raw.signal.removeEventListener("abort", onAbort);
    }
  });
}

function normalizeKernelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed === "forgeax" ? "forgeax-core" : trimmed;
}

function parseToolArgs(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function createCliRouter() {
  const r = new Hono();

  // 所有 /api/cli/* 端点统一带 Deprecation header。
  r.use("*", DEPRECATION_NOTICE);

  // 健康检查 —— 让 interface 能 probe "claude 二进制有没有 / API key 设了没"。
  r.get("/health", async (c) => {
    const providers = listProviders();
    const snaps = await Promise.all(providers.map(async (p) => {
      const h = await p.health(1500);
      return { id: p.id, ok: h.ok, detail: h.detail, capabilities: p.capabilities };
    }));
    // 总体 ok 以 cli-provider(默认对话路径)为准 —— 第三方内核(codex/cursor)未装/
    // 不健康不应让整个输入框 disabled(R1-06)。
    const overallOk = snaps.length > 0 && snaps.every((s) => s.ok);
    // 内核路径(kernelEnabled,ship-gate 默认开):picker 还要能选 codex / cursor-agent /
    // forgeax-core —— chat 路径据 providerOverride 走 resolveKernel 真跑。把已注册内核并进
    // 列表(按 id 去重,claude-code 已由 cli-provider 覆盖则跳过),与能跑的集合一致。
    if (kernelEnabled()) {
      const seen = new Set(snaps.map((s) => s.id));
      for (const k of listAvailableKernels()) {
        if (seen.has(k.id)) continue;
        let h: { ok: boolean; detail?: string };
        try {
          h = await k.probe();
        } catch (e) {
          h = { ok: false, detail: (e as Error).message };
        }
        seen.add(k.id);
        // 把 KernelCapabilities 映射成 picker 期望的 ProviderCapabilities 形:
        // 内核经 threadId resume(sessions=true);子 agent 走编排层 handoff 而非内核内
        // (subAgents=false,保守);无 JSONL 回放语义。
        const cap = k.capabilities;
        snaps.push({
          id: k.id,
          ok: h.ok,
          detail: h.detail,
          capabilities: {
            streaming: cap.streaming,
            thinking: cap.thinking,
            toolCalls: cap.toolCalls,
            subAgents: false,
            sessions: true,
            jsonlReplay: false,
          },
        });
      }
    }
    if (snaps.length === 0) {
      return c.json({ ok: false, providers: [], detail: "no cli-provider registered" }, 503);
    }
    return c.json({ ok: overallOk, providers: snaps });
  });

  // POST /api/cli/warm — lightweight readiness probe used by the Composer
  // before the first real turn. It must never create a chat session or spawn a
  // model turn; probe the same kernel/provider that /chat will select.
  r.post("/warm", async (c) => {
    let body: { agentId?: string; providerOverride?: string } = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as typeof body;
      }
    } catch {
      // The warm request is intentionally body-optional for older clients.
    }
    const requested = typeof body.providerOverride === "string"
      ? body.providerOverride.trim()
      : "";

    if (kernelEnabled()) {
      try {
        const kernel = resolveKernel(
          body.agentId ?? "default",
          requested ? normalizeKernelId(requested) : undefined,
        );
        const health = await kernel.probe();
        return c.json({
          ok: health.ok,
          providerId: kernel.id,
          ...(health.detail ? { detail: health.detail } : {}),
        }, health.ok ? 200 : 503);
      } catch (error) {
        return c.json({
          ok: false,
          providerId: normalizeKernelId(requested) ?? requested,
          error: error instanceof Error ? error.message : String(error),
        }, 503);
      }
    }

    const provider = requested
      ? getProvider(requested)
      : resolveProvider(body.agentId);
    if (!provider) {
      return c.json({
        ok: false,
        error: requested ? `no cli-provider registered: ${requested}` : "no cli-provider registered",
      }, 503);
    }
    try {
      const health = await provider.health(1500);
      return c.json({
        ok: health.ok,
        providerId: provider.id,
        ...(health.detail ? { detail: health.detail } : {}),
      }, health.ok ? 200 : 503);
    } catch (error) {
      return c.json({
        ok: false,
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      }, 503);
    }
  });

  r.post("/chat", async (c) => {
    let body: ChatBody;
    try {
      body = (await c.req.json()) as ChatBody;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const message = body?.message;
    if (typeof message !== "string" || !message.trim()) {
      return c.json({ ok: false, error: "message (non-empty string) required" }, 400);
    }
    if (
      body.summonAgentId !== undefined &&
      body.summonAgentId !== null &&
      !isValidSummonAgentId(body.summonAgentId)
    ) {
      return c.json(
        { ok: false, error: "summonAgentId must match /^[A-Za-z0-9_-]+$/" },
        400,
      );
    }

    // 写时迁移(plan B PR2-compat):若这是对一个 pre-PR2 老 session 发新消息,先把整份
    // 老 session 目录搬进当前项目 games/<slug>/sessions/<sid>/,确保新老记录都落项目下。
    // 幂等:已在项目内 / 非老 session → no-op。读路径(list/open 预览)不经此。
    if (body.sessionId) {
      try { await getSessionManager().prepareForWrite(body.sessionId); }
      catch (e) { console.warn(`[chat] prepareForWrite(${body.sessionId}) failed: ${(e as Error).message}`); }
    }

    // ── M1:新内核路径(FORGEAX_KERNEL=kernel)。compose → resolveKernel.runTurn →
    //    toWireEvents → SSE。前端按 event 名消费,零改。旧 cli-provider 路径见下方(默认 fallback)。
    if (kernelEnabled()) {
      // Session-scoped callers share the exact RuntimeController lifecycle used
      // by POST /api/sessions/:sid/messages. This route only projects Runtime
      // events back to the legacy SSE wire. Standalone callers without a
      // session keep the direct compatibility path below.
      if (body.sessionId) {
        return runSessionRuntimeChat(
          c,
          { ...body, sessionId: body.sessionId },
          message,
        );
      }
      const callId = typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : undefined;
      const agentId = body.agentId ?? "default";
      // 该 agent 的插件 host-tools(exposedToAI + 命中 agent.json host-tools allow)→
      // extraTools 下发内核。conscious-agent 路径经 kits 桥自带这步;/api/cli/chat
      // (租用内核聊天入口)此前漏了它,导致 team + gen3d 等插件工具对 cbc/cc/codex
      // 不可见。与桥同一套 allow 规则,无需活着的 conscious agent。
      const hostToolSurface = hostToolSurfaceForAgent(body.sessionId, agentId);
      const extraTools = hostToolSurface.specs;
      const visibleAgentManagementTools = hostToolSurface.visibleAgentManagementTools;
      // Resolve before compose: the selected kernel owns attachment/history semantics.
      let selectedKernel: AgentKernel;
      try {
        selectedKernel = resolveKernel(agentId, body.providerOverride);
      } catch (err: any) {
        const payload = await toKernelErrorPayload(null, err);
        return c.json(payload, 503);
      }
      const selectedModel = normalizeChatModelOverride(body.model);
      const composeInput: ComposeInput = {
        message,
        agentId,
        kernel: selectedKernel,
        threadId: body.threadId,
        sessionId: body.sessionId,
        callId,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(extraTools.length ? { extraTools } : {}),
        visibleAgentManagementTools,
        ...(Array.isArray(body.attachments) && body.attachments.length ? { attachments: body.attachments } : {}),
        ...(body.replyLanguage === "en" || body.replyLanguage === "zh" ? { replyLanguage: body.replyLanguage } : {}),
        ...(isValidSummonAgentId(body.summonAgentId) ? { summonAgentId: body.summonAgentId } : {}),
      };
      let turnReq = await composeTurnRequest(composeInput);

      // 历史持久化(host-owned,核心目标):内核每轮的 KernelEvent 流由编排层**转录**进
      // per-agent 账本 —— 与具体内核(claude-code / codex / forgeax-core)无关,账本是
      // 上下文真相,不依赖任何内核的私有会话。直接写账本(不经 eventBus,避免与 UI 已消费
      // 的 SSE 在 WS 上重复渲染),形状对齐 sessions 路径(user_input / hook:turnStart /
      // hook:toolCall|toolResult / hook:assistantMessage(llmMessage)/ hook:turnEnd),
      // replay 即可还原。
      //
      // ★ 账本必须 key 到「UI 重放用的同一个 (sid, agentPath)」。UI(store.ts)发消息时
      //   传 `agentId`、刷新后又用**同一个** `agentId`(= tab.agentId)调
      //   fetch_session_events(sid, agentId) 重放。此前用 `display===agentId || depth===1`
      //   的启发式解析会落到**另一个**节点 → claude-code/codex 的历史写错 key、刷新即"消失"。
      //   修复:直接以 `agentId` 为账本 key(账本路径只由 (sid, agentPath) 计算、append 时
      //   自建目录,无需 agent 已 scaffold),与 UI 重放键逐字一致 → 刷新历史恒在。
      let persistSession: Session | null = null;
      const persistAgent = agentId;
      if (body.sessionId) {
        try {
          persistSession = await getSessionManager().open(body.sessionId);
        } catch (e) {
          console.warn(`[cli/chat] ledger persist skipped: ${(e as Error).message}`);
        }
      }
      // checkpoint 定格:新用户消息到达 → 若有挂起的软回退,先定格(此后 UI 移除置灰段)。
      // 与原生 POST /api/sessions/:sid/messages 同语义 —— CLI 桥(cursor/claude-code 等)
      // 之前漏了这步,导致经 CLI provider 发消息时 rewind:finalized 永不触发,挂起态(置灰
      // + 「已回退到此处」)永久卡住。失败不阻塞聊天。
      if (persistSession) {
        try { await getCheckpointManager().finalizePending(persistSession); } catch (e) {
          console.warn(`[cli/chat] finalizePending failed: ${(e as Error).message}`);
        }
      }

      return streamSSE(c, async (sse) => {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        c.req.raw.signal.addEventListener("abort", onAbort);
        const fold = newWireFoldState();
        // accumulate the turn for the WAL write in `finally`.
        let asstText = "";
        let thinkingText = "";
        let stopReason: "end_turn" | "tool_use" | "max_tokens" | "cancelled" = "end_turn";
        let usage: unknown;
        const toolEvents: Array<
          | { kind: "call"; callId: string; name: string; args: unknown }
          | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
        > = [];
        // 内核 id 即 wire/账本的 providerId(claude-code / codex / forgeax-core)。
        // 在 try 外声明,让 finally 的账本转录也能拿到(刷新后据此还原来源 badge)。
        let providerId = "claude-code";
        // 在 try 外声明,让 catch 能拿到内核去 probe(区分「内核不可用」与「运行时报错」)。
        // resolveKernel 抛错(unknown-id / not-registered)时它保持 null,由 err 自身分类。
        let kernel: AgentKernel | null = selectedKernel;
        let cliTrace: CliKernelTurnTrace | null = null;
        let kernelRunFailed = false;
        let kernelRunError: unknown;
        try {
          if (selectedKernel.id !== "forgeax-core" && hostTelemetryEnabled()) {
            cliTrace = startCliKernelTurn({
              kernelId: selectedKernel.id,
              agentId,
              ...(body.sessionId?.trim() ? { sid: body.sessionId.trim() } : {}),
              ...(body.traceparent?.trim() ? { traceparent: body.traceparent.trim() } : {}),
            });
          }
        } catch {
          // Telemetry must never make the compatibility route fail.
        }
        try {
          providerId = selectedKernel.id;
          for await (const kev of runWithHistoryResync({
            initial: turnReq,
            retrySnapshot: async () => {
              turnReq = await composeTurnRequest({ ...composeInput, forceSnapshot: true });
              return turnReq;
            },
            run: (request) => kernel.runTurn(request, ac.signal),
          })) {
            for (const wire of toWireEvents(kev, fold)) {
              let out: ChatEvent = { ...wire, providerId };
              // The MCP adapter's envelope is an internal transport shape:
              // take its toolExecutionId for the span, then expose only the
              // tool's actual text to the legacy SSE/WAL consumers.
              if (out.type === "tool-result") {
                cliTrace?.onToolResult(out.callId, out.ok, out.result, out.error);
                out = { ...out, result: unwrapMcpResultEnvelope(out.result) };
              }
              // 内核 yield 出的终态 error(如第三方 CLI 未装 → spawn ENOENT 被 kernel 包成
              // code:'protocol' 的裸串)在这里统一翻成友好文案:probe 内核确认是否真不可用,
              // 是 → kernel_unavailable + 成因指引;否 → 保留原 code(真·运行时报错)。
              if (out.type === "error") {
                kernelRunFailed = true;
                kernelRunError = new Error(out.message);
                const payload = await toKernelErrorPayload(kernel, { message: out.message }, out.code);
                await sse.writeSSE({ event: "error", data: JSON.stringify({ ...payload, providerId }) });
                return;
              }
              await sse.writeSSE({ event: out.type, data: JSON.stringify(out) });
              switch (out.type) {
                case "token": asstText += out.text ?? ""; break;
                case "thinking": thinkingText += out.text ?? ""; break;
                case "tool-call":
                  cliTrace?.onToolCall(out.callId, out.name);
                  toolEvents.push({ kind: "call", callId: out.callId, name: out.name, args: out.args });
                  break;
                case "tool-result": toolEvents.push({ kind: "result", callId: out.callId, ok: out.ok, result: out.result, error: out.error }); break;
                case "done": {
                  stopReason = out.stopReason; usage = out.usage;
                  // 缓存命中率打点(还原老 studio 的 cachedRatio,迁移遗失)。
                  // 经通用 console 通道落该 session 的 <sid>/logs/debug.log(由
                  // app.ts 的 sessionScope 中间件给本请求建好 ALS sid 作用域),便于把
                  // 「子 agent 首轮应然 0」与「多轮前缀被击穿导致的回归 0」分开量。
                  // FORGEAX_TURN_TRACE 开才落盘。
                  if (ttEnabled() && out.usage) {
                    const u = out.usage;
                    tt("turn.usage", {
                      agent: agentId,
                      sid: body.sessionId,
                      provider: providerId,
                      input: u.inputTokens,
                      output: u.outputTokens,
                      cacheRead: u.cacheReadTokens,
                      cacheCreation: u.cacheCreationTokens,
                      cachedRatio: formatCacheHitRatio(u.inputTokens ?? 0, u.cacheReadTokens ?? 0),
                    });
                  }
                  break;
                }
                default: break;
              }
              if (out.type === "done") return;
            }
          }
        } catch (err: any) {
          kernelRunFailed = true;
          kernelRunError = err;
          // 单一翻译点:内核不可用(resolveKernel 抛 KernelUnavailableError,或 probe 判定
          // 内核 down)→ 友好 kernel_unavailable + 成因;真·运行时报错(网络/LLM/工具)→
          // 保留原样并标 turn_failed,不再被 catch-all 一律误标成 kernel_unavailable。
          const rawCode = err && typeof err.code === "string" ? err.code : undefined;
          const payload = await toKernelErrorPayload(kernel, err, rawCode);
          await sse.writeSSE({ event: "error", data: JSON.stringify({ ...payload, providerId }) });
        } finally {
          try {
            const traceUsage = usage as
              | { inputTokens?: unknown; outputTokens?: unknown }
              | undefined;
            const normalizedUsage = traceUsage &&
              typeof traceUsage.inputTokens === "number" &&
              Number.isFinite(traceUsage.inputTokens) &&
              typeof traceUsage.outputTokens === "number" &&
              Number.isFinite(traceUsage.outputTokens)
              ? {
                  inputTokens: traceUsage.inputTokens,
                  outputTokens: traceUsage.outputTokens,
                }
              : undefined;
            const cancelled = stopReason === "cancelled" || ac.signal.aborted;
            cliTrace?.end({
              ok: !kernelRunFailed && !cancelled,
              reason: stopReason,
              ...(typeof turnReq.model === "string" && turnReq.model
                ? { model: turnReq.model }
                : {}),
              ...(normalizedUsage ? { usage: normalizedUsage } : {}),
              ...(kernelRunFailed
                ? {
                    error: kernelRunError instanceof Error
                      ? kernelRunError.message
                      : String(kernelRunError),
                  }
                : {}),
            });
          } catch {
            // Telemetry close is best-effort and must not affect the turn.
          }
          c.req.raw.signal.removeEventListener("abort", onAbort);
          // Transcribe the kernel turn into the host-owned ledger (kernel-agnostic,
          // keyed to `persistAgent` = the agentId the UI replays with). Direct WAL
          // write, not via eventBus → no WS double-render against the SSE above.
          if (persistSession && persistAgent) {
            try {
              transcribeKernelTurn(persistSession, persistAgent, {
                message,
                contextText: turnReq.input.text,
                asstText,
                thinkingText,
                stopReason,
                providerId,
                ...(usage ? { usage } : {}),
                ...(turnReq.model ? { model: turnReq.model } : {}),
                ...(turnReq.input.attachments?.length
                  ? { attachments: turnReq.input.attachments as Array<Record<string, unknown>> }
                  : {}),
                toolEvents,
              });
            } catch (e) {
              console.warn(`[cli/chat] ledger write failed: ${(e as Error).message}`);
            }
          }
        }
      });
    }

    const provider = body.providerOverride
      ? getProvider(body.providerOverride)
      : getDefaultProvider();
    if (!provider) {
      return c.json(
        { ok: false, error: `no cli-provider available${body.providerOverride ? ` (override="${body.providerOverride}")` : ""}` },
        503,
      );
    }

    // Pre-flight health —— 避免开了 SSE 才报 "claude 二进制找不到"。
    const h = await provider.health(1500);
    if (!h.ok) {
      return c.json({ ok: false, error: h.detail ?? `provider ${provider.id} unhealthy` }, 503);
    }

    const req: ChatRequest = {
      agentId: body.agentId ?? "default",
      message,
      threadId: body.threadId,
      sessionId: body.sessionId,
      callId: typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : undefined,
      timeoutMs: typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined,
    };

    // Stamp the resolved provider on the response stream so the cancel route
    // (which only sees callId) can short-circuit when the registry shape
    // changes mid-flight; the lifecycle wrapper inside provider.chat is the
    // one that actually owns the AbortController.
    // Observatory bridge — when the caller passes a forgeax sessionId we
    // also publish a translated copy of every ChatEvent onto the session's
    // EventBus so per-agent ledger persistence + observatory live SSE both
    // see the same turn. Skipped when sessionId is missing (legacy callers)
    // or the session can't be opened.
    let bridge: CliEventBridge | null = null;
    if (req.sessionId) {
      try {
        const session = await getSessionManager().open(req.sessionId);
        // checkpoint 定格:与 kernel 路径同语义(见上)。新用户消息 → 定格挂起的软回退,
        // 否则经 legacy CLI provider 发送时置灰段永不移除。失败不阻塞聊天。
        try { await getCheckpointManager().finalizePending(session); } catch (e) {
          console.warn(`[cli/chat] finalizePending failed: ${(e as Error).message}`);
        }
        // Keep the legacy provider bridge on the same message-anchor contract
        // as the RuntimeTree path.  The provider path is still used when the
        // compatibility switch is enabled, so omitting this snapshot makes a
        // CLI turn invisible to code rewind even though the next message can
        // finalize a pending rewind.
        try {
          await getCheckpointManager().snapshotForMessage(
            session,
            req.callId?.trim() || randomUUID(),
          );
        } catch (e) {
          console.warn(`[cli/chat] snapshotForMessage failed: ${(e as Error).message}`);
        }
        const node = session.tree.list().find((n) => n.display === req.agentId)
          ?? session.tree.list().find((n) => n.depth === 1)
          ?? null;
        const agentPath = node?.path ?? req.agentId;
        bridge = new CliEventBridge({ session, agentPath, model: provider.id });

        // Per-agent model selection: the ModelPicker writes the user's choice to
        // `agent.json::models.model` (via the `set_agent_models` command). That
        // file is the SSOT the forgeax runtime already consumes — but the
        // cli-provider bridge built `req` without it, so providers like
        // claude-code fell back to the CLI's built-in default (looked like the
        // picker "did nothing"). Resolve it here and forward as a provider
        // override (types.ts: `options` = "provider-specific overrides … model")
        // so the selected model actually reaches whichever provider runs.
        // Candidate paths: prefer the exact agentPath the ModelPicker wrote to
        // (req.agentId — the UI sends the active tab's agent path, which is the
        // same value `set_agent_models` keys on), then the tree-resolved path.
        // First candidate that yields a models.model wins.
        const pm = getPathManager();
        const candidates = Array.from(new Set([req.agentId, agentPath].filter(Boolean)));
        for (const cand of candidates) {
          try {
            const cfg = JSON.parse(await readFile(pm.session(req.sessionId).agent(cand).agentJson(), "utf8")) as {
              models?: { model?: string | string[] | null };
            };
            const raw = cfg.models?.model;
            const model = Array.isArray(raw)
              ? raw.find((m) => typeof m === "string" && m.trim())?.trim()
              : typeof raw === "string" && raw.trim()
                ? raw.trim()
                : undefined;
            if (model) { req.options = { ...(req.options ?? {}), model }; break; }
          } catch {
            /* this candidate has no agent.json / unreadable → try next */
          }
        }
      } catch (e) {
        console.warn(`[cli/chat] observatory bridge skipped: ${(e as Error).message}`);
      }
    }

    return streamSSE(c, async (sse) => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      c.req.raw.signal.addEventListener("abort", onAbort);

      bridge?.start();
      let endStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' = 'end_turn';
      let endDurationMs: number | undefined;
      let endUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
      let endEmitted = false;
      const finishBridge = () => {
        if (!bridge || endEmitted) return;
        endEmitted = true;
        bridge.end(endStopReason, endDurationMs, endUsage);
      };

      try {
        for await (const ev of provider.chat(req, ac.signal)) {
          // 把 providerId 也回写到事件（旧实现里在 mapper 出口已经 stamped；这里
          // 兼容性兜底）。
          const out: ChatEvent = { ...ev, providerId: ev.providerId ?? provider.id };
          await sse.writeSSE({
            event: out.type,
            data: JSON.stringify(out),
          });
          if (bridge) {
            if (out.type === 'done') {
              endStopReason = out.stopReason;
              endDurationMs = out.durationMs;
              endUsage = out.usage;
            } else if (out.type === 'error') {
              endStopReason = 'cancelled';
            }
            bridge.forward(out);
          }
          if (out.type === "done" || out.type === "error") break;
        }
      } catch (err: any) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", message: err?.message ?? String(err), providerId: provider.id }),
        });
        endStopReason = 'cancelled';
      } finally {
        finishBridge();
        // A blocked permission card belongs to THIS turn. When the turn ends
        // (naturally, on error, or because the user cancelled / sent a new
        // message → the subprocess is terminated, which also kills the MCP
        // permission child and drops its HTTP call), release any permission
        // still pending for this thread. The held /permission-request then
        // resolves fail-closed *now* and its finally publishes
        // `permission:resolved` → the UI card dismisses — instead of lingering
        // for 10 minutes against a turn whose subprocess is already gone.
        // sid + agent recompute exactly what claude-code.ts fed the MCP server
        // (FORGEAX_SID / FORGEAX_AGENT). No-op on a normal turn (the answered
        // request was already removed from the registry).
        const permSid = req.threadId?.trim() || req.sessionId?.trim() || "";
        if (permSid) {
          try {
            denyPermissionsForSession(permSid, req.agentId?.trim() || "forge");
          } catch (e) {
            console.warn(`[cli/chat] permission cleanup failed: ${(e as Error).message}`);
          }
        }
        c.req.raw.signal.removeEventListener("abort", onAbort);
      }
    });
  });

  // POST /api/cli/cancel -- Doc 05 section 7 cancel channel. Calls
  // provider.cancel(callId) so the in-flight chat aborts and emits its
  // `{ type: 'done', stopReason: 'cancelled', code: 'cancelled' }` terminal
  // on its own SSE stream. Idempotent: unknown callIds return ok:true so
  // the UI can fire-and-forget without races against natural completion.
  r.post("/cancel", async (c) => {
    let body: CancelBody;
    try {
      body = (await c.req.json()) as CancelBody;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    if (!callId) {
      return c.json({ ok: false, error: "callId (non-empty string) required" }, 400);
    }
    const runtimeCall = runtimeCliCalls.get(callId);
    if (runtimeCall) {
      runtimeCall.session.interruptRuntime(
        runtimeCall.agentPath,
        "cancelled by /api/cli/cancel",
      );
      return c.json({
        ok: true,
        callId,
        providerId: normalizeKernelId(body.providerOverride) ?? null,
      });
    }
    const provider = body.providerOverride
      ? getProvider(body.providerOverride)
      : getDefaultProvider();
    if (!provider) {
      return c.json(
        { ok: false, error: `no cli-provider available${body.providerOverride ? ` (override="${body.providerOverride}")` : ""}` },
        503,
      );
    }
    if (typeof provider.cancel !== "function") {
      return c.json({ ok: false, error: `provider ${provider.id} does not support cancel` }, 501);
    }
    try {
      await provider.cancel(callId);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message ?? String(err) }, 500);
    }
    return c.json({ ok: true, callId, providerId: provider.id });
  });

  return r;
}
