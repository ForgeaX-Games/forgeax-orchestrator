/**
 * codex-session-home — a stable, ISOLATED `CODEX_HOME` per logical agent session,
 * plus a keyed mutex serializing access to each home.
 *
 * Why isolate (plan §8.1): Codex keeps its config, auth, sessions, SQLite and
 * logs under `CODEX_HOME`. Sharing the user's `~/.codex` would contend on those
 * mutable stores. Each logical session therefore gets its own directory under
 * the orchestrator's user dir, while authored native capabilities are preserved
 * through a verbatim config copy and links to the user's capability directories.
 *
 * Why STABLE (not per-turn): a fresh dir every turn would lose Codex thread state,
 * so `exec resume` / `thread/resume` could not restore context. The directory is
 * reused across turns of the same logical session.
 *
 * Auth: subscription auth lives in `auth.json`; refresh it into the isolated
 * home so a logged-in Codex keeps working. API-key auth still flows via env
 * (OPENAI_API_KEY) and needs no file.
 *
 * Concurrency (plan §8.2): one Codex process per home at a time. `codexHomeMutex`
 * is a keyed mutex; callers acquire before spawn and release in `finally`.
 * Different logical sessions run in parallel; the same home is strictly serial.
 */
import type { TurnRequest } from '@forgeax/agent-runtime';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
 * Keep the user's authored native Codex capability configuration intact. The
 * session still has an isolated SQLite/history home, while native MCP, plugins,
 * hooks, marketplaces, models and project trust are loaded exactly as the user
 * configured them. ForgeaX adds its scoped `fxt` MCP through command-line
 * overrides; capability isolation comes from the process fingerprint and the
 * fxt double allowlist, not by deleting native functionality.
 */
export function sanitizeCodexConfig(raw: string): string {
  return raw;
}

/** Keep provider/model/UI preferences for imported turns, but remove every
 * user-authored native capability table. Imported content must not inherit a
 * local MCP, plugin, hook or marketplace that bypasses the host trust gate. */
export function sanitizeImportedCodexConfig(raw: string): string {
  const blocked = /^(?:mcp_servers|plugins|hooks|plugin_marketplaces)(?:\.|$)/;
  let omit = false;
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) omit = blocked.test(section[1]?.trim() ?? '');
    if (!omit) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Enabled native stdio MCPs whose startup must settle before a thread snapshots
 * the tool catalog. HTTP MCPs are intentionally excluded: authentication or an
 * unreachable remote must not turn app-server warm-up into an unbounded gate.
 *
 * This is a deliberately narrow TOML reader rather than a second config parser:
 * it recognizes only exact top-level `[mcp_servers.<name>]` tables and the two
 * scalar fields needed for admission (`command`, `enabled`). Nested `.env` /
 * `.http_headers` tables cannot be mistaken for servers.
 */
export function codexNativeStdioMcpNames(config: string): string[] {
  const found = new Map<string, { command: boolean; enabled: boolean }>();
  let current: { name: string; command: boolean; enabled: boolean } | undefined;
  const commit = (): void => {
    if (current?.command && current.enabled) found.set(current.name, current);
  };

  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/);
    if (section) {
      commit();
      let name = section[3] ?? section[2] ?? section[1] ?? '';
      if (section[1] !== undefined) {
        try { name = JSON.parse(`"${section[1]}"`) as string; } catch { name = section[1]; }
      }
      current = { name, command: false, enabled: true };
      continue;
    }
    if (/^\s*\[/.test(line)) {
      commit();
      current = undefined;
      continue;
    }
    if (!current) continue;
    if (/^\s*command\s*=/.test(line)) current.command = true;
    if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/i.test(line)) current.enabled = false;
  }
  commit();
  return [...found.keys()];
}

export function codexSessionNativeStdioMcpNames(dir: string): string[] {
  try {
    const names = codexNativeStdioMcpNames(readFileSync(join(dir, 'config.toml'), 'utf8'));
    // Installed plugins are represented to Codex through this native gateway.
    // Waiting for it preserves plugin/skill/app capabilities without having to
    // reinterpret every plugin manifest in ForgeaX.
    if (existsSync(join(dir, 'plugins'))) names.push('codex_apps');
    return [...new Set(names)];
  } catch {
    return [];
  }
}

const NATIVE_CAPABILITY_DIRS = ['skills', 'rules', 'plugins', 'vendor_imports'];

