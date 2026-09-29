import { describe, expect, test } from 'bun:test';
import {
  ExtensionCapabilityRegistry,
  type ExtensionCapabilityInvocationContext,
} from '../src/tools/extension-capabilities';

const context: ExtensionCapabilityInvocationContext = {
  caller: { kind: 'ai' },
  toolId: 'video_game_generate_video',
  env: {},
  cwd: '/extensions/video-game',
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

  test('keeps a legacy Extension Host caller anonymous instead of inventing identity', async () => {
    const registry = new ExtensionCapabilityRegistry();
    const anonymousContext: ExtensionCapabilityInvocationContext = {
      ...context,
      caller: { kind: 'extension', identityState: 'unavailable' },
    };
    let observed: ExtensionCapabilityInvocationContext | undefined;
    registry.control.registerProvider({
      capabilityId: 'media.video.generate',
      version: 1,
      async invoke(_input, _options, invocationContext) {
        observed = invocationContext;
        return { ok: true };
      },
    });

    await registry.scoped(anonymousContext).invoke('media.video.generate', 1, {});

    expect(observed?.caller).toEqual({ kind: 'extension', identityState: 'unavailable' });
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
