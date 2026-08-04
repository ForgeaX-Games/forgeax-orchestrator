import { describe, expect, test } from 'bun:test';
import {
  ExtensionCapabilityRegistry,
  type ExtensionCapabilityInvocationContext,
} from '../src/tools/extension-capabilities';

const context: ExtensionCapabilityInvocationContext = {
  caller: { kind: 'ai' },
  toolId: 'wb_game_video_generate_video',
  env: {},
  cwd: '/extensions/wb-game-video',
  projectRoot: '/project',
  game: 'game-1',
};

describe('ExtensionCapabilityRegistry', () => {
  test('binds one registered provider to the current tool invocation context', async () => {
    const registry = new ExtensionCapabilityRegistry();
    const calls: unknown[] = [];
    expect(registry.scoped(context).has('media.video.generate', 1)).toBe(false);
    registry.control.registerProvider({
      capabilityId: 'media.video.generate',
      version: 1,
      async invoke(input, options, invocationContext) {
        calls.push({ input, options, invocationContext });
        return { ok: true };
      },
    });
    expect(registry.scoped(context).has('media.video.generate', 1)).toBe(true);

    await expect(registry.scoped(context).invoke(
      'media.video.generate',
      1,
      { prompt: 'rain' },
      { requestId: 'request-1' },
    )).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{
      input: { prompt: 'rain' },
      options: { requestId: 'request-1' },
      invocationContext: context,
    }]);
  });

  test('reports missing and ambiguous providers with stable capability codes', async () => {
    const missing = new ExtensionCapabilityRegistry();
    await expect(missing.scoped(context).invoke('media.video.generate', 1, {})).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });

    const ambiguous = new ExtensionCapabilityRegistry();
    for (let index = 0; index < 2; index += 1) {
      ambiguous.control.registerProvider({
        capabilityId: 'media.video.generate',
        version: 1,
        async invoke() {
          return index;
        },
      });
    }
    await expect(ambiguous.scoped(context).invoke('media.video.generate', 1, {})).rejects.toMatchObject({
      code: 'CAPABILITY_AMBIGUOUS',
    });
  });
});
