import type {
  FrozenAgentTemplate,
  TemplateRef,
} from "../agents/template-types";

export interface FileSystemLocator {
  readonly medium: "filesystem";
  readonly templateRef: TemplateRef;
  readonly root: string;
  readonly expectedSourceRevision: string;
}

export interface MemoryLocator {
  readonly medium: "memory";
  readonly registrationId: string;
  readonly templateRef: TemplateRef;
  readonly expectedSourceRevision: string;
}

export type AgentTemplateLocator = FileSystemLocator | MemoryLocator;

export class MemoryTemplateRegistry {
  private readonly snapshots = new Map<string, FrozenAgentTemplate>();

  register(snapshot: FrozenAgentTemplate): MemoryLocator {
    const registrationId = crypto.randomUUID();
    this.snapshots.set(registrationId, snapshot);
    return Object.freeze({
      medium: "memory",
      registrationId,
      templateRef: snapshot.templateRef,
      expectedSourceRevision: snapshot.definitionRevision,
    });
  }

  resolve(locator: MemoryLocator): FrozenAgentTemplate {
    const snapshot = this.snapshots.get(locator.registrationId);
    if (!snapshot || snapshot.templateRef !== locator.templateRef) {
      throw new Error(`memory template registration not found: ${locator.registrationId}`);
    }
    if (snapshot.definitionRevision !== locator.expectedSourceRevision) {
      throw new Error(`memory template revision mismatch: ${locator.templateRef}`);
    }
    return snapshot;
  }

  unregister(registrationId: string): boolean {
    return this.snapshots.delete(registrationId);
  }

  clear(): void {
    this.snapshots.clear();
  }
}
