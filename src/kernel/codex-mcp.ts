/**
 * codex-mcp — Codex-specific encoding of a shared `fxt` MCP runtime into
 * `codex -c key=value` per-process config overrides, plus the version-capability
 * gate and structured failure codes.
 *
 * Why per-process `-c` overrides (not a config.toml / not `--mcp-config`): Codex
 * has no dynamic per-turn MCP flag, but every `-c key=value` value is parsed as
 * TOML (verified: `codex exec --help`). So we register `mcp_servers.fxt` entirely
 * through repeated `-c` overrides, regenerated each turn from `TurnRequest.tools`.
 * This keeps the tool set exact-per-turn without mutating the user's global config.
 *
 * Invariants (docs/features/codex-mcp-tool-parity-plan.md §5.3 / §5.5 / §13.1):
 *   - Values are emitted by dedicated TOML string/array serializers — NEVER by
 *     assuming a JSON object is valid TOML, and NEVER by shell-quoting.
 *   - Secrets never go into argv. Codex app-server does not reliably inherit
 *     arbitrary parent env vars into an MCP child, so the runtime's non-secret
 *     `FORGEAX_*` context is also declared under `mcp_servers.fxt.env`.
 *   - `required=true` + `default_tools_approval_mode="approve"`: Codex must not
 *     add a second approval prompt for `fxt` tools; the host trust-gate stays the
 *     single permission authority.
 *   - A turn with tools on a Codex older than the MCP-config baseline fails with
 *     an explicit `codex_mcp_unsupported` code — it must not silently drop tools.
 */
import type { ForgeaxToolsRuntime } from './mcp/forgeax-tools-runtime';

/** Structured failure codes for the Codex MCP path (plan §13.1). */
export type CodexMcpErrorCode =
  | 'codex_mcp_unsupported'
  | 'codex_mcp_materialize_failed'
  | 'codex_mcp_start_failed'
  | 'codex_mcp_config_mismatch'
  | 'codex_mcp_contaminated'
  | 'codex_mcp_bridge_failed';

/** Error carrying one of the structured Codex MCP failure codes. */
export class CodexMcpError extends Error {
  constructor(readonly code: CodexMcpErrorCode, message: string) {
    super(message);
    this.name = 'CodexMcpError';
  }
}

/** MCP server key registered in Codex config (`mcp_servers.<KEY>`). */
export const CODEX_MCP_SERVER_KEY = 'fxt';

/** Minimum Codex CLI version supporting the required MCP config surface:
 *  `mcp_servers.*.enabled_tools`, `.required`, `.default_tools_approval_mode`,
 *  and app-server `mcpToolCall` item events (plan §5.5). */
export const MIN_CODEX_MCP_VERSION = '0.122.0';

/** MCP timeouts (seconds) — startup probe + ordinary per-tool ceiling (plan §5.3).
 * Blocking ask_user is delivered as an app-server dynamic tool and therefore
 * never enters this finite MCP execution path. */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 10;
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 100;

// ─── TOML value serializers ──────────────────────────────────────────
// TOML basic-string escaping: backslash, double-quote, and the control chars
// TOML requires as escapes (\b \t \n \f \r) plus \uXXXX for other C0 controls.
// We deliberately do NOT rely on JSON.stringify — a JSON array of strings is
// *coincidentally* valid TOML only because each element is a basic string, so we
// still escape each element through tomlString to stay correct for edge chars.

/** Serialize a JS string as a TOML basic string (double-quoted, escaped). */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\f': out += '\\f'; break;
      case '\r': out += '\\r'; break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

/** Serialize a JS string[] as a TOML inline array of basic strings. */
export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

// ─── version gate ────────────────────────────────────────────────────

/** Extract a `major.minor.patch` triple from a version string (e.g.
 *  "codex-cli 0.143.0" → [0,143,0]). Returns null when unparseable. */
