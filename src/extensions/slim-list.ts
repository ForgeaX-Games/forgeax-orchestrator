// packages/orchestrator/src/extensions/slim-list.ts
//
// The slim extension list the shell strip consumes (formerly api/bus.ts
// loadExtensionList, ADR 0025 M3): manifest snapshot -> UI-facing ExtensionInfo
// items, with dev-port overrides + stable Activity order. Served by
// GET /api/extensions/list (api/extensions.ts).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionOrigin } from './scanner';
import type { MergedManifest } from './merger';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { computeAgentNaming, pickPersonName } from '../api/lib/agent-naming';
import type { ExtensionManifestV2 } from '@forgeax/types';

interface ExtensionManifest {
  schemaVersion?: number;
  id?: string;
  version?: string;
  kind?: string;
  displayName?: { zh?: string; en?: string; ja?: string } | string;
  description?: { zh?: string; en?: string; ja?: string } | string;
  icon?: string;
  experimental?: boolean;
  provides?: {
    modelBinding?: {
      channel: string;
      vendor: string;
      models?: string[];
      roles?: string[];
    };
    /** Bundled persona family; slim projection only needs id/role. */
    agents?: Array<{ id?: string; role?: string }>;
    skills?: Array<{ id: string; trigger?: string }>;
    tools?: Array<{ id: string; exposedToAI?: boolean }>;
    events?: Array<{ name: string }>;
    cliProvider?: {
      id: string;
      displayName?: string;
      models?: string[];
      capabilities?: {
        streaming?: boolean;
        thinking?: boolean;
        toolCalls?: boolean;
        subAgents?: boolean;
        sessions?: boolean;
      };
    };
    agent?: {
      id?: string;
      role?: string;
      personaFile?: string;
      memoryDir?: string;
      preferredCliProvider?: string;
      defaultLang?: string;
      multiInstance?: boolean;
      defaultSkills?: unknown[];
      produces?: string[];
      card?: {
        name?: { zh?: string; en?: string } | string;
        cnTitle?: string;
        enTitle?: string;
        color?: string;
        avatar?: string;
      };
    };
  };
  entry?: {
    frontend?: string;
    standalone?: {
      start?: string;
      port?: number;
      readyProbe?: string;
      embeddedAlso?: boolean;
    };
  };
}

export interface ExtensionInfo {
  id: string;
  version: string;
  kind: string;
  displayName: { zh?: string; en?: string; ja?: string } | string;
  description?: { zh?: string; en?: string; ja?: string } | string;
  icon?: string;
  experimental?: boolean;
  /** Canonical manifest-v2 contribution catalog for browser hosts. */
  contributes?: ExtensionManifestV2['contributes'];
  modelBinding?: ExtensionManifest['provides'] extends infer P
    ? P extends { modelBinding?: infer M }
      ? M
      : never
    : never;
  /** Bundled persona family (id/role only). */
  agents?: Array<{ id: string; role: string }>;
  skills?: Array<{ id: string; trigger: string }>;
  tools?: Array<{ id: string; exposedToAI?: boolean }>;
  events?: Array<{ name: string }>;
  cliProvider?: {
    id: string;
    displayName: string;
    models?: string[];
    capabilities: {
      streaming: boolean;
      thinking: boolean;
      toolCalls: boolean;
      subAgents: boolean;
      sessions: boolean;
    };
  };
  agent?: {
    id: string;
    role: string;
    personaFile?: string;
    memoryDir?: string;
    preferredCliProvider?: string;
    defaultLang?: string;
    multiInstance?: boolean;
    defaultSkills?: unknown[];
    produces?: string[];
    card?: {
      name?: { zh?: string; en?: string } | string;
      cnTitle?: string;
      enTitle?: string;
      color?: string;
      avatar?: string;
    };
  };
  /** 统一命名（kind=agent 才有）：title=「中文职能·英文名」，sub=灰字英文职能。 */
  naming?: { title: string; sub: string };
  /** Browser-safe origin descriptor. `relativeManifestPath` is the manifest
   *  path relative to the origin root (`<slug>/forgeax-extension.json`) — never
   *  the absolute `originPath`, which would leak the host's home directory to
   *  the shell strip. The UI rebuilds a filesystem path from `origin` + this. */
  source: { origin: ExtensionOrigin; relativeManifestPath: string };
  frontendUrl?: string;
  moduleUrl?: string;
  allowedOrigin?: string;
  runtimeMode?: 'native-module' | 'embedded' | 'standalone';
  registryGeneration?: number;
  entry?: {
    frontend?: string;
    standalone?: {
      start?: string;
      port?: number;
      readyProbe?: string;
      embeddedAlso?: boolean;
    };
  };
}

