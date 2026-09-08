import type { SourceRef } from "./source-ref";
import type {
  TemplateProvenance,
  TemplateRegistrationLifetime,
  TemplateRevisionPolicy,
  TemplateScope,
  TemplateSourceLocator,
  TemplateTrust,
} from "./template-source-locator";
import type { RuntimeConfig } from "../runtime/runtime-config";

export type TemplateRef = string;
export type AgentDefinitionRevision = string;
export type AgentExecutionRevision = string;

export interface AgentDefinition {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly kernelId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResolvedSkillSource {
  readonly id: string;
  readonly source: SourceRef;
  readonly description?: string;
  readonly executor?: "prompt" | "typescript" | "python";
}

export interface KitSourceRef {
  readonly id: string;
  readonly source: SourceRef;
}

export interface AgentTemplateResourceSet {
  readonly templateRoot?: string;
  readonly persona?: SourceRef;
  readonly skills: readonly ResolvedSkillSource[];
  readonly kits: readonly KitSourceRef[];
  readonly memorySeeds: readonly SourceRef[];
}

export interface AgentExecutionSnapshot {
  readonly revision: AgentExecutionRevision;
  readonly persona?: SourceRef;
  readonly skills: readonly ResolvedSkillSource[];
  readonly kits: readonly KitSourceRef[];
}

export interface AgentTemplateDraft {
  readonly definition: AgentDefinition;
  /** Full author config retained for compatibility fields such as kits policy. */
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly runtimeConfigDefaults: RuntimeConfig;
  readonly resources: AgentTemplateResourceSet;
}

export interface FrozenAgentTemplate extends AgentTemplateDraft {
  readonly templateRef: TemplateRef;
  readonly definitionRevision: AgentDefinitionRevision;
  readonly execution: AgentExecutionSnapshot;
}

export interface TemplateCatalogEntry {
  readonly templateRef: TemplateRef;
  readonly entryId: string;
  readonly locator: TemplateSourceLocator;
  readonly scope: TemplateScope;
  readonly registrationLifetime: TemplateRegistrationLifetime;
  readonly trust: TemplateTrust;
  readonly provenance: TemplateProvenance;
  readonly revisionPolicy: TemplateRevisionPolicy;
}