export function parseCodexVersion(raw: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw ?? '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two `[maj,min,patch]` triples: -1 / 0 / 1. */
function cmpVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Does this Codex version support the required MCP config surface? Unparseable
 *  version strings are treated as UNSUPPORTED (fail-closed for a tools turn). */
export function codexSupportsMcpTools(versionRaw: string): boolean {
  const v = parseCodexVersion(versionRaw);
  const min = parseCodexVersion(MIN_CODEX_MCP_VERSION)!;
  if (!v) return false;
  return cmpVersion(v, min) >= 0;
}

/**
 * Gate a turn against the Codex version. Only throws when the turn NEEDS tools
 * (hasTools) and the version is below the baseline — an empty-tools turn is
 * allowed to run on any version (plan §5.5).
 */
export function assertCodexMcpSupported(versionRaw: string, hasTools: boolean): void {
  if (!hasTools) return;
  if (!codexSupportsMcpTools(versionRaw)) {
    throw new CodexMcpError(
      'codex_mcp_unsupported',
      `codex ${versionRaw || '(unknown version)'} lacks required MCP config support ` +
        `(need >= ${MIN_CODEX_MCP_VERSION}); refusing to run a tools turn without them`,
    );
  }
}

// ─── override builder ────────────────────────────────────────────────

/**
 * Encode a materialized `fxt` runtime into Codex `-c key=value` argv pairs.
 * Returns a flat argv array (`['-c', 'mcp_servers.fxt.command="..."', '-c', ...]`)
 * ready to splice into `codex exec` / `codex app-server` invocation.
 *
 * Only config lives here; secrets and session context ride the process env
 * (`runtime.env`) — see plan §5.3.
 */
export function buildCodexMcpOverrides(runtime: ForgeaxToolsRuntime): string[] {
  const k = `mcp_servers.${CODEX_MCP_SERVER_KEY}`;
  const pairs: Array<[string, string]> = [
    [`${k}.command`, tomlString(runtime.command)],
    [`${k}.args`, tomlStringArray(runtime.args)],
    [`${k}.required`, 'true'],
    [`${k}.enabled_tools`, tomlStringArray(runtime.enabledTools)],
    [`${k}.default_tools_approval_mode`, tomlString('approve')],
    [`${k}.startup_timeout_sec`, String(CODEX_MCP_STARTUP_TIMEOUT_SEC)],
    [`${k}.tool_timeout_sec`, String(CODEX_MCP_TOOL_TIMEOUT_SEC)],
  ];
  const argv: string[] = [];
  for (const [key, val] of pairs) {
    argv.push('-c', `${key}=${val}`);
  }
  // Codex app-server sanitizes the environment it gives to MCP children. The
  // runtime env contains only FORGEAX_* context (no provider credentials), so
  // pass that context through the MCP server's explicit env table. This is
  // what makes dynamically wired host-tool specs discoverable; builtins work
  // without it and therefore masked the bug in the original parity test.
  for (const [name, value] of Object.entries(runtime.env)) {
    if (!name.startsWith('FORGEAX_')) continue;
    argv.push('-c', `${k}.env.${name}=${tomlString(value)}`);
  }
  return argv;
}

// ─── post-start config validation (best-effort) ──────────────────────

/**
 * Validate that a started Codex process registered our scoped `fxt` server with
 * exactly this turn's `enabled_tools`. User-authored native MCP servers are
 * deliberately allowed; ForgeaX's per-turn authority remains constrained by
 * the fxt server-side allowlist.
 *
 * Tolerant by design: the app-server RPC used to introspect config is still
 * evolving upstream, so an UNAVAILABLE introspection channel (method not found /
 * shape we don't recognize) is NOT a failure — we can't prove contamination, so
 * we proceed and rely on the double server-side allowlist + e2e. We only throw
 * when we positively observe a mismatch or contamination.
 *
 * @param observed  What we managed to read from Codex (null fields = unreadable).
 * @param expected  The enabledTools we configured this turn.
 */
export function validateCodexMcpConfig(
  observed: { servers?: string[] | null; fxtEnabledTools?: string[] | null },
  expected: readonly string[],
): void {
  const servers = observed.servers;
  if (Array.isArray(servers)) {
    if (!servers.includes(CODEX_MCP_SERVER_KEY)) {
      throw new CodexMcpError(
        'codex_mcp_config_mismatch',
        `codex did not register the '${CODEX_MCP_SERVER_KEY}' MCP server (saw: [${servers.join(', ')}])`,
      );
    }
  }
  const enabled = observed.fxtEnabledTools;
  if (Array.isArray(enabled)) {
    const a = [...enabled].sort();
    const b = [...expected].sort();
    const mismatch = a.length !== b.length || a.some((x, i) => x !== b[i]);
    if (mismatch) {
      throw new CodexMcpError(
        'codex_mcp_config_mismatch',
        `codex fxt.enabled_tools [${a.join(', ')}] != requested [${b.join(', ')}]`,
      );
    }
  }
}
