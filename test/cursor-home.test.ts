import { describe, expect, test } from 'bun:test';
import { buildCursorHomeWithoutUserMcp, disposeCursorHome } from '../src/kernel/cursor-home';

describe('Cursor HOME isolation', () => {
  test('preserves the native HOME by default and only mirrors on explicit opt-in', () => {
    const previous = process.env.FORGEAX_CURSOR_ISOLATE_MCP;
    try {
      delete process.env.FORGEAX_CURSOR_ISOLATE_MCP;
      expect(buildCursorHomeWithoutUserMcp()).toBeUndefined();

      process.env.FORGEAX_CURSOR_ISOLATE_MCP = '0';
      expect(buildCursorHomeWithoutUserMcp()).toBeUndefined();

      if (process.platform !== 'win32') {
        process.env.FORGEAX_CURSOR_ISOLATE_MCP = '1';
        const isolated = buildCursorHomeWithoutUserMcp();
        expect(typeof isolated).toBe('string');
        disposeCursorHome(isolated);
      }
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_CURSOR_ISOLATE_MCP;
      else process.env.FORGEAX_CURSOR_ISOLATE_MCP = previous;
    }
  });
});
