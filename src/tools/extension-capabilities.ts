import type { ToolCall } from '@forgeax/types';

/**
 * The published 0.1.x types package predates extension-origin callers. Keep
 * the compatibility widening at this orchestrator boundary so the runtime
 * can carry its identity without pretending that the legacy ToolCall schema
 * validates it. Once the public contract is released with the wider caller
 * union this local alias can collapse back to the published type.
 */
export type ExtensionCaller = ToolCall['caller'] | {
  readonly kind: 'extension';
  readonly extensionId: string;
  readonly instanceId: string;
  readonly sessionId?: string;
  readonly threadId?: string;
};

export type ExtensionToolCall = Omit<ToolCall, 'caller'> & {
  readonly caller: ExtensionCaller;
};

export interface ExtensionCapabilityInvocationOptions {
  readonly requestId?: string;
}

export interface ExtensionCapabilityInvocationContext {
  readonly caller: ExtensionCaller;
  readonly toolId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly game?: string;
}

export interface ExtensionCapabilityProvider {
  readonly capabilityId: string;
  readonly version: number;
  invoke(
    input: unknown,
    options: ExtensionCapabilityInvocationOptions,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<unknown>;
}

export interface ExtensionCapabilityControl {
  registerProvider(provider: ExtensionCapabilityProvider): void;
}

export interface ScopedExtensionCapabilities {
  has(capabilityId: string, version: number): boolean;
  invoke(
    capabilityId: string,
    version: number,
    input: unknown,
    options?: ExtensionCapabilityInvocationOptions,
  ): Promise<unknown>;
}

export class ExtensionCapabilityError extends Error {
  readonly code: 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_AMBIGUOUS';

  constructor(
    code: 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_AMBIGUOUS',
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionCapabilityError';
    this.code = code;
  }
}

function capabilityKey(capabilityId: string, version: number): string {
  return `${capabilityId}@${version}`;
}

function assertProvider(provider: ExtensionCapabilityProvider): void {
  if (
    !provider ||
    typeof provider.capabilityId !== 'string' ||
    provider.capabilityId.trim().length === 0 ||
    !Number.isInteger(provider.version) ||
    provider.version <= 0 ||
    typeof provider.invoke !== 'function'
  ) {
    throw new Error('Invalid extension capability provider');
  }
}

export class ExtensionCapabilityRegistry {
  readonly #providers = new Map<string, ExtensionCapabilityProvider[]>();

  readonly control: ExtensionCapabilityControl = {
    registerProvider: (provider) => {
      assertProvider(provider);
      const key = capabilityKey(provider.capabilityId, provider.version);
      const providers = this.#providers.get(key) ?? [];
      providers.push(provider);
      this.#providers.set(key, providers);
    },
  };

  scoped(context: ExtensionCapabilityInvocationContext): ScopedExtensionCapabilities {
    return {
      has: (capabilityId, version) =>
        (this.#providers.get(capabilityKey(capabilityId, version))?.length ?? 0) > 0,
      invoke: async (capabilityId, version, input, options = {}) => {
        const providers = this.#providers.get(capabilityKey(capabilityId, version)) ?? [];
        if (providers.length === 0) {
          throw new ExtensionCapabilityError(
            'CAPABILITY_UNAVAILABLE',
            `No provider registered for ${capabilityId}@${version}`,
          );
        }
        if (providers.length > 1) {
          throw new ExtensionCapabilityError(
            'CAPABILITY_AMBIGUOUS',
            `Multiple providers registered for ${capabilityId}@${version}`,
          );
        }
        return providers[0]!.invoke(input, options, context);
      },
    };
  }
}

const registry = new ExtensionCapabilityRegistry();

export function getExtensionCapabilityControl(): ExtensionCapabilityControl {
  return registry.control;
}

export function createScopedExtensionCapabilities(
  context: ExtensionCapabilityInvocationContext,
): ScopedExtensionCapabilities {
  return registry.scoped(context);
}
