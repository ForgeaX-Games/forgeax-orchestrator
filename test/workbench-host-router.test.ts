import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { createHonoWorkbenchRouter } from '@forgeax/workbench-host/http/hono';
import { mountWorkbenchHost } from '../src/app';

type HttpHost = Parameters<typeof createHonoWorkbenchRouter>[0];

function fakeHost(): HttpHost {
  return {
    catalog: (gameId) => [{
      extensionId: '@forgeax/wb-game-video',
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

describe('mountWorkbenchHost', () => {
  test('mounts the shared Hono adapter only at /__workbench__/v1', async () => {
    const app = new Hono();
    mountWorkbenchHost(app, fakeHost());

    const response = await app.request('/__workbench__/v1/catalog?gameId=game-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      extensionId: '@forgeax/wb-game-video',
      runtimeId: 'runtime-game-1',
      title: 'Game Video',
    }]);
    expect((await app.request('/api/game-host/catalog?gameId=game-1')).status).toBe(404);
    expect((await app.request('/api/extensions/catalog?gameId=game-1')).status).toBe(404);
  });
});
