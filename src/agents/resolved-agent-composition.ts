import type { ToolSpec, TrustTier } from "@forgeax/agent-runtime";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SourceRef } from "./source-ref";
import type {
  FrozenAgentTemplate,
  ResolvedSkillSource,
} from "./template-types";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import {
  composeStableMemory,
  layeredMemoryForAgent,
  loadAgentRecord,
  loadNativeSoulOverlay,
} from "../soul";
import type {
  AgentRecord,
  LayeredMemoryRef,
  SkillRefLite,
} from "../soul/types";
import type { SystemBlock } from "../llm/types";
import type { RuntimeConfig } from "../runtime/runtime-config";

export interface ResolveAgentCompositionInput {
  readonly agentId: string;
  readonly projectRoot: string;
  readonly game?: string;
  readonly template?: FrozenAgentTemplate;
  /** Current turn snapshot, including runtime overrides of template defaults. */
  readonly runtimeConfig?: Readonly<RuntimeConfig>;
  /** RuntimeAgentHost 已按当前 execution revision 解析的 Kit slots。 */
  readonly kitSystemBlocks?: readonly SystemBlock[];
}

/** The only model-visible Agent content consumed by composeTurnRequest. */
export interface ResolvedAgentComposition {
  readonly persona: string;
  readonly tools: readonly ToolSpec[];
  readonly memory: LayeredMemoryRef;
  readonly trustFallback: TrustTier;
  readonly dynamicPrompt?: string;
  readonly promptMode?: "append" | "replace";
  readonly toolPolicy?: { allow?: string[]; deny?: string[] };
  readonly budget?: { maxTurns?: number; maxBudgetUsd?: number };
}

/**
 * Resolve one complete Agent composition.
 *
 * Live Runtime instances take their base content exclusively from the frozen
 * template. A real native soul-pack may overlay it. A soul miss is empty and
 * never falls through to extension synthesis. Callers without a Runtime
 * template use the legacy record as one exclusive compatibility source.
 */
export async function resolveAgentComposition(
  input: ResolveAgentCompositionInput,
): Promise<ResolvedAgentComposition> {
  const loadOptions = {
    projectRoot: input.projectRoot,
    ...(input.game ? { game: input.game } : {}),
  };
  if (!input.template) {
    const record = await loadAgentRecord(input.agentId, loadOptions);
    return compositionFromLegacyRecord(record);
  }

  const maxIterations = (input.runtimeConfig ?? input.template.runtimeConfigDefaults).maxIterations;
  // Invalid limits must not reach kernels where zero/negative values skip the
  // loop entirely. Absent limits retain the kernel's existing default.
  const maxTurns = typeof maxIterations === "number"
      && Number.isSafeInteger(maxIterations) && maxIterations > 0
    ? maxIterations
    : undefined;
  const definitionId = input.template.definition.id;
  const overlay = await loadNativeSoulOverlay(definitionId, loadOptions);
  // A native soul overlay replaces only fields it declares. A dollar-only
  // budget must not erase the resident's iteration ceiling.
  const budget = {
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...overlay?.budget,
  };
  const memory =
    overlay?.memory ?? layeredMemoryForAgent(definitionId, loadOptions);
  const templatePrompt = await materializeTemplatePrompt(input.template);
  const stableKitPrompt = blocksText(input.kitSystemBlocks, "stable");
  const dynamicKitPrompt = blocksText(input.kitSystemBlocks, "dynamic");
  const persona = joinPromptFragments([
    templatePrompt,
    overlay?.persona,
    composeStableMemory(memory),
    stableKitPrompt,
  ]);
  return {
    persona,
    tools: [
      ...(overlay?.tools ?? []),
      ...soulSkillsToToolSpecs(overlay?.skills ?? []),
    ],
    memory,
    trustFallback: overlay?.trustTier ?? "imported",
    ...(dynamicKitPrompt ? { dynamicPrompt: dynamicKitPrompt } : {}),
    ...(overlay?.promptMode ? { promptMode: overlay.promptMode } : {}),
    ...(overlay?.toolPolicy ? { toolPolicy: overlay.toolPolicy } : {}),
    ...(Object.keys(budget).length ? { budget } : {}),
  };
}

