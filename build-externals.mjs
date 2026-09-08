/**
 * Mutable runtime singletons must be shared with the embedding product.
 * Bundling a second copy creates a second kernel registry inside compiled apps.
 */
export const SHARED_RUNTIME_SINGLETONS = new Set([
  '@forgeax/agent-runtime',
]);

export function shouldExternalizeBuildSpecifier(specifier) {
  if (SHARED_RUNTIME_SINGLETONS.has(specifier)) return true;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('@/')) return false;
  if (specifier.startsWith('@forgeax/')) return false;
  return true;
}
