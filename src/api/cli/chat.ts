/** POST /api/cli/chat —— 临时 SSE 桥，让 interface 还能跟 claude-code 聊天。
 *
 *  R3 阶段定位（参考 docs/features/internal-loop-completion-plan.md §5）：
 *  - **独立 REST 分支**，不走 commands transport。
 *  - 标 `Deprecation: true` + `Sunset: forgeax-v1.0` —— 等原生 ScriptAgent /
 *    commands `attach_script_agent` 跑通后，这条整片下线。
 *  - 简化版砍掉旧实现的 runs / threads / event-log / SessionStore 持久化层；
 *    只保留 "POST 一句话 → SSE 一回合 → done/error 终止" 的最小核心。多轮上下文
 *    继续靠 claude-code 自带的 `--session-id` / `--resume`（provider 内部维持
 *    `startedThreadIds` set），threadId 由 caller（interface）提供。
 *
 *  请求体（与旧 chat.ts 子集兼容）：
 *    {
 *      message: string,           // 必填
 *      threadId?: string,         // UUID v4；缺则 provider 每次起独立 session（无续上下文）
 *      agentId?: string,          // 暂时只用于日志
 *      providerOverride?: string, // UI 选的内核 id(claude-code / codex / forgeax-core);内核路径据此 resolveKernel
 *      model?: string             // 可选：所选内核认可的显式模型；未传则用该 CLI 的当前模型
 *    }
 *
 *  响应：text/event-stream，每条事件 `event: <type>\ndata: <json>\n\n`。
 *  事件类型来自 ChatEvent union（token / thinking / tool-call / tool-result / done / error）。
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  getDefaultProvider,
  getProvider,
  listProviders,
} from "../../cli-providers/registry";
import type { ChatEvent, ChatRequest } from "../../cli-providers/types";
import type { Session } from "../../core/session";
import { deprecation } from "../lib/deprecation";
import { getSessionManager } from "../../core/session-manager";
import { getCheckpointManager } from "../../checkpoint/checkpoint-manager";
import { getPathManager } from "../../fs/path-manager";
import { readFile } from "node:fs/promises";
import { CliEventBridge } from "../../observatory/cli-event-bridge";
import { denyPermissionsForSession } from "../../core/permission-registry";
// M1 内核路径(FORGEAX_KERNEL=kernel):chat → 内核契约 → wire,前端零改。
import { composeTurnRequest } from "../../kernel/compose-turn-request";
import { ProjectMcpNativeOwnershipBusyError } from "../../kernel/project-mcp";
import { hostToolSpecsForAgent } from "../lib/host-tools-for-agent";
import { resolveKernel, listAvailableKernels } from "../../kernel/resolve-kernel";
import { toKernelErrorPayload } from "../../kernel/kernel-unavailable";
import { toWireEvents, newWireFoldState } from "../../kernel/to-wire-events";
import type { AgentKernel } from "@forgeax/agent-runtime";
import { kernelEnabled } from "../../kernel/kernel-mode";
import { transcribeKernelTurn } from "../../kernel/transcribe-turn";
import { hostTelemetryEnabled } from "../../kernel/host-telemetry";
import { startCliKernelTurn, unwrapMcpResultEnvelope, type CliKernelTurnTrace } from "../../kernel/cli-kernel-trace";
import { deriveThreadId } from "../../lib/thread-id";
import { tt, ttEnabled } from "../../lib/turn-trace";
import { formatCacheHitRatio } from "../../lib/cache-ratio";
import { getExtensionSnapshot } from "../../extensions/registry";
import { emptyCapabilitySnapshot } from "@forgeax/types";
import { listAllCommands } from "../../commands/runner";
import { commandCapabilities } from "../../capabilities/adapters";
import { getSessionManager as getCapabilitySessionManager } from "../../core/session-manager";
import { commonCapabilityRoots } from "../../capabilities/common-roots";
import { listCommonMcpServers } from "../../capabilities/mcp-catalog";
import {
  appliedKernelMutationRecords,
  captureKernelMutationIntents,
  type KernelMutationIntent,
} from "../../kernel/kernel-file-activity";

interface ChatBody {
  message?: string;
  /** Client message id used as the host-owned checkpoint foreign key. */
  messageId?: string;
  agentId?: string;
  threadId?: string;
  sessionId?: string;
  providerOverride?: string;
  /** Selected kernel model. Never inherit a different kernel's agent model. */
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
  /** 浏览器 `ui.request` span 的 W3C traceparent —— 服务端的 kernel.turn 挂在它下面,
   *  链才连得起 `ui.send → ui.request → kernel.turn → agent.run → tool`。
   *  缺失时服务端自建 root trace(链仍成立,只是少了浏览器那两段),**不伪造父 id**。 */
  traceparent?: string;
}

