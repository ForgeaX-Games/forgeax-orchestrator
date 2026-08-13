/**
 * codex-session-home — a stable, ISOLATED `CODEX_HOME` per logical agent session,
 * plus a keyed mutex serializing access to each home.
 *
 * Why isolate (plan §8.1): Codex keeps its config, auth, sessions, SQLite, logs
 * and skills under `CODEX_HOME`. Sharing the user's `~/.codex` would let a turn
 * inherit global MCP servers / hooks / plugins (contaminating the exact-per-turn
 * tool set) and contend on the user's SQLite. So each logical session gets its
 * own directory under the orchestrator's user dir.
 *
 * Why STABLE (not per-turn): a fresh dir every turn would lose Codex thread state,
 * so `exec resume` / `thread/resume` could not restore context. The directory is
 * reused across turns of the same logical session.
 *
 * Auth: we do NOT copy the user's `config.toml` (that's the whole point — a clean
 * config with no inherited MCP). But subscription auth lives in `auth.json`; we
 * copy it read-only into the isolated home on first use so a logged-in Codex keeps
 * working without leaking the rest of the global config. API-key auth still flows
 * via env (OPENAI_API_KEY) and needs no file.
 *
 * Concurrency (plan §8.2): one Codex process per home at a time. `codexHomeMutex`
 * is a keyed mutex; callers acquire before spawn and release in `finally`.
 * Different logical sessions run in parallel; the same home is strictly serial.
 */
import type { TurnRequest } from '@forgeax/agent-runtime';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { resolveUserDir } from '../fs/user-dir';

/** Sanitize one path segment into a safe directory-name fragment.
 *  Collapses runs of dots so a hostile id can't smuggle a `..` traversal even
 *  after other punctuation is normalized to `-`. */
function seg(value: string, fallback: string): string {
  const s = (value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s.slice(0, 64) || fallback;
}

/**
 * Compute the keyed-mutex / directory key for a turn:
 *   `<project-or-tenant>/<logical-session>/<agent>`
 * Logical session prefers the real host sid, then the thread id, then the agent.
 */
export function codexHomeKey(req: TurnRequest): string {
  const project = seg(basename(defaultProjectRoot()), 'workspace');
  const logical = seg(req.hostSessionId?.trim() || req.session.threadId?.trim() || req.session.agentId?.trim() || 'session', 'session');
  const agent = seg(req.session.agentId?.trim() || 'forge', 'forge');
  return `${project}/${logical}/${agent}`;
}

/** The user's real Codex home (source of auth + provider config to copy from). */
function userCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || resolvePath(homedir(), '.codex');
}

/**
 * Strip the pollution vectors (`[mcp_servers.*]`, `[hooks.*]`, `[plugins.*]`
 * tables + any top-level `mcp_servers =` assignment) from a Codex `config.toml`
 * while PRESERVING everything else — most importantly `model` / `model_provider`
 * / `[model_providers.*]` (base_url / wire_api / auth mode) and project trust.
 *
 * This is the crux of §8.1 isolation done right: a fully-empty home would drop
 * the user's custom model endpoint (breaking auth), while a verbatim copy would
 * re-inherit global MCP/hooks (breaking the exact-per-turn tool set). We keep the
 * provider config and drop only the MCP/hook/plugin surface (we register `fxt`
 * ourselves via `-c` overrides).
 */
export function sanitizeCodexConfig(raw: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*$/.exec(line);
    if (header) {
      const name = header[1];
      skipping = /^mcp_servers(\.|$)/.test(name) || /^hooks(\.|$)/.test(name) || /^plugins(\.|$)/.test(name);
      if (!skipping) out.push(line);
      continue;
    }
    if (skipping) continue;
    if (/^\s*mcp_servers\s*=/.test(line)) continue; // top-level inline table
    out.push(line);
  }
  return out.join('\n');
}

function normalizedProjectPath(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

/** Render a TOML table header with a safely quoted path key. */
export function codexProjectTrustHeader(projectRoot: string): string {
  return `[projects.${JSON.stringify(projectRoot)}]`;
}

/** Does the sanitized config already trust `projectRoot`? */
export function hasProjectTrust(cfg: string, projectRoot: string): boolean {
  const wanted = normalizedProjectPath(projectRoot);
  for (const match of cfg.matchAll(/^\s*\[projects\.(.+)\]\s*$/gm)) {
    const rawKey = match[1]?.trim() ?? '';
    let decoded: string | undefined;
    if (rawKey.startsWith("'") && rawKey.endsWith("'")) decoded = rawKey.slice(1, -1);
    else if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
      try { decoded = JSON.parse(rawKey) as string; } catch { /* malformed */ }
    }
    if (decoded !== undefined && normalizedProjectPath(decoded) === wanted) return true;
  }
  return false;
}

/**
 * Ensure the isolated `CODEX_HOME` directory for `key` exists and return its
 * absolute path. Seeds it with:
 *   - `auth.json` (copied read-only, first use only) so API-key/subscription auth works;
 *   - a SANITIZED `config.toml` (provider/trust preserved, MCP/hooks/plugins stripped),
 *     rewritten each call so provider settings stay fresh, with the current project
 *     root marked trusted (headless exec must not block on a trust prompt).
 */
export async function ensureCodexSessionHome(key: string): Promise<string> {
  const dir = join(resolveUserDir(), 'codex', ...key.split('/').map((p) => seg(p, 'x')));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'sessions'), { recursive: true });

  const src = userCodexHome();

  const authDest = join(dir, 'auth.json');
  if (!existsSync(authDest)) {
    const authSrc = join(src, 'auth.json');
    if (existsSync(authSrc)) {
      try {
        copyFileSync(authSrc, authDest);
        await chmod(authDest, 0o600);
      } catch {
        /* best-effort: fall back to env auth (OPENAI_API_KEY) if copy fails */
      }
    }
  }

  // Sanitized provider config + trust for the current cwd (overwritten each call).
  const projectRoot = defaultProjectRoot();
  let cfg = '';
  try {
    const cfgSrc = join(src, 'config.toml');
    if (existsSync(cfgSrc)) cfg = sanitizeCodexConfig(readFileSync(cfgSrc, 'utf8'));
  } catch {
    cfg = '';
  }
  if (!hasProjectTrust(cfg, projectRoot)) {
    cfg = `${cfg}\n\n${codexProjectTrustHeader(projectRoot)}\ntrust_level = "trusted"\n`;
  }
  try {
    writeFileSync(join(dir, 'config.toml'), cfg, { mode: 0o600 });
  } catch {
    /* best-effort: without config the turn may fall back to default provider */
  }
  return dir;
}

/**
 * A keyed mutex: `acquire(key)` resolves when the caller holds the lock for that
 * key, returning a `release()` (idempotent). Distinct keys never block each other.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => done);
    this.tails.set(key, tail);
    // Prune the map entry once this segment fully settles (best-effort, avoids
    // unbounded growth) — only if no later acquirer replaced the tail.
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}

/** Process-wide keyed mutex for Codex homes (one Codex process per home). */
export const codexHomeMutex = new KeyedMutex();
