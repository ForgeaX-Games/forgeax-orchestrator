import { describe, expect, test } from 'bun:test';
import { messagesToAnthropic } from '../src/llm/anthropic';

const toolUse = {
  type: 'tool_use',
  id: 'call-1',
  name: 'ask_user',
  input: { question: 'Pick one', options: ['A', 'B'] },
};

describe('Anthropic assistant history', () => {
  test('does not replay an unsigned thinking block', async () => {
    const messages = await messagesToAnthropic([{
      role: 'assistant',
      content: [],
      providerSidecarData: {
        anthropic: {
          contentBlocks: [
            { type: 'thinking', thinking: 'waiting for the user' },
            toolUse,
          ],
        },
      },
    }]);

    expect(messages).toEqual([{ role: 'assistant', content: [toolUse] }]);
  });

  test('preserves a signed thinking block', async () => {
    const signed = { type: 'thinking', thinking: 'signed reasoning', signature: 'sig-1' };
    const messages = await messagesToAnthropic([{
      role: 'assistant',
      content: [],
      providerSidecarData: { anthropic: { contentBlocks: [signed] } },
    }]);

    expect(messages).toEqual([{ role: 'assistant', content: [signed] }]);
  });
});
