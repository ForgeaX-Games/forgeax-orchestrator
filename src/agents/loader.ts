/**
 * Phase B5 — AgentLoader (minimal).
 *
 * Reads the kind registry built in B2/B3 and exposes:
 *   - listAgents()              — directory of registered agents
 *   - lookupAgent(id)           — by agent.id (e.g. "cc-coder")
 *   - resolveSkill(ref)         — turn a SkillRef into a SkillEntry
 *   - composeSystemPrompt(id)   — persona md + (optional) default skill
 *                                 prompt sections, per agent
 *
 * Skill execution still lives in Phase D (SkillRunner). Today this loader
 * is consulted by the chat boot path so the right system prompt lands in
 * the LLM call regardless of which CLI provider drives the conversation.
 *
 * See docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.2/§2.3.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import type { SkillRef } from '@forgeax/types';
import { pickI18n } from '@forgeax/types';
import type { AgentEntry, SkillEntry } from '../extensions/kinds';
import { getExtensionSnapshot } from '../extensions/registry';
import { loadBrand } from '../brand';
import {
  memLangFromPersonaFile,
  pickMemoryFilesForLang,
  type MemLang,
} from './memory-locale';
import { parseSkillFrontmatter } from './skill-frontmatter';

export { parseSkillFrontmatter } from './skill-frontmatter';

export interface ComposedSystemPrompt {
  agentId: string;
  extensionId: string;
  persona: string;
  /** Concatenated `## Skill: <id>\n<body>` blocks for prompt-kind skills only. */
  skillSections: Array<{ skillId: string; extensionId: string; body: string }>;
  /** Per-agent skill index — every defaultSkills entry surfaced as `name —
   *  description`, regardless of entry kind. Prompt-kind skills additionally
   *  show up inline in `skillSections` (full body); ts/py-kind skills only
   *  appear here so the agent knows the tool exists. */
  skillIndex: Array<{ skillId: string; extensionId: string; kind: string; description: string }>;
  /** Concatenated memory file contents (every *.md under AgentDefinition.memoryDir),
   *  keyed by file basename so the LLM can cite which file it's quoting from. */
  memorySections: Array<{ file: string; body: string }>;
  /** Combined string (persona + skill index + skills + memory). */
  text: string;
  warnings: string[];
}

export interface ResolvedExternalSkillSource {
  id: string;
  path: string;
  description?: string;
  executor: 'prompt' | 'typescript' | 'python';
}

export interface ResolvedExternalAgentTemplate {
  personaPath: string;
  /** Absolute path to author-provided memory seeds, when present. */
  memoryDir?: string;
  /** Concrete sources for the Agent's declared default skills. */
  skillSources: ResolvedExternalSkillSource[];
  /** Host tool allow-list carried by the external Agent definition. */
  tools?: string[];
  source: 'plugin' | 'brand';
  origin?: AgentEntry['origin'];
  trustTier: 'own' | 'imported';
}

export function listAgents(): AgentEntry[] {
  return getExtensionSnapshot().kinds.agents.slice();
}

export function lookupAgent(agentId: string): AgentEntry | null {
  const snap = getExtensionSnapshot();
  return snap.kinds.agents.find((a) => a.definition.id === agentId) ?? null;
}

/** Return the skill registry entry that a SkillRef points at, or null
 *  if the ref doesn't resolve. inline-source refs only match within the
 *  same plugin (B5 enforces the simple cases; the cross-plugin
 *  `@scope/name#skillId` form lands when SkillRunner gets implemented). */
export function resolveSkill(
  ref: SkillRef,
  contextPluginId?: string,
): SkillEntry | null {
  const snap = getExtensionSnapshot();
  if (ref.source === 'plugin') {
    return snap.kinds.skills.find(
      (s) => s.extensionId === ref.pluginId && (!ref.skillId || s.definition.id === ref.skillId),
    ) ?? null;
  }
  // inline: same plugin as caller
  if (!contextPluginId) return null;
  return snap.kinds.skills.find(
    (s) => s.extensionId === contextPluginId && s.definition.id === ref.skillId,
  ) ?? null;
}

/** Read persona file + any prompt-kind default skills, concatenate into a
 *  single system prompt string. Falls back gracefully when files are
 *  missing — the agent still gets a usable (if shorter) prompt and a
 *  warning is recorded. */
