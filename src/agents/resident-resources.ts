import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { defaultProjectRoot } from "@forgeax/platform-io";
import type { AgentJson } from "../core/types";
import type { ResolvedExternalAgentTemplate } from "./loader";
import { getResidentResourcePolicy, type ResidentResourcePolicy } from "../orchestration-seams";

export function sameResidentResource(root: string, configured: string, expected: string): boolean {
  return resourceCandidates(root, configured).some((candidate) => {
    try { return realpathSync(candidate) === realpathSync(expected); }
    catch { return false; }
  });
}

function resourceCandidates(root: string, configured: string): string[] {
  if (isAbsolute(configured) || win32.isAbsolute(configured)) return [configured];
  return [resolve(root, configured), resolve(defaultProjectRoot(), configured)];
}

function matchesResidentResource(root: string, configured: string, expected: string, policy: ResidentResourcePolicy): boolean {
  if (sameResidentResource(root, configured, expected)) return true;
  // Existing custom files always win, even if they mimic an installation path.
  if (resourceCandidates(root, configured).some(existsSync) || !existsSync(expected)) return false;
  return policy.matchesLegacyPath(configured, expected);
}

/** Copy only inputs accepted by the injected host policy; callers publish agent.json afterwards.
 * Unique snapshot directories never overwrite resident-authored files. Keeping
 * the original persona filename preserves memory language selection.
 */
export async function snapshotResidentResources(
  root: string,
  config: AgentJson,
  external: ResolvedExternalAgentTemplate,
): Promise<AgentJson> {
  const policy = getResidentResourcePolicy();
  if (policy?.persistence !== "snapshot" || !policy.acceptsSource({ kind: external.source, origin: external.origin })) return config;
  if (!config.personaFile || !matchesResidentResource(root, config.personaFile, external.personaPath, policy)) return config;
  const next = { ...config };
  let snapshot: string | undefined;
  const copy = async (source: string, category: string, directory = false): Promise<string> => {
    if (!snapshot) {
      // mkdtemp directly under the resident avoids following an author-owned
      // intermediate resource-directory symlink.
      snapshot = await mkdtemp(join(root, ".resident-resources-"));
    }
    const destination = join(snapshot, category, basename(source));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: directory, dereference: true, errorOnExist: true, force: false });
    return `./${relative(root, destination).split("\\").join("/")}`;
  };
  next.personaFile = await copy(external.personaPath, "persona");
  if (config.memoryDir && external.memoryDir && matchesResidentResource(root, config.memoryDir, external.memoryDir, policy)) {
    next.memoryDir = await copy(external.memoryDir, "memory", true);
  }
  const sources = config.skillSources ?? external.skillSources;
  next.skillSources = await Promise.all(sources.map(async (source, index) => {
    const accepted = external.skillSources.find((candidate) =>
      candidate.id === source.id && external.skillResourceSources?.some((resource) =>
        resource.path === candidate.path && policy.acceptsSource({ kind: resource.kind, origin: resource.origin }))
      && matchesResidentResource(root, source.path, candidate.path, policy));
    if (!accepted) return { ...source };
    // Preserve sibling scripts/references used by prompt and executable skills.
    const dir = await copy(dirname(accepted.path), `skills/${index}`, true);
    return { ...source, path: `${dir}/${basename(accepted.path)}` };
  }));
  // Resource repair is not an authority migration. In particular, a missing
  // legacy trust field must not be filled by the subsequent leaf-name resolver.
  if (next.trustTier === undefined) next.trustTier = "imported";
  return next;
}
