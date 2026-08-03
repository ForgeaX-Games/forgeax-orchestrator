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
export { HEADLESS_ACTION_GRANDFATHER_IDS } from './kernel/action-catalog';

// Boot / lifecycle helpers used by product shells.
export { initPathManager } from './fs/path-manager';
export { ensureUserDirDefaults } from './defaults/scaffold';
export { initSessionManager, getSessionManager } from './core/session-manager';
export { bootCliProviders } from './cli-providers';
export { reloadExtensions } from './extensions/registry';
export { getExtensionSnapshot } from './extensions/registry';
export { buildCapabilitySnapshot, findCapabilities } from './capabilities/catalog';
export { commandCapabilities } from './capabilities/adapters';
export { projectToolSpecs } from './capabilities/projection';
export { loadBrand, createBrandRouter } from './brand';
export { getVersion } from '@forgeax/platform-io';
export { listAllCommands } from './commands/runner';

// WS + watcher primitives the shell wires into Bun.serve.
export { WsHub, createWsHandler, type WsClientData } from './ws';
export { FsWatcher, type AssetDiskChangedEvent, type FileChangeEvent, type FsWatcherEvent } from './api/lib/watcher';

// Path helpers.
export { defaultProjectRoot } from '@forgeax/platform-io';
export { friendlyPath } from '@forgeax/platform-io';
export { mp, interfaceDist } from '@forgeax/platform-io';