export async function composeSystemPrompt(agentId: string): Promise<ComposedSystemPrompt | null> {
  const entry = lookupAgent(agentId);
  if (!entry) {
    const brand = resolveBrandAssistantTemplate(agentId);
    if (!brand) return null;
    try {
      const persona = await readFile(brand.personaPath, 'utf-8');
      return {
        agentId,
        extensionId: 'brand:assistant',
        persona,
        skillSections: [],
        skillIndex: [],
        memorySections: [],
        text: persona.trim(),
        warnings: [],
      };
    } catch {
      return null;
    }
  }
  const warnings: string[] = [];

  let persona = '';
  try {
    persona = await readFile(entry.personaPath, 'utf-8');
  } catch (e) {
    warnings.push(`persona file unreadable: ${(e as Error).message}`);
  }

  const sections: ComposedSystemPrompt['skillSections'] = [];
  const skillIndex: ComposedSystemPrompt['skillIndex'] = [];
  const refs = entry.definition.defaultSkills ?? [];
  for (const r of refs as SkillRef[]) {
    const skill = resolveSkill(r, entry.extensionId);
    if (!skill) {
      warnings.push(`defaultSkill ref unresolved: ${JSON.stringify(r)}`);
      continue;
    }
    const sd = skill.definition;
    let description =
      pickI18n(sd.description, entry.definition.defaultLang ?? 'zh') ||
      pickI18n(sd.displayName, entry.definition.defaultLang ?? 'zh') ||
      '';
    // Prompt-kind skills also get their full body inlined; ts/py skills stay
    // index-only — the agent still knows they exist via the skill listing
    // above and invokes them through the `skill` tool at runtime.
    if (sd.entry.kind === 'prompt') {
      const extensionDir = extensionDirOf(skill.extensionId);
      if (!extensionDir) {
        warnings.push(`cannot resolve plugin dir for skill ${sd.id}`);
      } else {
        const absolute = resolveSkillFile(extensionDir, sd.entry.file);
        try {
          const raw = await readFile(absolute, 'utf-8');
          // agentskills.io: SKILL.md has YAML frontmatter (name+description).
          // Strip before injection (LLM doesn't need the YAML metadata) and
          // prefer frontmatter description when manifest didn't supply one.
          const fm = parseSkillFrontmatter(raw);
          if (!description && fm.description) description = fm.description;
          sections.push({ skillId: sd.id, extensionId: skill.extensionId, body: fm.body });
        } catch (e) {
          warnings.push(`skill file unreadable (${absolute}): ${(e as Error).message}`);
        }
      }
    }
    skillIndex.push({
      skillId: sd.id,
      extensionId: skill.extensionId,
      kind: sd.entry.kind,
      description,
    });
  }

  // Long-term memory: every *.md under the plugin's memoryDir gets pulled in
  // wholesale. Forgeax has no auto-write/compaction on memory yet — files
  // are author-curated lessons / conventions / preferences, so size stays
  // small in practice. If a plugin author wants tiered memory, they split
  // by file (lessons.md / conventions.md / …).
  const memorySections: ComposedSystemPrompt['memorySections'] = [];
  if (entry.definition.memoryDir) {
    const extensionDir = extensionDirOf(entry.extensionId);
    if (extensionDir) {
      const memDirAbs = resolveMemoryDir(extensionDir, entry.definition.memoryDir);
      const memLang = memLangFromPersonaFile(entry.personaPath);
      const loaded = await loadMemoryDir(memDirAbs, memLang, warnings);
      memorySections.push(...loaded);
    } else {
      warnings.push(`cannot resolve plugin dir for memoryDir of ${entry.extensionId}`);
    }
  }

  const skillIndexBlock = skillIndex.length > 0
    ? `# Your Skills\n\n${skillIndex.map((s) =>
        `- \`${s.skillId}\` (${s.kind})${s.description ? ` — ${s.description}` : ''}`,
      ).join('\n')}\n\nInvoke ts/py skills via the \`skill\` tool; prompt skills are inlined above.`
    : '';
  const skillBlocks = sections
    .map((s) => `## Skill: ${s.skillId}\n\n${s.body.trim()}`)
    .join('\n\n');
  const memoryBlock = memorySections.length > 0
    ? `# Long-term Memory\n\n${memorySections.map((m) =>
        `## ${m.file}\n\n${m.body.trim()}`,
      ).join('\n\n')}`
    : '';
  const text = [persona.trim(), skillIndexBlock, skillBlocks, memoryBlock]
    .filter((s) => s.length > 0)
    .join('\n\n---\n\n');

  return {
    agentId,
    extensionId: entry.extensionId,
    persona,
    skillSections: sections,
    skillIndex,
    memorySections,
    text,
    warnings,
  };
}

function resolveMemoryDir(extensionDir: string, raw: string): string {
  if (raw.startsWith('/')) return raw;
  return resolve(extensionDir, raw);
}

async function loadMemoryDir(
  absDir: string,
  lang: MemLang,
  warnings: string[],
): Promise<Array<{ file: string; body: string }>> {
  if (!existsSync(absDir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch (e) {
    warnings.push(`memoryDir unreadable (${absDir}): ${(e as Error).message}`);
    return [];
  }
  // Pick one variant per base so a bilingual agent never gets both the zh and
  // en copy of the same memory file injected at once (see memory-locale.ts).
  const mds = pickMemoryFilesForLang(
    entries.filter((f) => f.toLowerCase().endsWith('.md')),
    lang,
  );
  const out: Array<{ file: string; body: string }> = [];
  for (const f of mds) {
    const abs = join(absDir, f);
    try {
      const body = await readFile(abs, 'utf-8');
      const trimmed = body.trim();
      if (trimmed) out.push({ file: basename(f), body: trimmed });
    } catch (e) {
      warnings.push(`memory file unreadable (${abs}): ${(e as Error).message}`);
    }
  }
  return out;
}

function resolveBrandAssistantTemplate(agentId: string): ResolvedExternalAgentTemplate | null {
  try {
    const { config, packDir } = loadBrand();
    const agent = config.assistant.agent;
    if (agent.id !== agentId) return null;
    const personaPath = resolve(packDir, agent.personaFiles.zh ?? agent.personaFiles.en);
    if (!existsSync(personaPath)) return null;
    return {
      personaPath,
      skillSources: [],
      tools: agent.tools,
      source: 'brand',
      trustTier: 'own',
    };
  } catch {
    return null;
  }
}

/** Resolve `agentId` (Brand assistant / plugin agent id) → absolute
 *  persona-file path. Used by /api/sessions/:sid/messages auto-scaffolding
 *  to pre-populate `agent.json::personaFile` so AgentTemplateLoader can
 *  freeze the persona for the first turn. Returns null if the id isn't a known
 *  plugin agent and isn't the Brand assistant (caller should fall
 *  through to the plain "route to root" path). */
export async function resolveExternalAgentTemplate(
  agentId: string,
): Promise<ResolvedExternalAgentTemplate | null> {
  // 1) Plugin agents — entry.personaPath is already absolute.
  const plugin = lookupAgent(agentId);
  if (plugin && plugin.personaPath && existsSync(plugin.personaPath)) {
    let memoryDir: string | undefined;
    if (plugin.definition.memoryDir) {
      const extensionDir = extensionDirOf(plugin.extensionId);
      if (extensionDir) {
        const abs = resolveMemoryDir(extensionDir, plugin.definition.memoryDir);
        if (existsSync(abs)) memoryDir = abs;
      }
    }
    return {
      personaPath: plugin.personaPath,
      memoryDir,
      skillSources: await resolveExternalSkillSources(plugin),
      tools: plugin.definition.tools,
      source: 'plugin',
      origin: plugin.origin,
      trustTier: plugin.origin === 'builtin' ? 'own' : 'imported',
    };
  }
  // 2) Product-owned main assistant from the active Brand pack.
  return resolveBrandAssistantTemplate(agentId);
}

/** Compatibility name for pre-template callers.
 *
 * New materialization/bootstrap code must use resolveExternalAgentTemplate so
 * it cannot accidentally treat the returned skills/memory/tools as persona
 * decoration. */
export async function resolvePersonaForAgent(
  agentId: string,
): Promise<ResolvedExternalAgentTemplate | null> {
  return resolveExternalAgentTemplate(agentId);
}

/** Resolve extension defaultSkills once at template materialization/bootstrap.
 *
 * The returned paths are persisted in resident agent.json and subsequently
 * loaded by AgentTemplateLoader. Runtime turns therefore never need to look up
 * the global extension registry by agent id. */
async function resolveExternalSkillSources(
  agent: AgentEntry,
): Promise<ResolvedExternalSkillSource[]> {
  const refs = (agent.definition.defaultSkills ?? []) as SkillRef[];
  const lang = agent.definition.defaultLang ?? 'zh';
  const result: ResolvedExternalSkillSource[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const skill = resolveSkill(ref, agent.extensionId);
    if (!skill || seen.has(skill.definition.id)) continue;
    seen.add(skill.definition.id);
    const definition = skill.definition;
    let description =
      pickI18n(definition.description, lang) ||
      pickI18n(definition.displayName, lang) ||
      '';
    const path = resolveSkillFile(skill.originDir, definition.entry.file);
    if (!description && definition.entry.kind === 'prompt') {
      try {
        description = parseSkillFrontmatter(await readFile(path, 'utf-8')).description ?? '';
      } catch {
        // The template loader will skip an unreadable body. Keep the index
        // entry so the persisted definition remains faithful to the manifest.
      }
    }
    result.push({
      id: definition.id,
      path,
      ...(description ? { description } : {}),
      executor:
        definition.entry.kind === 'ts'
          ? 'typescript'
          : definition.entry.kind === 'py'
            ? 'python'
            : 'prompt',
    });
  }
  return result;
}

function extensionDirOf(extensionId: string): string | null {
  const m = getExtensionSnapshot().manifests.find((mm) => mm.manifest.id === extensionId);
  if (!m) return null;
  return dirname(m.originPath);
}

function resolveSkillFile(extensionDir: string, file: string): string {
  if (file.startsWith('/')) return file;
  return join(extensionDir, file);
}
