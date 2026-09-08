import { afterEach, describe, expect, test } from 'bun:test';
import {
  callExtensionAgentTool,
  configureExtensionAgentTools,
  listExtensionAgentTools,
  resetExtensionAgentToolsForTests,
} from '../src/extension-host/agent-tools';
import hostToolBridge from '../builtin/kits/host-tools/plugins/host_tool_bridge';
import { ToolRegistry } from '../src/kits/tool-registry';
import type { AgentContext } from '../src/core/types';
import { withAgentHostToolDefinitions } from '../src/tools/agent-host-tool-surface';

afterEach(() => resetExtensionAgentToolsForTests());

describe('extension agent tools', () => {
  test('projects canonical Host tools from the live AgentContext when the packaged Kit registry is isolated', async () => {
    const calls: unknown[] = [];
    await configureExtensionAgentTools({
      listTools: () => [{
        id: 'get-audio-project',
        description: 'Read the audio project',
        inputSchema: 'audio',
        exposedToAI: true,
      }],
      toolInputSchema: async () => ({
        type: 'object',
        properties: { slug: { type: 'string' } },
      }),
      callTool: async (input) => {
        calls.push(input);
        return { ok: true as const, result: { revision: 3 } };
      },
    });

    let allow = ['get-audio-project'];
    const ctx = {
      sid: 'sid-audio',
      agentPath: 'audio-designer',
      cwd: '/project/.forgeax/games/game-one',
      getAgentJson: () => ({
        kits: { config: { 'host-tools': { allow } } },
      }),
    } as unknown as AgentContext;

    // No host_tool_bridge plugin is started here. This models the independently
    // bundled desktop Kit graph while the canonical Host remains configured in
    // the Server graph.
    const projected = withAgentHostToolDefinitions([], ctx);
    expect(projected.map((tool) => tool.name)).toEqual(['get-audio-project']);
    expect(await projected[0]!.execute({}, ctx)).toBe(JSON.stringify({ revision: 3 }, null, 2));
    expect(calls).toEqual([{
      caller: 'ai',
      gameId: 'game-one',
      toolId: 'get-audio-project',
      args: {},
    }]);

    // Projection is recalculated from the live context, not a stale disk copy.
    allow = [];
    expect(withAgentHostToolDefinitions([], ctx)).toEqual([]);
  });

  test('projects exposed tools and routes UI/AI calls through the same Host executor', async () => {
    const calls: unknown[] = [];
    const host = {
      listTools: () => [
        {
          id: 'video-game:save-graph',
          description: 'Save graph',
          inputSchema: './schemas/save.json',
          exposedToAI: true,
        },
        {
          id: 'video-game:internal',
          inputSchema: './schemas/internal.json',
          exposedToAI: false,
        },
      ],
      toolInputSchema: async (toolId: string) => ({
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
        toolId,
      }),
      callTool: async (input: unknown) => {
        calls.push(input);
        return { ok: true as const, result: { saved: true } };
      },
    };
    await configureExtensionAgentTools(host);

    expect(listExtensionAgentTools()).toEqual([{
      id: 'video-game:save-graph',
      description: 'Save graph',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
        toolId: 'video-game:save-graph',
      },
    }]);

    await host.callTool({
      caller: 'ui',
      gameId: 'game-one',
      toolId: 'video-game:save-graph',
      args: { title: 'same' },
    });
    expect(await callExtensionAgentTool({
      gameId: 'game-one',
      toolId: 'video-game:save-graph',
      args: { title: 'same' },
    })).toEqual({ saved: true });
    expect(calls).toEqual([
      {
        caller: 'ui',
        gameId: 'game-one',
        toolId: 'video-game:save-graph',
        args: { title: 'same' },
      },
      {
        caller: 'ai',
        gameId: 'game-one',
        toolId: 'video-game:save-graph',
        args: { title: 'same' },
      },
    ]);
  });

  test('fails closed on duplicate wire names', async () => {
    await configureExtensionAgentTools({
      listTools: () => [
        { id: 'a:b', inputSchema: 'a', exposedToAI: true },
        { id: 'a.b', inputSchema: 'b', exposedToAI: true },
      ],
      toolInputSchema: async () => ({ type: 'object', properties: {} }),
      callTool: async () => ({ ok: true as const, result: {} }),
    });

    expect(listExtensionAgentTools()).toEqual([]);
    await expect(callExtensionAgentTool({
      gameId: 'game-one',
      toolId: 'a:b',
      args: {},
    })).rejects.toThrow('not exposed to AI');
  });

  test('preserves a shared Host executor error for AI callers', async () => {
    await configureExtensionAgentTools({
      listTools: () => [{ id: 'safe:tool', inputSchema: 'safe', exposedToAI: true }],
      toolInputSchema: async () => ({ type: 'object', properties: {} }),
      callTool: async () => ({
        ok: false as const,
        error: { code: 'denied', message: 'blocked', target: 'tool', retryable: false },
      }),
    });

    try {
      await callExtensionAgentTool({
        gameId: 'game-one',
        toolId: 'safe:tool',
        args: {},
      });
      throw new Error('expected shared Host executor error');
    } catch (error) {
      expect(error).toMatchObject({ message: 'blocked', code: 'denied' });
    }
  });

  test('registers the shared tool in the agent bridge and binds the session game', async () => {
    const calls: unknown[] = [];
    await configureExtensionAgentTools({
      listTools: () => [{
        id: 'video-game:save-graph',
        inputSchema: 'save',
        exposedToAI: true,
      }],
      toolInputSchema: async () => ({ type: 'object', properties: {} }),
      callTool: async (input) => {
        calls.push(input);
        return { ok: true as const, result: { saved: true } };
      },
    });
    const registry = new ToolRegistry();
    const bridge = hostToolBridge({
      agentPath: 'nodia',
      agentDir: '/project/.forgeax/games/game-one/sessions/sid/agents/nodia',
      cwd: '/project/.forgeax/games/game-one',
      getAgentJson: () => ({
        kits: { config: { 'host-tools': { allow: ['video-game:*'] } } },
      }),
      tools: registry,
      eventBus: { observe: () => () => undefined },
    } as unknown as AgentContext);

    await bridge.start();
    try {
      const tool = registry.list().find((candidate) => candidate.name === 'video-game_save-graph');
      expect(tool).toBeDefined();
      expect(await tool!.execute({}, {} as AgentContext)).toBe(JSON.stringify({ saved: true }, null, 2));
      expect(calls).toEqual([{
        caller: 'ai',
        gameId: 'game-one',
        toolId: 'video-game:save-graph',
        args: {},
      }]);
    } finally {
      await bridge.stop();
    }
  });
});
