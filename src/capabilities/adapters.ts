import type { CapabilityDescriptor } from '@forgeax/types';
import type { CommandSpec } from '../commands/types';

/** Convert the existing command runner catalog into runtime descriptors. */
export function commandCapabilities(
  commands: readonly CommandSpec[],
  generation: number,
): CapabilityDescriptor[] {
  return commands.map((command) => ({
    capabilityId: `@forgeax-extension/builtin-commands#command:${command.name}`,
    kind: 'command' as const,
    extensionId: '@forgeax-extension/builtin-commands',
    extensionVersion: 'builtin',
    schemaVersion: 1,
    origin: 'builtin' as const,
    originPath: 'builtin/commands',
    shadowedBy: [],
    trustTier: 'own' as const,
    permissions: [],
    dependencies: [],
    lifecycle: {
      state: 'ready' as const,
      reloadable: true,
      requiresRestart: false,
    },
    isolation: {
      project: true,
      agent: true,
      session: true,
      thread: true,
      memoryTiers: [],
    },
    generation,
    localId: command.name,
    metadata: {
      description: command.description,
      hasQuery: command.hasQuery,
      hasExecute: command.hasExecute,
    },
  }));
}
