/**
 * `@forgeax/orchestrator/kernel` — the public kernel surface (P3 / D-3 / D-7).
 *
 * Exposes:
 *   - the facade composition entry (`bootKernel` / `shutdownKernel` /
 *     `createKernelRuntime`) that internalizes the kernel boot/shutdown order
 *     the server used to own inline (§3.1);
 *   - read-only `KernelProfile` constants + helpers the host must cross-cut on;
 *   - the P7 cross-cutting symbols folded into this surface: `lib/turn-trace`
 *     and `core/logger`'s router snapshot — both are consumed only by the
 *     server's kernel adapter in a kernel-runtime-observability context, so
 *     they belong to the kernel surface (D-7), not a new top-level export.
 *
 * The barrel is declarative re-export only; the assembly logic lives in
 * `facade.ts` and the referenced modules stay in place.
 */

// Facade composition entry (D-3, §3.1).
export {
  bootKernel,
  shutdownKernel,
  createKernelRuntime,
  type BootKernelOpts,
  type KernelRuntime,
  type KernelFacadeSeams,
} from './facade';

// Read-only kernel-orchestration profile constants + helpers (cross-cutting
// types the host consumes; `KernelProfile` family).
export {
  NATIVE_KERNEL_PROFILE,
  RENTED_KERNEL_PROFILE,
  CODEX_KERNEL_PROFILE,
  orchestrationProfileOf,
  hasNativeHistoryResume,
  type KernelOrchestrationProfile,
  type NativeAttachmentKind,
} from './kernel-profile';

// P7 cross-cutting symbols folded into ./kernel (D-7): turn-trace + logger
// router snapshot. Consumed by the server kernel adapter as kernel-runtime
// observability.
export { tt, ttEnabled } from '../lib/turn-trace';
export { getConsoleRouterSnapshot } from '../core/logger';
export {
  resolveAsk,
  setExternalAskReplyResolver,
  type AskReply,
  type AskReplyIdentity,
} from '../core/ask-user-registry';

// P3 cross-cutting promotions (a3-port-mapping.md P3 "cross-cut to public"): the three
// kernel/* modules the server reaches into today, surfaced on the curated
// kernel face so the M5 server rewrite drops its deep imports.
//
//   - host-telemetry: the injection/query/emit trio. `main.ts` injects the
//     product sink via `setHostTelemetry`; the CLI-kernel side reads
//     `hostTelemetryEnabled` / `emitHostTelemetry`.
//   - action-catalog: the catalog read surface consumed by the host
//     (`catalogAll` today; siblings kept together as one coherent read face).
//   - action-door: the visible-door resolver + its public shapes.
export { setHostTelemetry, hostTelemetryEnabled, emitHostTelemetry } from './host-telemetry';
export {
  catalogAll,
  catalogGet,
  catalogFirstClass,
  type ActionCatalogEntry,
  type ActionCapability,
  type ActionSurface,
} from './action-catalog';
export {
  findVisibleDoor,
  type ActionDoor,
  type DoorSources,
  type DoorWalk,
} from './action-door';

// M5 server-shell kernel symbols (a3-port-mapping P3: `kernel/{resolve-kernel,
// …,project-mcp,…}` -> ./kernel; P6 notes "kernel(main.ts side already counted
// in P3)"). The server shell reaches into these kernel/* modules today; the M5
// rewrite switches to this curated face. Pure additive re-exports — every
// source module stays byte-for-byte unchanged. listAvailableKernels /
// discoverProjectMcpTools land here (NOT the root surface) per the approved
// mapping; the M5 blocker report suggested the root, but the mapping table wins.
export {
  CORE_DEFAULT_PERMISSION_MODE,
  CORE_SUPPORTED_PERMISSION_MODES,
} from './permission-config';
export { ensureSidecar } from './sidecar-singleton';
export { makeInProcessExecuteTool } from './host-tool-bridge';
export type { HostExecuteToolFn } from './host-tool-bridge';
export { materializeEnv, stripModelKeys } from './sidecar-spawn';
export { listAvailableKernels } from './resolve-kernel';
// Product registration must use the same registry as kernel selection, even
// when independently installed consumers resolve different runtime packages.
export { getKernel, registerKernel } from '@forgeax/agent-runtime';
export { discoverProjectMcpTools } from './project-mcp';

// Combined kernel-stack guard (R3-15): the server's soul-pack safety guard in
// main.ts needs a public-surface equivalent of the `kernelEnabled() &&
// sidecarEnabled()` composite predicate. The composition lives producer-side
// (kernel-mode) per SSOT; the host consumes it through this curated face.
export { kernelStackGuarded } from './kernel-mode';
