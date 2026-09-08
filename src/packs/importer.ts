/**
 * Phase D7 — `.fxpack` importer.
 *
 * Two-step contract per 10 §5.2:
 *   1. `inspectPack(zipPath)` — unzip to a tmp dir, parse manifest.fxpack.json,
 *      gather permissions per plugin, detect id collisions vs the current
 *      PluginRegistry snapshot, return a TrustDescriptor for the UI to
 *      render. The unzipped contents stay in tmp under `<id>-<rand>` so a
 *      subsequent install can reuse them — but `installPack` re-unzips
 *      defensively, so callers can also rm the tmp dir at will.
 *
 *   2. `installPack(zipPath, opts)` — re-unzip, copy each plugin tree to
 *      `<destRoot>/.forgeax/extensions/<id>/`, honouring conflictPolicy. We do
 *      NOT call `reloadExtensions()` here — the API endpoint chains that. Tests
 *      can install + assert on the dest tree without touching the live
 *      snapshot.
 *
 * Signature verification is reserved for a follow-up. The trust descriptor
 * already carries `signed: false` + a warning when the pack is unsigned, so
 * UIs can stop gating here and gain proof-of-origin in a later patch.
 */
import { mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { runCapture } from '../lib/node-spawn';
import { basename, join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ManifestSchema, type ExtensionManifest } from '@forgeax/types';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getExtensionSnapshot } from '../extensions/registry';
import {
  FxpackManifestSchema,
  type FxpackManifest,
  type FxpackTrustDescriptor,
  type FxpackInspectResult,
  type FxpackInspectFailure,
  type FxpackInstallInput,
  type FxpackInstallResult,
  type FxpackLifecycleInput,
  type FxpackLifecycleResult,
} from './types';
import { recordInstall, recordTrust } from './ledger';
import { verifyStaging } from './signing';
import { lookupTrustedKey } from './trusted-keys';

const NATIVE_BINARY_EXT = /\.(so|dll|dylib|node)$/i;

async function runUnzip(zipPath: string, destDir: string): Promise<void> {
  // -q quiet, -o overwrite without prompt (we own the dest dir).
  const { code, stderr } = await runCapture('unzip', ['-q', '-o', zipPath, '-d', destDir], { captureStderr: true });
  if (code !== 0) {
    throw Object.assign(new Error(`unzip exited ${code}: ${stderr}`), { code: 'unzip_error' });
  }
}

function sha256OfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return '';
  }
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
}

/** Copy before mutating the live tree, then swap sibling directories. */
function replaceTreeAtomically(src: string, dest: string): void {
  const parent = dirname(dest);
  const stem = basename(dest);
  const transactionId = crypto.randomUUID();
  const staged = join(parent, `.${stem}.install-${transactionId}`);
  const backup = join(parent, `.${stem}.backup-${transactionId}`);
  mkdirSync(parent, { recursive: true });
  copyTree(src, staged);
  const hadExisting = existsSync(dest);
  try {
    if (hadExisting) renameSync(dest, backup);
    renameSync(staged, dest);
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (hadExisting && existsSync(backup) && !existsSync(dest)) renameSync(backup, dest);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

function walk(root: string, out: string[] = [], rel = ''): string[] {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const r = rel ? `${rel}/${entry}` : entry;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out, r);
    else out.push(r);
  }
  return out;
}

function loadExtensionManifest(srcDir: string): ExtensionManifest {
  const raw = JSON.parse(readFileSync(join(srcDir, 'forgeax-extension.json'), 'utf-8'));
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw Object.assign(new Error(`plugin manifest invalid in ${srcDir}: ${parsed.error.issues.map((i) => i.message).join('; ')}`), {
      code: 'manifest_invalid',
    });
  }
  return parsed.data;
}

const EXTENSION_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

function extensionSlug(id: string): string | null {
  const slug = id.slice(id.lastIndexOf('/') + 1);
  return EXTENSION_SLUG_RE.test(slug) ? slug : null;
}

function lifecycleRoot(origin: FxpackLifecycleInput['destinationOrigin']): string {
  return origin === 'user' ? homedir() : defaultProjectRoot();
}

function installedManifest(dir: string, expectedId: string): ExtensionManifest | null {
  if (!existsSync(dir)) return null;
  try {
    const manifest = loadExtensionManifest(dir);
    return manifest.id === expectedId ? manifest : null;
  } catch {
    return null;
  }
}

