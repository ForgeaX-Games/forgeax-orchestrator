import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AgentTemplateCatalog } from "../agents/agent-template-catalog";
import type { ResidentIdentity } from "../agents/resident-definition-store";
import type { FrozenAgentTemplate } from "../agents/template-types";
import { EventStore } from "../ledger/event-store";
import { SessionEventPaths } from "../ledger/session-event-paths";
import type {
  InstanceEventBinding,
} from "../ledger/types";
import { cloneAndFreeze, stableHash } from "./freeze";
import type {
  AgentTemplateLocator,
  MemoryTemplateRegistry,
} from "./agent-template-locator";
import { AgentExecutionBinding } from "./agent-execution";
import {
  AgentRuntimeController,
  type AgentTurnExecutor,
} from "./agent-runtime-controller";
import { AgentRegistrationPolicy } from "./agent-registration-policy";
import {
  RuntimeConfigBinding,
  type RuntimeConfig,
} from "./runtime-config";
import type {
  AgentInstance,
  AgentLifetime,
} from "./types";
import { RuntimeTree } from "./runtime-tree";
import type { AgentRuntimeContext } from "./runtime-context";
import { RuntimeEventFactory } from "./runtime-event-factory";

export type AgentRegistrationTrigger = "bootstrap" | "runtime";

export interface RegisterAgentRequest {
  readonly locator: AgentTemplateLocator;
  readonly lifetime: AgentLifetime;
  readonly parentId: string | null;
  readonly trigger: AgentRegistrationTrigger;
  readonly residentIdentity?: ResidentIdentity;
  readonly runtimeConfigPatch?: Partial<RuntimeConfig>;
  readonly runtime: Omit<AgentRuntimeContext, "runtimeStateRoot"> & {
    readonly runtimeStateRoot?: string;
  };
}

export interface RegisteredAgent {
  readonly instance: AgentInstance;
  readonly controller: AgentRuntimeController;
  readonly eventStore: EventStore;
}

export type EventStoreFactory = (
  binding: InstanceEventBinding,
  paths: ReturnType<SessionEventPaths["resolve"]>,
) => EventStore;

export class AgentRegistrar {
  constructor(
    private readonly sid: string,
    private readonly catalog: AgentTemplateCatalog,
    private readonly memoryTemplates: MemoryTemplateRegistry,
    private readonly tree: RuntimeTree,
    private readonly eventPaths: SessionEventPaths,
    private readonly executorFactory: (
      instance: AgentInstance,
      eventStore: EventStore,
    ) => AgentTurnExecutor,
    private readonly policy = new AgentRegistrationPolicy(),
    private readonly eventStoreFactory: EventStoreFactory = (binding, paths) =>
      new EventStore(binding, paths),
    readonly eventFactory = new RuntimeEventFactory(sid),
  ) {}

  async register(request: RegisterAgentRequest): Promise<RegisteredAgent> {
    this.policy.assertAllowed(request);
    if (request.parentId && !this.tree.get(request.parentId)) {
      throw new Error(`Agent registration parent not found: ${request.parentId}`);
    }
    const template = await this.resolveTemplate(request.locator);
    const instanceId = request.residentIdentity?.instanceId ?? newEphemeralId();
    const runtimeEpochId = `epoch_${randomUUID().replaceAll("-", "")}`;
    const locator = request.lifetime === "resident"
      ? this.eventPaths.resident(request.residentIdentity!.logicalPath)
      : this.eventPaths.ephemeral(instanceId);
    const binding: InstanceEventBinding = Object.freeze({
      ownerInstanceId: instanceId,
      runtimeEpochId,
      storeId: `store_${stableHash({ sid: this.sid, instanceId })}`,
      locator,
    });
    const resolvedPaths = this.eventPaths.resolve(locator);
    const eventStore = this.eventStoreFactory(binding, resolvedPaths);
    const instance = this.createInstance(
      request,
      template,
      instanceId,
      runtimeEpochId,
      binding,
    );

    try {
      await eventStore.append(
        this.eventFactory.agent(instance, "agent.registered", {
          parentInstanceId: request.parentId,
          templateRef: template.templateRef,
          displayName: template.definition.displayName ?? template.definition.id,
          lifetime: request.lifetime,
          createdAt: instance.createdAt,
          definitionRevision: template.definitionRevision,
          runtimeConfigRevision: instance.runtimeConfig.current().revision,
          agentExecutionRevision: template.execution.revision,
        }),
        "required",
      );
    } catch (error) {
      eventStore.dispose();
      throw error;
    }

    let controller: AgentRuntimeController;
    try {
      controller = new AgentRuntimeController(
        instance,
        this.executorFactory(instance, eventStore),
      );
      controller.start();
      this.tree.insert(instance);
    } catch (error) {
      await eventStore.append(
        this.eventFactory.agent(instance, "agent.registration_failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "required",
      );
      await eventStore.flush();
      eventStore.dispose();
      throw error;
    }
    return Object.freeze({ instance, controller, eventStore });
  }

  private async resolveTemplate(
    locator: AgentTemplateLocator,
  ): Promise<FrozenAgentTemplate> {
    if (locator.medium === "memory") {
      return this.memoryTemplates.resolve(locator);
    }
    const descriptor = this.catalog.get(locator.templateRef);
    if (!descriptor || descriptor.locator.medium !== "filesystem") {
      throw new Error(`filesystem templateRef not registered: ${locator.templateRef}`);
    }
    if (realpathSync(locator.root) !== descriptor.locator.root) {
      throw new Error(`filesystem template root mismatch: ${locator.templateRef}`);
    }
    const template = await this.catalog.resolve(locator.templateRef);
    if (template.definitionRevision !== locator.expectedSourceRevision) {
      throw new Error(`filesystem template revision mismatch: ${locator.templateRef}`);
    }
    return template;
  }

  private createInstance(
    request: RegisterAgentRequest,
    template: FrozenAgentTemplate,
    instanceId: string,
    runtimeEpochId: string,
    binding: InstanceEventBinding,
  ): AgentInstance {
    const configValue = cloneAndFreeze({
      ...template.runtimeConfigDefaults,
      ...(request.runtimeConfigPatch ?? {}),
    });
    const configRevision = `cfg_${stableHash(configValue)}`;
    return {
      sid: this.sid,
      instanceId,
      runtimeEpochId,
      templateRef: template.templateRef,
      parentInstanceId: request.parentId,
      lifetime: request.lifetime,
      ...(request.residentIdentity
        ? { residentPath: request.residentIdentity.logicalPath }
        : {}),
      template,
      runtime: Object.freeze({
        ...request.runtime,
        runtimeStateRoot:
          request.runtime.runtimeStateRoot ??
          this.eventPaths.runtimeStateRoot(instanceId),
      }),
      runtimeConfig: new RuntimeConfigBinding({
        revision: configRevision,
        value: configValue,
      }),
      execution: new AgentExecutionBinding(template.execution),
      events: binding,
      createdAt: Date.now(),
      state: "registered",
    };
  }

}

function newEphemeralId(): string {
  return `eph_${randomUUID().replaceAll("-", "")}`;
}
