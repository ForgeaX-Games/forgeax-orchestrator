#!/usr/bin/env bun
// Fail the pack pipeline when dist/ imports a bare specifier that is not
// declared in package.json dependencies. Needed because build.mjs inlines
// @forgeax/* workspace source and leaves third-party imports external —
// transitive deps of inlined packages must be re-declared on this package.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
]);

function packageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0];
}

function isBare(spec) {
  return !!spec && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:');
}

/** Strip comments + string/template literals so scaffold source-in-string is ignored. */
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\])\/\/.*$/gm, '$1')
    .replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, '""')
    .replace(/`(?:\\.|[^\\`]|\$\{(?:[^{}]|\{[^}]*\})*\})*`/g, '``');
}

function collectJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...collectJsFiles(path));
    else if (/\.(js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const dist = join(root, 'dist');
const files = collectJsFiles(dist);
const missing = new Map(); // pkg -> [file, spec]

for (const file of files) {
  const text = stripNoise(readFileSync(file, 'utf8'));
  const re = /(?:from\s+|import\s*\(\s*|export\s+\*\s+from\s+)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const spec = m[1];
    if (!isBare(spec)) continue;
    const base = spec.startsWith('node:') ? spec.slice(5).split('/')[0] : packageName(spec);
    if (NODE_BUILTINS.has(base)) continue;
    if (spec.startsWith('node:') || NODE_BUILTINS.has(packageName(spec))) continue;
    const name = packageName(spec);
    if (NODE_BUILTINS.has(name)) continue;
    if (declared.has(name)) continue;
    const list = missing.get(name) ?? [];
    list.push(`${file.replace(root + '/', '')}: ${spec}`);
    missing.set(name, list);
  }
}

if (missing.size > 0) {
  console.error('[check-pack-externals] undeclared bare imports in dist/:');
  for (const [name, hits] of [...missing.entries()].sort()) {
    console.error(`  - ${name}`);
    for (const h of hits.slice(0, 5)) console.error(`      ${h}`);
    if (hits.length > 5) console.error(`      … +${hits.length - 5} more`);
  }
  console.error('\nAdd them to package.json dependencies (inlined @forgeax/* may pull these in).');
  process.exit(1);
}

console.log('[check-pack-externals] ok (%d files, %d declared deps)', files.length, declared.size);
