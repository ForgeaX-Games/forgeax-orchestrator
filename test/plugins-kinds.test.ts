/**
 * Phase B2 unit tests for kind loaders. Builds disposable manifests in
 * /tmp and verifies workbench/skill/agent entries materialize correctly.
 *
 * w3 additions: requireConfirm three-value enum pass-through via loadTools()
 * (ToolEntry.requireConfirm) and listTools() (ToolDescriptor.requireConfirm).
 * AC-02 / AC-13.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllExtensionOrigins } from '../src/extensions/scanner';
import { mergeManifests } from '../src/extensions/merger';
import { buildKindRegistry } from '../src/extensions/kinds';
import {
  listTools,
  _resetToolHandlerCacheForTests,
} from '../src/tools/registry';
import {
  _setSnapshotForTests,
  _resetSnapshotForTests,
} from '../src/extensions/registry';
import { _resetEventBusForTests } from '../src/events/bus';

const TMP = `/tmp/forgeax-kinds-${process.pid}`;

function mkmanifest(origin: 'builtin' | 'user' | 'project', dirName: string, body: Record<string, unknown>): string {
  const dir = join(TMP, origin, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
  return dir;
}

const ROOTS = () => ({
  builtin: join(TMP, 'builtin'),
  user: join(TMP, 'user'),
  project: join(TMP, 'project'),
});

async function reloadFromTmp() {
  const scan = await scanAllExtensionOrigins(ROOTS());
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  _setSnapshotForTests({
    generation: 1,
    loadedAt: Date.now(),
    manifests: merge.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merge.issues,
  });
  return kinds;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['builtin', 'user', 'project'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
});

// Extension Page contributions are consumed directly from normalized manifests;
// the kind registry intentionally contains only sanctioned non-UI v1 capabilities.

// w3: AC-02 / AC-13 — requireConfirm three-value enum pass-through
describe('loadTools requireConfirm enum pass-through (AC-02)', () => {
  it('passes requireConfirm:destructive from manifest through ToolEntry', async () => {
    mkmanifest('user', 'rc-destructive', {
      id: '@x/rc-destructive',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      provides: {
        tools: [{ id: 'rd.del', exposedToAI: true, requireConfirm: 'destructive' }],
      },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'rd.del')!;
    expect(entry).toBeDefined();
    // This assertion fails before w4 because ToolEntry.requireConfirm is boolean
    expect(entry.requireConfirm).toBe('destructive');
  });

  it('passes requireConfirm:never through ToolEntry', async () => {
    mkmanifest('user', 'rc-never', {
      id: '@x/rc-never',
      kind: 'tool',
      displayName: { zh: 'n', en: 'n' },
      provides: { tools: [{ id: 'rn.t', requireConfirm: 'never' }] },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'rn.t')!;
    expect(entry).toBeDefined();
    expect(entry.requireConfirm).toBe('never');
  });

  it('passes requireConfirm:undefined (omitted) through ToolEntry', async () => {
    mkmanifest('user', 'rc-omit', {
      id: '@x/rc-omit',
      kind: 'tool',
      displayName: { zh: 'o', en: 'o' },
      provides: { tools: [{ id: 'ro.t' }] },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'ro.t')!;
    expect(entry).toBeDefined();
    // undefined (no value) is the correct state when manifest omits requireConfirm
    expect(entry.requireConfirm).toBeUndefined();
  });
});

// w3: AC-13 — listTools() ToolDescriptor contains requireConfirm field
describe('listTools ToolDescriptor requireConfirm (AC-13)', () => {
  it('ToolDescriptor.requireConfirm is destructive when manifest declares it', async () => {
    mkmanifest('user', 'desc-destructive', {
      id: '@x/desc-destructive',
      kind: 'tool',
      displayName: { zh: 'd', en: 'd' },
      provides: {
        tools: [{ id: 'dd.del', exposedToAI: true, requireConfirm: 'destructive' }],
      },
    });
    await reloadFromTmp();
    const list = listTools();
    const desc = list.find((t) => t.id === 'dd.del')!;
    expect(desc).toBeDefined();
    // This assertion fails before w4 because ToolDescriptor.requireConfirm is boolean
    expect(desc.requireConfirm).toBe('destructive');
  });

  it('ToolDescriptor.requireConfirm is undefined when manifest omits field', async () => {
    mkmanifest('user', 'desc-omit', {
      id: '@x/desc-omit',
      kind: 'tool',
      displayName: { zh: 'o', en: 'o' },
      provides: { tools: [{ id: 'do.t' }] },
    });
    await reloadFromTmp();
    const list = listTools();
    const desc = list.find((t) => t.id === 'do.t')!;
    expect(desc).toBeDefined();
    expect(desc.requireConfirm).toBeUndefined();
  });
});

describe('loadTools defaultAgentAllow and pinned', () => {
  it('passes defaultAgentAllow and pinned from the manifest to ToolEntry and listTools', async () => {
    mkmanifest('user', 'audio-gen', {
      id: '@x/audio-gen',
      kind: 'tool',
      displayName: { zh: 'g', en: 'g' },
      provides: {
        tools: [{
          id: 'generate-audio-assets',
          exposedToAI: true,
          defaultAgentAllow: true,
          pinned: true,
        }],
      },
    });
    const kinds = await reloadFromTmp();
    const entry = kinds.tools.find((t) => t.toolId === 'generate-audio-assets')!;
    expect(entry.defaultAgentAllow).toBe(true);
    expect(entry.pinned).toBe(true);
    const desc = listTools().find((t) => t.id === 'generate-audio-assets')!;
    expect(desc.defaultAgentAllow).toBe(true);
    expect(desc.pinned).toBe(true);
  });
});
