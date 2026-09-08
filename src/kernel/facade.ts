/**
 * kernel/facade — the `./kernel` composition entry (P3 / D-3 / §3.1).
 *
 * WHY THIS EXISTS
 * ---------------
 * The kernel boot/shutdown ORDER used to live inline in the product shell
 * (server `main.ts`: spawn guard @227-234, kernel-only key wipe @1138-1163,
 * shutdown @1185-1197) + `forgeax-core-adapter.ts`. That forced the server to
 * know the existence and assembly order of ~13 orchestrator-internal kernel/*
 * modules — the heaviest §2.5 (Depend on Abstractions) violation in this feat.
 *
 * This facade internalizes that ordering knowledge. The server collapses to two
 * calls (`bootKernel(productParams)` / `shutdownKernel(rt)`); the "who first,
 * who next" is owned here.
 *
 * BUSINESS-AGNOSTIC (D-3 / §4 Pipeline Isolation)
 * -----------------------------------------------
 * `opts` carries only PRODUCT params the server must inject — never a product
 * `ProductContext` (D-3 alt-b, rejected). Crucially the native in-process kernel
 * (forgeax-core) is REGISTERED BY THE PRODUCT via `opts.registerNativeKernel`:
 * its adapter imports `@forgeax/agent-host` + product concepts and therefore
 * lives in the server. This facade only sequences WHEN that injected registrar
 * runs, so it imports no product/server package (asserted by the M3 test and by
 * `check:business-agnostic`).
 *
 * The 13 kernel/* modules stay where they are; nothing moves. The seams below
 * default to the real orchestrator-side implementations and are overridable
 * only for tests (`__seams`), so the unit test asserts ordering without
 * spawning a real sidecar or CLI binary.
 */
import { kernelStackGuarded } from './kernel-mode';
import { listAvailableKernels } from './resolve-kernel';
import { ensureSidecar, resetSidecarSingleton } from './sidecar-singleton';
import { stripModelKeys } from './sidecar-spawn';
import { ClaudeCodeKernel } from './claude-code-kernel';
import { CodexKernel } from './codex-kernel';
import { shutdownProjectMcpPool } from './project-mcp';

/**
 * Product params the server injects. Deliberately the minimal set (D-3): the
 * product concepts stay in the server; the orchestrator receives only what it
 * needs to assemble + start the kernel stack.
 */
export interface BootKernelOpts {
  /** Project root the kernel-mode gate consults (`.forgeax/use-cli` escape). */
  readonly projectRoot?: string;
  /** Env the boot path reads for the kernel-mode / kernel-only gates. Defaults
   *  to `process.env`. Passed explicitly so the product owns env provenance. */
  readonly env?: Record<string, string | undefined>;
  /**
   * Register the product's native in-process kernel (forgeax-core) into the
   * shared `@forgeax/agent-runtime` registry. Injected because the adapter that
   * constructs it imports agent-host + product concepts (server-owned). The
   * facade only sequences when it runs. Omit for pure-CLI / no-native hosts.
   */
  readonly registerNativeKernel?: () => void;
  /** Product logger sink (reserved; the facade does not branch on it — it is
   *  threaded through for the server shell to keep a single boot call site). */
  readonly loggerSink?: unknown;
  /** Host-side telemetry sink (reserved, threaded through — same rationale). */
  readonly telemetrySink?: unknown;
  /** Injected host-tool implementation (reserved, threaded through). */
  readonly hostToolImpl?: unknown;
  /**
   * TEST-ONLY seam overrides. Never set by product code — the real seams below
   * spawn a sidecar / touch pools, which the unit test must not do. Underscore
   * prefix marks it internal.
   */
  readonly __seams?: Partial<KernelFacadeSeams>;
}

/** The orchestrator-side steps the facade sequences. Defaults are the real
 *  kernel/* implementations; tests inject spies. */
export interface KernelFacadeSeams {
  /** Register the self-hosted rented kernels (claude-code / codex / …). The
   *  real path lists them via `listAvailableKernels()`, whose `ensureRegistered`
   *  side-effect registers the in-process kernels into the shared registry. */
  registerSelfHostedKernels: () => void;
  /** Warm + connect the ring-0 agent-host sidecar singleton. */
  ensureSidecar: () => Promise<void>;
  /** Wipe the real model keys from the server process env (kernel-only). */
  stripServerModelKeys: (env: Record<string, string | undefined>) => void;
  /** Reap the Claude stream-json session pool. */
  closeClaudeSessionPool: () => Promise<void>;
  /** Reap the Codex app-server pool. */
  closeCodexAppServerPool: () => Promise<void>;
  /** Reap the project-MCP pool. */
  shutdownProjectMcpPool: () => Promise<void>;
  /** Tear the sidecar singleton down. */
  teardownSidecar: () => Promise<void>;
}

/** The real orchestrator-side seams. Position of every referenced module is
 *  unchanged; the facade only wires their call order. */
