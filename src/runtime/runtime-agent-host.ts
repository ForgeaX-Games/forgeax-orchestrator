/**
 * Kernel-backed Agent capability host.
 *
 * Lifecycle, queueing and cancellation belong to AgentRuntimeController. This
 * object only binds Kit registries, AgentContext and one Kernel turn. It has no
 * forever loop, filesystem watcher or independent AbortController.
 */

import type {
  AgentContext,
  AgentJson,
  AgentTreeAPI,
  BlackboardAPI,
  Event,
  EventBusAPI,
  ModelsConfig,
  SelfEvent,
  ToolDefinition,
} from "../core/types";
import { mkdirSync } from "node:fs";
import { EventBus } from "../core/event-bus";
import { runWithAgentTurn, runWithSession } from "../core/logger";
import { resolveModelsConfig } from "../core/resolve-models";
import { BLACKBOARD_KEYS } from "../defaults/blackboard-vars";
import { createAgentFs } from "../fs/agent-fs";
import {
  type RecorderHooks,
  wrapAgentFsWithRecorder,
} from "../fs/agent-fs-recorder";
import { getPathManager } from "../fs/path-manager";
import { Hook } from "../hooks/types";
import { ContextWindow } from "../context-window/context-window";
import { KitPluginLoader } from "../kits/plugin-loader";
import { PluginRegistry } from "../kits/plugin-registry";
import { KitSlotLoader } from "../kits/slot-loader";
import { SlotRegistry } from "../kits/slot-registry";
import { KitToolLoader } from "../kits/tool-loader";
import { ToolRegistry } from "../kits/tool-registry";
import { executeTool } from "../kits/tool/tool-executor";
import { getTerminalManager } from "../terminal/manager";
import { deepMerge } from "../utils/deep-merge";
import { eventToSessionMessage } from "../message/message-ingress";
import { runKernelTurn } from "./kernel-turn-runner";
import { materializeTurnContext } from "./turn-context";
import type { RuntimeToolContext } from "./runtime-context";
import type { KitSourceRef } from "../agents/template-types";
import { ContextEngine } from "../kits/slot/context-engine";
import type { SystemBlock } from "../llm/types";
import { bareName, visibleTools } from "./visible-tools";
import { visibleAgentManagementToolsFromConfig } from "../kits/agent-management-visibility";
import { withAgentHostToolDefinitions } from "../tools/agent-host-tool-surface";

export interface RuntimeAgentHostConfig {
  readonly sid: string;
  readonly instanceId: string;
  readonly runtimeEpochId: string;
  readonly agentPath: string;
  readonly runtimeStateRoot: string;
  readonly templateRoot?: string;
  readonly kitSources: readonly KitSourceRef[];
  readonly workspaceRoot: string;
  readonly agentJson: AgentJson;
  readonly kernelId?: string;
  readonly sessionDefaultModels?: ModelsConfig;
  readonly eventBus: EventBus;
  readonly blackboard: BlackboardAPI;
  readonly tree: AgentTreeAPI;
  readonly ledger: import("../context-window/context-window").LedgerReader;
  readonly fileRecorder?: RecorderHooks;
  /** Session-owned policy gate for externally requested agent commands. */
  readonly authorizeTool?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<void>;
  readonly runtimeToolContext: RuntimeToolContext;
}

export interface RuntimeHostTurnResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly output?: unknown;
  readonly error?: string;
  readonly usage?: Record<string, unknown>;
}

export class RuntimeAgentHost {
  readonly agentPath: string;
  readonly boundEventBus: EventBusAPI;
  readonly agentContext: AgentContext;
  private agentJson: AgentJson;
  private currentSignal: AbortSignal = new AbortController().signal;
  private currentTurn = 0;
  private activeTurnId: string | undefined;
  private activeDelegationId: string | undefined;
  private activeSourceEventId: string | undefined;
  private activeKernelId: string | undefined;
  private disposed = false;
  private readonly contextWindow: ContextWindow;

