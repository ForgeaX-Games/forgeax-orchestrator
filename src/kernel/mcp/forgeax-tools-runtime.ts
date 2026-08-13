/**
 * forgeax-tools-runtime — SSOT for materializing the `fxt` MCP runtime that a
 * rented kernel (Codex first; CC/CBC to follow in a later refactor) uses to
 * expose this turn's exact `TurnRequest.tools`.
 *
 * A "runtime" bundles everything a kernel needs to spawn / register the
 * `forgeax-tools-server.mjs` MCP server for ONE turn:
 *   - `command` + `args`  — how to launch the stdio MCP server (node + script).
 *   - `enabledTools`      — the per-turn allowlist (deduped, order-preserving),
 *                           derived DIRECTLY from `req.tools`. This is the exact
 *                           set the model may see and call this turn.
 *   - `env`               — FORGEAX_* context (server url, sid, agent, specs file,
 *                           expose allowlist) inherited by the MCP child.
 *   - `cleanup()`         — idempotent teardown of the per-turn temp dir; run on
 *                           normal completion, cancel, and start failure.
 *
 * Design invariants (see docs/features/codex-mcp-tool-parity-plan.md §5.1):
 *   - `enabledTools` is the sole per-turn tool set; no second registry.
 *   - The specs file carries EVERY `ToolSpec` of the turn; the MCP server dedupes
 *     names it already implements as builtins.
 *   - The temp dir is created with `mkdtemp` + a callId/random suffix so two
 *     concurrent turns of the same sid can never overwrite each other's specs.
 *   - `FORGEAX_SID` prefers `req.hostSessionId` (the real sid the UI listens on),
 *     never a synthetic thread id.
 *   - Fail CLOSED: if `req.tools` is non-empty but the specs file cannot be
 *     written, throw — a required-tools turn must not silently degrade to a
 *     tool-less run.
 */
import type { ToolSpec, TurnRequest } from '@forgeax/agent-runtime';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';

/** Tools the `fxt` MCP server implements locally (not host-bridged). Kept in
 *  sync with `forgeax-tools-server.mjs`'s builtin `TOOLS` map. Exported as the
 *  single source of truth so kernel profiles don't each hardcode the list. */
export const FXT_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'echo',
  'list_games',
  'memory_search',
  'remember',
  'query_world',
  'capture_frame',
  'ui_snapshot',
  'ui_invoke',
  'ui_screenshot',
]);

export interface ForgeaxToolsRuntime {
  /** Executable to spawn the MCP server (node / current runtime). */
  command: string;
  /** Argv for the MCP server script. */
  args: string[];
  /** Per-turn tool allowlist (deduped, order-preserving), derived from req.tools. */
  enabledTools: string[];
  /** FORGEAX_* env the MCP child inherits (server url, sid, agent, specs, expose). */
  env: Record<string, string>;
  /** Absolute path to the per-turn temp dir (owned by this runtime). */
  dir: string;
  /** Absolute path to the written specs JSON. */
  specsFile: string;
  /** Idempotent teardown of the temp dir. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

export interface MaterializeOptions {
  /** Stable-ish id folded into the temp dir name for traceability (e.g. callId). */
  runtimeId: string;
  /** Per-kernel posture for MCP clients whose native permission callback does
   * not observe tools executed through this per-turn server. */
  permissionMode?: 'gated' | 'unrestricted';
  /** Drop perception tools (query_world / capture_frame) from the server. */
  disablePerception?: boolean;
  /** Drop the ui_* bridge tools from the server. */
  disableUiBridge?: boolean;
}

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';

/** Deduplicate tool names, preserving first-seen order. */
function dedupeToolNames(tools: readonly ToolSpec[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tools) {
    const name = t?.name?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Sanitize a runtime id into a filesystem-safe temp-dir fragment. */
function safeFragment(id: string): string {
  return (id || 'turn').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'turn';
}

/**
 * Materialize the per-turn `fxt` MCP runtime. Returns `undefined` when the turn
 * declares no tools (nothing to expose → the kernel skips MCP entirely).
 *
 * Throws when `req.tools` is non-empty but the specs file cannot be written
 * (fail-closed: a required-tools turn must not proceed tool-less).
 */
export async function materializeForgeaxToolsRuntime(
  req: TurnRequest,
  options: MaterializeOptions,
): Promise<ForgeaxToolsRuntime | undefined> {
  const enabledTools = dedupeToolNames(req.tools ?? []);
  if (enabledTools.length === 0) return undefined;

  // Unique per-turn temp dir: mkdtemp appends random chars, and we prefix the
  // runtime id so concurrent turns of the same sid never collide (plan §5.1).
  const dir = await mkdtemp(join(tmpdir(), `forgeax-fxt-${safeFragment(options.runtimeId)}-`));
  const specsFile = join(dir, 'tool-specs.json');

  // Specs file carries EVERY ToolSpec of the turn (name/description/inputSchema);
  // the MCP server dedupes names it already implements as builtins. Written 0600.
  const specs = (req.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.capabilityId ? { capabilityId: t.capabilityId } : {}),
    ...(t.capabilityGeneration !== undefined ? { capabilityGeneration: t.capabilityGeneration } : {}),
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  const cleanup = async (): Promise<void> => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort; a leftover temp dir is harmless */
    }
  };

  try {
    await writeFile(specsFile, JSON.stringify(specs), { mode: 0o600 });
  } catch (e) {
    // Fail closed: required tools but no specs → tear down and surface.
    await cleanup();
    throw new Error(
      `forgeax-tools-runtime: failed to write specs file (${enabledTools.length} tools): ${(e as Error).message}`,
    );
  }

  const env: Record<string, string> = {
    FORGEAX_PROJECT_ROOT: defaultProjectRoot(),
    FORGEAX_SOUL_AGENT: req.session.agentId?.trim() || 'default',
    FORGEAX_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
    // Real sid the UI listens on wins; synthetic thread id is only a fallback.
    FORGEAX_SID: req.hostSessionId?.trim() || req.session.threadId?.trim() || '',
    FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
    FORGEAX_TOOL_SPECS_FILE: specsFile,
    ...(options.permissionMode ? { FORGEAX_KERNEL_PERMISSION_MODE: options.permissionMode } : {}),
    // Double-allowlist client side: the server filters BOTH list and call.
    FORGEAX_FXT_EXPOSE: enabledTools.join(','),
    ...(req.capabilityGeneration !== undefined
      ? { FORGEAX_CAPABILITY_GENERATION: String(req.capabilityGeneration) }
      : {}),
  };
  if (options.disablePerception) env.FORGEAX_DISABLE_PERCEPTION = '1';
  if (options.disableUiBridge) env.FORGEAX_DISABLE_UI_BRIDGE = '1';

  return {
    command: process.execPath,
    args: [resolvePath(import.meta.dirname, 'forgeax-tools-server.mjs')],
    enabledTools,
    env,
    dir,
    specsFile,
    cleanup,
  };
}
