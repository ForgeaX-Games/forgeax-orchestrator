import { describe, expect, test } from 'bun:test';
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KimiCodeKernel } from '../src/kernel/kimi-code-kernel';
import type { KimiAcpClientOptions } from '../src/kernel/kimi-acp-client';

class FakeClient {
  static instances: FakeClient[] = [];
  static emitMessage = true;
  readonly calls: string[] = [];
  readonly options: KimiAcpClientOptions;
  sessionId = 'kimi-session-1';

  constructor(options: KimiAcpClientOptions) {
    this.options = options;
    FakeClient.instances.push(this);
  }

  async newSession(mcpServers: unknown[]) {
    this.calls.push(`new:${mcpServers.length}`);
    return { sessionId: this.sessionId, configOptions: [] };
  }

  async resumeSession(sessionId: string, mcpServers: unknown[]) {
    this.calls.push(`resume:${sessionId}:${mcpServers.length}`);
    return { sessionId, configOptions: [] };
  }

  async setModel(model: string) {
    this.calls.push(`model:${model}`);
  }

  async prompt(text: string) {
    this.calls.push(`prompt:${text}`);
    if (FakeClient.emitMessage) this.options.onEvent({ kind: 'message.delta', role: 'assistant', text: 'ok' });
    return {
      stopReason: 'end_turn' as const,
      usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 },
    };
  }

  async cancel() {
    this.calls.push('cancel');
  }

  shutdown() {
    this.calls.push('shutdown');
  }
}

function request(
  threadId: string,
  text: string,
  model?: string,
  overrides: Partial<TurnRequest> = {},
): TurnRequest {
  return {
    session: { threadId, agentId: 'forge' },
    callId: `${threadId}-call`,
    input: { text },
    systemPrompt: { charter: 'CHARTER', persona: 'PERSONA' },
    tools: [],
    budget: {},
    ...(model ? { model } : {}),
    ...overrides,
  };
}

async function collect(kernel: KimiCodeKernel, req: TurnRequest): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const event of kernel.runTurn(req, new AbortController().signal)) out.push(event);
  return out;
}

describe('KimiCodeKernel', () => {
  test('creates first session, injects instructions once, then resumes', async () => {
    FakeClient.instances = [];
    const kernel = new KimiCodeKernel({
      createClient: (options) => new FakeClient(options) as never,
    });

    const first = await collect(kernel, request('thread-1', 'first', 'k3'));
    const second = await collect(kernel, request('thread-1', 'second'));

    expect(first.map((event) => event.kind)).toEqual(['message.delta', 'turn.usage', 'turn.done']);
    expect(second.map((event) => event.kind)).toEqual(['message.delta', 'turn.usage', 'turn.done']);
    expect(FakeClient.instances).toHaveLength(2);
    expect(FakeClient.instances[0]!.calls).toContain('new:0');
    expect(FakeClient.instances[0]!.calls).toContain('model:k3');
    expect(FakeClient.instances[0]!.calls.find((call) => call.startsWith('prompt:'))).toContain('CHARTER');
    expect(FakeClient.instances[0]!.calls.find((call) => call.startsWith('prompt:'))).toContain('PERSONA');
    expect(FakeClient.instances[1]!.calls).toContain('resume:kimi-session-1:0');
    expect(FakeClient.instances[1]!.calls.find((call) => call.startsWith('prompt:'))).toBe('prompt:second');
  });

  test('permission callback defaults to allow and honors settings callback surface', async () => {
    FakeClient.instances = [];
    const kernel = new KimiCodeKernel({
      createClient: (options) => new FakeClient(options) as never,
    });
    await collect(kernel, request('thread-p', 'go'));
    const decision = await FakeClient.instances[0]!.options.onPermission(
      { name: 'Bash', args: { command: 'pwd' } },
      { sessionId: 's', toolCall: { toolCallId: 't', title: 'Bash' }, options: [] },
    );
    expect(decision).toEqual({ behavior: 'allow' });
  });

  test('keeps native project MCP visible while routing dangerous calls through permission callback', async () => {
    const previousRoot = process.env.FORGEAX_PROJECT_ROOT;
    const root = mkdtempSync(join(tmpdir(), 'forgeax-kimi-project-mcp-'));
    try {
      process.env.FORGEAX_PROJECT_ROOT = root;
      mkdirSync(join(root, '.forgeax'));
      writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
        mcpServers: { project: { command: process.execPath, args: ['fixture.mjs'] } },
      }));
      FakeClient.instances = [];
      const permissionCalls: string[] = [];
      const kernel = new KimiCodeKernel({
        createClient: (options) => new FakeClient(options) as never,
      });
      await collect(kernel, request('thread-project-mcp', 'go', undefined, {
        trustTier: 'own',
        tools: [{ name: 'mcp__project__get_secret', description: 'secret', inputSchema: { type: 'object' } }],
        requestPermission: async (call) => {
          permissionCalls.push(call.name);
          return { behavior: 'allow' };
        },
      }));

      expect(FakeClient.instances[0]!.calls).toContain('new:2');
      const decision = await FakeClient.instances[0]!.options.onPermission(
        { name: 'mcp__project__get_secret', args: {} },
        { sessionId: 's', toolCall: { toolCallId: 't', title: 'get secret' }, options: [] },
      );
      expect(decision).toEqual({ behavior: 'allow' });
      expect(permissionCalls).toEqual(['mcp__project__get_secret']);
    } finally {
      if (previousRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
      else process.env.FORGEAX_PROJECT_ROOT = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not turn an empty successful ACP response into a blank success', async () => {
    FakeClient.instances = [];
    FakeClient.emitMessage = false;
    const kernel = new KimiCodeKernel({
      createClient: (options) => new FakeClient(options) as never,
    });

    const events = await collect(kernel, request('thread-empty', 'go'));

    expect(events.map((event) => event.kind)).toEqual(['turn.usage', 'error', 'turn.done']);
    expect(events.find((event) => event.kind === 'error')).toMatchObject({
      error: { message: expect.stringContaining('no assistant content') },
    });
    FakeClient.emitMessage = true;
  });
});
