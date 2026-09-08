import { describe, expect, test } from 'bun:test';
import { createAgentToolScope, COORDINATOR_TOOL_GRANTS } from '../src/agents/tool-grants';

describe('agent tool grants', () => {
  test('specialist keeps declared tools and infrastructure, not ambient capabilities', () => {
    const scope = createAgentToolScope(undefined, ['scene_create', 'read_file']);
    expect(['scene_create', 'read_file', 'todo_write'].every(scope.allows)).toBe(true);
    for (const name of ['search-audio', 'skill_character', 'mcp__playwright__browser_click', 'ui_act_role_create']) {
      expect(scope.allows(name)).toBe(false);
    }
    expect(scope.hasProjectMcpGrants).toBe(false);
  });
  test('explicit coordinator grants preserve ambient host, skill and MCP capabilities', () => {
    const scope = createAgentToolScope(COORDINATOR_TOOL_GRANTS);
    for (const name of ['query_world', 'ui_invoke', 'skill_character', 'mcp__playwright__browser_click']) {
      expect(scope.allows(name)).toBe(true);
    }
  });
  test('MCP grant is a wire-name glob and does not authorize another server or tool', () => {
    const scope = createAgentToolScope({ projectMcp: ['mcp__scene__read_*'] });
    expect(scope.allows('mcp__scene__read_scene')).toBe(true);
    expect(scope.allows('mcp__scene__delete_scene')).toBe(false);
    expect(scope.allows('mcp__playwright__read_scene')).toBe(false);
    expect(scope.allows('skill_scene')).toBe(false);
  });
  test('grants are separate namespaces and malformed grants fail closed', () => {
    expect(createAgentToolScope({ host: ['*'] }).allows('mcp__scene__read_scene')).toBe(false);
    expect(createAgentToolScope({ host: ['*'] }).allows('skill_scene')).toBe(false);
    expect(() => createAgentToolScope({ projectMcp: '*' } as any)).toThrow();
  });
});
