// Bundle @forgeax/orchestrator to node-runnable ESM JS (dist/).
//
// Why: forgeax-studio imports `@forgeax/orchestrator/kernel/forgeax-core-kernel` in-process
// (remote agent runtime). Shipped as a self-contained npm tarball (no forgeax-os
// checkout), it inlines the `@forgeax/*` workspace source (types, agent-runtime,
// platform-io, agent-host client) and leaves third-party deps external (installed
// via package.json `dependencies`). Inlined workspace packages may introduce
// additional third-party bare imports — re-declare them here and gate with pack:check.
//
// NOTE: cli spawns sibling *packages* at runtime — `@forgeax/agent-host/serve`
// and `@forgeax/cli/serve` — via import.meta.resolve. Those are NOT bundled
// here; they ship as their own tarballs and must be installed alongside. The
// `.mjs` MCP servers are runtime assets resolved by import.meta.dirname, so we
// copy them into dist preserving their src-relative layout.
import { build } from 'bun';
import { rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { Glob } from 'bun';
import { dirname, join } from 'node:path';
import { buildPlatformOptions } from './build-platform.mjs';
import { shouldExternalizeBuildSpecifier } from './build-externals.mjs';

rmSync('./dist', { recursive: true, force: true });

/**
 * Externalize third-party bare specifiers plus mutable ForgeaX singletons.
 * Most workspace packages remain bundled from source, but agent-runtime owns
 * the process-wide kernel registry and must be shared with the product shell.
 */
const externalizeNonForgeax = {
  name: 'externalize-non-forgeax',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const p = a.path;
      if (!shouldExternalizeBuildSpecifier(p)) return;
      return { path: p, external: true };
    });
  },
};

const res = await build({
  entrypoints: [
    './src/index.ts',
    './src/kernel/index.ts',
    './src/kernel/forgeax-core-kernel.ts',
    './src/orchestration-seams.ts',
    './src/extensions/index.ts',
    './src/fs/index.ts',
    './src/lib/gateways/index.ts',
    './src/npc-brain/model-config.ts',
    './src/npc-brain/standalone.ts',
  ],
  outdir: './dist',
  root: './src',
  target: 'node',
  format: 'esm',
  // Every public runtime entry must share one graph. In particular, the root
  // app installs mutable seams/registries that ./kernel and ./extensions read.
  // Building those subpaths separately from source creates duplicate module
  // instances inside a compiled consumer and silently drops advertised tools.
  splitting: true,
  ...buildPlatformOptions(process.platform),
  plugins: [externalizeNonForgeax],
});

for (const l of res.logs) console.log(String(l));
if (!res.success) process.exit(1);

// Copy runtime .mjs assets (MCP stdio servers) preserving src-relative paths so
// `resolve(import.meta.dirname, '…/mcp/*.mjs')` keeps resolving inside dist/.
const glob = new Glob('**/*.mjs');
let assets = 0;
for await (const rel of glob.scan({ cwd: './src' })) {
  const dest = join('./dist', rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join('./src', rel), dest);
  assets++;
}

// Minimal hand-written type shims. forgeax-studio consumes these loosely
// (`as unknown as Os2Kernel`), so full cross-package .d.ts bundling is unnecessary.
writeFileSync(
  './dist/kernel/forgeax-core-kernel.d.ts',
  [
    '// Minimal type shim (loosely typed on purpose — the consumer casts).',
    'export declare function registerForgeaxCoreKernel(opts: { hostBridge: unknown; hostTurnSnapshot?: unknown }): void;',
    'export declare function getKernel(name: string): unknown;',
    'export declare function coreServeSpawnTimeoutMs(): number;',
    '',
  ].join('\n'),
);
writeFileSync(
  './dist/index.d.ts',
  'export declare const HEADLESS_ACTION_GRANDFATHER_IDS: readonly string[];\n',
);

console.log('[build] @forgeax/orchestrator → dist/ (%d js + %d mjs assets + 2 d.ts)', res.outputs.length, assets);
