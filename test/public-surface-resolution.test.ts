// M1 acceptance anchor (AC-04): the newly-declared public export surface must
// resolve, and the root-surface completion symbols (D-6 / D-7) must be present.
//
// This is the resolvability / symbol-existence gate the plan requires for the
// orchestrator public face. It is intentionally structural: it does not test
// behavior (that lives in the modules' own specs), it tests that the `exports`
// map keys resolve to real modules and the root index re-exports the promoted
// symbols. If a future edit renames an export key or drops a re-export, this
// test fails at import time rather than silently breaking the M4 server rewrite.
//
// `./gateways` (M2) is asserted below for the gateway-catalog helpers the M5
// server kernel adapter consumes. The `./kernel` (M3) subpath is asserted below
// for its P3 cross-cutting promotions (host-telemetry / action-catalog /
// action-door) plus the M5 kernel-shell symbols, which the server rewrite
// depends on.

import { test, expect } from 'bun:test';
import * as root from '../src/index';

// (1) Each M1-ready subpath resolves via its `@forgeax/orchestrator/<key>`
// specifier and exposes at least one representative symbol from its source.
test('@forgeax/orchestrator/seams resolves', async () => {
  const m = await import('@forgeax/orchestrator/seams');
  expect(typeof m.initOrchestrationSeams).toBe('function');
});

test('@forgeax/orchestrator/session-fs resolves', async () => {
  const m = await import('@forgeax/orchestrator/session-fs');
  expect(typeof m.getPathManager).toBe('function');
  expect(typeof m.initPathManager).toBe('function');
  expect(typeof m.listSessionDirs).toBe('function');
  expect(typeof m.safeSegment).toBe('function');
  expect(typeof m.resolveUserDir).toBe('function');
});

test('@forgeax/orchestrator/extensions resolves', async () => {
  const m = await import('@forgeax/orchestrator/extensions');
  expect(typeof m.getExtensionSnapshot).toBe('function');
  expect(typeof m.reloadExtensions).toBe('function');
  expect(typeof m.listAgents).toBe('function');
  expect(typeof m.resolvePersonaForAgent).toBe('function');
});

test('@forgeax/orchestrator/npc-brain/model-config resolves', async () => {
  const m = await import('@forgeax/orchestrator/npc-brain/model-config');
  expect(typeof m.resolveNpcModel).toBe('function');
});

// (1a) `./gateways` (M2) exposes the gateway-catalog helpers the M5 server
// kernel adapter consumes (a3-port-mapping P2, tradeoff 1). The server switches from
// deep-importing `lib/llm-gateway/gateway-catalog` to this face, so these two
// symbols must be present or that rewrite breaks at import time.
test('@forgeax/orchestrator/gateways exposes gateway catalog helpers', async () => {
  const m = await import('@forgeax/orchestrator/gateways');
  expect(typeof m.loadGatewayCatalog).toBe('function');
  expect(typeof m.gatewayCatalogToKernelModels).toBe('function');
});

// (1b) `./kernel` P3 cross-cutting promotions resolve. The server reaches into
// `kernel/{host-telemetry,action-catalog,action-door}` today; the M5 rewrite
// switches to `@forgeax/orchestrator/kernel`, so these symbols must be present
// on the curated kernel face or that rewrite breaks at import time.
test('@forgeax/orchestrator/kernel exposes P3 cross-cutting symbols', async () => {
  const m = await import('@forgeax/orchestrator/kernel');
  // host-telemetry injection/query/emit trio
  expect(typeof m.setHostTelemetry).toBe('function');
  expect(typeof m.hostTelemetryEnabled).toBe('function');
  expect(typeof m.emitHostTelemetry).toBe('function');
  // action-catalog read surface (server consumes catalogAll)
  expect(typeof m.catalogAll).toBe('function');
  expect(typeof m.catalogGet).toBe('function');
  expect(typeof m.catalogFirstClass).toBe('function');
  // action-door resolver (server consumes findVisibleDoor)
  expect(typeof m.findVisibleDoor).toBe('function');
  // combined kernel-stack guard (R3-15): main.ts soul-pack safety guard
  // consumes this composite predicate through the curated kernel face.
  expect(typeof m.kernelStackGuarded).toBe('function');
});

// (1c) `./kernel` M5 server-shell symbols resolve (a3-port-mapping P3). The M5
// server shell drops its deep imports of kernel/{permission-config,
// sidecar-singleton,host-tool-bridge,sidecar-spawn,resolve-kernel,project-mcp}
// in favor of this face; each symbol must be present or that rewrite breaks at
// import time. HostExecuteToolFn is type-only (asserted at compile time below).
test('@forgeax/orchestrator/kernel exposes M5 server-shell symbols', async () => {
  const m = await import('@forgeax/orchestrator/kernel');
  // permission-config: default mode is a string, supported modes an array.
  expect(typeof m.CORE_DEFAULT_PERMISSION_MODE).toBe('string');
  expect(Array.isArray(m.CORE_SUPPORTED_PERMISSION_MODES)).toBe(true);
  // sidecar lifecycle + env materialization the server shell orchestrates.
  expect(typeof m.ensureSidecar).toBe('function');
  expect(typeof m.materializeEnv).toBe('function');
  expect(typeof m.stripModelKeys).toBe('function');
  // in-process host-tool bridge factory (server injects it into the kernel).
  expect(typeof m.makeInProcessExecuteTool).toBe('function');
  // kernel enumeration + project MCP discovery the server surfaces.
  expect(typeof m.listAvailableKernels).toBe('function');
  expect(typeof m.getKernel).toBe('function');
  expect(typeof m.registerKernel).toBe('function');
  expect(typeof m.discoverProjectMcpTools).toBe('function');
});

// (1d) Type-only kernel promotion compiles against the public kernel surface.
// No runtime assertion — fails at typecheck if the type export is dropped.
test('@forgeax/orchestrator/kernel HostExecuteToolFn type is on the surface', async () => {
  const kernel = await import('@forgeax/orchestrator/kernel');
  type _Fn = typeof kernel extends { makeInProcessExecuteTool: infer _F } ? true : never;
  const _fn: import('@forgeax/orchestrator/kernel').HostExecuteToolFn | undefined = undefined;
  expect(_fn).toBeUndefined();
});

// (2) Root-surface completion symbols (P6 / P7) are re-exported from the root.
test('root surface completion symbols are present', () => {
  const runtimeSymbols = [
    'ensureSessionWithBootstrap',
    'dispatchToSurface',
    'dispatchAndWait',
    'getSurfaceSnapshot',
    'listSurfaces',
    'getEventBus',
    'BLACKBOARD_KEYS',
    'computeAgentNaming',
    'pickPersonName',
    'repointEngineForgeaXSymlink',
    'callTool',
    'getTerminalManager',
  ] as const;
  const bag = root as Record<string, unknown>;
  for (const name of runtimeSymbols) {
    expect(bag[name], `root export missing: ${name}`).toBeDefined();
  }
});

// (3) Type-only promoted symbols compile against the public root surface. This
// has no runtime assertion — it fails at typecheck if the type export is dropped.
test('type-only promoted symbols are on the public surface', () => {
  const _record: root.FileActivityRecord | undefined = undefined;
  const _naming: root.AgentNaming | undefined = undefined;
  expect(_record).toBeUndefined();
  expect(_naming).toBeUndefined();
});
