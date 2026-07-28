/**
 * Phase B1 — ManifestScanner.
 *
 * Walks the three extension origins (built-in / user-installed / project-specific) and
 * returns parsed ExtensionManifest[] tagged by origin. Zod-validation goes
 * through `@forgeax/types`, so any divergence between scanner and
 * marketplace manifest grammar surfaces here as a typed error.
 *
 * See docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.1
 * for the origin precedence contract and 13-MIGRATION-ROADMAP §B1.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseManifest } from '@forgeax/types';
import type { ExtensionManifest } from '@forgeax/types';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { assetRoot } from '@forgeax/platform-io';

export type ExtensionOrigin = 'builtin' | 'user' | 'project';

export interface ScannedManifest {
  origin: ExtensionOrigin;
  originPath: string;
  manifest: ExtensionManifest;
}

export interface ScanError {
  origin: ExtensionOrigin;
  originPath: string;
  reason: string;
}

export interface ScanResult {
  found: ScannedManifest[];
  errors: ScanError[];
}

/** Resolve the canonical root directory for each origin.
 *
 *  builtin: `<repo>/packages/marketplace/extensions`
 *  user: `~/.forgeax/extensions`
 *  project: `<projectRoot>/.forgeax/extensions`
 *
 *  Returns null for an origin when its root doesn't exist (so newcomers
 *  without ~/.forgeax don't trip an error). Caller can override roots
 *  via `opts` for tests. */
/** ADR 0025 M3.5 — user-disk directory migration (the sanctioned compat
 *  exception, same family as the scanner's legacy-id normalize): machines
 *  from before the Extension rename carry `.forgeax/plugins` directories.
 *  Rename once at the single resolution point; idempotent — skipped when
 *  the new dir already exists or the legacy one is absent. */
function migrateLegacyExtensionDir(base: string): void {
  const legacy = resolve(base, '.forgeax/plugins');
  const current = resolve(base, '.forgeax/extensions');
  try {
    if (safeIsDir(legacy) && !safeIsDir(current)) {
      renameSync(legacy, current);
      console.warn(`[extensions/scanner] migrated legacy directory ${legacy} -> ${current}`);
    }
  } catch (e) {
    console.warn(`[extensions/scanner] legacy directory migration failed (${legacy}): ${(e as Error).message}`);
  }
}

export function defaultExtensionRoots(opts?: { repoRoot?: string; projectRoot?: string }): Record<ExtensionOrigin, string | null> {
  const repoRoot = opts?.repoRoot ?? findRepoRoot();
  const projectRoot = opts?.projectRoot ?? defaultProjectRoot();
  migrateLegacyExtensionDir(homedir());
  if (projectRoot) migrateLegacyExtensionDir(projectRoot);
  const candidates = (paths: string[]) => paths.find((p) => safeIsDir(p)) ?? null;
  return {
    // builtin (host-bundled marketplace). assetRoot() resolves to `packages/` in dev
    // and `<Resources>/resources/` in the packaged .app, so this single
    // candidate covers both — crucial because findRepoRoot() can't locate a
    // `packages/marketplace` in the bundle (marketplace lives at
    // resources/marketplace) and would otherwise yield 0 plugins.
    builtin: candidates([
      resolve(assetRoot(), 'marketplace/extensions'),
      ...(repoRoot
        ? [
            resolve(repoRoot, 'packages/marketplace/extensions'),
            resolve(repoRoot, 'marketplace/extensions'),
          ]
        : []),
    ]),
    user: candidates([resolve(homedir(), '.forgeax/extensions')]),
    project: projectRoot ? candidates([resolve(projectRoot, '.forgeax/extensions')]) : null,
  };
}

/** Best-effort repo root finder: walks up from this file until it sees
 *  a directory with `packages/marketplace`. Allows the scanner to work
 *  when invoked from any CWD. */
