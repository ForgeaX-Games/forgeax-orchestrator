/**
 * ToolRegistry consumer contract against the exact published character package.
 * The isolated user install uses its real manifest and schemas, and dispatches
 * to the package's declared backend. No retired Marketplace checkout is needed.
 * Keep all ten tools, AI exposure, structured not_implemented and not_found checks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { scanAllExtensionOrigins } from '../src/extensions/scanner';
import { mergeManifests } from '../src/extensions/merger';
import { buildKindRegistry } from '../src/extensions/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/extensions/registry';
import { callTool, listTools, _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { _resetEventBusForTests } from '../src/events/bus';

const SRC_DIR = dirname(createRequire(import.meta.url).resolve('@forgeax-extension/character/package.json'));
const TMP = `/tmp/forgeax-wbc-tools-${process.pid}`;
const PLUGIN_DIR = join(TMP, 'user', 'wb-character');

const TOOL_IDS = [
  // AI-facing pipelines (exposedToAI:true).
  'character:generate-portrait',
  'character:generate-turnaround',
  'character:list',
  'character:get',
  'character:rename',
  // Doc 01 §P4 funnel tools — internal-only stubs (exposedToAI:false) used
  // when wb-character runs embedded as an iframe.
  'character:save-render-config',
  'character:save-spine-session',
  'character:publish-character',
  'character:publish-to-workspace-game',
  'character:merge-skills-to-workspace-game',
];

// portrait/turnaround/list/get/rename are the AI-facing tools (indices 0-4);
// the 5 P4-funnel stubs are exposedToAI:false. generate-pixel/spine/vfx/
// monster/video/vehicle exist as handler stubs but are NOT in the pinned
// manifest, so they never surface in the ToolRegistry snapshot.
const AI_EXPOSED_TOOL_IDS = TOOL_IDS.slice(0, 5);

function mirrorPluginToTmp() {
  mkdirSync(join(PLUGIN_DIR, 'server'), { recursive: true });
  copyFileSync(join(SRC_DIR, 'forgeax-extension.json'), join(PLUGIN_DIR, 'forgeax-extension.json'));
  cpSync(join(SRC_DIR, 'schemas'), join(PLUGIN_DIR, 'schemas'), { recursive: true });
  // Preserve package-local dependency resolution for the published backend.
  const backend = pathToFileURL(resolve(SRC_DIR, 'server/tool-handlers.ts')).href;
  writeFileSync(
    join(PLUGIN_DIR, 'server', 'tool-handlers.ts'),
    `export { default, tools } from ${JSON.stringify(backend)};\n`,
  );
}

async function reload() {
  const scan = await scanAllExtensionOrigins({
    builtin: join(TMP, 'builtin'),
    user: join(TMP, 'user'),
    project: join(TMP, 'project'),
  });
  expect(scan.errors).toEqual([]);
  const merge = mergeManifests(scan.found);
  expect(merge.issues).toEqual([]);
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
  mirrorPluginToTmp();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetEventBusForTests();
});

describe('wb-character ToolRegistry wiring', () => {
  it('all manifest tools land in the snapshot with backendPath set', async () => {
    await reload();
    const tools = listTools();
    const charTools = tools.filter((t) => t.id.startsWith('character:'));
    expect(charTools).toHaveLength(TOOL_IDS.length);
    for (const id of TOOL_IDS) {
      const t = charTools.find((x) => x.id === id);
      expect(t).toBeDefined();
      expect(t!.hasHandler).toBe(true);
      // Only the 5 AI-facing tools opt into exposedToAI; the P4-funnel
      // stubs are internal (UI/save buttons), exposedToAI:false.
      const expectAi = AI_EXPOSED_TOOL_IDS.includes(id);
      expect(t!.exposedToAI).toBe(expectAi);
    }
  });

  it('ai caller is allowed because every tool opts into exposedToAI', async () => {
    await reload();
    const r = await callTool({
      toolId: 'character:list',
      args: { slug: 'nope-not-a-real-game' },
      caller: { kind: 'ai', threadId: 'th' },
    });
    // We can't assert ok=true (storage origin expects a real game dir) — but
    // the point is: AI gating must not reject. So the *kind* of failure
    // must not be `forbidden`.
    if (!r.ok) expect(r.code).not.toBe('forbidden');
  });

  it('unimplemented pipelines surface the not_implemented code from the stub', async () => {
    await reload();
    // save-render-config is a manifest tool backed by a notImplemented() stub;
    // a non-ai caller bypasses the exposedToAI gate so we reach the handler,
    // which throws with code:'not_implemented' → ToolRegistry now preserves it.
    const r = await callTool({
      toolId: 'character:save-render-config',
      args: { slug: 'irrelevant' },
      caller: { kind: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('not_implemented');
      expect(r.error).toContain('not implemented');
    }
  });

  it('unknown tool id under character: namespace returns not_found', async () => {
    await reload();
    const r = await callTool({
      toolId: 'character:does-not-exist',
      args: {},
      caller: { kind: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});
