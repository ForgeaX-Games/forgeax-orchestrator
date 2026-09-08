import type { ModelsConfig, AgentJson, Event } from "../core/types";
import type { Blackboard } from "../core/blackboard";
import type { EventBus } from "../core/event-bus";
import type { RecorderHooks } from "../fs/agent-fs-recorder";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import type { EventStore } from "../ledger/event-store";
import { deepMerge } from "../utils/deep-merge";
import type {
  AgentTurnExecutor,
  AgentTurnResult,
  RuntimeTurnBatch,
  TurnBindings,
} from "./agent-runtime-controller";
import type { RuntimeAgentTreeAdapter } from "./runtime-agent-tree-adapter";
import type { AgentInstance } from "./types";
import type { RuntimeToolContext } from "./runtime-context";
import { RuntimeAgentHost } from "./runtime-agent-host";
import { Hook } from "../hooks/types";

export interface KernelTurnExecutorServices {
  readonly eventBus: EventBus;
  readonly blackboard: Blackboard;
  readonly tree: RuntimeAgentTreeAdapter;
  readonly sessionCwd?: string;
  readonly sessionDefaultModels?: ModelsConfig;
  readonly fileRecorder?: RecorderHooks;
  readonly onAgentReady?: (agent: RuntimeAgentHost) => void | Promise<void>;
  readonly onAgentDisposed?: (agent: RuntimeAgentHost) => void | Promise<void>;
  /** Session-owned policy gate for externally requested agent commands. */
  readonly authorizeTool?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<void>;
  /** Poll Kit source hashes after a unified Kernel turn, before the Controller
   * commits its execution revision. Failures are non-fatal and retain LKG. */
  readonly flushExecutionReloads?: () => void | Promise<void>;
  readonly runtimeToolContext: RuntimeToolContext;
}

/**
 * One-turn execution adapter for RuntimeSupervisor.
 *
 * RuntimeAgentHost owns only the Kit/AgentContext capability surface. Queueing,
 * cancellation, identity and topology remain exclusively runtime-owned.
 */
export class KernelTurnExecutor implements AgentTurnExecutor {
  private agent: RuntimeAgentHost | null = null;
  private initialization: Promise<RuntimeAgentHost> | null = null;
  private loadedExecutionRevision: string | null = null;

  constructor(
    private readonly instance: AgentInstance,
    private readonly eventStore: EventStore,
    private readonly services: KernelTurnExecutorServices,
  ) {}

  async execute(
    instance: AgentInstance,
    input: unknown,
    bindings: TurnBindings,
    signal: AbortSignal,
  ): Promise<AgentTurnResult> {
    if (instance !== this.instance) {
      throw new Error(`KernelTurnExecutor instance mismatch: ${instance.instanceId}`);
    }
    const event = toTurnEvent(
      isRuntimeTurnBatch(input)
        ? mergeTurnInputs(input.inputs)
        : input,
      this.services.tree.addressOf(instance),
    );
    let agent: RuntimeAgentHost;
    try {
      agent = await this.getOrCreateAgent();
      if (this.loadedExecutionRevision !== bindings.execution.revision) {
        await agent.initKits();
        this.loadedExecutionRevision = bindings.execution.revision;
      }
      agent.setAgentJson(toAgentJson(instance, bindings));
    } catch (error) {
      // RuntimeAgentHost normally emits turn-end from its own finally block.
      // Initial host/kit setup happens before that block exists, however. A
      // delegated delivery must still settle through the same five-part
      // identity gate, otherwise a resident remains busy forever and an
      // ephemeral child is released without notifying its delegator.
      this.emitInitializationFailure(event, error);
      try {
        await this.eventStore.flush();
      } finally {
        await this.flushExecutionReloads();
      }
      throw error;
    }
    try {
      const result = await agent.executeTurn(event, signal);
      if (result.status === "cancelled") {
        throw new DOMException("runtime kernel turn cancelled", "AbortError");
      }
      if (result.status === "failed") {
        throw new Error(result.error ?? "runtime kernel turn failed");
      }
      return {
        final: instance.lifetime === "ephemeral",
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } finally {
      try {
        await this.eventStore.flush();
      } finally {
        await this.flushExecutionReloads();
      }
    }
  }

  async dispose(): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    this.initialization = null;
    this.loadedExecutionRevision = null;
    if (!agent) return;
    await this.services.onAgentDisposed?.(agent);
    await agent.shutdown();
  }

