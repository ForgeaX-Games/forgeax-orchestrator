import { COORDINATOR_TOOL_GRANTS } from './tool-grants';
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { defaultProjectRoot } from "@forgeax/platform-io";
import type { AgentJson } from "../core/types";
import type { ResidentDefinition } from "./resident-definition-store";
import { resolveExternalAgentTemplate } from "./loader";

/**
 * Persist extension/marketplace default-skill sources into an existing
 * resident definition at the bootstrap/materialization boundary.
 *
 * Older Session residents only persisted personaFile/memoryDir because the
 * legacy turn loader re-read defaultSkills by agent id on every request. The
 * unified template path cannot keep that hidden dependency. We migrate only
 * when the configured persona resolves to the same external persona, avoiding
 * accidental coupling for a user-authored resident that merely shares its
 * leaf id with an installed extension.
 */
export async function synchronizeResidentExternalSkillSources(
  definition: ResidentDefinition,
): Promise<void> {
  const file = resolve(definition.templateRoot, "agent.json");
  const config = await readAgentJson(file);
  // Presence means the resident author or a newer materializer already owns
  // this list. Bootstrap migration must never overwrite explicit config.
  if (config.skillSources !== undefined && config.toolGrants !== undefined) return;
  const configuredPersona =
    typeof config.personaFile === "string" ? config.personaFile.trim() : "";
  if (!configuredPersona) return;

  const leafId = definition.logicalPath.split("/").at(-1)!;
  const external = await resolveExternalAgentTemplate(leafId).catch(() => null);
  if (!external) return;
  if (!sameExistingPath(
    resolveConfiguredPersonaCandidates(definition.templateRoot, configuredPersona),
    external.personaPath,
  )) {
    return;
  }

  if (config.skillSources !== undefined && (config.toolGrants !== undefined || external.source !== "brand")) return;

  const nextSources = external.skillSources.map((source) => ({ ...source }));
  const next: AgentJson = {
    ...config,
    skillSources: config.skillSources ?? nextSources,
    ...(config.toolGrants === undefined && external.source === "brand"
      ? { toolGrants: structuredClone(COORDINATOR_TOOL_GRANTS) }
      : {}),
  };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function resolveConfiguredPersonaCandidates(
  templateRoot: string,
  configured: string,
): string[] {
  if (isAbsolute(configured)) return [configured];
  return [
    resolve(templateRoot, configured),
    resolve(defaultProjectRoot(), configured),
  ];
}

function sameExistingPath(candidates: readonly string[], expected: string): boolean {
  if (!existsSync(expected)) return false;
  let canonicalExpected: string;
  try {
    canonicalExpected = realpathSync(expected);
  } catch {
    return false;
  }
  return candidates.some((candidate) => {
    try {
      return existsSync(candidate) && realpathSync(candidate) === canonicalExpected;
    } catch {
      return false;
    }
  });
}

async function readAgentJson(file: string): Promise<AgentJson> {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`resident agent.json must contain an object: ${file}`);
  }
  return raw as AgentJson;
}
