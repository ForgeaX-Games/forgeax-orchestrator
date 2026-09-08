import { randomUUID } from "node:crypto";
import type { AgentTemplateCatalog } from "../agents/agent-template-catalog";
import type { TemplateRef } from "../agents/template-types";
import type { RegisteredAgent } from "./agent-registrar";
import { AgentRegistrar } from "./agent-registrar";
import type { MemoryTemplateRegistry } from "./agent-template-locator";
import type { RuntimeConfig } from "./runtime-config";

export interface SpawnEphemeralRequest {
  readonly parentInstanceId: string | null;
  readonly templateRef: TemplateRef;
  readonly runtimeConfigPatch?: Partial<RuntimeConfig>;
}

export interface SpawnedEphemeralRegistration extends RegisteredAgent {
  readonly memoryRegistrationId: string;
}

/**
 * Resolves an author-facing Catalog reference into an immutable, runtime-only
 * MemoryLocator. The live instance never reads the author filesystem again.
 */
export class EphemeralAgentSpawner {
  constructor(
    private readonly catalog: AgentTemplateCatalog,
    private readonly memoryTemplates: MemoryTemplateRegistry,
    private readonly registrar: AgentRegistrar,
    private readonly workspaceRoot: string,
  ) {}

  async register(
    request: SpawnEphemeralRequest,
  ): Promise<SpawnedEphemeralRegistration> {
    const snapshot = await this.catalog.resolve(request.templateRef);
    const locator = this.memoryTemplates.register(snapshot);
    try {
      const registered = await this.registrar.register({
        locator,
        lifetime: "ephemeral",
        parentId: request.parentInstanceId,
        trigger: "runtime",
        ...(request.runtimeConfigPatch
          ? { runtimeConfigPatch: request.runtimeConfigPatch }
          : {}),
        runtime: {
          workspaceRoot: this.workspaceRoot,
          runtimeStateRef: `memory:agent:${randomUUID()}`,
          ...(snapshot.resources.templateRoot
            ? { templateRoot: snapshot.resources.templateRoot }
            : {}),
        },
      });
      return Object.freeze({
        ...registered,
        memoryRegistrationId: locator.registrationId,
      });
    } catch (error) {
      this.memoryTemplates.unregister(locator.registrationId);
      throw error;
    }
  }
}