interface CancelBody {
  callId?: string;
  providerOverride?: string;
}

type PrewarmableKernel = AgentKernel & {
  prewarm?: (req: import('@forgeax/agent-runtime').TurnRequest) => Promise<{
    warmed: boolean;
    reused: boolean;
  }>;
};

const DEPRECATION_NOTICE = deprecation({
  sunset: "forgeax-v1.0",
  reason: "cli-provider bridge is temporary; will be replaced by commands.attach_script_agent + ScriptAgent",
  migration: "/api/commands/attach_script_agent/execute (planned R5)",
});

export function createCliRouter() {
  const r = new Hono();

  const boundedProbe = async <T extends { ok: boolean; detail?: string }>(
    probe: () => Promise<T>,
    timeoutMs = 6000,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe(),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, detail: `probe timed out after ${timeoutMs}ms` } as T), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // 所有 /api/cli/* 端点统一带 Deprecation header。
  r.use("*", DEPRECATION_NOTICE);

  // 健康检查 —— 让 interface 能 probe "claude 二进制有没有 / API key 设了没"。
  r.get("/health", async (c) => {
    const providers = listProviders();
    const snaps = await Promise.all(providers.map(async (p) => {
      const h = await boundedProbe(() => p.health(1500));
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
      const kernels = listAvailableKernels().filter((k) => !seen.has(k.id));
      const kernelSnaps = await Promise.all(kernels.map(async (k) => {
        let h: { ok: boolean; detail?: string };
        try {
          // Some installed CLIs (notably Kimi and Cursor) perform a short
          // first-run bootstrap even for their non-interactive help probe.
          // The kernel owns a 10s child timeout; do not let the health route's
          // old 6s wrapper report a healthy binary as unavailable.
          h = await boundedProbe(() => k.probe(), 15000);
        } catch (e) {
          h = { ok: false, detail: (e as Error).message };
        }
        // 把 KernelCapabilities 映射成 picker 期望的 ProviderCapabilities 形:
        // 内核经 threadId resume(sessions=true);子 agent 走编排层 handoff 而非内核内
        // (subAgents=false,保守);无 JSONL 回放语义。
        const cap = k.capabilities;
        return {
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
            checkpoint: {
              mode: k.id === "forgeax-core" ? "native" : "host-compatible",
              code: true,
              conversation: true,
              privateHistory: false,
            },
          },
        };
      }));
      snaps.push(...kernelSnaps);
    }
    if (snaps.length === 0) {
      return c.json({ ok: false, providers: [], detail: "no cli-provider registered" }, 503);
    }
    return c.json({ ok: overallOk, providers: snaps });
  });

  /** Kernel picker discovery: shared catalog + kernel-native catalog. */
  r.get("/capabilities", async (c) => {
    const kernelId = c.req.query("kernel")?.trim();
    if (!kernelId) return c.json({ ok: false, error: "missing kernel query" }, 400);
    try {
      const kernel = resolveKernel("", kernelId);
      const snapshot = getExtensionSnapshot().capabilities ?? emptyCapabilitySnapshot();
      const commands = await listAllCommands({
        sm: getCapabilitySessionManager(),
        paths: getPathManager(),
      });
      const native = kernel.listCapabilities
        ? await kernel.listCapabilities()
        : { kernelId: kernel.id, capabilities: [] };
      return c.json({
        kernelId: kernel.id,
        shared: {
          generation: snapshot.generation,
          capabilities: [...snapshot.capabilities, ...commandCapabilities(commands, snapshot.generation)],
          mcp: listCommonMcpServers(),
          roots: commonCapabilityRoots(),
        },
        native,
      });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 404);
    }
  });

  /**
   * Warm an idle session-scoped CLI transport before the first user turn.
   * This endpoint never sends a hidden model prompt: the kernel only starts
   * its persistent process with the exact capability/permission surface that
   * the following real turn will use. Kernels without that optional transport
   * capability return a successful no-op so the UI remains kernel-agnostic.
   */
  r.post("/warm", async (c) => {
    let raw: Record<string, unknown>;
    try {
      raw = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : 'forge';
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    const requestedThreadId = typeof raw.threadId === 'string' && raw.threadId.trim()
      ? raw.threadId.trim()
      : sessionId;
    // The host session id is a routing/permission identity. The provider
    // session identity is a separate SSOT and must include the agent, or two
    // agents in one Studio session can resume the same native conversation.
    const threadId = sessionId ? deriveThreadId(sessionId, agentId) : requestedThreadId;
    if (!sessionId || !threadId) return c.json({ ok: false, error: 'sessionId and threadId are required' }, 400);
    const providerOverride = typeof raw.providerOverride === 'string' ? raw.providerOverride.trim() : undefined;

    let selectedKernel: AgentKernel;
    try {
      selectedKernel = resolveKernel(agentId, providerOverride);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 503);
    }
    const prewarm = (selectedKernel as PrewarmableKernel).prewarm;
    if (typeof prewarm !== 'function') {
      return c.json({ ok: true, kernelId: selectedKernel.id, warmed: false, reused: false, reason: 'kernel-does-not-support-prewarm' });
    }

    try {
      const extraTools = hostToolSpecsForAgent(sessionId, agentId);
      const turnReq = await composeTurnRequest({
        // This text is never sent to the kernel. It only gives the composer a
        // complete TurnRequest so prewarm uses the same native settings,
        // MCP/plugin/skill catalog and permission hook as the real turn.
        message: '',
        prewarm: true,
        agentId,
        kernel: selectedKernel,
        threadId,
        sessionId,
        ...(extraTools.length ? { extraTools } : {}),
      });
      const result = await prewarm.call(selectedKernel, turnReq);
      return c.json({ ok: true, kernelId: selectedKernel.id, ...result });
    } catch (error) {
      return c.json({ ok: false, kernelId: selectedKernel.id, error: (error as Error).message }, 503);
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
      const callId = typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : undefined;
      // 一次生成、两处使用:compose 写进 manifest,转录写进 hook:turnStart。
      // 这是"哪条工具面对应真正执行的那一轮"的连接键。
      const turnAttemptId = randomUUID();
      const agentId = body.agentId ?? "default";
      const sessionId = body.sessionId?.trim() || undefined;
      // UI historically sent the raw Studio sid as threadId. Keep accepting
      // that wire shape, but never use it as the provider-native key when a
      // host session is present: the canonical key is (sid, agentId).
      const threadId = sessionId ? deriveThreadId(sessionId, agentId) : body.threadId?.trim() || undefined;
      const checkpointMsgId = body.sessionId
        ? (typeof body.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : randomUUID())
        : undefined;
      // 该 agent 的插件 host-tools(exposedToAI + 命中 agent.json host-tools allow)→
      // extraTools 下发内核。conscious-agent 路径经 kits 桥自带这步;/api/cli/chat
      // (租用内核聊天入口)此前漏了它,导致 team + gen3d 等插件工具对 cbc/cc/codex
      // 不可见。与桥同一套 allow 规则,无需活着的 conscious agent。
      const extraTools = hostToolSpecsForAgent(body.sessionId, agentId);
      // Resolve before compose: the selected kernel owns attachment/history semantics.
      let selectedKernel: AgentKernel;
      try {
        selectedKernel = resolveKernel(agentId, body.providerOverride);
      } catch (err: any) {
        const payload = await toKernelErrorPayload(null, err);
        return c.json(payload, 503);
      }
      const composeInput = {
        message,
        agentId,
        turnAttemptId,
        kernel: selectedKernel,
        threadId,
        sessionId,
        callId,
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : {}),
        ...(extraTools.length ? { extraTools } : {}),
        ...(Array.isArray(body.attachments) && body.attachments.length ? { attachments: body.attachments } : {}),
        ...(body.replyLanguage === "en" || body.replyLanguage === "zh" ? { replyLanguage: body.replyLanguage } : {}),
      } satisfies Parameters<typeof composeTurnRequest>[0];
      let turnReq: Awaited<ReturnType<typeof composeTurnRequest>>;
      let composeError: unknown;
      // A host MCP pool may still be draining while a native Claude/Cursor
      // transport hands ownership back. Retry that bounded transition once;
      // never spin or resend the user's model turn.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          turnReq = await composeTurnRequest(composeInput);
          composeError = undefined;
          break;
        } catch (error) {
          composeError = error;
          if (!(error instanceof ProjectMcpNativeOwnershipBusyError) || attempt !== 0) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (composeError !== undefined) {
        const messageText = composeError instanceof Error ? composeError.message : String(composeError);
        if (composeError instanceof ProjectMcpNativeOwnershipBusyError) {
          return c.json({
            code: 'project_mcp_native_busy',
            message: 'Project MCP is switching ownership between host and native transports; retry this turn.',
            retryable: true,
            retryAfterMs: 250,
          }, 409);
        }
        if (messageText.includes('history_unavailable')) {
          return c.json({ code: 'history_unavailable', message: 'Unable to sync shared history; the turn was not sent.', retryable: true }, 409);
        }
        throw composeError;
      }

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
        if (checkpointMsgId) {
          try {
            await getCheckpointManager().snapshotForMessage(persistSession, checkpointMsgId, {
              providerId: selectedKernel.id,
              checkpointMode: selectedKernel.id === "forgeax-core" ? "native" : "host-compatible",
            });
          } catch (e) {
            console.warn(`[cli/chat] checkpoint snapshot failed: ${(e as Error).message}`);
          }
        }
      }

      const turnStartedAt = Date.now();
      return streamSSE(c, async (sse) => {
        const ac = new AbortController();
        const sseStartedAt = Date.now();
        let sseTokenFirstSeen = false;
        const onAbort = () => ac.abort();
        c.req.raw.signal.addEventListener("abort", onAbort);
        const fold = newWireFoldState();
        // accumulate the turn for the WAL write in `finally`.
        // Keep the post-tool conclusion separate from the ordered process
        // slices. This lets refresh reproduce assistant text/tool/result order
        // without duplicating the same text in the final assistant message.
        let pendingAssistantText = "";
        let thinkingText = "";
        let publicSummaryText = "";
        const processEvents: Array<
          | { kind: "assistant_text"; text: string }
          | { kind: "public_summary"; text: string }
          | { kind: "call"; callId: string; name: string; args: unknown }
          | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
        > = [];
        let stopReason: "end_turn" | "tool_use" | "max_tokens" | "cancelled" = "end_turn";
        let usage: unknown;
        const toolEvents: Array<
          | { kind: "call"; callId: string; name: string; args: unknown }
          | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
        > = [];
        // Rented kernels execute local-capable tools in their own process, so
        // those writes bypass Session's AgentFs recorder. Capture an intent at
        // tool-call time and append applied evidence after a successful result
        // before the artifact resolver runs.
        const kernelMutationIntents = new Map<string, KernelMutationIntent[]>();
        // 内核 id 即 wire/账本的 providerId(claude-code / codex / forgeax-core)。
        // 在 try 外声明,让 finally 的账本转录也能拿到(刷新后据此还原来源 badge)。
        let providerId = "claude-code";
        // 第 2 层全链路 trace(2026-08-06 外审):此前**只有** core/kernel-turn.ts 那条路
        // 装了 kernel.turn span,而模型选择器里显式选 CLI 内核时走的是本路由 —— 于是
        // 真实会话 0 个 span。磁盘实证:codex 35 个会话仅 5 个有 trace(那 5 个走原生
        // 入口)。护栏/观测只装一个执行口、另一口整条绕开,这个病本工作流已犯过两次;
        // 这里与 runKernelTurn 同名同形补上第二口。
        let cliTrace: CliKernelTurnTrace | null = null;
        let kernelRunFailed = false;
        let kernelRunError: unknown;
        // 在 try 外声明,让 catch 能拿到内核去 probe(区分「内核不可用」与「运行时报错」)。
        // resolveKernel 抛错(unknown-id / not-registered)时它保持 null,由 err 自身分类。
        let kernel: AgentKernel | null = selectedKernel;
        try {
          if (selectedKernel.id !== "forgeax-core" && hostTelemetryEnabled()) {
            const tp = typeof body.traceparent === "string" && body.traceparent.trim() ? body.traceparent.trim() : undefined;
            cliTrace = startCliKernelTurn({
              kernelId: selectedKernel.id,
              agentId,
              ...(body.sessionId?.trim() ? { sid: body.sessionId.trim() } : {}),
              ...(tp ? { traceparent: tp } : {}),
            });
          }
        } catch { /* 遥测绝不反噬聊天主流程 */ }
        try {
          providerId = selectedKernel.id;
          for await (const kev of kernel.runTurn(turnReq, ac.signal)) {
            // x.* 观测事件在 wire 层没有对应类型(toWireEvents 对它们返回 []),
            // 所以必须在这里单独落账 —— 否则**在租用内核实际走的这条路径上**它们被
            // 静默丢弃。2026-08-05 终审实测:codex 会话账本里 x.kernel.thread 零命中,
            // 而它承载的正是"本会话 ↔ 哪份内核转录"这个不落盘就永久丢失的指针。
            // native 路径由 core/kernel-turn.ts 负责同样的事,两条路各管各的。
            // 2026-08-06(外审#四):直写 ledger,不再经 eventBus.publish —— bus 的
            // tree 门在 agent 未 scaffold 时 `candidates.length === 0` 就静默 return,
            // 这条指针会无声消失。x.tools.manifest 走的就是 append 直写,同一 PR 里
            // 知道正确做法却对新事件用了错的那套 —— 现在两条对齐。
            const kind = (kev as { kind?: unknown }).kind;
            if (typeof kind === 'string' && kind.startsWith('x.') && persistSession && persistAgent) {
              try {
                persistSession.getOrCreateLedger(persistAgent).append(
                  { type: kind, ts: Date.now(), source: `agent:${persistAgent}`, payload: kev as unknown as Record<string, unknown> },
                  persistAgent,
                );
              } catch { /* 观测通道绝不影响主流程 */ }
            }
            for (const wire of toWireEvents(kev, fold)) {
              let out: ChatEvent = { ...wire, providerId };
              // 工具结果必须在**写进 SSE 之前**处理:先把连接键取给 span,再把 MCP 信封剥掉。
              // 顺序反了就白做 —— 前端 store 只认字符串 result,信封一旦发出去,工具卡的正文
              // 就整段消失。剥的逻辑与 core/kernel-turn.ts 共用同一份(两个执行口从不各写各的)。
              if (out.type === "tool-result") {
                cliTrace?.onToolResult(out.callId, out.ok, out.result, out.error);
                out = { ...out, result: unwrapMcpResultEnvelope(out.result) };
              }
              // 内核 yield 出的终态 error(如第三方 CLI 未装 → spawn ENOENT 被 kernel 包成
              // code:'protocol' 的裸串)在这里统一翻成友好文案:probe 内核确认是否真不可用,
              // 是 → kernel_unavailable + 成因指引;否 → 保留原 code(真·运行时报错)。
              if (out.type === "error") {
                const payload = await toKernelErrorPayload(kernel, { message: out.message }, out.code);
                await sse.writeSSE({ event: "error", data: JSON.stringify({ ...payload, providerId }) });
                return;
              }
              await sse.writeSSE({ event: out.type, data: JSON.stringify(out) });
              switch (out.type) {
                case "token":
                  if (!sseTokenFirstSeen) {
                    sseTokenFirstSeen = true;
                    tt("sse.token-first", { ms: Date.now() - sseStartedAt, provider: providerId });
                  }
                  pendingAssistantText += out.text ?? "";
                  break;
                case "thinking": {
                  if (out.visibility === "public_summary") {
                    const text = out.text ?? "";
                    publicSummaryText += text;
                    const last = processEvents[processEvents.length - 1];
                    if (last?.kind === "public_summary") last.text += text;
                    else if (text) processEvents.push({ kind: "public_summary", text });
                  } else {
                    thinkingText += out.text ?? "";
                  }
                  break;
                }
                // 第 4 层 tool span —— 与 core/kernel-turn.ts 调同一个状态机(cli-kernel-trace)。
                // 观测异常由该模块内部吞掉,这里不再包一层,免得两口的降级策略各写各的又走偏。
                // (tool-result 的 onToolResult 在上面 writeSSE 之前已调,此处只落账本。)
                case "tool-call": {
                  if (pendingAssistantText.trim()) {
                    processEvents.push({ kind: "assistant_text", text: pendingAssistantText });
                    pendingAssistantText = "";
                  }
                  cliTrace?.onToolCall(out.callId, out.name);
                  const event = { kind: "call" as const, callId: out.callId, name: out.name, args: out.args };
                  if (persistSession) {
                    const intents = captureKernelMutationIntents(
                      out.name,
                      out.args,
                      persistSession.artifactProjectRoot(),
                    );
                    if (intents.length) kernelMutationIntents.set(out.callId, intents);
                  }
                  toolEvents.push(event);
                  processEvents.push(event);
                  break;
                }
                case "tool-result": {
                  const event = { kind: "result" as const, callId: out.callId, ok: out.ok, result: out.result, error: out.error };
                  if (out.ok && persistSession && persistAgent) {
                    const intents = kernelMutationIntents.get(out.callId) ?? [];
                    for (const record of appliedKernelMutationRecords(intents, {
                      agentPath: persistAgent,
                      toolCallId: out.callId,
                    })) {
                      persistSession.fileActivity.append(record);
                    }
                  }
                  kernelMutationIntents.delete(out.callId);
                  toolEvents.push(event);
                  processEvents.push(event);
                  break;
                }
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
          const retryCode = err && typeof err.code === 'string' ? err.code : undefined;
          const payload = await toKernelErrorPayload(kernel, err, retryCode);
          await sse.writeSSE({ event: "error", data: JSON.stringify({ ...payload, providerId }) });
        } finally {
          // span 必须在 finally 收口:抛异常/被 abort 时也要收。收不了口的 kernel.turn
          // 是这套 trace 用来定位「卡在内核」的信号,漏收会变成误报源。
          try {
            const u = usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
            const traceUsage = u && typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens)
              && typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens)
              ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens }
              : undefined;
            const cancelled = stopReason === "cancelled" || ac.signal.aborted;
            cliTrace?.end({
              ok: !kernelRunFailed && !cancelled,
              reason: stopReason,
              ...(typeof turnReq.model === "string" && turnReq.model ? { model: turnReq.model } : {}),
              ...(traceUsage ? { usage: traceUsage } : {}),
              ...(kernelRunFailed
                ? { error: kernelRunError instanceof Error ? kernelRunError.message : String(kernelRunError) }
                : {}),
            });
          } catch { /* 遥测收口失败静默降级 */ }
          c.req.raw.signal.removeEventListener("abort", onAbort);
          // Transcribe the kernel turn into the host-owned ledger (kernel-agnostic,
          // keyed to `persistAgent` = the agentId the UI replays with). Direct WAL
          // write, not via eventBus → no WS double-render against the SSE above.
          if (persistSession && persistAgent) {
            try {
              const transcript = transcribeKernelTurn(persistSession, persistAgent, {
                message,
                ...(checkpointMsgId ? { msgId: checkpointMsgId } : {}),
                contextText: turnReq.input.text,
                startedAt: turnStartedAt,
                asstText: pendingAssistantText,
                thinkingText,
                publicSummaryText,
                stopReason,
                providerId,
                ...(usage ? { usage } : {}),
                ...(turnReq.model ? { model: turnReq.model } : {}),
                ...(turnReq.input.attachments?.length
                  ? { attachments: turnReq.input.attachments as Array<Record<string, unknown>> }
                  : {}),
                ...(turnReq.historyPlan ? { historyPlan: turnReq.historyPlan } : {}),
                toolEvents,
                processEvents,
              });
              if (transcript) {
                await persistSession.resolveArtifactTurn({
                  sid: persistSession.sid,
                  agentId: persistAgent,
                  projectRoot: persistSession.artifactProjectRoot(),
                  ...(persistSession.config.defaultDir ? { game: persistSession.config.defaultDir } : {}),
                  turnId: transcript.turnId,
                  ...(checkpointMsgId ? { checkpointMsgId } : {}),
                  startedAt: transcript.startedAt,
                  settledAt: transcript.settledAt,
                  ...(stopReason === "cancelled" ? { aborted: true } : {}),
                });
              }
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
    const legacyCheckpointMsgId = req.sessionId
      ? (typeof body.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : randomUUID())
      : undefined;

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
        if (legacyCheckpointMsgId) {
          try {
            await getCheckpointManager().snapshotForMessage(session, legacyCheckpointMsgId, {
              providerId: provider.id,
              checkpointMode: "host-compatible",
            });
          } catch (e) {
            console.warn(`[cli/chat] checkpoint snapshot failed: ${(e as Error).message}`);
          }
        }
        const node = session.tree.list().find((n) => n.display === req.agentId)
          ?? session.tree.list().find((n) => n.depth === 1)
          ?? null;
        const agentPath = node?.path ?? req.agentId;
        bridge = new CliEventBridge({
          session,
          agentPath,
          model: provider.id,
          message,
          ...(legacyCheckpointMsgId ? { msgId: legacyCheckpointMsgId } : {}),
        });

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
