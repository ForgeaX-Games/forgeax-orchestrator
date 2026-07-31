import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('createForgeaxApp forwards both game-host product hooks', async () => {
  const source = await Bun.file(join(import.meta.dir, '../src/app.ts')).text();
  const routeStart = source.indexOf("app.route('/api/game-host', createGameHostRouter({");
  const routeEnd = source.indexOf('}));', routeStart);

  expect(routeStart).toBeGreaterThan(-1);
  expect(routeEnd).toBeGreaterThan(routeStart);
  const route = source.slice(routeStart, routeEnd);
  expect(route).toContain('beforeVersion: ctx.gameHostBeforeVersion');
  expect(route).toContain('seedProvider: ctx.gameHostSeedProvider');
});
