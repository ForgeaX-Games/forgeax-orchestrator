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

  test('resolves a stable extension slug before delegating packaged HTTP routes', async () => {
    const requests: Parameters<HttpHost['extension']>[0][] = [];
    const host = fakeHost();
    host.catalog = () => [{
      extensionId: '@forgeax-extension/reel',
      runtimeId: 'runtime-reel',
      title: 'Reel Studio',
    }];
    host.extension = (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"ok":true}'),
      };
    };
    const app = new Hono();
    mountExtensionHost(app, host);

    const response = await app.request(
      '/__extension__/v1/by-id/reel/scenarios?gameId=game-1&kind=image',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{"db":{"version":1}}',
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      gameId: 'game-1',
      runtimeId: 'runtime-reel',
      path: 'scenarios',
      method: 'PUT',
      query: { kind: ['image'] },
    });
    expect(new TextDecoder().decode(requests[0]?.body)).toBe('{"db":{"version":1}}');

    const proxiedResponse = await app.request(
      '/api/extension-runtime/by-id/reel/assets?gameId=game-1',
    );
    expect(proxiedResponse.status).toBe(200);
    expect(requests[1]).toMatchObject({
      gameId: 'game-1',
      runtimeId: 'runtime-reel',
      path: 'assets',
      method: 'GET',
    });
  });

  test('rejects missing or ambiguous extension slugs', async () => {
    const host = fakeHost();
    host.catalog = () => [
      {
        extensionId: '@forgeax-extension/reel',
        runtimeId: 'runtime-reel-a',
        title: 'Reel A',
      },
      {
        extensionId: '@other/reel',
        runtimeId: 'runtime-reel-b',
        title: 'Reel B',
      },
    ];
    const app = new Hono();
    mountExtensionHost(app, host);

    expect((await app.request(
      '/__extension__/v1/by-id/reel/scenarios?gameId=game-1',
    )).status).toBe(409);
    expect((await app.request(
      '/__extension__/v1/by-id/missing/scenarios?gameId=game-1',
    )).status).toBe(404);
    expect((await app.request(
      '/__extension__/v1/by-id/reel/scenarios',
    )).status).toBe(400);
  });

  test('keeps the stable-id adapter within the shared request-size bound', async () => {
    const host = fakeHost();
    host.catalog = () => [{
      extensionId: '@forgeax-extension/reel',
      runtimeId: 'runtime-reel',
      title: 'Reel',
    }];
    const app = new Hono();
    mountExtensionHost(app, host);

    const response = await app.request(
      '/api/extension-runtime/by-id/reel/assets?gameId=game-1',
      {
        method: 'POST',
        body: new Uint8Array(1_048_577),
      },
    );

    expect(response.status).toBe(413);
  });
});
