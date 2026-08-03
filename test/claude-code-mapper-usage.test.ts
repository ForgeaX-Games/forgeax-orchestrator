/** claude-code-mapper usage —— inputTokens 框架统一口径回归。
 *
 *  背景:Anthropic 原始 input_tokens 是「裸输入」,不含缓存;但框架级
 *  `usage.inputTokens` 的统一口径是**含**缓存(src/llm/anthropic.ts 直连
 *  provider 的既有算法:nakedInput + cacheRead + cacheCreate,Codex/OpenAI 的
 *  input_tokens 原生也是这个口径)。the reference agent CLI CLI 适配层原来对 input_tokens
 *  做直通(不加缓存),导致这条路径产出的 inputTokens 与框架口径不一致——重度
 *  命中缓存的会话会被下游(auto_compaction 上下文占用估算)严重低估。
 *  修复:在 captureUsage(唯一适配入口)把裸 input_tokens 换算成含缓存口径。 */

import { describe, expect, test } from 'bun:test';
import { createClaudeMapperState, mapClaudeEvent } from '../src/cli-providers/shared/claude-code-mapper';

describe('claude-code-mapper captureUsage — inputTokens 含缓存统一口径', () => {
  test('result 事件的裸 input_tokens 换算成含 cacheRead+cacheCreation 的口径', () => {
    const state = createClaudeMapperState();
    const events = mapClaudeEvent(
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 20,
        },
      } as never,
      state,
    );

    const done = events.find((e) => e.type === 'done');
    expect(done?.usage?.inputTokens).toBe(1020); // 100 + 900 + 20
    expect(done?.usage?.outputTokens).toBe(50);
    expect(done?.usage?.cacheReadTokens).toBe(900);
    expect(done?.usage?.cacheCreationTokens).toBe(20);
  });

  test('无缓存字段时,inputTokens 原样等于裸 input_tokens(不受影响)', () => {
    const state = createClaudeMapperState();
    const events = mapClaudeEvent(
      { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } } as never,
      state,
    );

    const done = events.find((e) => e.type === 'done');
    expect(done?.usage?.inputTokens).toBe(100);
  });

  test('缓存字段随 assistant 快照先到,input_tokens 随 result 后到——仍能换算正确', () => {
    const state = createClaudeMapperState();
    mapClaudeEvent(
      { type: 'assistant', message: { usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 20 } } } as never,
      state,
    );
    const events = mapClaudeEvent(
      { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } } as never,
      state,
    );

    const done = events.find((e) => e.type === 'done');
    expect(done?.usage?.inputTokens).toBe(1020);
  });
});
