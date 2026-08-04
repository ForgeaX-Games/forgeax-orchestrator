import { afterEach, describe, expect, test } from 'bun:test';
import {
  callWorkbenchAgentTool,
  configureWorkbenchAgentTools,
  listWorkbenchAgentTools,
  resetWorkbenchAgentToolsForTests,
} from '../src/workbench/agent-tools';
import hostToolBridge from '../builtin/kits/host-tools/plugins/host_tool_bridge';
import { ToolRegistry } from '../src/kits/tool-registry';
import type { AgentContext } from '../src/core/types';

afterEach(() => resetWorkbenchAgentToolsForTests());

describe('workbench agent tools', () => {
  test('projects exposed tools and routes UI/AI calls through the same Host executor', async () => {
    const calls: unknown[] = [];
    const host = {
      listTools: () => [
        {
          id: 'wb-game-video:save-graph',
          description: 'Save graph',
          inputSchema: './schemas/save.json',
          exposedToAI: true,
        },
        {
          id: 'wb-game-video:internal',
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
    await configureWorkbenchAgentTools(host);

    expect(listWorkbenchAgentTools()).toEqual([{
      id: 'wb-game-video:save-graph',
      description: 'Save graph',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
        toolId: 'wb-game-video:save-graph',
      },
    }]);

    await host.callTool({
      caller: 'ui',
      gameId: 'game-one',
      toolId: 'wb-game-video:save-graph',
      args: { title: 'same' },
    });
    expect(await callWorkbenchAgentTool({
      gameId: 'game-one',
      toolId: 'wb-game-video:save-graph',
      args: { title: 'same' },
    })).toEqual({ saved: true });
    expect(calls).toEqual([
      {
        caller: 'ui',
        gameId: 'game-one',
        toolId: 'wb-game-video:save-graph',
        args: { title: 'same' },
      },
      {
        caller: 'ai',
        gameId: 'game-one',
        toolId: 'wb-game-video:save-graph',
        args: { title: 'same' },
      },
    ]);
  });

  test('fails closed on duplicate wire names', async () => {
    await configureWorkbenchAgentTools({
      listTools: () => [
        { id: 'a:b', inputSchema: 'a', exposedToAI: true },
        { id: 'a.b', inputSchema: 'b', exposedToAI: true },
      ],
      toolInputSchema: async () => ({ type: 'object', properties: {} }),
      callTool: async () => ({ ok: true as const, result: {} }),
    });

    expect(listWorkbenchAgentTools()).toEqual([]);
    await expect(callWorkbenchAgentTool({
      gameId: 'game-one',
      toolId: 'a:b',
      args: {},
    })).rejects.toThrow('not exposed to AI');
  });

  test('preserves a shared Host executor error for AI callers', async () => {
    await configureWorkbenchAgentTools({
      listTools: () => [{ id: 'safe:tool', inputSchema: 'safe', exposedToAI: true }],
      toolInputSchema: async () => ({ type: 'object', properties: {} }),
      callTool: async () => ({
        ok: false as const,
        error: { code: 'denied', message: 'blocked', target: 'tool', retryable: false },
      }),
    });

    await expect(callWorkbenchAgentTool({
      gameId: 'game-one',
      toolId: 'safe:tool',
      args: {},
    })).rejects.toThrow('blocked');
  });

  test('registers the shared tool in the agent bridge and binds the session game', async () => {
    const calls: unknown[] = [];
    await configureWorkbenchAgentTools({
      listTools: () => [{
        id: 'wb-game-video:save-graph',
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
        kits: { config: { 'host-tools': { allow: ['wb-game-video:*'] } } },
      }),
      tools: registry,
      eventBus: { observe: () => () => undefined },
    } as unknown as AgentContext);

    await bridge.start();
    try {
      const tool = registry.list().find((candidate) => candidate.name === 'wb-game-video_save-graph');
      expect(tool).toBeDefined();
      expect(await tool!.execute({}, {} as AgentContext)).toBe(JSON.stringify({ saved: true }, null, 2));
      expect(calls).toEqual([{
        caller: 'ai',
        gameId: 'game-one',
        toolId: 'wb-game-video:save-graph',
        args: {},
      }]);
    } finally {
      await bridge.stop();
    }
  });
});
