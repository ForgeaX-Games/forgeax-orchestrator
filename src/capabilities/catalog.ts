import type {
  CapabilityDescriptor,
  CapabilityIsolation,
  CapabilityKind,
  CapabilityOrigin,
  CapabilitySnapshot,
  CapabilityTrustTier,
  ExtensionManifest,
} from '@forgeax/types';
import type { ExtensionOrigin } from '../extensions/scanner';
import type { MergedManifest } from '../extensions/merger';
import type { KindRegistry } from '../extensions/kinds';

export interface CapabilityRegistryInput {
  generation: number;
  loadedAt: number;
  manifests: readonly MergedManifest[];
  kinds: KindRegistry;
  scanErrors: readonly { reason: string }[];
  mergeIssues: readonly { detail: string }[];
}

interface DeclaredCapability {
  id: string;
  kind: CapabilityKind;
  metadata?: Readonly<Record<string, unknown>>;
}

function trustForOrigin(origin: ExtensionOrigin): CapabilityTrustTier {
  return origin === 'builtin' ? 'own' : 'imported';
}

function originFor(origin: ExtensionOrigin): CapabilityOrigin {
  return origin;
}

function defaultIsolation(kind: CapabilityKind, metadata?: Record<string, unknown>): CapabilityIsolation {
  const memoryTiers = Array.isArray(metadata?.memoryTiers)
    ? metadata.memoryTiers.filter(
        (tier): tier is 'identity' | 'traits' | 'episodes' =>
          tier === 'identity' || tier === 'traits' || tier === 'episodes',
      )
    : [];
  return {
    project: true,
    agent: true,
    session: true,
    thread: true,
    memoryTiers,
  };
}

function declaredFromManifest(manifest: ExtensionManifest): DeclaredCapability[] {
  const provides = manifest.provides as Record<string, unknown>;
  const out: DeclaredCapability[] = [
    { id: manifest.id, kind: 'extension' },
  ];
  for (const key of ['commands', 'mcp', 'memory'] as const) {
    const raw = provides[key];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (typeof value.id !== 'string' && typeof value.name !== 'string') continue;
      const id = String(value.id ?? value.name);
      out.push({ id, kind: key === 'commands' ? 'command' : key, metadata: value });
    }
  }
  return out;
}

function descriptor(
  merged: MergedManifest,
  declared: DeclaredCapability,
  generation: number,
): CapabilityDescriptor {
  const manifest = merged.manifest;
  const metadata = declared.metadata;
  const requiresRestart =
    declared.kind === 'mcp' &&
    typeof metadata?.requiresRestart === 'boolean' &&
    metadata.requiresRestart;
  return {
    capabilityId: `${manifest.id}#${declared.kind}:${declared.id}`,
    kind: declared.kind,
    extensionId: manifest.id,
    extensionVersion: manifest.version,
    schemaVersion: manifest.schemaVersion,
    origin: originFor(merged.origin),
    originPath: merged.originPath,
    shadowedBy: merged.shadowedBy.map((shadowed) => ({
      origin: shadowed.origin,
      originPath: shadowed.originPath,
    })),
    trustTier: trustForOrigin(merged.origin),
    permissions: manifest.permissions ?? [],
    dependencies: (manifest.dependencies ?? []).map((dependency) => dependency.id),
    lifecycle: {
      state: 'ready',
      reloadable: manifest.hot ?? true,
      requiresRestart: requiresRestart || declared.kind === 'extension' && manifest.kind === 'cli-provider',
    },
    isolation: defaultIsolation(declared.kind, metadata),
    generation,
    localId: declared.id,
    ...(metadata ? { metadata } : {}),
  };
}

function addKindEntries(
  out: CapabilityDescriptor[],
  manifests: readonly MergedManifest[],
  kind: 'skill' | 'tool',
  generation: number,
): void {
  const byExtension = new Map(manifests.map((merged) => [merged.manifest.id, merged]));
  for (const merged of manifests) {
    const entries = kind === 'skill'
      ? (merged.manifest.provides as { skills?: Array<{ id: string; description?: unknown }> }).skills ?? []
      : (merged.manifest.provides as { tools?: Array<{ id: string; description?: unknown }> }).tools ?? [];
    for (const entry of entries) {
      const source = byExtension.get(merged.manifest.id);
      if (!source) continue;
      out.push(
        descriptor(source, {
          id: entry.id,
          kind,
          metadata: { description: entry.description ?? null },
        }, generation),
      );
    }
  }
}

export function buildCapabilitySnapshot(input: CapabilityRegistryInput): CapabilitySnapshot {
  const capabilities: CapabilityDescriptor[] = [];
  for (const merged of input.manifests) {
    for (const declared of declaredFromManifest(merged.manifest)) {
      capabilities.push(descriptor(merged, declared, input.generation));
    }
  }
  addKindEntries(capabilities, input.manifests, 'skill', input.generation);
  addKindEntries(capabilities, input.manifests, 'tool', input.generation);

  return Object.freeze({
    generation: input.generation,
    loadedAt: input.loadedAt,
    capabilities: Object.freeze(capabilities),
    issues: Object.freeze([
      ...input.scanErrors.map((error) => error.reason),
      ...input.mergeIssues.map((issue) => issue.detail),
      ...input.kinds.issues.map((issue) => `${issue.extensionId}: ${issue.reason}`),
    ]),
  });
}

export function findCapabilities(
  snapshot: CapabilitySnapshot,
  query: { kind?: CapabilityKind; extensionId?: string; localId?: string },
): CapabilityDescriptor[] {
  return snapshot.capabilities.filter((capability) =>
    (!query.kind || capability.kind === query.kind) &&
    (!query.extensionId || capability.extensionId === query.extensionId) &&
    (!query.localId || capability.localId === query.localId),
  );
}
