import { AgentTemplateCatalog } from "./agent-template-catalog";
import { FileSystemTemplateSource } from "./filesystem-template-source";
import type { TemplateRef } from "./template-types";
import type {
  ResidentDefinition,
  ResidentDefinitionStore,
} from "./resident-definition-store";
import type { FileSystemLocator } from "../runtime/agent-template-locator";
import { ensureResidentTrust } from "./resident-trust";
import { synchronizeResidentExternalSkillSources } from "./extension-template-adapter";

export interface RegisteredResidentDefinition {
  readonly definition: ResidentDefinition;
  readonly templateRef: TemplateRef;
  readonly locator: FileSystemLocator;
}

/** Bridges one resident's filesystem identity into the otherwise
 *  source-neutral Catalog. Shared by bootstrap (`registerResidentDefinitions`,
 *  scans the whole `agents/` tree) and dynamic runtime materialization
 *  (`Session.ensureResidentAgent`, registers exactly one freshly-scaffolded
 *  definition without touching the others). */
export async function registerResidentDefinition(
  catalog: AgentTemplateCatalog,
  sid: string,
  definition: ResidentDefinition,
): Promise<RegisteredResidentDefinition> {
  await synchronizeResidentExternalSkillSources(definition);
  const source = new FileSystemTemplateSource({
    sourceId: `resident:${sid}:${definition.logicalPath}`,
    root: definition.templateRoot,
  });
  const trust = await ensureResidentTrust(definition);
  const templateRef = catalog.register({
    entryId: definition.logicalPath,
    source,
    scope: { kind: "session", sid },
    registrationLifetime: "session",
    trust,
    provenance: {
      adapter: "resident-scanner",
      externalId: definition.logicalPath,
    },
    revisionPolicy: { kind: "explicit" },
  });
  const template = await catalog.resolve(templateRef);
  return Object.freeze({
    definition,
    templateRef,
    locator: Object.freeze({
      medium: "filesystem" as const,
      templateRef,
      root: definition.templateRoot,
      expectedSourceRevision: template.definitionRevision,
    }),
  });
}

/** Bridges bootstrap filesystem identity into the otherwise source-neutral Catalog. */
export async function registerResidentDefinitions(
  catalog: AgentTemplateCatalog,
  store: ResidentDefinitionStore,
): Promise<readonly RegisteredResidentDefinition[]> {
  return Promise.all(
    store.list().map((definition) => registerResidentDefinition(catalog, store.sid, definition)),
  );
}
