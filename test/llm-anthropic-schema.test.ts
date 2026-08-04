import { describe, expect, test } from 'bun:test';
import { toolDefsToAnthropic } from '../src/llm/anthropic';
import type { ToolDefinition } from '../src/core/types';

describe('Anthropic tool schema mapping', () => {
  test('adds the required top-level type without mutating the source schema', () => {
    const inputSchema = { properties: { query: { type: 'string' } } };
    const tool = {
      name: 'search',
      description: 'search',
      input_schema: inputSchema,
      execute: async () => 'ok',
    } as unknown as ToolDefinition;

    const mapped = toolDefsToAnthropic([tool]) as Array<{
      input_schema: Record<string, unknown>;
    }>;

    expect(mapped[0]?.input_schema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
    expect(inputSchema).toEqual({ properties: { query: { type: 'string' } } });
  });
});
