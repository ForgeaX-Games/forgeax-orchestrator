import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { createHonoExtensionRouter } from '@forgeax/extension-host/http/hono';
import { mountExtensionHost } from '../src/app';

type HttpHost = Parameters<typeof createHonoExtensionRouter>[0];

function fakeHost(): HttpHost {
  return {
    catalog: (gameId) => [{
      extensionId: '@forgeax-extension/video-game',
      runtimeId: `runtime-${gameId}`,
      title: 'Game Video',
    }],
    listTools: () => [],
    callTool: () => ({}),
    packageStatus: () => ({ state: 'uninitialized' }),
    initializePackage: () => ({}),
    readPackage: () => ({}),
    updatePackage: () => ({}),
    createVersion: () => ({}),
    createCheckpoint: () => ({}),
    listVersions: () => [],
    currentVersion: () => null,
    readVersionPackage: () => ({}),
    restoreVersion: () => ({}),
    runtimeRoot: () => null,
    componentFile: () => null,
    extension: () => ({ status: 404 }),
  };
}

describe('mountExtensionHost', () => {
  test('mounts the shared Hono adapter only at /__extension__/v1', async () => {
    const app = new Hono();
    mountExtensionHost(app, fakeHost());

    const response = await app.request('/__extension__/v1/catalog?gameId=game-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      extensionId: '@forgeax-extension/video-game',
      runtimeId: 'runtime-game-1',
      title: 'Game Video',
    }]);
    expect((await app.request('/api/game-host/catalog?gameId=game-1')).status).toBe(404);
    expect((await app.request('/api/extensions/catalog?gameId=game-1')).status).toBe(404);
  });
});