function refreshNativeCapabilityOverlay(sourceHome: string, sessionHome: string): void {
  for (const name of NATIVE_CAPABILITY_DIRS) {
    const source = join(sourceHome, name);
    const destination = join(sessionHome, name);
    if (!existsSync(source) || existsSync(destination)) continue;
    try {
      // A 300MB plugin cache must not be copied into every logical session.
      // The isolated home owns mutable history/SQLite; user-managed native
      // capability assets stay single-source and are visible through links.
      symlinkSync(source, destination, 'dir');
    } catch {
      /* best-effort: config and ForgeaX fxt still remain usable */
    }
  }
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
 *   - current `auth.json` so API-key/subscription auth works;
 *   - current `config.toml`, including native MCP/hooks/plugins, plus project trust;
 *   - links to user-managed native capability directories, avoiding per-session copies.
 */
export async function ensureCodexSessionHome(
  key: string,
  options: { nativeCapabilities?: boolean } = {},
): Promise<string> {
  const nativeCapabilities = options.nativeCapabilities !== false;
  const parts = key.split('/').map((p) => seg(p, 'x'));
  if (!nativeCapabilities) parts.push('imported-hermetic');
  const dir = join(resolveUserDir(), 'codex', ...parts);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'sessions'), { recursive: true });

  const src = userCodexHome();
  if (nativeCapabilities) refreshNativeCapabilityOverlay(src, dir);

  const authDest = join(dir, 'auth.json');
  const authSrc = join(src, 'auth.json');
  if (existsSync(authSrc)) {
    try {
      const sourceAuth = readFileSync(authSrc);
      const destinationAuth = existsSync(authDest) ? readFileSync(authDest) : undefined;
      if (!destinationAuth || !sourceAuth.equals(destinationAuth)) {
        copyFileSync(authSrc, authDest);
        await chmod(authDest, 0o600);
      }
    } catch {
      /* best-effort: fall back to env auth (OPENAI_API_KEY) if copy fails */
    }
  }

  // Current native config + trust for the current cwd (overwritten each call).
  const projectRoot = defaultProjectRoot();
  let cfg = '';
  try {
    const cfgSrc = join(src, 'config.toml');
    if (existsSync(cfgSrc)) {
      const raw = readFileSync(cfgSrc, 'utf8');
      cfg = nativeCapabilities ? sanitizeCodexConfig(raw) : sanitizeImportedCodexConfig(raw);
    }
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
 * Process-start inputs from the isolated home. Credential bytes are reduced to
 * a one-way digest so even a same-size/same-mtime login refresh invalidates the
 * process without putting the secret itself in diagnostics.
 */
export function codexSessionHomeFingerprint(dir: string): string {
  let config = '';
  try { config = readFileSync(join(dir, 'config.toml'), 'utf8'); } catch { /* missing */ }
  let authStamp = 'missing';
  try {
    authStamp = createHash('sha256').update(readFileSync(join(dir, 'auth.json'))).digest('hex');
  } catch { /* missing */ }
  return createHash('sha256').update([
    process.env.FORGEAX_CODEX_NATIVE_FINGERPRINT?.trim() ?? '',
    config,
    authStamp,
  ].join('\n')).digest('hex');
}

/** User-authored native sources observed before refreshing the session overlay. */
export function codexNativeSourceFingerprint(): string {
  const sourceHome = userCodexHome();
  const stamps: string[] = [];
  const activeDirectories = new Set<string>();
  const maxDepth = 64;
  const maxEntries = 50_000;
  let entries = 0;
  let limitStamped = false;
  const stamp = (path: string, relative = '', depth = 0): void => {
    if (depth > maxDepth || entries >= maxEntries) {
      if (!limitStamped) {
        stamps.push(`limit:${depth > maxDepth ? 'depth' : 'entries'}`);
        limitStamped = true;
      }
      return;
    }
    entries += 1;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        stamps.push(`${relative || path}:link:${stat.mode}:${readlinkSync(path)}`);
        // Capability managers commonly install skills/plugins as links into a
        // cache. Fingerprint the resolved content as well as the link itself so
        // an in-place target update replaces the warm app-server owner.
        const target = realpathSync(path);
        stamp(target, `${relative || path}:target`, depth + 1);
        return;
      }
      if (!stat.isDirectory()) {
        stamps.push(`${relative || path}:file:${stat.mode}:${stat.size}:${stat.mtimeMs}`);
        return;
      }
      const realDirectory = realpathSync(path);
      if (activeDirectories.has(realDirectory)) {
        stamps.push(`${relative || path}:cycle`);
        return;
      }
      // A directory mtime changes when Codex atomically replaces an ignored
      // runtime marker. Child entries already fingerprint every authored input,
      // so the directory's own mutable metadata is intentionally excluded.
      stamps.push(`${relative || path}:dir:${stat.mode}`);
      activeDirectories.add(realDirectory);
      try {
        for (const child of readdirSync(path).sort()) {
          // Runtime sockets/staging are process outputs, not authored capability
          // inputs. This applies equally inside a symlinked capability tree.
          if (
            child === '.plugin-appserver'
            || child === '.remote-plugin-install-staging'
            || child === '.codex-remote-plugin-install.json'
          ) continue;
          stamp(join(path, child), relative ? `${relative}/${child}` : child, depth + 1);
        }
      } finally {
        activeDirectories.delete(realDirectory);
      }
    } catch { stamps.push(`${relative || path}:missing`); }
  };
  stamp(join(sourceHome, 'config.toml'));
  stamp(join(sourceHome, 'auth.json'));
  for (const name of NATIVE_CAPABILITY_DIRS) stamp(join(sourceHome, name));
  return createHash('sha256').update([
    process.env.FORGEAX_CODEX_NATIVE_FINGERPRINT?.trim() ?? '',
    ...stamps,
  ].join('\n')).digest('hex');
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
