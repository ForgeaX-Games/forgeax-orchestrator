import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultProjectRoot } from "@forgeax/platform-io";
import { loadAgentRecord } from "../soul";
import type { ResidentDefinition } from "./resident-definition-store";
import type { TemplateTrust } from "./template-source-locator";

/**
 * Restore one Session resident's registration trust.
 *
 * New residents persist this host-derived field when they are materialized.
 * Older resident configs are migrated once by the same source resolver used
 * before RuntimeTree/Catalog existed, then the result becomes stable identity
 * metadata for later Session bootstraps.
 */
export async function ensureResidentTrust(
  definition: ResidentDefinition,
): Promise<TemplateTrust> {
  const file = join(definition.templateRoot, "agent.json");
  const config = await readAgentJson(file);
  if (config.trustTier === "own" || config.trustTier === "imported") {
    return config.trustTier;
  }
  if (config.trustTier !== undefined) {
    throw new Error(
      `invalid resident trustTier at ${definition.logicalPath}: ${String(config.trustTier)}`,
    );
  }

  const leafId = definition.logicalPath.split("/").at(-1)!;
  let trust: TemplateTrust = "imported";
  try {
    trust = (
      await loadAgentRecord(leafId, { projectRoot: defaultProjectRoot() })
    ).trustTier;
  } catch {
    // Missing/failed legacy source resolution must not grant authority.
  }

  // Bootstrap is the compatibility migration boundary. Persist only the
  // derived result; never copy a trust claim out of an external template.
  await writeFile(
    file,
    `${JSON.stringify({ ...config, trustTier: trust }, null, 2)}\n`,
    "utf8",
  );
  return trust;
}

async function readAgentJson(file: string): Promise<Record<string, unknown>> {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`resident agent.json must contain an object: ${file}`);
  }
  return raw as Record<string, unknown>;
}
