import { describe, expect, test } from 'bun:test';
import {
  SHARED_RUNTIME_SINGLETONS,
  shouldExternalizeBuildSpecifier,
} from '../build-externals.mjs';

describe('orchestrator build externals', () => {
  test('keeps the mutable agent-runtime registry shared with the product shell', () => {
    expect(SHARED_RUNTIME_SINGLETONS).toEqual(new Set(['@forgeax/agent-runtime']));
    expect(shouldExternalizeBuildSpecifier('@forgeax/agent-runtime')).toBe(true);
  });

  test('continues bundling ordinary ForgeaX workspace source', () => {
    expect(shouldExternalizeBuildSpecifier('@forgeax/platform-io')).toBe(false);
    expect(shouldExternalizeBuildSpecifier('@forgeax/agent-host')).toBe(false);
    expect(shouldExternalizeBuildSpecifier('@/kernel/resolve-kernel')).toBe(false);
    expect(shouldExternalizeBuildSpecifier('./kernel/resolve-kernel')).toBe(false);
    expect(shouldExternalizeBuildSpecifier('hono')).toBe(true);
  });
});