function blocksText(
  blocks: readonly SystemBlock[] | undefined,
  cacheHint: "stable" | "dynamic",
): string {
  return (blocks ?? [])
    .filter((block) => (block.cacheHint ?? "dynamic") === cacheHint)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function compositionFromLegacyRecord(
  record: AgentRecord,
): ResolvedAgentComposition {
  return {
    persona: joinPromptFragments([
      record.persona,
      composeStableMemory(record.memory),
    ]),
    tools: [
      ...(record.tools ?? []),
      ...soulSkillsToToolSpecs(record.skills ?? []),
    ],
    memory: record.memory,
    trustFallback: record.trustTier,
    ...(record.promptMode ? { promptMode: record.promptMode } : {}),
    ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
    ...(record.budget ? { budget: record.budget } : {}),
  };
}

async function materializeTemplatePrompt(
  template: FrozenAgentTemplate,
): Promise<string> {
  const persona = await readTextSource(template.execution.persona);
  const skillIndex: string[] = [];
  const promptSkills: string[] = [];
  for (const skill of template.execution.skills) {
    const executor = skill.executor ?? "prompt";
    skillIndex.push(
      `- \`${skill.id}\` (${displayExecutor(executor)})${
        skill.description?.trim() ? ` — ${skill.description.trim()}` : ""
      }`,
    );
    if (executor !== "prompt") continue;
    const raw = await readTextSource(skill.source);
    if (!raw.trim()) continue;
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed.body.trim()) continue;
    promptSkills.push(`## Skill: ${skill.id}\n\n${parsed.body.trim()}`);
  }
  const skillIndexBlock = skillIndex.length
    ? [
        "# Your Skills",
        "",
        ...skillIndex,
        "",
        "Prompt skills are inlined below. Executable ts/py skill invocation is unavailable in this runtime.",
      ].join("\n")
    : "";
  const memorySections: string[] = [];
  for (const [index, source] of template.resources.memorySeeds.entries()) {
    const body = await readTextSource(source);
    if (!body.trim()) continue;
    memorySections.push(
      `## ${sourceLabel(source, index)}\n\n${body.trim()}`,
    );
  }
  const memoryBlock = memorySections.length
    ? `# Long-term Memory\n\n${memorySections.join("\n\n")}`
    : "";
  return joinPromptFragments([
    persona,
    skillIndexBlock,
    promptSkills.join("\n\n"),
    memoryBlock,
  ]);
}

function soulSkillsToToolSpecs(
  skills: readonly SkillRefLite[],
): ToolSpec[] {
  return skills
    .filter((skill) => skill?.skillId?.trim())
    .map((skill) => ({
      name: `skill_${sanitizeSkillId(skill.skillId)}`,
      description:
        skill.description?.trim() ||
        `Invoke the "${skill.skillId}" skill (${skill.kind}).`,
      inputSchema: {
        type: "object",
        properties: { args: { type: "string" } },
      },
    }));
}

async function readTextSource(source: SourceRef | undefined): Promise<string> {
  if (!source) return "";
  if (source.kind === "inline") return source.text;
  if (source.kind !== "file") return "";
  try {
    return await readFile(source.path, "utf8");
  } catch {
    return "";
  }
}

function sourceLabel(source: SourceRef, index: number): string {
  return source.kind === "file"
    ? basename(source.path)
    : source.kind === "inline" && source.label
      ? source.label
    : `memory-${index + 1}.md`;
}

function displayExecutor(
  executor: NonNullable<ResolvedSkillSource["executor"]>,
): string {
  if (executor === "typescript") return "ts";
  if (executor === "python") return "py";
  return "prompt";
}

function joinPromptFragments(
  fragments: ReadonlyArray<string | undefined>,
): string {
  return fragments
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .join("\n\n---\n\n");
}

function sanitizeSkillId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