function findRepoRoot(): string | null {
  let dir = resolve(import.meta.dirname, '..', '..', '..', '..');
  for (let i = 0; i < 4; i += 1) {
    if (safeIsDir(join(dir, 'packages', 'marketplace'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function safeIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function scanExtensionOrigin(origin: ExtensionOrigin, root: string): Promise<ScanResult> {
  const out: ScanResult = { found: [], errors: [] };
  // Async + withFileTypes — kills the per-entry statSync probe for "is this a
  // directory?" and the readdir itself stops blocking the event loop. The
  // existsSync on manifestPath is also gone; we just try-readFile and let
  // ENOENT surface as a 'continue' below.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    out.errors.push({ origin, originPath: root, reason: `readdir failed: ${(e as Error).message}` });
    return out;
  }
  for (const dirent of entries) {
    const name = dirent.name;
    if (name.startsWith('.')) continue;
    const extensionDir = join(root, name);
    if (!dirent.isDirectory() && !(dirent.isSymbolicLink() && safeIsDir(extensionDir))) continue;
    const manifestPath = join(extensionDir, 'forgeax-extension.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf-8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // not a plugin dir, just skip
      out.errors.push({ origin, originPath: manifestPath, reason: (e as Error).message });
      continue;
    }
    try {
      const json = JSON.parse(raw);
      const parsed = parseManifest(json);
      if (!parsed.ok || !parsed.manifest) {
        const reason = parsed.error
          ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'zod parse failed';
        out.errors.push({ origin, originPath: manifestPath, reason });
        continue;
      }
      // ADR 0025 M3 — persistent-id namespace migration: manifests authored
      // before the Extension rename carry `@forgeax-plugin/*`. Normalize at
      // this single read point so user-installed and project-specific extensions (old ids on
      // the user's disk — the sanctioned compat exception) keep resolving.
      if (typeof parsed.manifest.id === 'string' && parsed.manifest.id.startsWith('@forgeax-plugin/')) {
        const legacyId = parsed.manifest.id;
        parsed.manifest.id = legacyId.replace('@forgeax-plugin/', '@forgeax-extension/');
        console.warn(`[extensions/scanner] normalized legacy id ${legacyId} -> ${parsed.manifest.id} (${manifestPath})`);
      }
      // Doc 14 §4 — refuse entry.standalone.devOnly:true under production.
      // Authors use this to ship `bun --watch` shims without leaking into
      // packaged builds; the scanner is the right rejection point because
      // the manifest hasn't entered the kind registry yet.
      if (
        isProduction() &&
        parsed.manifest.entry?.standalone?.devOnly === true
      ) {
        out.errors.push({
          origin,
          originPath: manifestPath,
          reason: 'entry.standalone.devOnly:true rejected under production (FORGEAX_NODE_ENV=production)',
        });
        continue;
      }
      out.found.push({ origin, originPath: manifestPath, manifest: parsed.manifest });
    } catch (e) {
      out.errors.push({ origin, originPath: manifestPath, reason: (e as Error).message });
    }
  }
  return out;
}

/** Doc 14 §4 spike — Safe Boot: when `FORGEAX_SAFE_BOOT=1`, skip user+project
 *  scans so the host can be edited without a broken plugin breaking it.
 *  builtin (in-tree marketplace) is always scanned because the host bundles it.
 *  Returns `true` when safe-boot is active. */
export function isSafeBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORGEAX_SAFE_BOOT;
  return v === '1' || v === 'true' || v === 'yes';
}

/** Doc 14 §4 spike — Production gate for `entry.standalone.devOnly`.
 *  Reads `FORGEAX_NODE_ENV` (preferred — explicit) and falls back to
 *  `NODE_ENV`. Only the literal "production" counts. Used by the scanner
 *  to refuse devOnly standalone entries in packaged builds. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FORGEAX_NODE_ENV ?? env.NODE_ENV;
  return v === 'production';
}

/** Scan all three extension origins. Caller usually passes the result through
 *  ManifestMerger to dedupe by id. Honours `FORGEAX_SAFE_BOOT=1` by
 *  scanning builtin only. */
export async function scanAllExtensionOrigins(
  roots?: Partial<Record<ExtensionOrigin, string | null>>,
): Promise<ScanResult> {
  const resolved = { ...defaultExtensionRoots(), ...(roots ?? {}) };
  const merged: ScanResult = { found: [], errors: [] };
  const safe = isSafeBoot();
  for (const origin of ['builtin', 'user', 'project'] as const) {
    if (safe && origin !== 'builtin') continue;
    const root = resolved[origin];
    if (!root) continue;
    const r = await scanExtensionOrigin(origin, root);
    merged.found.push(...r.found);
    merged.errors.push(...r.errors);
  }
  return merged;
}
