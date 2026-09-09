import { parseAgentToolGrants } from './tool-grants';
import { parseAgentPermissionMode } from '../runtime/runtime-config';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AgentJson } from "../core/types";
import {
  memLangFromPersonaFile,
  pickMemoryFilesForLang,
} from "./memory-locale";
import type {
  AgentTemplateDraft,
  AgentTemplateResourceSet,
  KitSourceRef,
  ResolvedSkillSource,
} from "./template-types";

export function loadFileSystemAgentTemplate(
  templateRoot: string,
  entryId: string,
): AgentTemplateDraft {
  const root = canonicalDirectory(templateRoot);
  const raw = readJson(join(root, "agent.json"));
  const config = raw as AgentJson & {
    id?: string;
    displayName?: string;
    description?: string;
    kernelId?: string;
  };
  // `trustTier` is host-owned resident identity metadata, not an authorable
  // runtime setting. The resident adapter reads it before loading the
  // template; other filesystem registrations receive trust from their
  // Catalog registration. Keep it out of the generic configuration merge so
  // an agent.json claim can never become runtime policy by accident.
  const { trustTier: _residentTrust, ...configuration } = raw;
  parseAgentToolGrants(config.toolGrants);
  const resources = scanResources(root, config);
  return {
    definition: {
      id: cleanId(config.id) ?? entryId,
      ...(typeof config.displayName === "string"
        ? { displayName: config.displayName }
        : {}),
      ...(typeof config.description === "string"
        ? { description: config.description }
        : {}),
      ...(typeof config.kernelId === "string" ? { kernelId: config.kernelId } : {}),
    },
    configuration: structuredClone(configuration),
    runtimeConfigDefaults: {
      ...(config.permissionMode !== undefined
        ? { permissionMode: parseAgentPermissionMode(config.permissionMode) } : {}),
      ...(config.models ? { models: config.models } : {}),
      ...(typeof config.coalesceMs === "number" ? { coalesceMs: config.coalesceMs } : {}),
      ...(typeof config.maxIterations === "number"
        ? { maxIterations: config.maxIterations }
        : {}),
      ...(config.historyKeep ? { historyKeep: config.historyKeep } : {}),
      ...(typeof config.timezone === "string" ? { timezone: config.timezone } : {}),
      ...(typeof config.defaultDir === "string" ? { defaultDir: config.defaultDir } : {}),
      ...(typeof config.defaultStatus === "string"
        ? { defaultStatus: config.defaultStatus }
        : {}),
    },
    resources,
  };
}

function scanResources(
  root: string,
  config: AgentJson,
): AgentTemplateResourceSet {
  const persona = resolvePersona(root, config.personaFile);
  const skills = mergeSkills(
    resolveConfiguredSkills(root, config.skillSources),
    scanSkills(root),
  );
  const kits = scanKits(root);
  const memorySeeds = scanMarkdownFiles(
    resolveConfiguredPath(root, config.memoryDir, "memory"),
    memLangFromPersonaFile(config.personaFile),
  );
  return {
    templateRoot: root,
    ...(persona ? { persona } : {}),
    skills,
    kits,
    memorySeeds,
  };
}

function resolvePersona(root: string, configured?: string) {
  if (configured) {
    const path = resolveConfiguredPath(root, configured);
    if (path && isFile(path)) return { kind: "file" as const, path };
    throw new Error(
      `configured personaFile is not a readable file: ${configured}`,
    );
  }
  const identity = join(root, "persona", "identity.md");
  if (isFile(identity)) return { kind: "file" as const, path: identity };
  const personaDir = join(root, "persona");
  const first = listNames(personaDir).find((name) => name.toLowerCase().endsWith(".md"));
  return first ? { kind: "file" as const, path: join(personaDir, first) } : undefined;
}

function scanSkills(root: string): ResolvedSkillSource[] {
  const skillsRoot = join(root, "skills");
  const result: ResolvedSkillSource[] = [];
  for (const name of listNames(skillsRoot)) {
    const dir = join(skillsRoot, name);
    const skillFile = join(dir, "SKILL.md");
    if (!isDirectory(dir) || !isFile(skillFile)) continue;
    result.push({
      id: name,
      source: { kind: "file", path: skillFile },
      executor: "prompt",
    });
  }
  return result;
}

function resolveConfiguredSkills(
  root: string,
  configured: AgentJson["skillSources"],
): ResolvedSkillSource[] {
  if (!Array.isArray(configured)) return [];
  const result: ResolvedSkillSource[] = [];
  for (const entry of configured) {
    const id = cleanId(entry?.id);
    const path = resolveConfiguredPath(root, entry?.path);
    if (!id || !path) continue;
    result.push({
      id,
      source: { kind: "file", path },
      ...(typeof entry.description === "string" && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
      ...(entry.executor ? { executor: entry.executor } : {}),
    });
  }
  return result;
}

function mergeSkills(
  configured: readonly ResolvedSkillSource[],
  discovered: readonly ResolvedSkillSource[],
): ResolvedSkillSource[] {
  const result: ResolvedSkillSource[] = [];
  const seen = new Set<string>();
  for (const skill of [...configured, ...discovered]) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    result.push(skill);
  }
  return result;
}

function scanKits(root: string): KitSourceRef[] {
  const kitsRoot = join(root, "kits");
  const result: KitSourceRef[] = [];
  for (const name of listNames(kitsRoot)) {
    const dir = join(kitsRoot, name);
    if (!isDirectory(dir)) continue;
    result.push({ id: name, source: { kind: "directory", path: dir } });
  }
  return result;
}

function scanMarkdownFiles(
  dir: string | undefined,
  lang: ReturnType<typeof memLangFromPersonaFile>,
) {
  if (!dir || !isDirectory(dir)) return [];
  return pickMemoryFilesForLang(
    listNames(dir).filter(
      (name) => name.toLowerCase().endsWith(".md") && isFile(join(dir, name)),
    ),
    lang,
  )
    .map((name) => ({ kind: "file" as const, path: join(dir, name) }));
}

function resolveConfiguredPath(
  root: string,
  configured: string | undefined,
  fallback?: string,
): string | undefined {
  const candidate = configured
    ? resolve(root, configured)
    : fallback
      ? join(root, fallback)
      : undefined;
  if (!candidate) return undefined;
  return candidate;
}

function canonicalDirectory(path: string): string {
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) {
    throw new Error(`template root is not a directory: ${path}`);
  }
  return real;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`agent.json must contain an object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function cleanId(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id || undefined;
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
