import type { ToolSpec } from '@forgeax/agent-runtime';
import type { CapabilitySnapshot } from '@forgeax/types';

export type KernelProjection = 'native' | 'rented';

/**
 * Add the catalog identity to a neutral tool list before it is handed to a
 * kernel adapter. Rented kernels receive the same descriptors through fxt MCP;
 * native kernels consume them through the host/local bridge.
 */
export function projectToolSpecs(
  tools: readonly ToolSpec[],
  snapshot: CapabilitySnapshot,
  projection: KernelProjection,
): ToolSpec[] {
  return tools.map((tool) => {
    const capability = snapshot.capabilities.find((candidate) =>
      (candidate.kind === 'tool' || candidate.kind === 'skill' || candidate.kind === 'memory') &&
      (candidate.localId === tool.name || candidate.localId === tool.name.replace(/^skill_/, '')),
    );
    return {
      ...tool,
      ...(capability
        ? {
            capabilityId: capability.capabilityId,
            capabilityGeneration: snapshot.generation,
          }
        : {}),
      delivery: projection === 'native' && tool.delivery === 'local' ? 'local' : 'host',
    };
  });
}