interface ExtensionDevPortOverrides {
  plugins?: Record<string, {
    frontendPort?: number;
    backendPort?: number;
  }>;
}

function extensionDevPortOverridesPath(): string {
  // New env/file names first (ADR 0025 词汇清尾, run.ts writes these);
  // legacy names accepted so an old running stack keeps working across the
  // rename (file is regenerated on every `bun fx start`).
  return process.env.FORGEAX_EXTENSION_DEV_PORTS_FILE
    ?? process.env.FORGEAX_PLUGIN_DEV_PORTS_FILE
    ?? [
      join(defaultProjectRoot(), '.forgeax', 'extension-dev-ports.json'),
      join(defaultProjectRoot(), '.forgeax', 'plugin-dev-ports.json'),
    ].find(existsSync)
    ?? join(defaultProjectRoot(), '.forgeax', 'extension-dev-ports.json');
}

function loadExtensionDevPortOverrides(): ExtensionDevPortOverrides | null {
  const path = extensionDevPortOverridesPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ExtensionDevPortOverrides;
  } catch (e) {
    console.warn(`[api/bus] ignored invalid plugin dev port overrides: ${(e as Error).message}`);
    return null;
  }
}

function isUsablePort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
}

function applyExtensionDevPortOverrides(
  items: ExtensionInfo[],
  overrides: ExtensionDevPortOverrides | null,
): ExtensionInfo[] {
  if (!overrides?.plugins) return items;
  for (const item of items) {
    const override = overrides.plugins[item.id];
    if (!override || !isUsablePort(override.frontendPort) || !item.entry?.standalone) continue;
    item.entry.standalone.port = override.frontendPort;
  }
  return items;
}

export function applyExtensionDevPortOverridesForTest(
  items: ExtensionInfo[],
  overrides: ExtensionDevPortOverrides | null,
): ExtensionInfo[] {
  return applyExtensionDevPortOverrides(items, overrides);
}

/** Derive the origin-relative manifest path from an absolute originPath.
 *  Extension roots always end at `<origin-root>/<slug>/forgeax-extension.json`, so
 *  the last two path segments are the browser-safe descriptor. Splitting on
 *  both separators keeps this correct for Windows origin paths too. */