function recordLifecycle(
  input: FxpackLifecycleInput,
  destRoot: string,
  manifest: ExtensionManifest,
  action: 'disable' | 'enable' | 'remove',
  state: 'enabled' | 'disabled' | 'removed',
  archivePath?: string,
): void {
  recordInstall(destRoot, {
    id: input.id,
    slug: extensionSlug(input.id)!,
    version: manifest.version,
    origin: input.destinationOrigin,
    ts: new Date().toISOString(),
    action,
    state,
    ...(archivePath === undefined ? {} : { archivePath }),
  });
}

export function disableInstalledExtension(input: FxpackLifecycleInput): FxpackLifecycleResult {
  const slug = extensionSlug(input.id);
  if (!slug) return { ok: false, code: 'bad_input', error: 'a valid extension id is required' };
  const destRoot = lifecycleRoot(input.destinationOrigin);
  const active = join(destRoot, '.forgeax', 'extensions', slug);
  const disabled = join(destRoot, '.forgeax', 'extensions-disabled', slug);
  const manifest = installedManifest(active, input.id);
  if (!manifest) return { ok: false, code: 'not_found', error: `enabled extension not found: ${input.id}` };
  if (existsSync(disabled)) return { ok: false, code: 'conflict', error: `disabled extension already exists: ${input.id}` };
  try {
    mkdirSync(dirname(disabled), { recursive: true });
    renameSync(active, disabled);
    recordLifecycle(input, destRoot, manifest, 'disable', 'disabled');
    return { ok: true, id: input.id, state: 'disabled', path: disabled };
  } catch (error) {
    return { ok: false, code: 'lifecycle_error', error: (error as Error).message };
  }
}

export function enableInstalledExtension(input: FxpackLifecycleInput): FxpackLifecycleResult {
  const slug = extensionSlug(input.id);
  if (!slug) return { ok: false, code: 'bad_input', error: 'a valid extension id is required' };
  const destRoot = lifecycleRoot(input.destinationOrigin);
  const active = join(destRoot, '.forgeax', 'extensions', slug);
  const disabled = join(destRoot, '.forgeax', 'extensions-disabled', slug);
  const manifest = installedManifest(disabled, input.id);
  if (!manifest) return { ok: false, code: 'not_found', error: `disabled extension not found: ${input.id}` };
  if (existsSync(active)) return { ok: false, code: 'conflict', error: `enabled extension already exists: ${input.id}` };
  try {
    mkdirSync(dirname(active), { recursive: true });
    renameSync(disabled, active);
    recordLifecycle(input, destRoot, manifest, 'enable', 'enabled');
    return { ok: true, id: input.id, state: 'enabled', path: active };
  } catch (error) {
    return { ok: false, code: 'lifecycle_error', error: (error as Error).message };
  }
}

export function removeInstalledExtension(input: FxpackLifecycleInput): FxpackLifecycleResult {
  const slug = extensionSlug(input.id);
  if (!slug) return { ok: false, code: 'bad_input', error: 'a valid extension id is required' };
  const destRoot = lifecycleRoot(input.destinationOrigin);
  const active = join(destRoot, '.forgeax', 'extensions', slug);
  const disabled = join(destRoot, '.forgeax', 'extensions-disabled', slug);
  const source = existsSync(active) ? active : disabled;
  const manifest = installedManifest(source, input.id);
  if (!manifest) return { ok: false, code: 'not_found', error: `installed extension not found: ${input.id}` };
  const archivePath = join(
    destRoot,
    '.forgeax',
    'extensions-removed',
    `${slug}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    mkdirSync(dirname(archivePath), { recursive: true });
    renameSync(source, archivePath);
    recordLifecycle(input, destRoot, manifest, 'remove', 'removed', archivePath);
    return { ok: true, id: input.id, state: 'removed', archivePath };
  } catch (error) {
    return { ok: false, code: 'lifecycle_error', error: (error as Error).message };
  }
}

function detectConflicts(
  newPlugins: Array<{ id: string; version: string }>,
): FxpackTrustDescriptor['conflicts'] {
  const snap = getExtensionSnapshot();
  const out: FxpackTrustDescriptor['conflicts'] = [];
  for (const np of newPlugins) {
    const hit = snap.manifests.find((m) => m.manifest.id === np.id);
    if (hit) {
      out.push({
        id: np.id,
        // npm-declared origin collapses to builtin for this trust descriptor
        // (3-value contract predates the npm origin); both are first-party.
        existingOrigin: hit.origin === 'npm' ? 'builtin' : hit.origin === 'dev' ? 'project' : hit.origin,
        existingVersion: hit.manifest.version,
        newVersion: np.version,
      });
    }
  }
  return out;
}

/** Unzip a `.fxpack` to `<tmp>/fxpack-inspect-<id>-<random>` and return the
 *  staging path. Caller is responsible for `rmSync(stagingDir)`. */
async function unzipToStaging(zipPath: string, tag: string): Promise<string> {
  const stagingDir = join(tmpdir(), `fxpack-${tag}-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    await runUnzip(zipPath, stagingDir);
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw e;
  }
  return stagingDir;
}

