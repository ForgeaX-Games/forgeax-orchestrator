/**
 * Phase B2 — Kind dispatcher.
 *
 * Walks every merged manifest and feeds the right per-kind loader. Returns
 * a populated KindRegistry that B3's PluginRegistry.replaceFromManifests
 * swaps into the live host.
 *
 * Skill discovery runs across all contribution-shaped extensions and legacy
 * all declare provides.skills), but the per-kind loader for the main kind
 * runs only when the discriminated kind matches.
 */
import type { MergedManifest } from '../merger';
import { loadAgent } from './agent';
import { loadCliProvider } from './cli-provider';
import { loadSkills } from './skill';
import { loadTools } from './tool';
import { emptyKindRegistry, type KindRegistry } from './types';

export function buildKindRegistry(manifests: MergedManifest[]): KindRegistry {
  const reg = emptyKindRegistry();
  for (const m of manifests) {
    // All agent contributions converge in the capability-shaped registry.
    const ag = loadAgent(m);
    reg.agents.push(...ag.entries);
    reg.issues.push(...ag.issues);

    const sk = loadSkills(m);
    reg.skills.push(...sk.entries);
    reg.issues.push(...sk.issues);

    const cp = loadCliProvider(m);
    if (cp.entry) reg.cliProviders.push(cp.entry);
    reg.issues.push(...cp.issues);

    const tl = loadTools(m);
    reg.tools.push(...tl.entries);
    reg.issues.push(...tl.issues);

    // Phase D stub: model-binding still untouched until the gateway needs it.
    if (m.manifest.schemaVersion === 1 && m.manifest.kind === 'model-binding') {
      reg.modelBindings.push({ extensionId: m.manifest.id, manifest: m.manifest });
    }
  }
  return reg;
}

export type { KindRegistry, AgentEntry, SkillEntry, KindLoadIssue } from './types';
export type { CliProviderEntry } from './cli-provider';
export { loadDriverForEntry } from './cli-provider';
export type { ToolEntry } from './tool';
