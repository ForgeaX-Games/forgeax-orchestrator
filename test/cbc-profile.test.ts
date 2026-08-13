import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCbcMcpArgs } from '../src/kernel/cbc-profile';

const request = {
  tools: [{ name: 'npc_wire', description: 'wire', inputSchema: { type: 'object' } }],
  session: { agentId: 'forge' },
  hostSessionId: 'sid',
} as never;

describe('cbc builtin adoption surface', () => {
  test('keeps npc_wire local to the forgeax builtin MCP server', () => {
    const args = buildCbcMcpArgs(request, 'sid');
    const configPath = args[args.indexOf('--mcp-config') + 1];
    expect(configPath).toBeTruthy();
    const config = JSON.parse(readFileSync(configPath!, 'utf8')) as { mcpServers?: { fxt?: { env?: Record<string, string> } } };
    expect(config.mcpServers?.fxt?.env?.FORGEAX_TOOL_SPECS_FILE).toBeUndefined();
  });

  test('routes project MCP through fxt without mounting a second native server', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-cbc-project-mcp-'));
    try {
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: { project: { command: process.execPath, args: ['fixture.mjs'] } },
      }));
      const args = buildCbcMcpArgs({
        tools: [{ name: 'mcp__project__read_data', description: 'read', inputSchema: { type: 'object' } }],
        session: { agentId: 'forge' },
        hostSessionId: 'sid',
      } as never, 'sid', root);
      const configPath = args[args.indexOf('--mcp-config') + 1];
      const config = JSON.parse(readFileSync(configPath!, 'utf8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      expect(Object.keys(config.mcpServers ?? {})).toEqual(['fxt']);
      expect(config.mcpServers?.fxt?.env?.FORGEAX_DISABLE_PROJECT_MCP).toBe('1');
      const specsPath = config.mcpServers?.fxt?.env?.FORGEAX_TOOL_SPECS_FILE;
      expect(specsPath).toBeTruthy();
      expect(JSON.parse(readFileSync(specsPath!, 'utf8'))).toEqual([
        { name: 'mcp__project__read_data', description: 'read', inputSchema: { type: 'object' } },
      ]);
      expect(args).toContain('mcp__fxt__mcp__project__read_data');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
