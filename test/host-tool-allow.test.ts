import { describe, expect, test } from 'bun:test';
import {
  globToRegExp,
  isDefaultConversationAgent,
  resolveHostToolAllow,
  unionAllowTokens,
} from '../src/tools/host-tool-allow';

describe('resolveHostToolAllow', () => {
  test('unions stale session allow with live persona globs', () => {
    const allow = resolveHostToolAllow('forge', ['gen3d:*', 'character:*', 'team:*'], {
      personaTools: () => ['gen3d:*', 'character:*', 'team:*', '*-audio-*', 'define-bus'],
      defaultAgentId: 'forge',
      defaultAgentToolIds: [],
    });
    expect(allow).toContain('*-audio-*');
    expect(allow).toContain('define-bus');
    expect(allow).toContain('gen3d:*');
  });

  test('default conversation agent gets plugin defaultAgentAllow even with empty session allow', () => {
    const allow = resolveHostToolAllow('forge', [], {
      personaTools: () => [],
      defaultAgentId: 'forge',
      defaultAgentToolIds: ['generate-audio-assets', 'get-audio-project'],
    });
    expect(allow).toEqual(['generate-audio-assets', 'get-audio-project']);
    expect(resolveHostToolAllow('default', [], {
      personaTools: () => [],
      defaultAgentId: 'forge',
      defaultAgentToolIds: ['generate-audio-assets'],
    })).toEqual(['generate-audio-assets']);
  });

  test('specialist agents stay opt-in empty without session or persona allow', () => {
    const allow = resolveHostToolAllow('iori', [], {
      personaTools: () => [],
      defaultAgentId: 'forge',
      defaultAgentToolIds: ['generate-audio-assets'],
    });
    expect(allow).toEqual([]);
  });

  test('glob *-audio-* matches generate-audio-assets and not search-audio or reel:edit-audio', () => {
    const re = globToRegExp('*-audio-*');
    expect(re.test('generate-audio-assets')).toBe(true);
    expect(re.test('get-audio-project')).toBe(true);
    expect(re.test('search-audio')).toBe(false);
    expect(re.test('reel:edit-audio')).toBe(false);
    expect(re.test('define-game-sync')).toBe(false);
  });

  test('unionAllowTokens preserves first-seen order', () => {
    expect(unionAllowTokens(['a', 'b'], ['b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
  });

  test('isDefaultConversationAgent covers forge aliases', () => {
    expect(isDefaultConversationAgent('forge', 'forge')).toBe(true);
    expect(isDefaultConversationAgent('default', 'forge')).toBe(true);
    expect(isDefaultConversationAgent('root', 'forge')).toBe(true);
    expect(isDefaultConversationAgent('iori', 'forge')).toBe(false);
  });
});