function defaultSeams(): KernelFacadeSeams {
  return {
    registerSelfHostedKernels: () => {
      // `listAvailableKernels()` runs `ensureRegistered()` as a side-effect,
      // registering claude-code / codex / cursor / codebuddy / kimi / deepseek
      // into the shared `@forgeax/agent-runtime` registry (resolve-kernel.ts).
      listAvailableKernels();
    },
    ensureSidecar: async () => {
      await ensureSidecar();
    },
    stripServerModelKeys: (env) => {
      // `stripModelKeys` (sidecar-spawn) owns WHICH keys are model keys — the
      // facade must not re-encode that list (§1 SSOT). It returns a filtered
      // COPY, so derive the removed keys as the delta and delete them off the
      // live process env after the sidecar holds them.
      const present: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string') present[k] = v;
      const kept = stripModelKeys(present);
      for (const k of Object.keys(present)) {
        if (!(k in kept)) delete env[k];
      }
    },
    closeClaudeSessionPool: () => ClaudeCodeKernel.closeSessionPool(),
    closeCodexAppServerPool: () => CodexKernel.closeAppServerPool(),
    shutdownProjectMcpPool: () => shutdownProjectMcpPool(),
    // A desktop can have more than one server process connected to the shared
    // agent-host socket. Server shutdown must only release its own connection
    // and child handle; asking the shared host to shut down strands every other
    // running Studio instance. Credential updates continue to use
    // `restartSidecar()`, which intentionally replaces the global singleton.
    teardownSidecar: async () => resetSidecarSingleton(),
  };
}

/** Handle returned by boot; the server holds it and calls `.shutdown()` (or the
 *  free `shutdownKernel(rt)`) on teardown. `createKernelRuntime` builds it WITHOUT
 *  running any side effect, so a caller can construct then boot in two steps. */
export interface KernelRuntime {
  /** Run the boot sequence (idempotent-safe: registrars are idempotent). */
  boot: () => Promise<KernelRuntime>;
  /** Tear the kernel stack down in the server-owned order. */
  shutdown: () => Promise<void>;
}

function envFor(opts: BootKernelOpts): Record<string, string | undefined> {
  return opts.env ?? process.env;
}

/**
 * Build a kernel runtime handle WITHOUT booting. Pure construction — no
 * register / warm / wipe runs until `.boot()`.
 */
export function createKernelRuntime(opts: BootKernelOpts = {}): KernelRuntime {
  const seams: KernelFacadeSeams = { ...defaultSeams(), ...opts.__seams };
  const env = envFor(opts);

  const runtime: KernelRuntime = {
    async boot() {
      // (1) Register self-hosted rented kernels into the shared registry.
      seams.registerSelfHostedKernels();
      // (2) Register the product-injected native kernel (forgeax-core). The
      //     facade never constructs it — the product adapter does — because that
      //     adapter knows agent-host + product concepts (business-agnostic).
      opts.registerNativeKernel?.();
      // (3) Warm the sidecar when the kernel + sidecar stack is enabled. Mirrors
      //     main.ts:227-234 (cold-start prewarm) — internalized here so the
      //     server no longer knows kernel-mode / sidecar-singleton exist.
      const sidecarOn = kernelStackGuarded(opts.projectRoot);
      if (sidecarOn) {
        await seams.ensureSidecar();
      }
      // (4) kernel-only key wipe (R3-02, main.ts:1138-1163): only after the
      //     sidecar holds the key — else there is no usable model path. Skip the
      //     wipe entirely when the sidecar is not up.
      if (env.FORGEAX_KERNEL_ONLY === '1' && sidecarOn) {
        seams.stripServerModelKeys(env);
      }
      return runtime;
    },
    async shutdown() {
      // Teardown order equivalent to server main.ts:1185-1197. Best-effort:
      // a failing step must not abort the rest (a stuck pool cannot strand the
      // sidecar teardown, and vice versa) — matches the inline try/catch chain.
      const steps: Array<() => Promise<void>> = [
        seams.closeClaudeSessionPool,
        seams.closeCodexAppServerPool,
        seams.shutdownProjectMcpPool,
        seams.teardownSidecar,
      ];
      for (const step of steps) {
        try {
          await step();
        } catch {
          /* best-effort during shutdown — never let one teardown strand another */
        }
      }
    },
  };
  return runtime;
}

/**
 * Assemble + boot the kernel stack, returning the runtime handle. The server's
 * boot path collapses to this single call (D-3): it injects product params and
 * never touches kernel/* modules directly.
 */
export async function bootKernel(opts: BootKernelOpts = {}): Promise<KernelRuntime> {
  return createKernelRuntime(opts).boot();
}

/**
 * Tear the kernel stack down. Accepts the handle from `bootKernel` /
 * `createKernelRuntime`; the server's shutdown path collapses to this call.
 */
export async function shutdownKernel(runtime: KernelRuntime): Promise<void> {
  await runtime.shutdown();
}
