// `@forgeax/orchestrator/session-fs` — session filesystem capability face (P5).
//
// Barrel that promotes the pre-existing `fs/{path-manager,session-layout,
// safe-segment,user-dir}` modules to a single stable export surface. Consumers
// (studio-session-layout, extension pages, telemetry-file-sink) depend on the
// `session-fs` capability rather than reaching into the concrete file paths.
//
// Pure re-export (no new logic). See plan-strategy D-5.

export * from './path-manager';
export * from './session-layout';
export * from './safe-segment';
export * from './user-dir';