function relativeManifestPathFrom(originPath: string): string {
  const parts = originPath.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** Map one merged manifest to its slim, browser-facing ExtensionInfo. Returns
 *  null for manifests missing required identity fields (caller skips them).
 *  Every returned item carries a `source` descriptor built from the origin +
 *  origin-relative manifest path — never the absolute originPath. */
export function projectExtensionInfo(mergedManifest: MergedManifest): ExtensionInfo | null {
  const m = mergedManifest.manifest as ExtensionManifest;
  if (!m.id || !m.version || !m.displayName) return null;
  const normalized = mergedManifest.normalizedManifest;
      const slim: ExtensionInfo = {
        id: m.id,
        version: m.version,
        kind: m.kind ?? normalized.categories?.[0] ?? 'extension',
        displayName: m.displayName,
        description: m.description,
        icon: m.icon,
        experimental: m.experimental,
        ...(normalized ? { contributes: normalized.contributes } : {}),
        source: {
          origin: mergedManifest.origin,
          relativeManifestPath: relativeManifestPathFrom(mergedManifest.originPath),
        },
      };
      const modelBinding = normalized.contributes.modelBindings?.[0];
      if (modelBinding) {
        slim.modelBinding = {
          channel: modelBinding.channel,
          vendor: modelBinding.vendor,
          models: modelBinding.models ?? [],
          roles: modelBinding.roles,
        } as ExtensionInfo['modelBinding'];
      }
      if (normalized.contributes.skills?.length) {
        slim.skills = normalized.contributes.skills.map((s) => ({
          id: s.id,
          trigger: s.trigger ?? `/${s.id}`,
        }));
      }
      if (normalized.contributes.tools?.length) {
        slim.tools = normalized.contributes.tools.map((t) => ({
          id: t.id,
          exposedToAI: t.exposedToAI,
        }));
      }
      if (normalized.contributes.events?.length) {
        slim.events = normalized.contributes.events.map((e) => ({ name: e.name }));
      }
      if (normalized.contributes.agents?.length) {
        slim.agents = normalized.contributes.agents.map((agent) => ({ id: agent.id, role: agent.role }));
      }
      const a = normalized.contributes.agents?.[0];
      if (a) {
        slim.agent = {
          id: a.id ?? m.id,
          role: a.role ?? 'unknown',
          personaFile: a.personaFile,
          memoryDir: a.memoryDir,
          preferredCliProvider: a.preferredCliProvider,
          defaultLang: a.defaultLang,
          multiInstance: a.multiInstance,
          defaultSkills: a.defaultSkills,
          produces: a.produces,
          card: a.card,
        };
        const cn = a.card?.cnTitle;
        const fallback = typeof m.displayName === 'string'
          ? m.displayName
          : (m.displayName.zh ?? m.displayName.en ?? a.id ?? m.id);
        slim.naming = computeAgentNaming({
          personName: cn ? pickPersonName(a.card?.name) : undefined,
          cnTitle: cn,
          enTitle: a.card?.enTitle,
          fallback,
        });
      }
      const cp = normalized.contributes.cliProviders?.[0];
      if (cp) {
        slim.cliProvider = {
          id: cp.id,
          displayName: cp.displayName ?? cp.id,
          models: cp.models ?? [],
          capabilities: {
            streaming: Boolean(cp.capabilities?.streaming),
            thinking: Boolean(cp.capabilities?.thinking),
            toolCalls: Boolean(cp.capabilities?.toolCalls),
            subAgents: Boolean(cp.capabilities?.subAgents),
            sessions: Boolean(cp.capabilities?.sessions),
          },
        };
      }
      if (mergedManifest.runtime) {
        slim.moduleUrl = mergedManifest.runtime.moduleUrl;
        if (mergedManifest.runtime.allowedOrigin) slim.allowedOrigin = mergedManifest.runtime.allowedOrigin;
        slim.runtimeMode = 'native-module';
      } else if (m.entry?.standalone) {
        slim.runtimeMode = 'standalone';
      } else if (m.entry?.frontend) {
        slim.runtimeMode = 'embedded';
      }
      if (m.entry?.frontend || m.entry?.standalone) {
        slim.entry = {};
        if (m.entry.frontend) slim.entry.frontend = m.entry.frontend;
        if (m.entry.standalone) {
          slim.entry.standalone = {
            start: m.entry.standalone.start,
            port: m.entry.standalone.port,
            readyProbe: m.entry.standalone.readyProbe,
            embeddedAlso: m.entry.standalone.embeddedAlso,
          };
        }
      }
      return slim;
}

/** Test hook — exercise the single-manifest projection (incl. `source`)
 *  without spinning up a disk scan. */
export const projectExtensionInfoForTest = projectExtensionInfo;

function projectExtensionList(
  manifests: readonly MergedManifest[],
  registryGeneration = 0,
): ExtensionInfo[] {
  const items: ExtensionInfo[] = [];
  for (const mergedManifest of manifests) {
    const slim = projectExtensionInfo(mergedManifest);
    if (slim) {
      slim.registryGeneration = registryGeneration;
      items.push(slim);
    }
  }

  applyExtensionDevPortOverrides(items, loadExtensionDevPortOverrides());

  // Stable sort by launcher order, then id, so the Activity rail is deterministic.
  items.sort((a, b) => {
    const ap = a.contributes?.activities?.[0]?.order ?? 999;
    const bp = b.contributes?.activities?.[0]?.order ?? 999;
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });

  return items;
}

/** Test hook — project the same authoritative manifest set used by the API. */
export const projectExtensionListForTest = projectExtensionList;

export function loadExtensionList(
  manifests: readonly MergedManifest[],
  registryGeneration = 0,
): ExtensionInfo[] {
  return projectExtensionList(manifests, registryGeneration);
}
