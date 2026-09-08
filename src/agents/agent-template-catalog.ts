import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { cloneAndFreeze, stableHash } from "../runtime/freeze";
import type { SourceRef } from "./source-ref";
import type { AgentTemplateSource } from "./template-source";
import type {
  AgentTemplateResourceSet,
  FrozenAgentTemplate,
  ResolvedSkillSource,
  TemplateCatalogEntry,
  TemplateRef,
} from "./template-types";
import type {
  TemplateProvenance,
  TemplateRegistrationLifetime,
  TemplateRevisionPolicy,
  TemplateScope,
  TemplateTrust,
} from "./template-source-locator";

export interface RegisterTemplateInput {
  readonly entryId: string;
  readonly source: AgentTemplateSource;
  readonly scope: TemplateScope;
  readonly registrationLifetime: TemplateRegistrationLifetime;
  readonly trust: TemplateTrust;
  readonly provenance: TemplateProvenance;
  readonly revisionPolicy: TemplateRevisionPolicy;
}

interface InternalEntry {
  readonly descriptor: TemplateCatalogEntry;
  readonly source: AgentTemplateSource;
}

export class AgentTemplateCatalog {
  private readonly entries = new Map<TemplateRef, InternalEntry>();

  register(input: RegisterTemplateInput): TemplateRef {
    const entryId = requireEntryId(input.entryId);
    const templateRef = makeTemplateRef(input.source.locator.sourceId, entryId);
    const descriptor = cloneAndFreeze<TemplateCatalogEntry>({
      templateRef,
      entryId,
      locator: input.source.locator,
      scope: input.scope,
      registrationLifetime: input.registrationLifetime,
      trust: input.trust,
      provenance: input.provenance,
      revisionPolicy: input.revisionPolicy,
    });
    const existing = this.entries.get(templateRef);
    if (existing) {
      if (stableHash(existing.descriptor) !== stableHash(descriptor)) {
        throw new Error(`templateRef collision with different registration: ${templateRef}`);
      }
      return templateRef;
    }
    if (input.source.has && !input.source.has(entryId)) {
      throw new Error(`template source entry not found: ${entryId}`);
    }
    this.entries.set(templateRef, { descriptor, source: input.source });
    return templateRef;
  }

  unregister(templateRef: TemplateRef): boolean {
    return this.entries.delete(templateRef);
  }

  unregisterByLifetime(lifetime: TemplateRegistrationLifetime): number {
    let removed = 0;
    for (const [templateRef, entry] of this.entries) {
      if (entry.descriptor.registrationLifetime !== lifetime) continue;
      this.entries.delete(templateRef);
      removed++;
    }
    return removed;
  }

  get(templateRef: TemplateRef): TemplateCatalogEntry | undefined {
    return this.entries.get(templateRef)?.descriptor;
  }

  list(): readonly TemplateCatalogEntry[] {
    return [...this.entries.values()]
      .map((entry) => entry.descriptor)
      .sort((a, b) => a.templateRef.localeCompare(b.templateRef));
  }

  async resolve(templateRef: TemplateRef): Promise<FrozenAgentTemplate> {
    const entry = this.entries.get(templateRef);
    if (!entry) throw new Error(`unknown templateRef: ${templateRef}`);
    const draft = await entry.source.load(entry.descriptor.entryId);
    validateDraft(draft, entry.descriptor.entryId);
    const resources = await snapshotTextResources(draft.resources);
    const definitionRevision = `def_${stableHash({
      definition: draft.definition,
      configuration: draft.configuration,
      runtimeConfigDefaults: draft.runtimeConfigDefaults,
    })}`;
    const executionRevision = `exec_${stableHash({
      persona: resources.persona,
      skills: resources.skills,
      kits: resources.kits,
      memorySeeds: resources.memorySeeds,
    })}`;
    return cloneAndFreeze<FrozenAgentTemplate>({
      templateRef,
      definitionRevision,
      definition: draft.definition,
      ...(draft.configuration ? { configuration: draft.configuration } : {}),
      runtimeConfigDefaults: draft.runtimeConfigDefaults,
      resources,
      execution: {
        revision: executionRevision,
        ...(resources.persona
          ? { persona: resources.persona }
          : {}),
        skills: resources.skills,
        kits: resources.kits,
      },
    }) as FrozenAgentTemplate;
  }
}

