import { afterEach, describe, expect, test } from 'bun:test';
import {
  resolveBundledBunExecutable,
  resolvePermissionServerEntry,
  resolvePermissionServerLaunch,
} from '../src/cli-providers/mcp/permission-server-entry';

const original = process.env.FORGEAX_PERMISSION_SERVER_ENTRY;

afterEach(() => {
  if (original === undefined) delete process.env.FORGEAX_PERMISSION_SERVER_ENTRY;
  else process.env.FORGEAX_PERMISSION_SERVER_ENTRY = original;
});

describe('permission server entry', () => {
  test('keeps the caller-specific colocated fallback without a product override', () => {
    delete process.env.FORGEAX_PERMISSION_SERVER_ENTRY;
    expect(resolvePermissionServerEntry('/source/cli-providers/mcp/permission-server.mjs'))
      .toBe('/source/cli-providers/mcp/permission-server.mjs');
  });

  test('normalizes one product-owned entry for every Claude execution path', () => {
    process.env.FORGEAX_PERMISSION_SERVER_ENTRY = '/packaged/runtime/../mcp/permission-server.mjs';
    const expected = '/packaged/mcp/permission-server.mjs';
    expect(resolvePermissionServerEntry('/kernel/fallback.mjs')).toBe(expected);
    expect(resolvePermissionServerEntry('/provider/fallback.mjs')).toBe(expected);
  });

  test('derives the packaged permission server and Bun command from product runtime anchors', () => {
    expect(resolvePermissionServerLaunch('/$bunfs/fallback.mjs', {
      FORGEAX_TOOLS_SERVER_ENTRY: '/App/Resources/resources/server-runtime/assets/forgeax-tools-server.mjs',
      FORGEAX_BUN_EXECUTABLE: '/App/Resources/resources/sidecars/bun-aarch64-apple-darwin',
    }, '/compiled/forgeax-server')).toEqual({
      command: '/App/Resources/resources/sidecars/bun-aarch64-apple-darwin',
      entry: '/App/Resources/resources/cli-providers/mcp/permission-server.mjs',
    });
  });

  test('uses the same packaged Bun for the permission and fxt MCP assets', () => {
    const env = { FORGEAX_BUN_EXECUTABLE: '/App/Resources/sidecars/bun' } as NodeJS.ProcessEnv;
    expect(resolveBundledBunExecutable(env, '/compiled/server')).toBe('/App/Resources/sidecars/bun');
    expect(resolvePermissionServerLaunch('/fallback.mjs', env, '/compiled/server').command)
      .toBe('/App/Resources/sidecars/bun');
  });
});
