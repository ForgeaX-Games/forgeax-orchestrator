import { describe, expect, test } from 'bun:test';
import {
  chunkHostWriteFileArgs,
  executeHostToolWithWriteRecovery,
  HOST_WRITE_FILE_CHUNK_CHARS,
} from '../src/kernel/host-write-recovery';

describe('forgeax-core host write recovery', () => {
  test('splits oversized legacy host writes and appends every later chunk', () => {
    const content = 'a'.repeat(HOST_WRITE_FILE_CHUNK_CHARS + 17);
    const args = { path: 'games/demo/src/scene.ts', content };
    const calls = chunkHostWriteFileArgs('write_file', args);

    expect(calls).toHaveLength(2);
    expect((calls[0] as Record<string, unknown>).content).toBe('a'.repeat(HOST_WRITE_FILE_CHUNK_CHARS));
    expect((calls[0] as Record<string, unknown>).append).toBeUndefined();
    expect((calls[1] as Record<string, unknown>).content).toBe('a'.repeat(17));
    expect((calls[1] as Record<string, unknown>).append).toBe(true);
    expect(calls.map((call) => (call as Record<string, unknown>).content).join('')).toBe(content);
  });

  test('does not split native contents or non-write host calls', () => {
    const nativeArgs = { path: 'scene.ts', contents: 'a'.repeat(HOST_WRITE_FILE_CHUNK_CHARS + 1) };
    const legacyLikeArgs = { file_path: 'scene.ts', content: 'a'.repeat(HOST_WRITE_FILE_CHUNK_CHARS + 1) };

    expect(chunkHostWriteFileArgs('write_file', nativeArgs)).toEqual([nativeArgs]);
    expect(chunkHostWriteFileArgs('Write', legacyLikeArgs)).toEqual([legacyLikeArgs]);
    expect(chunkHostWriteFileArgs('read_file', legacyLikeArgs)).toEqual([legacyLikeArgs]);
  });

  test('keeps Unicode code points intact at chunk boundaries', () => {
    const content = 'abc😀def';
    const calls = chunkHostWriteFileArgs('write_file', { path: 'scene.ts', content }, 4);
    const chunks = calls.map((call) => (call as { content: string }).content);

    expect(chunks.join('')).toBe(content);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
    expect(chunks.every((chunk) =>
      [...chunk].every((codePoint) => !(/[\uD800-\uDFFF]/.test(codePoint) && codePoint.length === 1)),
    )).toBe(true);
  });

  test('executes chunks serially and preserves host bridge context', async () => {
    const content = 'x'.repeat(HOST_WRITE_FILE_CHUNK_CHARS + 3);
    const seen: Array<{ args: unknown; sid?: string; agentId?: string; callId?: string; turnCallId?: string }> = [];
    const result = await executeHostToolWithWriteRecovery(
      async (name, args, sid, agentId, callId, turnCallId) => {
        expect(name).toBe('write_file');
        seen.push({ args, sid, agentId, callId, turnCallId });
        return `ok:${(args as { content: string }).content.length}`;
      },
      'write_file',
      { path: 'scene.ts', content },
      'sid-1',
      'agent-1',
      'call-1',
      'turn-1',
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ sid: 'sid-1', agentId: 'agent-1', callId: 'call-1', turnCallId: 'turn-1' });
    expect(seen[1]).toMatchObject({ sid: 'sid-1', agentId: 'agent-1', callId: 'call-1', turnCallId: 'turn-1' });
    expect((seen[1].args as Record<string, unknown>).append).toBe(true);
    expect(result).toBe(`ok:${HOST_WRITE_FILE_CHUNK_CHARS}\nok:3`);
  });
});
