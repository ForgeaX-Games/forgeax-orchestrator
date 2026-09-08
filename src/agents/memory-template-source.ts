import { cloneAndFreeze } from "../runtime/freeze";
import type { AgentTemplateDraft } from "./template-types";
import type { AgentTemplateSource } from "./template-source";
import type { TemplateSourceLocator } from "./template-source-locator";

export interface MemoryTemplateSourceOptions {
  readonly sourceId: string;
  readonly templates: Readonly<Record<string, AgentTemplateDraft>>;
}

export class MemoryTemplateSource implements AgentTemplateSource {
  readonly locator: Extract<TemplateSourceLocator, { medium: "memory" }>;
  private readonly templates: Readonly<Record<string, Readonly<AgentTemplateDraft>>>;

  constructor(options: MemoryTemplateSourceOptions) {
    if (!options.sourceId.trim()) throw new Error("template sourceId may not be empty");
    this.locator = Object.freeze({
      medium: "memory",
      sourceId: options.sourceId,
    });
    this.templates = cloneAndFreeze(options.templates);
  }

  has(entryId: string): boolean {
    return Object.hasOwn(this.templates, entryId);
  }

  async load(entryId: string): Promise<AgentTemplateDraft> {
    const draft = this.templates[entryId];
    if (!draft) throw new Error(`memory template entry not found: ${entryId}`);
    return structuredClone(draft) as AgentTemplateDraft;
  }
}