export async function inspectPack(
  zipPath: string,
  opts: { trustLookup?: { projectRoot?: string; homeDir?: string } } = {},
): Promise<FxpackInspectResult | FxpackInspectFailure> {
  if (!existsSync(zipPath)) {
    return { ok: false, code: 'bad_input', error: `pack not found: ${zipPath}` };
  }

  let staging: string;
  try {
    staging = await unzipToStaging(zipPath, 'inspect');
  } catch (e) {
    return { ok: false, code: 'unzip_error', error: (e as Error).message };
  }

  try {
    const manifestPath = join(staging, 'manifest.fxpack.json');
    if (!existsSync(manifestPath)) {
      return { ok: false, code: 'manifest_missing', error: 'manifest.fxpack.json not present at pack root' };
    }
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const parsed = FxpackManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'manifest_invalid',
        error: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    const manifest = parsed.data;

    const trust: FxpackTrustDescriptor = {
      signed: false,
      permissions: {},
      conflicts: [],
      warnings: [],
    };
    if (existsSync(join(staging, 'signature.json'))) {
      // 10 §4 — ed25519 verification. signing.ts:verifyStaging walks the
      // staging dir, recomputes sha256 per file, then runs node's
      // crypto.verify('ed25519', payload, embeddedPublicKey, signature).
      // `signed: true` is set only when that returns ok=true; tampering or
      // a stale digest map drops us into the "签名校验失败" branch so the
      // unsigned-warning UI path still gates installs.
      //
      // TODO: real key chain — trust currently piggy-backs on the embedded
      // public key + the trusted-keys.yaml lookup below. A future patch will
      // anchor against a project-pinned root + sigstore-style transparency
      // log so a stolen signing key can be revoked without rotating every
      // installer.
      const v = verifyStaging(staging);
      if (v.publicKey) trust.publicKey = v.publicKey;
      if (v.ok) {
        trust.signed = true;
        // 10 §4 — once the signature is mathematically valid, look up the
        // public key in trusted-keys.yaml to decide trust.
        const verdict = lookupTrustedKey(v.publicKey!, opts.trustLookup);
        trust.signerTrust = verdict.trust;
        if (verdict.label) trust.signerLabel = verdict.label;
        trust.signerTrustSource = verdict.source;
        if (verdict.trust === 'revoked') {
          trust.warnings.push(`签名密钥已吊销 · ${verdict.label ?? v.publicKey!.slice(0, 64)} · 拒绝安装`);
        } else if (verdict.trust === 'trusted') {
          trust.warnings.push(`已签名 · 信任发布者 ${verdict.label ?? v.publicKey!.slice(0, 64)}`);
        } else {
          trust.warnings.push(`已签名 · 未知发布者 ${v.publicKey!.slice(0, 64)} · 首次安装请确认来源`);
        }
      } else {
        trust.signed = false;
        const detail = v.detail?.length ? ` (${v.detail.slice(0, 3).join(', ')}${v.detail.length > 3 ? '...' : ''})` : '';
        trust.warnings.push(`签名校验失败 · ${v.reason ?? 'unknown'}${detail} · 请勿安装`);
      }
    } else {
      trust.warnings.push('未签名 · 请确认来源');
    }

    const pluginsDir = join(staging, 'plugins');
    if (!existsSync(pluginsDir)) {
      return { ok: false, code: 'manifest_invalid', error: '`plugins/` directory missing from pack' };
    }
    const containedIds = manifest.contains.map((c) => c.id);
    const extensionVersions: Array<{ id: string; version: string }> = [];

    for (const entry of containedIds) {
      const dir = join(pluginsDir, entry);
      if (!existsSync(dir)) {
        return { ok: false, code: 'manifest_invalid', error: `plugin ${entry} declared in contains[] but missing from plugins/` };
      }
      let pm: ExtensionManifest;
      try {
        pm = loadExtensionManifest(dir);
      } catch (e) {
        return { ok: false, code: 'manifest_invalid', error: (e as Error).message };
      }
      trust.permissions[entry] = pm.permissions ?? [];
      extensionVersions.push({ id: entry, version: pm.version });

      // Walk the plugin tree for native binaries — even imported they're
      // useless on a foreign platform; per 10 §7 reject.
      for (const f of walk(dir)) {
        if (NATIVE_BINARY_EXT.test(f)) {
          trust.warnings.push(`${entry}: 含 native 二进制 ${f},接收方平台可能跑不动`);
        }
      }
    }

    trust.conflicts = detectConflicts(extensionVersions);
    return { ok: true, manifest, trust };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function installPack(input: FxpackInstallInput): Promise<FxpackInstallResult> {
  if (!existsSync(input.zipPath)) {
    return { ok: false, code: 'bad_input', error: `pack not found: ${input.zipPath}` };
  }
  if (!input.destRoot) {
    return { ok: false, code: 'bad_input', error: 'destRoot is required' };
  }
  const policy = input.conflictPolicy ?? 'skip';

  // Step 1: re-inspect to ensure the pack is sane before we touch the FS.
  const inspect = await inspectPack(input.zipPath, { trustLookup: input.trustLookup });
  if (!inspect.ok) {
    return { ok: false, code: 'inspect_failed', error: inspect.error, details: inspect.code };
  }
  // 10 §4 — installation must hard-block when the signing key has been
  // explicitly revoked. The TrustPanel can warn earlier; this is the
  // last-ditch server-side gate so a UI bug can't bypass it.
  if (inspect.trust.signerTrust === 'revoked') {
    return {
      ok: false,
      code: 'inspect_failed',
      error: `signing key revoked · ${inspect.trust.signerLabel ?? inspect.trust.publicKey ?? 'unknown'}`,
      details: 'revoked_key',
    };
  }

  let staging: string;
  try {
    staging = await unzipToStaging(input.zipPath, 'install');
  } catch (e) {
    return { ok: false, code: 'install_error', error: (e as Error).message };
  }

  try {
    const extensionsRoot = join(input.destRoot, '.forgeax', 'extensions');
    mkdirSync(extensionsRoot, { recursive: true });
    const installed: string[] = [];
    const skipped: string[] = [];
    const renamed: Record<string, string> = {};

    const packSha = sha256OfFile(input.zipPath);
    const sourceTag = input.zipPath.split('/').pop() ?? input.zipPath;

    for (const entry of inspect.manifest.contains) {
      const srcDir = join(staging, 'plugins', entry.id);
      // On-disk dir name is the id's slug (last segment after `/`). The
      // scanner walks one level under the origin root, so a scope-prefixed
      // dir like `@me/foo` would land two levels deep and never be seen.
      // fork.ts already uses the same convention.
      const slash = entry.id.indexOf('/');
      const slug = slash >= 0 ? entry.id.slice(slash + 1) : entry.id;
      const destDir = join(extensionsRoot, slug);
      const hadExisting = existsSync(destDir);
      if (hadExisting) {
        if (policy === 'skip') {
          skipped.push(entry.id);
          continue;
        }
        if (policy === 'rename') {
          const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
          const renamedDir = `${destDir}-${stamp}`;
          copyTree(srcDir, renamedDir);
          renamed[entry.id] = renamedDir;
          recordInstall(input.destRoot, {
            id: entry.id,
            slug: `${slug}-${stamp}`,
            version: entry.version,
            origin: input.destinationOrigin,
            source: sourceTag,
            sha256: packSha,
            ts: new Date().toISOString(),
          });
          continue;
        }
        // overwrite is an upgrade. The copy below stages before swapping.
      }
      replaceTreeAtomically(srcDir, destDir);
      installed.push(entry.id);
      recordInstall(input.destRoot, {
        id: entry.id,
        slug,
        version: entry.version,
        origin: input.destinationOrigin,
        source: sourceTag,
        sha256: packSha,
        ts: new Date().toISOString(),
        action: hadExisting ? 'upgrade' : 'install',
        state: 'enabled',
      });
    }

    // 10 §plugins-trust.yaml — when the pack is unsigned but the user
    // explicitly acknowledged the warning, append a trust ack entry per
    // installed id. Re-installs of the same id will see the latest ack and
    // can suppress the warning. We write one entry per id (not per pack) so
    // bundles surface in the ledger at the right granularity.
    if (input.userAcknowledgedUnsigned && !inspect.trust.signed) {
      const ackTs = new Date().toISOString();
      for (const id of installed) {
        recordTrust(input.destRoot, {
          id,
          decision: 'allow',
          signed: false,
          ts: ackTs,
          reason: 'user-ack-unsigned',
        });
      }
      for (const id of Object.keys(renamed)) {
        recordTrust(input.destRoot, {
          id,
          decision: 'allow',
          signed: false,
          ts: ackTs,
          reason: 'user-ack-unsigned',
        });
      }
    }

    return { ok: true, installed, skipped, renamed };
  } catch (e) {
    return { ok: false, code: 'install_error', error: (e as Error).message };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export type {
  FxpackInstallInput,
  FxpackInstallResult,
  FxpackLifecycleInput,
  FxpackLifecycleResult,
  FxpackTrustDescriptor,
} from './types';
