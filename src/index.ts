// @forgeax/orchestrator — package entry (Stage0).
//
// Reusable orchestration layer public surface. The product shell can either:
//   (a) import the high-level seam from here:  `import { createForgeaxApp } from '@forgeax/orchestrator'`
//   (b) import individual routers/boot helpers via subpaths:
//       `import { createCliRouter } from '@forgeax/orchestrator/api/cli/chat'`  (enabled by
//       the `"./*": "./src/*.ts"` export map).
//
// 现状(2026-06):产品壳 packages/server/src/main.ts 走 (a) —— `createForgeaxApp(ctx)`
// 装配全部 /api/* 路由 + boot;(b) 子路径导出仍开放给需要单独拿某个 router/helper 的场景。

export * from './app';
export { createNpcRouter, type NpcRouterOptions } from './api/npc';
export {
  createNpcWebSocketHandler,
  NpcRuntime,
  type NpcRuntimeConfig,
  type NpcSession,
  type NpcSessionGrant,
  type ResolvedNpcSoulBinding as NpcSoulBinding,
  type NpcWsClientData,
} from './npc-brain/runtime';
export {
  resolveStandaloneNpcBrainConfig,
  startStandaloneNpcBrain,
  type StandaloneNpcBrainConfig,
  type StandaloneNpcBrainServer,
} from './npc-brain/standalone';
export {
  NPC_LIMITS,
  NPC_PROTOCOL_VERSION,
  NPC_WIRE_FRAME_TYPES,
  isNpcDecisionWire,
  isNpcWireEnvelope,
  isReplayWindowInBounds,
  isSupportedNpcProtocolVersion,
  parseAffordance,
  parseNpcDecisionFrame,
  parseNpcDecisionWire,
  parseNpcEpisodeEndFrame,
  parseNpcErrorFrame,
  parseNpcHeartbeatFrame,
  parseNpcResumeFrame,
  parseNpcSessionReadyFrame,
  parseNpcSnapshotFrame,
  parseNpcWireEnvelope,
  parsePerceptionSnapshot,
  safeParseAffordance,
  safeParseNpcDecisionFrame,
  safeParseNpcDecisionWire,
  safeParseNpcEpisodeEndFrame,
  safeParseNpcErrorFrame,
  safeParseNpcHeartbeatFrame,
  safeParseNpcResumeFrame,
  safeParseNpcSessionReadyFrame,
  safeParseNpcSnapshotFrame,
  safeParseNpcWireEnvelope,
  safeParsePerceptionSnapshot,
  type Affordance,
  type AffordanceParam,
  type NearbyEntity,
  type NpcDecisionFrame,
  type NpcDecisionWire,
  type NpcEmotion,
  type NpcEpisodeEndFrame,
  type NpcErrorFrame,
  type NpcHeartbeatFrame,
  type NpcIntent,
  type NpcResumeFrame,
  type NpcSelfState,
  type NpcSessionReadyFrame,
  type NpcSnapshotFrame,
  type NpcUtterance,
  type NpcWireEnvelope,
  type NpcWireEnvelopeType,
  type NpcWireFrameType,
  type PerceptionEvent,
  type PerceptionSnapshot,
  type ResumeRequest,
  type Vec2,
} from '@forgeax/types/npc-protocol';
export type { ActionCatalogEntry, ActionCatalogBuildOptions } from './kernel/action-catalog';
export {
  redactSecretsInText,
  scanBufferForSecrets,
  scanContentForSecrets,
  sensitiveEnvLiterals,
  walkUploadTree,
  type RedactedEgressText,
  type SecretHit,
  type UploadFile,
  type WalkOptions,
  type WalkResult,
} from './upload/manifest';
export {
  githubAuthHeader,
  githubRemoteUrl,
  pushFilesToPath,
  type GitPathUploadFile,
  type PushFilesToPathParams,
  type PushFilesToPathResult,
} from './upload/git-uploader';
export { FORGEAX_BUILTIN_TOOL_NAMES } from './kernel/compose-turn-request';
export {
  ProgressController,
  type ProgressControllerOptions,
  type ProgressDecision,
  type ProgressEvidence,
  type ProgressEvent,
  type ProgressEventClassifier,
  type ProgressEventContext,
  type ProgressMetric,
  type ProgressObservation,
  type ProgressObservationKind,
  type ProgressPauseReason,
  type ProgressPolicy,
  type ProgressPolicyContext,
  type ProgressPolicyProvider,
  type ProgressRecheckPlan,
  type ProgressRestoreResult,
  type ProgressSnapshot,
  type ProgressStatus,
  type ProgressWaitKind,
} from './runtime/progress-control';

