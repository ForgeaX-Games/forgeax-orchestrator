import { dirname, join, resolve as resolvePath } from 'node:path';

export interface PermissionServerLaunch {
  command: string;
  entry: string;
}

/** The executable that may launch packaged `.mjs` MCP assets. A compiled
 * Server binary is not that runtime; desktop assembly supplies its owned Bun. */
export function resolveBundledBunExecutable(
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable = process.execPath,
): string {
  return resolvePath(env.FORGEAX_BUN_EXECUTABLE?.trim() || runtimeExecutable);
}

/**
 * Resolve the permission MCP server used by every Claude execution path.
 *
 * Source and npm-package runtimes keep using their colocated asset. Compiled
 * product binaries cannot derive that asset from Bun's virtual import.meta
 * directory, so the product shell supplies one explicit packaged entry.
 */
export function resolvePermissionServerLaunch(
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable = process.execPath,
): PermissionServerLaunch {
  const explicitEntry = env.FORGEAX_PERMISSION_SERVER_ENTRY?.trim();
  const resourceRoot = env.FORGEAX_RESOURCE_ROOT?.trim();
  const toolsEntry = env.FORGEAX_TOOLS_SERVER_ENTRY?.trim();
  // `forgeax-core serve` may be launched through a restricted runtime env.
  // The tools entry is already required for the same MCP config, so it is a
  // reliable packaged-resource anchor if the dedicated permission override
  // was omitted at that boundary.
  const packagedEntry = explicitEntry
    ?? (resourceRoot ? join(resourceRoot, 'cli-providers', 'mcp', 'permission-server.mjs') : undefined)
    ?? (toolsEntry
      ? join(dirname(resolvePath(toolsEntry)), '..', '..', 'cli-providers', 'mcp', 'permission-server.mjs')
      : undefined);
  return {
    command: resolveBundledBunExecutable(env, runtimeExecutable),
    entry: packagedEntry ? resolvePath(packagedEntry) : fallback,
  };
}

/** Compatibility entry-only resolver for callers and tests that do not spawn. */
export function resolvePermissionServerEntry(fallback: string): string {
  return resolvePermissionServerLaunch(fallback).entry;
}
