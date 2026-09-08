// M3 acceptance anchor (D-3, AC-08, plan-strategy §3.1): the `./kernel` facade
// composition entry.
//
// Two behavior contracts the plan makes red-green mandatory:
//   (1) profile assembly ORDER — bootKernel must run its internalized steps in
//       the §3.1 sequence (resolve/mode gate → register self-hosted kernels →
//       inject native kernel → sidecar warmup → key-wipe when kernel-only),
//       driving each step through injected seams so the test asserts the order
//       without spawning a real sidecar or binary.
//   (2) boot/shutdown behavior equivalence — shutdownKernel tears the pools and
//       sidecar down in the order server/main.ts used to own inline, so the M5
//       server shell can collapse to two calls with no behavior drift.
//
// The facade only orchestrates orchestrator-side kernel/* modules and receives
// PRODUCT params (projectRoot/env/loggerSink/telemetrySink/host-tool impl +
// injected native-kernel registrar). It must not import any product/server
// package — that business-agnostic constraint is asserted structurally below
// and enforced by `bun run check:business-agnostic`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bootKernel,
  createKernelRuntime,
  shutdownKernel,
  NATIVE_KERNEL_PROFILE,
  RENTED_KERNEL_PROFILE,
  CODEX_KERNEL_PROFILE,
  type KernelRuntime,
  type BootKernelOpts,
} from '@forgeax/orchestrator/kernel';

// Env keys the boot path reads (kernel-mode gate + kernel-only key wipe). Saved
// and cleared before each test so an ambient .env cannot leak into ordering.
const BOOT_ENV_KEYS = [
  'FORGEAX_KERNEL',
  'FORGEAX_SIDECAR',
  'FORGEAX_KERNEL_ONLY',
  'FORGEAX_NO_KERNEL',
  'FORGEAX_KERNEL_IMPL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of BOOT_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of BOOT_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A seam bundle recording the order the facade drives its internalized steps.
// Every seam is injectable so the unit test never spawns a real sidecar/binary.
function makeSeamSpy(): { seams: NonNullable<BootKernelOpts['__seams']>; order: string[] } {
  const order: string[] = [];
  const seams: NonNullable<BootKernelOpts['__seams']> = {
    registerSelfHostedKernels: () => {
      order.push('register-self-hosted');
    },
    ensureSidecar: async () => {
      order.push('ensure-sidecar');
    },
    stripServerModelKeys: () => {
      order.push('strip-keys');
    },
    closeClaudeSessionPool: async () => {
      order.push('close-claude-pool');
    },
    closeCodexAppServerPool: async () => {
      order.push('close-codex-pool');
    },
    shutdownProjectMcpPool: async () => {
      order.push('shutdown-mcp-pool');
    },
    teardownSidecar: async () => {
      order.push('teardown-sidecar');
    },
  };
  return { seams, order };
}

describe('kernel facade — profile assembly (D-3, §3.1 boot order)', () => {
  test('kernel+sidecar default: registers kernels, injects native kernel, warms sidecar — in order', async () => {
    const { seams, order } = makeSeamSpy();
    const registered: string[] = [];
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {
        registered.push('forgeax-core');
        order.push('inject-native');
      },
      __seams: seams,
    });
    // Native kernel registration is a PRODUCT-injected step (the adapter that
    // knows agent-host lives in server), sequenced by the facade — never
    // performed by the facade itself.
    expect(registered).toEqual(['forgeax-core']);
    // Self-hosted rented kernels register before the native injection, and the
    // sidecar warms up last (matches §3.1: resolve/register → sidecar ready).
    expect(order).toEqual(['register-self-hosted', 'inject-native', 'ensure-sidecar']);
    expect(rt).toBeTruthy();
    await shutdownKernel(rt);
  });

  test('kernel disabled (FORGEAX_KERNEL=cli): sidecar is NOT warmed', async () => {
    process.env.FORGEAX_KERNEL = 'cli';
    const { seams, order } = makeSeamSpy();
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => order.push('inject-native'),
      __seams: seams,
    });
    // Rented kernels still register (they run in-process), but no sidecar warm.
    expect(order).toContain('register-self-hosted');
    expect(order).not.toContain('ensure-sidecar');
    await shutdownKernel(rt);
  });

  test('sidecar disabled (FORGEAX_SIDECAR=off): sidecar is NOT warmed', async () => {
    process.env.FORGEAX_SIDECAR = 'off';
    const { seams, order } = makeSeamSpy();
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {},
      __seams: seams,
    });
    expect(order).not.toContain('ensure-sidecar');
    await shutdownKernel(rt);
  });

  test('kernel-only (FORGEAX_KERNEL_ONLY=1): warms sidecar THEN wipes server model keys', async () => {
    process.env.FORGEAX_KERNEL_ONLY = '1';
    const { seams, order } = makeSeamSpy();
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {},
      __seams: seams,
    });
    const warmAt = order.indexOf('ensure-sidecar');
    const wipeAt = order.indexOf('strip-keys');
    expect(warmAt).toBeGreaterThanOrEqual(0);
    expect(wipeAt).toBeGreaterThanOrEqual(0);
    // Wipe only after the sidecar holds the key — never before (else no path).
    expect(wipeAt).toBeGreaterThan(warmAt);
    await shutdownKernel(rt);
  });

  test('kernel-only but sidecar disabled: keys are NOT wiped (no usable path)', async () => {
    process.env.FORGEAX_KERNEL_ONLY = '1';
    process.env.FORGEAX_SIDECAR = 'off';
    const { seams, order } = makeSeamSpy();
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {},
      __seams: seams,
    });
    expect(order).not.toContain('strip-keys');
    await shutdownKernel(rt);
  });
});

