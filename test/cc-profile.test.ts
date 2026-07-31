import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMcpArgs } from '../src/kernel/cc-profile';

const request = {
  tools: [{ name: 'npc_wire', description: 'wire', inputSchema: { type: 'object' } }],
  session: { agentId: 'forge' },
  hostSessionId: 'sid',
} as never;

describe('cc builtin adoption surface', () => {
  test('keeps npc_wire local to the forgeax builtin MCP server', () => {
    const args = buildMcpArgs(request, 'sid');
    const configPath = args[args.indexOf('--mcp-config') + 1];
    expect(configPath).toBeTruthy();
    const config = JSON.parse(readFileSync(configPath!, 'utf8')) as { mcpServers?: { fxt?: { env?: Record<string, string> } } };
    expect(config.mcpServers?.fxt?.env?.FORGEAX_TOOL_SPECS_FILE).toBeUndefined();
  });
});