/** Capture model-visible text at the Catalog boundary.
 *
 * A FrozenAgentTemplate must freeze bytes, not merely absolute paths. Persona,
 * skills and memory therefore become inline snapshots, so a later file edit
 * cannot mutate an existing revision. Any unreadable declared source rejects
 * the candidate revision, allowing callers to keep their last-known-good
 * template. */
async function snapshotTextResources(
  resources: AgentTemplateResourceSet,
): Promise<AgentTemplateResourceSet> {
  const persona = resources.persona
    ? await snapshotTextSource(resources.persona, "persona")
    : undefined;
  const skills = await Promise.all(
    resources.skills.map(snapshotSkillSource),
  );
  const memorySeeds = await Promise.all(
    resources.memorySeeds.map((source, index) =>
      snapshotTextSource(source, `memory seed ${index + 1}`),
    ),
  );
  return {
    ...(resources.templateRoot
      ? { templateRoot: resources.templateRoot }
      : {}),
    ...(persona ? { persona } : {}),
    skills,
    kits: resources.kits,
    memorySeeds,
  };
}

async function snapshotSkillSource(
  skill: ResolvedSkillSource,
): Promise<ResolvedSkillSource> {
  const bytes = await readTextSource(skill.source, `skill "${skill.id}"`);
  return {
    ...skill,
    source: inlineSource(bytes, skill.source),
  };
}

async function snapshotTextSource(
  source: SourceRef,
  label: string,
): Promise<SourceRef> {
  const bytes = await readTextSource(source, label);
  return inlineSource(bytes, source);
}

async function readTextSource(
  source: SourceRef,
  label: string,
): Promise<string> {
  if (source.kind === "inline") return source.text;
  if (source.kind === "file") {
    try {
      return await readFile(source.path, "utf8");
    } catch (error) {
      throw new Error(
        `template ${label} is unreadable (${source.path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  throw new Error(`template ${label} must be a text source, got ${source.kind}`);
}

function inlineSource(text: string, original: SourceRef): SourceRef {
  const label =
    original.kind === "file"
      ? basename(original.path)
      : original.kind === "inline"
        ? original.label
        : undefined;
  return {
    kind: "inline",
    text,
    ...(label ? { label } : {}),
  };
}

/** Runtime authorization lookup over the Catalog's narrow read API.
 *  Missing registrations fail closed without requiring callers/tests to hold
 *  the concrete Catalog class. */
export function resolveTemplateTrust(
  catalog: Pick<AgentTemplateCatalog, "get">,
  templateRef: TemplateRef,
): TemplateTrust {
  return catalog.get(templateRef)?.trust === "own" ? "own" : "imported";
}

export function makeTemplateRef(sourceId: string, entryId: string): TemplateRef {
  return `tpl_${stableHash({
    namespace: "forgeax:agent-template:v1",
    sourceId,
    entryId,
  })}`;
}

function requireEntryId(entryId: string): string {
  const value = entryId.trim();
  if (!value) throw new Error("template entryId may not be empty");
  return value;
}

function validateDraft(
  draft: Awaited<ReturnType<AgentTemplateSource["load"]>>,
  entryId: string,
): void {
  if (!draft.definition?.id?.trim()) {
    throw new Error(`template definition id missing: ${entryId}`);
  }
  if (!Array.isArray(draft.resources?.skills)) {
    throw new Error(`template skills must be an array: ${entryId}`);
  }
  if (!Array.isArray(draft.resources?.kits)) {
    throw new Error(`template kits must be an array: ${entryId}`);
  }
  if (!Array.isArray(draft.resources?.memorySeeds)) {
    throw new Error(`template memorySeeds must be an array: ${entryId}`);
  }
}