  private readonly toolLoader = new KitToolLoader();
  private readonly slotLoader = new KitSlotLoader();
  private readonly pluginLoader = new KitPluginLoader();
  private readonly toolRegistry = new ToolRegistry();
  private readonly slotRegistry = new SlotRegistry();
  private readonly contextEngine = new ContextEngine(this.slotRegistry);
  private readonly pluginRegistry = new PluginRegistry();

  constructor(private readonly config: RuntimeAgentHostConfig) {
    this.agentPath = config.agentPath;
    this.agentJson = config.agentJson;
    mkdirSync(config.runtimeStateRoot, { recursive: true });
    const bus = config.eventBus;
    const me = this.agentPath;
    const identify = (event: Event): Event => ({
      ...event,
      payload: {
        ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
        ...(this.activeDelegationId ? { delegationId: this.activeDelegationId } : {}),
        ...(this.activeSourceEventId ? { sourceEventId: this.activeSourceEventId } : {}),
        ...(this.activeKernelId
          ? {
              providerId: this.activeKernelId,
              kernelId: this.activeKernelId,
            }
          : {}),
        ...event.payload,
        agentInstanceId: config.instanceId,
        runtimeEpochId: config.runtimeEpochId,
        templateRef: config.runtimeToolContext.templateRef,
      },
    });
    const sendWithoutWaitingForTurn = (target: string, event: Event): void => {
      void config.runtimeToolContext.sendToAgent(target, event).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[runtime-agent-host] message delivery rejected for "${target}": ${message}\n`,
        );
      });
    };
    this.boundEventBus = {
      publish: (event: Event, emitterId?: string) =>
        bus.publish(identify(event), emitterId ?? me),
      emit: (event: Event, emitterId?: string) => {
        if (event.to && event.to !== "*") {
          sendWithoutWaitingForTurn(event.to, identify(event));
        } else {
          bus.publish(identify(event), emitterId ?? me);
        }
      },
      emitToSelf: (event: SelfEvent) =>
        sendWithoutWaitingForTurn(
          me,
          identify({ ...event, to: me } as Event),
        ),
      hook: (type, payload) => {
        const event = identify({
          source: `agent:${me}`,
          type,
          payload,
          ts: Date.now(),
        });
        bus.publish(event, me);
        return event;
      },
      observe: (handler) => bus.observe(handler),
      observeAgent: (target, handler) => bus.observeAgent(target, handler),
    };
    this.contextWindow = new ContextWindow(
      this.agentPath,
      config.ledger,
      config.blackboard,
    );

    const pathManager = getPathManager();
    const baseFs = createAgentFs(
      pathManager,
      config.blackboard,
      this.agentPath,
      config.runtimeStateRoot,
      () => config.workspaceRoot,
    );
    const fs = config.fileRecorder
      ? wrapAgentFsWithRecorder(baseFs, this.agentPath, config.fileRecorder)
      : baseFs;
    const self = this;
    this.agentContext = {
      agentPath: this.agentPath,
      sid: config.sid,
      instanceId: config.instanceId,
      runtimeEpochId: config.runtimeEpochId,
      runtimeStateRoot: config.runtimeStateRoot,
      ...(config.templateRoot ? { templateRoot: config.templateRoot } : {}),
      kitSources: config.kitSources,
      runtimeManaged: true,
      runtime: config.runtimeToolContext,
      cwd: config.workspaceRoot,
      get signal() {
        return self.currentSignal;
      },
      eventBus: this.boundEventBus,
      blackboard: config.blackboard,
      tree: config.tree,
      hook: Hook,
      getAgentJson: () => this.agentJson,
      applyAgentDefaults: (defaults) => {
        this.agentJson = deepMerge(
          this.agentJson as unknown as Record<string, unknown>,
          defaults,
        ) as unknown as AgentJson;
      },
      tools: this.toolRegistry,
      slots: this.slotRegistry,
      plugins: this.pluginRegistry,
      fs,
      pathManager,
      terminal: getTerminalManager(),
      ledger: config.ledger,
      resolveModels: () =>
        resolveModelsConfig(this.agentJson, config.sessionDefaultModels ?? {}),
    };
    this.slotLoader.setSlotContext(this.agentContext);
    this.pluginRegistry.setContext(this.agentContext);
  }

  setAgentJson(next: AgentJson): void {
    this.agentJson = next;
  }

  async initKits(): Promise<void> {
    await this.reloadKitKind("plugins");
    await this.reloadKitKind("tools");
    await this.reloadKitKind("slots");
  }

  async reloadKitKind(kind: "tools" | "slots" | "plugins"): Promise<void> {
    if (this.disposed) return;
    if (kind === "plugins") {
      await this.pluginRegistry.replaceStatic(
        await this.pluginLoader.load(this.agentContext),
      );
    } else if (kind === "tools") {
      this.toolRegistry.replaceStatic(
        await this.toolLoader.load(this.agentContext),
      );
    } else {
      this.slotRegistry.replaceStatic(
        await this.slotLoader.load(this.agentContext),
      );
    }
  }

  async validateKitKinds(
    kinds: ReadonlySet<"tools" | "slots" | "plugins">,
  ): Promise<void> {
    for (const kind of kinds) {
      if (kind === "plugins") {
        await this.pluginLoader.load(this.agentContext);
      } else if (kind === "tools") {
        await this.toolLoader.load(this.agentContext);
      } else {
        await this.slotLoader.load(this.agentContext);
      }
    }
  }

  /** Resolve all visible Kit slots for the current pinned execution revision.
   *
   * Template persona/skills/memory and product-shell charter/environment are
   * not Kit slots anymore; this seam carries only additional Kit-authored
   * stable/dynamic context into the same ResolvedAgentComposition. */
  async assembleKitSystemBlocks(): Promise<SystemBlock[]> {
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      this.config.blackboard.getAll(this.agentPath),
    )) {
      vars[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return (
      await this.contextEngine.assemblePrompt(
        this.agentContext,
        [],
        undefined,
        undefined,
        vars,
      )
    ).system;
  }

  async executeTurn(
    input: Event,
    signal: AbortSignal,
  ): Promise<RuntimeHostTurnResult> {
    if (this.disposed) throw new Error(`runtime host disposed: ${this.config.instanceId}`);
    if (signal.aborted) {
      throw new DOMException(
        String(signal.reason ?? "turn aborted before execution"),
        "AbortError",
      );
    }
    this.currentSignal = signal;
    const turn = ++this.currentTurn;
    return runWithSession(this.config.sid, () =>
      runWithAgentTurn(this.agentPath, turn, async () => {
        const payload = input.payload as Record<string, unknown>;
        const kernelId = resolveTurnKernelId(payload, this.config.kernelId);
        const turnId =
          typeof payload.delegationId === "string" && payload.delegationId.trim()
            ? `delegation:${payload.delegationId.trim()}`
            : typeof payload.msgId === "string" && payload.msgId.trim()
            ? payload.msgId.trim()
            : `${this.config.runtimeEpochId}:${turn}`;
        this.activeTurnId = turnId;
        this.activeDelegationId = typeof payload.delegationId === "string" && payload.delegationId.trim()
          ? payload.delegationId.trim()
          : undefined;
        this.activeSourceEventId = typeof input.eventId === "string" && input.eventId.trim()
          ? input.eventId.trim()
          : undefined;
        this.activeKernelId = kernelId;
        this.config.blackboard.set(
          this.agentPath,
          BLACKBOARD_KEYS.RUNNING,
          true,
          { persist: false },
        );
        this.boundEventBus.hook(Hook.TurnStart, {
          turn,
          eventCount: 1,
          turnId,
          ...(kernelId ? { providerId: kernelId, kernelId } : {}),
        });
        let error: string | undefined;
        try {
          if (input.type === "agent_command") {
            return await this.executeCommand(input, turn);
          }
          this.contextWindow.trackEvents([input]);
          const inboundMessage = eventToSessionMessage(input);
          if (inboundMessage) {
            this.boundEventBus.publish({
              source: input.source,
              type: "inbound_message",
              payload: {
                llmMessage: inboundMessage,
                turn,
                sourceEvent:
                  typeof input.sgen === "string" &&
                  typeof input.seq === "number"
                    ? { sgen: input.sgen, seq: input.seq }
                    : undefined,
                originalType: input.type,
              },
              ts: Date.now(),
            });
          }
          const excludeEvents =
            typeof input.sgen === "string" && typeof input.seq === "number"
              ? [{ sgen: input.sgen, seq: input.seq }]
              : [];
          const context = await materializeTurnContext({
            agentId: this.agentPath,
            ledger: this.config.ledger,
            blackboard: this.config.blackboard,
            excludeEvents,
          });
          const userText =
            typeof payload.contextContent === "string"
              ? payload.contextContent
              : typeof payload.content === "string"
                ? payload.content
                : JSON.stringify(payload.content ?? "");
          const models = resolveModelsConfig(
            this.agentJson,
            this.config.sessionDefaultModels ?? {},
          );
          const requestedModel = typeof payload.model === "string"
            ? payload.model.trim() || undefined
            : undefined;
          const model = requestedModel ?? (Array.isArray(models.model)
            ? models.model[0]
            : models.model ?? undefined);
          const tools = visibleTools(
            withAgentHostToolDefinitions(this.toolRegistry.list(), this.agentContext),
            this.agentContext,
          );
          const visibleAgentManagementTools = visibleAgentManagementToolsFromConfig(this.agentJson.kits);
          const kitSystemBlocks = await this.assembleKitSystemBlocks();
          this.config.blackboard.set(
            this.agentPath,
            BLACKBOARD_KEYS.ACTIVE_TOOLS,
            tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
            })),
            { persist: false },
          );
          const result = await runKernelTurn({
            agentId: this.agentPath,
            sessionId: this.config.sid,
            instanceId: this.config.instanceId,
            runtimeEpochId: this.config.runtimeEpochId,
            templateRef: this.config.runtimeToolContext.templateRef,
            ...(kernelId ? { kernelId } : {}),
            ...(context ? { context } : {}),
            userText,
            eventBus: this.boundEventBus,
            signal,
            turn,
            tools: tools.map((tool) => ({
              name: bareName(tool.name),
              description: tool.description,
              inputSchema: tool.input_schema,
            })),
            visibleAgentManagementTools,
            kitSystemBlocks,
            historyExcludeEvents: excludeEvents,
            callId: turnId,
            ...(Array.isArray(payload.attachments)
              ? { attachments: payload.attachments as Array<Record<string, unknown>> }
              : {}),
            ...(typeof payload.traceparent === "string"
              ? { traceparent: payload.traceparent }
              : {}),
            ...(payload.replyLanguage === "en" || payload.replyLanguage === "zh"
              ? { replyLanguage: payload.replyLanguage }
              : {}),
            ...(model ? { model } : {}),
          });
          if (result.status === "cancelled" || result.aborted) {
            throw new DOMException(
              String(signal.reason ?? "turn aborted"),
              "AbortError",
            );
          }
          if (result.status === "failed" || result.error) {
            error = result.error;
            throw new Error(result.error ?? "kernel turn failed");
          }
          return {
            status: "completed",
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
          };
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          throw caught;
        } finally {
          this.boundEventBus.hook(Hook.TurnEnd, {
            turn,
            aborted: signal.aborted,
            turnId,
            ...(kernelId ? { providerId: kernelId, kernelId } : {}),
            ...(error ? { error } : {}),
          });
          this.config.blackboard.set(
            this.agentPath,
            BLACKBOARD_KEYS.RUNNING,
            false,
            { persist: false },
          );
          this.currentSignal = new AbortController().signal;
          this.activeTurnId = undefined;
          this.activeDelegationId = undefined;
          this.activeSourceEventId = undefined;
          this.activeKernelId = undefined;
        }
      })
    );
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.toolRegistry.clear();
    this.slotRegistry.clear();
    this.pluginRegistry.clear();
  }

  private async executeCommand(
    input: Event,
    turn: number,
  ): Promise<RuntimeHostTurnResult> {
    const payload = input.payload as Record<string, unknown>;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    if (!toolName) throw new Error("agent_command toolName missing");
    const args = payload.args && typeof payload.args === "object"
      ? payload.args as Record<string, unknown>
      : {};
    const allTools = withAgentHostToolDefinitions(this.toolRegistry.list(), this.agentContext);
    const tools = visibleTools(allTools, this.agentContext);
    const tool = resolveToolForCommand(toolName, tools);
    if (!tool) {
      // A hidden or ambiguous tool is an authorization/visibility failure and
      // must not emit a tool call. A genuinely deleted tool is different: keep
      // the established executeTool result + ledger shape so one stale command
      // does not reject the whole resident runtime turn.
      const hasRegistryCandidate = allTools.some(
        (candidate) => candidate.name === toolName || bareName(candidate.name) === toolName,
      );
      if (hasRegistryCandidate) {
        throw new Error(`Tool "${toolName}" is not available in the current context`);
      }
    }
    if (tool) await this.config.authorizeTool?.(tool.name, args);
    // Keep the command in the same host-owned history path as a normal inbound
    // message. The original agent_command event is persisted by Session; this
    // derived inbound_message is the model/replay projection of that command.
    this.contextWindow.trackEvents([input]);
    const inboundMessage = eventToSessionMessage(input);
    if (inboundMessage) {
      this.boundEventBus.publish({
        source: input.source,
        type: "inbound_message",
        payload: {
          llmMessage: inboundMessage,
          turn,
          originalType: input.type,
          sourceEventId: input.eventId,
        },
        ts: Date.now(),
      });
    }
    const callId = `cmd_${crypto.randomUUID()}`;
    this.boundEventBus.hook(Hook.ToolCall, {
      name: toolName,
      args,
      toolCallId: callId,
      toolCall: { id: callId, name: toolName, arguments: args },
      turn,
    });
    const startedAt = Date.now();
    const result = await executeTool(
      toolName,
      args,
      tools,
      this.agentContext,
    );
    const isError =
      Boolean(result && typeof result === "object" && "error" in result);
    this.boundEventBus.hook(Hook.ToolResult, {
      name: toolName,
      callId,
      toolCallId: callId,
      durationMs: Date.now() - startedAt,
      ok: !isError,
      ...(isError ? { error: String((result as { error: unknown }).error) } : { result }),
      turn,
    });
    // A missing hot-reloaded tool is already represented by the structured
    // tool result above; preserve the resident turn and let the caller observe
    // the normal tool-result/ledger error instead of rejecting the runtime turn.
    return { status: "completed", output: result };
  }
}

function resolveTurnKernelId(
  payload: Record<string, unknown>,
  configured?: string,
): string | undefined {
  const requested =
    typeof payload.kernelId === "string"
      ? payload.kernelId.trim()
      : typeof payload.providerOverride === "string"
        ? payload.providerOverride.trim()
        : "";
  if (requested) {
    return requested === "forgeax" ? "forgeax-core" : requested;
  }
  return configured?.trim() || undefined;
}

function resolveToolForCommand(
  name: string,
  tools: readonly ToolDefinition[],
): ToolDefinition | undefined {
  const exact = tools.find((tool) => tool.name === name);
  if (exact) return exact;
  const bare = tools.filter((tool) => bareName(tool.name) === name);
  return bare.length === 1 ? bare[0] : undefined;
}
