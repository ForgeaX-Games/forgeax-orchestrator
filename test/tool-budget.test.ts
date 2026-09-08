import { describe, expect, test } from 'bun:test';
import { capToolsForProvider, PROVIDER_TOOL_LIMIT } from '../src/kernel/tool-budget';

describe('capToolsForProvider', () => {
  test('leaves lists at or under the provider limit unchanged', () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}` }));
    expect(capToolsForProvider(tools, { limit: 128 })).toEqual(tools);
  });

  test('drops unpinned tools from the end and keeps pinned generation tools', () => {
    const tools = [
      { name: 'ask_user' },
      { name: 'generate-audio-assets' },
      { name: 'get-audio-project' },
      ...Array.from({ length: 130 }, (_, i) => ({ name: `skill_${i}` })),
    ];
    const capped = capToolsForProvider(tools, {
      limit: PROVIDER_TOOL_LIMIT,
      pinNames: ['ask_user', 'generate-audio-assets', 'get-audio-project'],
    });
    expect(capped).toHaveLength(PROVIDER_TOOL_LIMIT);
    expect(capped.map((t) => t.name)).toEqual(
      expect.arrayContaining(['ask_user', 'generate-audio-assets', 'get-audio-project']),
    );
    expect(capped.at(-1)?.name).not.toBe('skill_129');
  });
});
