// `@forgeax/orchestrator/extensions` — extension-source read facade (P4).
//
// Barrel that promotes the pre-existing extension/agent read surface to a
// single stable export. It aggregates the three modules the product shell
// consumes when reading installed extensions and agents:
//   - extensions/registry       (snapshot + reload of installed extensions)
//   - agents/loader             (enumerate agents + resolve their personas)
//
// Consumers (extension pages, environment, editor-ui-browse-host-tools) depend on the
// `extensions` capability rather than reaching into these concrete paths.
//
// Pure re-export (no new logic). See plan-strategy D-4 / a3-port-mapping P4.

export * from './registry';
export * from '../agents/loader';
