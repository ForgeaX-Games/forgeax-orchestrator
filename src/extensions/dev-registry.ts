import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DevExtensionRegistrationSchema,
  parseExtensionPackageManifest,
  type DevExtensionRegistration,
} from '@forgeax/toolkit/contracts';
import type { DevExtensionRuntime, ScanError, ScannedManifest } from './scanner';

export const DEV_REGISTRATION_TTL_MS = 15_000;

const dynamic = new Map<string, DevExtensionRegistration>();
const suppressed = new Set<string>();

export function devRegistrationFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGEAX_STUDIO_DEV_REGISTRY_FILE ?? join(homedir(), '.forgeax', 'studio', 'dev-extensions.v2.json');
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function inside(root: string, child: string): boolean {
  const value = relative(root, child);
  return value !== '' && !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value);
}
function recordShape(value: unknown): value is DevExtensionRegistration {
  return DevExtensionRegistrationSchema.safeParse(value).success;
}

export function validateDevRegistration(value: unknown, now = Date.now()): { ok: true; registration: DevExtensionRegistration; scanned: ScannedManifest } | { ok: false; reason: string } {
  if (!recordShape(value)) return { ok: false, reason: 'registration schema or owner is invalid' };
  const registration = value;
  if (!isAbsolute(registration.artifactDirectory) || !isAbsolute(registration.manifestPath)) return { ok: false, reason: 'artifactDirectory and manifestPath must be absolute' };
  if (!existsSync(registration.artifactDirectory) || !existsSync(registration.manifestPath)) return { ok: false, reason: 'artifact or manifest does not exist' };
  const artifactDirectory = realpathSync(registration.artifactDirectory);
  const manifestPath = realpathSync(registration.manifestPath);
  if (artifactDirectory !== resolve(registration.artifactDirectory) || manifestPath !== resolve(registration.manifestPath)) return { ok: false, reason: 'artifact and manifest paths must be canonical' };
  if (!inside(artifactDirectory, manifestPath) || dirname(manifestPath) !== artifactDirectory) return { ok: false, reason: 'manifest must be directly owned by the artifact directory' };
  try {
    const marker = JSON.parse(readFileSync(join(artifactDirectory, '.forgeax-artifact.json'), 'utf8')) as Record<string, unknown>;
    if (marker.owner !== '@forgeax/toolkit' || marker.mode !== 'dev') return { ok: false, reason: 'artifact ownership marker is invalid' };
  } catch { return { ok: false, reason: 'artifact ownership marker is missing or invalid' }; }
  let url: URL;
  try { url = new URL(registration.moduleUrl); } catch { return { ok: false, reason: 'moduleUrl is invalid' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.origin !== registration.allowedOrigin) return { ok: false, reason: 'moduleUrl and allowedOrigin do not describe one exact HTTP origin' };
  if (registration.pid <= 0 || !pidAlive(registration.pid)) return { ok: false, reason: 'registration process is not alive' };
  if (registration.heartbeatAt < registration.startedAt || now - registration.heartbeatAt > DEV_REGISTRATION_TTL_MS) return { ok: false, reason: 'registration heartbeat is stale' };
  try {
    const packageJson = JSON.parse(readFileSync(join(artifactDirectory, 'package.json'), 'utf8'));
    const parsed = parseExtensionPackageManifest(
      packageJson,
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    );
    if (manifestPath !== join(artifactDirectory, parsed.metadata.manifest)) {
      return { ok: false, reason: 'manifestPath does not match the extension package contract' };
    }
    if (parsed.manifest.id !== registration.extensionId) return { ok: false, reason: 'manifest id does not match extensionId' };
    const runtime: DevExtensionRuntime = { registrationId: registration.registrationId, moduleUrl: registration.moduleUrl, allowedOrigin: registration.allowedOrigin, mode: 'dev' };
    const manifest = parsed.manifest as unknown as ScannedManifest['manifest'];
    return { ok: true, registration, scanned: { origin: 'dev', originPath: manifestPath, manifest, normalizedManifest: manifest as ScannedManifest['normalizedManifest'], runtime } };
  } catch (error) { return { ok: false, reason: `could not read extension package: ${(error as Error).message}` }; }
}

function fileRecords(path = devRegistrationFile()): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; registrations?: unknown };
    return parsed.schemaVersion === 2 && Array.isArray(parsed.registrations)
      ? parsed.registrations
      : [];
  } catch { return []; }
}

export function loadDevExtensions(path = devRegistrationFile()): { found: ScannedManifest[]; errors: ScanError[] } {
  const records = fileRecords(path);
  const presentIds = new Set(records.flatMap((value) => recordShape(value) ? [value.registrationId] : []));
  for (const id of suppressed) if (!presentIds.has(id)) suppressed.delete(id);
  const candidates = [...records, ...dynamic.values()];
  const found: ScannedManifest[] = []; const errors: ScanError[] = []; const ids = new Set<string>(); const extensions = new Set<string>();
  for (const value of candidates) {
    const hint = recordShape(value) ? value.registrationId : 'unknown';
    if (suppressed.has(hint) || ids.has(hint)) continue;
    const checked = validateDevRegistration(value);
    if (!checked.ok) { errors.push({ origin: 'dev', originPath: path, reason: `${hint}: ${checked.reason}` }); continue; }
    if (extensions.has(checked.registration.extensionId)) { errors.push({ origin: 'dev', originPath: path, reason: `${hint}: duplicate dev extension id` }); continue; }
    ids.add(hint); extensions.add(checked.registration.extensionId); found.push(checked.scanned);
  }
  return { found, errors };
}

export function registerDevExtension(value: unknown): { ok: true; registration: DevExtensionRegistration } | { ok: false; reason: string } {
  const checked = validateDevRegistration(value); if (!checked.ok) return checked;
  dynamic.set(checked.registration.registrationId, checked.registration); suppressed.delete(checked.registration.registrationId);
  return { ok: true, registration: checked.registration };
}
export function unregisterDevExtension(registrationId: string): void { dynamic.delete(registrationId); suppressed.add(registrationId); }
export function _resetDevExtensionsForTests(): void { dynamic.clear(); suppressed.clear(); }