describe('kernel facade — shutdown behavior equivalence (§3.1 teardown order)', () => {
  test('shutdownKernel tears pools then sidecar, in the server-owned order', async () => {
    const { seams, order } = makeSeamSpy();
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {},
      __seams: seams,
    });
    order.length = 0; // isolate the shutdown ordering assertion
    await shutdownKernel(rt);
    expect(order).toEqual([
      'close-claude-pool',
      'close-codex-pool',
      'shutdown-mcp-pool',
      'teardown-sidecar',
    ]);
  });

  test('shutdown is best-effort: a failing pool does not abort the rest', async () => {
    const { seams, order } = makeSeamSpy();
    seams.closeClaudeSessionPool = async () => {
      order.push('close-claude-pool');
      throw new Error('pool boom');
    };
    const rt = await bootKernel({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {},
      __seams: seams,
    });
    order.length = 0;
    await shutdownKernel(rt); // must not throw
    // Later teardown steps still ran despite the earlier failure.
    expect(order).toContain('close-codex-pool');
    expect(order).toContain('shutdown-mcp-pool');
    expect(order).toContain('teardown-sidecar');
  });
});

describe('kernel facade — surface + business-agnostic', () => {
  test('createKernelRuntime builds a runtime handle without side-effect boot', async () => {
    const { seams, order } = makeSeamSpy();
    const rt: KernelRuntime = createKernelRuntime({
      projectRoot: '/tmp/forgeax-facade-test',
      env: process.env,
      registerNativeKernel: () => {},
      __seams: seams,
    });
    // Pure construction: no register/warm/wipe ran yet.
    expect(order).toEqual([]);
    expect(rt).toBeTruthy();
    // Booting the handle runs the sequence.
    await rt.boot();
    expect(order).toContain('register-self-hosted');
    await rt.shutdown();
  });

  test('`@forgeax/orchestrator/kernel` re-exports the kernel-profile constants + cross-cutting symbols', async () => {
    expect(NATIVE_KERNEL_PROFILE.hostOwnedHistory).toBe(true);
    expect(RENTED_KERNEL_PROFILE.hostOwnedHistory).toBe(false);
    expect(CODEX_KERNEL_PROFILE.nativeAttachmentKinds).toContain('image');
    const m = await import('@forgeax/orchestrator/kernel');
    // P7 cross-cutting symbols folded into ./kernel (turn-trace + core/logger).
    expect(typeof m.tt).toBe('function');
    expect(typeof m.ttEnabled).toBe('function');
    expect(typeof m.getConsoleRouterSnapshot).toBe('function');
  });

  test('facade.ts imports no product/server package (business-agnostic, D-3 / §4)', () => {
    const facadePath = fileURLToPath(new URL('../src/kernel/facade.ts', import.meta.url));
    const src = readFileSync(facadePath, 'utf-8');
    // Assert on actual `import ... from '<spec>'` / `import('<spec>')` statements,
    // not prose mentions — the facade's doc comment legitimately explains WHY the
    // agent-host-importing adapter lives in the server, and forbidding the string
    // in comments would punish that documentation.
    const importSpecifiers = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    // The orchestrator must never depend upward on its consumers.
    expect(importSpecifiers).not.toContain('@forgeax/server');
    expect(importSpecifiers.some((s) => s.startsWith('@forgeax/agent-host'))).toBe(false);
    // A native kernel is INJECTED via opts, never imported here (that adapter
    // knows agent-host + product concepts and lives in the server).
    expect(importSpecifiers.some((s) => /forgeax-core-adapter/.test(s))).toBe(false);
  });
});