  initialize(): Promise<RuntimeAgentHost> {
    return this.getOrCreateAgent();
  }

  get compatibilityAgent(): RuntimeAgentHost | null {
    return this.agent;
  }

  private async flushExecutionReloads(): Promise<void> {
    try {
      await this.services.flushExecutionReloads?.();
    } catch (error) {
      // A Kit authoring error must not retroactively fail a completed model
      // turn. AgentKitReloadCoordinator validates before staging, so keeping
      // the current revision is the complete last-known-good fallback.
      process.stderr.write(
        `[kernel-turn-executor] ${this.instance.sid}/${this.instance.instanceId}: ` +
          `post-turn Kit reload rejected; keeping last-known-good revision: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
      );
    }
  }

  private getOrCreateAgent(): Promise<RuntimeAgentHost> {
    if (this.agent) return Promise.resolve(this.agent);
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const address = this.services.tree.addressOf(this.instance);
      const templateRoot = this.instance.template.resources.templateRoot;
      let agent: RuntimeAgentHost | null = null;
      try {
        agent = new RuntimeAgentHost({
          sid: this.instance.sid,
          instanceId: this.instance.instanceId,
          runtimeEpochId: this.instance.runtimeEpochId,
          agentPath: address,
          runtimeStateRoot: this.instance.runtime.runtimeStateRoot,
          ...(templateRoot ? { templateRoot } : {}),
          kitSources: this.instance.template.execution.kits,
          workspaceRoot:
            this.services.sessionCwd ??
            this.instance.runtime.workspaceRoot,
          agentJson: toAgentJson(this.instance),
          ...(this.instance.template.definition.kernelId
            ? { kernelId: this.instance.template.definition.kernelId }
            : {}),
          eventBus: this.services.eventBus,
          blackboard: this.services.blackboard,
          tree: this.services.tree,
          ledger: this.eventStore.ledger,
          sessionDefaultModels: this.services.sessionDefaultModels,
          ...(this.services.authorizeTool
            ? { authorizeTool: this.services.authorizeTool }
            : {}),
          ...(this.services.fileRecorder
            ? { fileRecorder: this.services.fileRecorder }
            : {}),
          runtimeToolContext: this.services.runtimeToolContext,
        });
        await agent.initKits();
        this.loadedExecutionRevision = this.instance.execution.current().revision;
        await this.services.onAgentReady?.(agent);
        this.agent = agent;
        return agent;
      } catch (error) {
        // Clear the sticky promise so a later retry can re-init (kit load
        // flake / transient I/O must not permanently poison this instance).
        this.initialization = null;
        await agent?.shutdown();
        throw error;
      }
    })();
    return this.initialization;
  }

  private emitInitializationFailure(event: Event, error: unknown): void {
    const payload = event.payload as Record<string, unknown>;
    const delegationId = stringValue(payload.delegationId);
    const turnId = stringValue(payload.turnId);
    const sourceEventId = stringValue(event.eventId);
    if (!delegationId || !turnId || !sourceEventId) return;

    const agentPath = this.services.tree.addressOf(this.instance);
    this.services.eventBus.publish(
      {
        source: `agent:${agentPath}`,
        type: Hook.TurnEnd,
        payload: {
          // No RuntimeAgentHost turn was entered, so 0 is a synthetic marker;
          // the delegation identity below is the authoritative correlation.
          turn: 0,
          aborted: false,
          error: error instanceof Error ? error.message : String(error),
          delegationId,
          sourceEventId,
          turnId,
          agentInstanceId: this.instance.instanceId,
          runtimeEpochId: this.instance.runtimeEpochId,
        },
        ts: Date.now(),
      },
      agentPath,
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toAgentJson(
  instance: AgentInstance,
  bindings?: TurnBindings,
): AgentJson {
  const runtime = bindings?.runtimeConfig.value
    ?? instance.runtimeConfig.current().value;
  return deepMerge(
    deepMerge(
      AGENT_DEFAULTS as unknown as Record<string, unknown>,
      instance.template.configuration ?? {},
    ),
    runtime as unknown as Record<string, unknown>,
  ) as unknown as AgentJson;
}

function toTurnEvent(input: unknown, target: string): Event {
  if (isEvent(input)) {
    return {
      ...input,
      to: target,
    };
  }
  const content = typeof input === "string"
    ? input
    : JSON.stringify(input ?? "");
  return {
    source: "runtime",
    type: "user_input",
    payload: { content },
    to: target,
    handoff: "turn",
    ts: Date.now(),
  };
}

function isEvent(value: unknown): value is Event {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Event>;
  return typeof candidate.type === "string"
    && typeof candidate.source === "string"
    && typeof candidate.ts === "number"
    && Boolean(candidate.payload && typeof candidate.payload === "object");
}

function isRuntimeTurnBatch(value: unknown): value is RuntimeTurnBatch {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "runtime-turn-batch" &&
      Array.isArray((value as { inputs?: unknown }).inputs),
  );
}

/**
 * Coalesce window may gather several inbound events into one
 * `runtime-turn-batch`. Mirror the old ConsciousAgent drain semantics: merge
 * every non-silent payload's content / attachments / replyLanguage into one
 * synthetic user_input. `agent_command` remains a separate controller turn;
 * silent-only batches fall through to the last input.
 */
function mergeTurnInputs(inputs: readonly unknown[]): unknown {
  const events = inputs.filter(isEvent);
  const triggers = events.filter((event) => event.handoff !== "silent");
  const source = triggers.length > 0 ? triggers : events;
  if (source.length === 0) return inputs.at(-1) ?? "";
  if (source.length === 1) return source[0];
  if (source.some((event) => event.type === "agent_command")) {
    throw new Error(
      "agent_command cannot be coalesced into a runtime user-input batch",
    );
  }

  const contents: string[] = [];
  const attachments: Array<Record<string, unknown>> = [];
  let replyLanguage: "en" | "zh" | undefined;
  let traceparent: string | undefined;
  let originAgent: unknown;
  let delegatedBy: unknown;
  let last = source[source.length - 1]!;

  for (const event of source) {
    last = event;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const content =
      typeof payload.contextContent === "string"
        ? payload.contextContent
        : typeof payload.content === "string"
          ? payload.content
          : payload.content !== undefined
            ? JSON.stringify(payload.content)
            : "";
    if (content.trim()) contents.push(content);
    if (Array.isArray(payload.attachments)) {
      for (const item of payload.attachments) {
        if (item && typeof item === "object") {
          attachments.push(item as Record<string, unknown>);
        }
      }
    }
    if (payload.replyLanguage === "en" || payload.replyLanguage === "zh") {
      replyLanguage = payload.replyLanguage;
    }
    if (typeof payload.traceparent === "string" && payload.traceparent.trim()) {
      traceparent = payload.traceparent;
    }
    if (payload.originAgent !== undefined) originAgent = payload.originAgent;
    if (payload.delegatedBy !== undefined) delegatedBy = payload.delegatedBy;
  }

  return {
    ...last,
    type: "user_input",
    handoff: "turn",
    payload: {
      ...(typeof last.payload === "object" && last.payload ? last.payload : {}),
      content: contents.join("\n\n"),
      ...(attachments.length ? { attachments } : {}),
      ...(replyLanguage ? { replyLanguage } : {}),
      ...(traceparent ? { traceparent } : {}),
      ...(originAgent !== undefined ? { originAgent } : {}),
      ...(delegatedBy !== undefined ? { delegatedBy } : {}),
    },
  };
}
