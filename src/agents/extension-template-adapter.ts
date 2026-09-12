import { COORDINATOR_TOOL_GRANTS, declaredProjectMcpGrants } from './tool-grants';
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentJson } from "../core/types";
import type { ResidentDefinition } from "./resident-definition-store";
import { resolveExternalAgentTemplate } from "./loader";
import { sameResidentResource, snapshotResidentResources } from "./resident-resources";

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
  const configuredPersona =
    typeof config.personaFile === "string" ? config.personaFile.trim() : "";
  if (!configuredPersona) return;

  const leafId = definition.logicalPath.split("/").at(-1)!;
  const external = await resolveExternalAgentTemplate(leafId).catch(() => null);
  if (!external) return;
  const samePersona = sameResidentResource(definition.templateRoot, configuredPersona, external.personaPath);
  const portable = await snapshotResidentResources(definition.templateRoot, config, external);
  if (!samePersona && portable === config) {
    return;
  }

  // Project MCP discovery runs before concrete tools can become extraTools.
  // Carry explicit manifest MCP declarations into the frozen scope so that
  // discovery is enabled without granting unrelated host or project tools.
  const manifestGrants = declaredProjectMcpGrants(external.tools);
  const nextSources = external.skillSources.map((source) => ({ ...source }));
  const next: AgentJson = {
    ...portable,
    skillSources: portable.skillSources ?? nextSources,
    ...(samePersona && config.toolGrants === undefined && external.source === "brand"
      ? { toolGrants: structuredClone(COORDINATOR_TOOL_GRANTS) }
      : samePersona && config.toolGrants === undefined && manifestGrants !== undefined
        ? { toolGrants: manifestGrants }
        : {}),
  };
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  // Publish only after all resources exist. A process exit while writing the
  // temporary file leaves the previous definition intact for the next boot.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (JSON.stringify(await readAgentJson(file)) !== JSON.stringify(config)) {
      throw new Error(`resident agent.json changed during resource migration: ${file}`);
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readAgentJson(file: string): Promise<AgentJson> {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`resident agent.json must contain an object: ${file}`);
  }
  return raw as AgentJson;
}
