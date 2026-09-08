import type { AgentTemplateDraft } from "./template-types";
import type { TemplateSourceLocator } from "./template-source-locator";

export interface AgentTemplateSource {
  readonly locator: TemplateSourceLocator;
  load(entryId: string): Promise<AgentTemplateDraft>;
  has?(entryId: string): boolean;
}