// Boot / lifecycle helpers used by product shells.
export { initPathManager } from './fs/path-manager';
export { ensureUserDirDefaults } from './defaults/scaffold';
export { initSessionManager, getSessionManager } from './core/session-manager';
export { bootCliProviders } from './cli-providers';
export { reloadExtensions } from './extensions/registry';
export { getExtensionSnapshot } from './extensions/registry';
export { configureNpmExtensionDirs } from './extensions/registry';
export { buildCapabilitySnapshot, findCapabilities } from './capabilities/catalog';
export { commandCapabilities } from './capabilities/adapters';
export { projectToolSpecs } from './capabilities/projection';
export { loadBrand, createBrandRouter } from './brand';
export { getVersion } from '@forgeax/platform-io';
export { listAllCommands } from './commands/runner';
export { HistoryCoordinator, type HistorySource, type LaneStore, type PrepareOptions } from './history/coordinator';
export type { HistoryEntry, HistoryCursor, KernelLane, PreparedHistory } from './history/types';
export { HistoryService } from './history/service';
export { cloneHistoryBundle, createHistoryBundle, verifyHistoryBundle } from './history/bundle';
export { authorizeHistory, type HistoryCapability, type HistoryPrincipal } from './history/authorizer';
export { redactHistoryEntries } from './history/redactor';
export {
  createScopedExtensionCapabilities,
  getExtensionCapabilityControl,
  type ExtensionCaller,
  type ExtensionToolCall,
  type ScopedExtensionCapabilities,
  type ExtensionCapabilityControl,
  type ExtensionCapabilityInvocationContext,
  type ExtensionCapabilityInvocationOptions,
  type ExtensionCapabilityProvider,
} from './tools/extension-capabilities';

// WS + watcher primitives the shell wires into Bun.serve.
export { WsHub, createWsHandler, type WsClientData } from './ws';
export {
  FsWatcher,
  type AssetDiskChangedEvent,
  type FileChangeEvent,
  type FsWatcherEvent,
  type FsWatcherOptions,
  type FsWatcherState,
  type FsWatcherStatus,
} from './api/lib/watcher';

// Path helpers.
export { defaultProjectRoot } from '@forgeax/platform-io';
export { friendlyPath } from '@forgeax/platform-io';
export { mp, interfaceDist } from '@forgeax/platform-io';

// Root-surface completion (P6 / P7): assembly wiring points the product shell
// consumes directly. These promote pre-existing internal modules to the root
// `@forgeax/orchestrator` export so server stops reaching into their concrete
// paths. Additive only — see plan-strategy D-6 / D-7 and a3-port-mapping P6/P7.

// P6 — session bootstrap (api/lib/session-create).
export { ensureSessionWithBootstrap } from './api/lib/session-create';
// P6 — surface bus dispatch (api/bus).
export { dispatchToSurface, dispatchAndWait, getSurfaceSnapshot, listSurfaces } from './api/bus';
// P6 — event bus accessor (events/bus).
export { getEventBus } from './events/bus';
// P6 — builtin blackboard variable keys (defaults/blackboard-vars).
export { BLACKBOARD_KEYS } from './defaults/blackboard-vars';
// P6 — agent naming (api/lib/agent-naming).
export { computeAgentNaming, pickPersonName, type AgentNaming } from './api/lib/agent-naming';
// P6 — engine symlink repoint (api/lib/engine-symlink). Export promotion only;
// its Rule 8 hardcoded-path debt is tracked as A4 and NOT repaid in this loop.
export { repointEngineForgeaXSymlink } from './api/lib/engine-symlink';
// P7 — host runtime wiring that lands on the root surface by nearest-fit
// (tools/registry, terminal/manager, ledger/file-activity-ledger).
export { callTool } from './tools/registry';
export { getTerminalManager } from './terminal/manager';
export type { FileActivityRecord } from './ledger/file-activity-ledger';
