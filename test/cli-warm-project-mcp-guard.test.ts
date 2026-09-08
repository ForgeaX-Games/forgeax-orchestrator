import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldDeferNativeProjectMcpPrewarm } from '../src/api/cli/chat';

describe('CLI warm native project-MCP guard', () => {
  test('defers native warm only while project MCP servers need native ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-cli-warm-project-mcp-'));
    try {
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: { project: { command: 'node' } },
      }));

      expect(shouldDeferNativeProjectMcpPrewarm('claude-code', 'own', root)).toBe(true);
      expect(shouldDeferNativeProjectMcpPrewarm('codex', 'own', root)).toBe(false);
      expect(shouldDeferNativeProjectMcpPrewarm('claude-code', 'imported', root)).toBe(false);

      rmSync(join(root, '.forgeax', 'mcp.json'));
      expect(shouldDeferNativeProjectMcpPrewarm('claude-code', 'own', root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
