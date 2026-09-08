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
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { normalizeManifest, parseAnyManifest } from '@forgeax/types';
import type { AnyExtensionManifest, ExtensionManifestV2 } from '@forgeax/types';
import { parseExtensionPackageManifest } from '@forgeax/toolkit/contracts';
import { defaultProjectRoot } from '@forgeax/platform-io';

export type ExtensionOrigin = 'builtin' | 'npm' | 'user' | 'project' | 'dev';

export interface DevExtensionRuntime {
  registrationId?: string;
  moduleUrl: string;
  allowedOrigin?: string;
  mode: 'dev' | 'installed';
}

export interface ScannedManifest {
  origin: ExtensionOrigin;
  originPath: string;
  manifest: AnyExtensionManifest;
  /** Canonical capability-shaped projection consumed by new hosts. */
  normalizedManifest: ExtensionManifestV2;
  runtime?: DevExtensionRuntime;
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

/** One-way compatibility boundary for installed directories created before
 * canonical extension IDs. Keep these legacy keys until the on-disk migration
 * window closes; new manifests and runtime identities must use the values. */
export const LEGACY_EXTENSION_SLUG_MIGRATIONS = new Map<string, string>([
  ['wb-agent-persona', 'agent-persona'], ['wb-ai-asset', 'ai-asset'],
  ['wb-anim', 'anim'], ['wb-asset-canvas', 'asset-canvas'],
  ['wb-balance', 'balance'], ['wb-bgm', 'bgm'], ['wb-character', 'character'],
  ['wb-code', 'code'], ['wb-diffusion-renderer', 'diffusion-renderer'],
  ['video-game', 'video-game'], ['wb-gen3d', 'gen3d'], ['wb-items', 'items'],
  ['wb-look', 'look'], ['wb-lowpoly-obj', 'lowpoly-obj'],
  ['wb-narrative', 'narrative'], ['wb-observatory', 'agent-monitor'],
  ['wb-plugin-author', 'plugin-author'], ['wb-reel', 'reel'], ['wb-skill', 'skill'],
  ['wb-team-forge', 'team-forge'], ['wb-ui', 'ui'],
  ['wb-2d-scene-asset-generator', '2d-scene-asset-generator'],
  ['wb-3d-lowpoly', '3d-lowpoly'], ['wb-scene-generator', 'scene-generator'],
]);

function canonicalExtensionId(id: string): string {
  const scoped = id.startsWith('@forgeax-plugin/')
    ? id.replace('@forgeax-plugin/', '@forgeax-extension/')
    : id.startsWith('@forgeax/')
      ? id.replace('@forgeax/', '@forgeax-extension/')
      : id;
  const prefix = '@forgeax-extension/';
  if (!scoped.startsWith(prefix)) return scoped;
  const slug = scoped.slice(prefix.length);
  return `${prefix}${LEGACY_EXTENSION_SLUG_MIGRATIONS.get(slug) ?? slug}`;
}

/** Rename installed extension directories once. Existing canonical installs
 * win; rerunning after migration is a no-op. */
function migrateLegacyExtensionIdentities(root: string): void {
  for (const [legacySlug, slug] of LEGACY_EXTENSION_SLUG_MIGRATIONS) {
    const legacy = join(root, legacySlug);
    const current = join(root, slug);
    try {
      if (safeIsDir(legacy) && !existsSync(current)) renameSync(legacy, current);
    } catch (error) {
      console.warn(`[extensions/scanner] identity migration failed (${legacy}): ${(error as Error).message}`);
    }
  }
}

/** Resolve the canonical root directory for each mutable origin.
 *
 *  builtin: no implicit filesystem root; product packages arrive through npm
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
  const projectRoot = opts?.projectRoot ?? defaultProjectRoot();
  migrateLegacyExtensionDir(homedir());
  if (projectRoot) migrateLegacyExtensionDir(projectRoot);
  const candidates = (paths: string[]) => paths.find((p) => safeIsDir(p)) ?? null;
  return {
    // Product-owned extensions are resolved from exact npm dependencies by
    // the product composition. Marketplace is a catalog, not a source root.
    builtin: null,
    // npm-declared extensions are resolved by the product composition root.
    // Keeping the slot in the origin record makes the scanner contract
    // explicit while avoiding a package-manager-specific lookup here.
    npm: null,
    user: candidates([resolve(homedir(), '.forgeax/extensions')]),
    project: projectRoot ? candidates([resolve(projectRoot, '.forgeax/extensions')]) : null,
    // Dev adapters are loaded only from the explicit registration index.
    dev: null,
  };
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
  migrateLegacyExtensionIdentities(root);
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
      const packagePath = join(extensionDir, 'package.json');
      let parsed = parseAnyManifest(json);
      if (existsSync(packagePath)) {
        const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { forgeaxExtension?: unknown };
        if (packageJson.forgeaxExtension !== undefined) {
          const extensionPackage = parseExtensionPackageManifest(packageJson, json);
          const modulePath = resolve(extensionDir, extensionPackage.module);
          if (!existsSync(modulePath)) {
            out.errors.push({ origin, originPath: manifestPath, reason: `extension artifact module is missing: ${extensionPackage.module}` });
            continue;
          }
          const nativeManifest = extensionPackage.manifest as unknown as AnyExtensionManifest;
          const extensionSlug = extensionPackage.manifest.id.slice(extensionPackage.manifest.id.lastIndexOf('/') + 1);
          out.found.push({
            origin,
            originPath: manifestPath,
            manifest: nativeManifest,
            normalizedManifest: nativeManifest as unknown as ExtensionManifestV2,
            runtime: {
              moduleUrl: `/extensions/${encodeURIComponent(extensionSlug)}/${extensionPackage.module.slice(2)}`,
              mode: 'installed',
            },
          });
          continue;
        }
      }
      if (!parsed.ok || !parsed.manifest) {
        const reason = parsed.error
          ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'zod parse failed';
        out.errors.push({ origin, originPath: manifestPath, reason });
        continue;
      }
      // ADR 0025 M3 — persistent-id namespace migration. Normalize at this
      // single read point so old user/project installs merge with their current
      // built-in identity instead of surfacing as duplicate activities.
      if (typeof parsed.manifest.id === 'string') {
        const legacyId = parsed.manifest.id;
        const canonicalId = canonicalExtensionId(legacyId);
        if (canonicalId !== legacyId) {
          parsed.manifest.id = canonicalId;
          console.warn(`[extensions/scanner] normalized legacy id ${legacyId} -> ${canonicalId} (${manifestPath})`);
        }
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
      const normalizedManifest = normalizeManifest(parsed.manifest);
      out.found.push({ origin, originPath: manifestPath, manifest: parsed.manifest, normalizedManifest });
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
  npmExtensionDirs: readonly string[] = [],
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
  for (const extensionDir of npmExtensionDirs) {
    const manifestPath = join(extensionDir, 'forgeax-extension.json');
    if (existsSync(manifestPath)) {
      const r = await scanExtensionOrigin('npm', dirname(extensionDir));
      merged.found.push(...r.found.filter((entry) => entry.originPath === manifestPath));
      merged.errors.push(...r.errors.filter((error) => error.originPath === manifestPath));
      continue;
    }
    const r = await scanExtensionOrigin('npm', extensionDir);
    merged.found.push(...r.found);
    merged.errors.push(...r.errors);
  }
  return merged;
}
