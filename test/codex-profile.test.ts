/**
 * codex-profile —— Codex 原生多 Agent 工具关闭参数单测。
 *
 * 背景:Codex CLI 自身带一套原生 spawn/send/wait 多 Agent 协作工具,与 ForgeaX
 * 自己的 agent-tree + `delegate_to_subagent` 编排面重叠、冲突。本文件钉住
 * codex-profile 在 `exec` 与 `app-server` 两条执行面上都会关闭该原生工具,防回归。
 */
import { describe, test, expect } from 'bun:test';
import type { TurnRequest, ComposedPrompt } from '@forgeax/agent-runtime/contract';
import {
  buildCodexArgs,
  buildCodexAppServerGlobalArgs,
  buildCodexInstructions,
  buildCodexSingleAgentArgs,
} from '../src/kernel/codex-profile';

function req(over: { systemPrompt?: Partial<ComposedPrompt> } & Partial<Omit<TurnRequest, 'systemPrompt'>> = {}): TurnRequest {
  const { systemPrompt, ...rest } = over;
  return {
    session: { threadId: '', agentId: 'forge' },
    input: { text: 'hello' },
    systemPrompt: { charter: 'CHARTER', persona: '', ...(systemPrompt ?? {}) },
    tools: [],
    budget: {},
    ...rest,
  } as TurnRequest;
}

describe('codex-profile — buildCodexSingleAgentArgs', () => {
  test('三个覆盖缺一不可', () => {
    const args = buildCodexSingleAgentArgs();
    expect(args).toEqual(['--disable', 'multi_agent', '--disable', 'multi_agent_v2', '-c', 'agents.enabled=false']);
  });

  test('每次调用返回新数组(不共享引用)', () => {
    expect(buildCodexSingleAgentArgs()).not.toBe(buildCodexSingleAgentArgs());
  });
});

describe('codex-profile — buildCodexAppServerGlobalArgs', () => {
  test('缺省 ⇒ 只有单 Agent 关闭参数', () => {
    expect(buildCodexAppServerGlobalArgs()).toEqual(buildCodexSingleAgentArgs());
  });

  test('hooksActive ⇒ 追加 --dangerously-bypass-hook-trust', () => {
    const args = buildCodexAppServerGlobalArgs(true, []);
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args.slice(0, 6)).toEqual(buildCodexSingleAgentArgs());
  });

  test('mcpOverrides ⇒ 追加在单 Agent 关闭参数之后', () => {
    const args = buildCodexAppServerGlobalArgs(false, ['-c', 'mcp_servers.fxt.command=fxt']);
    expect(args).toEqual([...buildCodexSingleAgentArgs(), '-c', 'mcp_servers.fxt.command=fxt']);
  });
});

describe('codex-profile — buildCodexArgs 内嵌单 Agent 关闭参数', () => {
  test('exec 首轮 ⇒ 含 --disable multi_agent/multi_agent_v2 + agents.enabled=false', () => {
    const args = buildCodexArgs(req(), undefined);
    expect(args).toContain('multi_agent');
    expect(args).toContain('multi_agent_v2');
    expect(args).toContain('agents.enabled=false');
  });

  test('exec resume ⇒ 同样关闭原生多 Agent', () => {
    const args = buildCodexArgs(req(), 'thread-123');
    expect(args).toContain('multi_agent');
    expect(args).toContain('multi_agent_v2');
    expect(args).toContain('agents.enabled=false');
  });
});

describe('codex-profile — ForgeaX ask_user routing', () => {
  test('advertised ask_user routes Ask User to the timeout-free host tool', () => {
    const request = req({
      tools: [{
        name: 'ask_user',
        description: 'Ask structured questions.',
        inputSchema: { type: 'object', properties: {} },
      }],
    });
    const instructions = buildCodexInstructions(request);

    expect(instructions).toContain('host-provided `ask_user` tool');
    expect(instructions).toContain('waits indefinitely');
    expect(buildCodexArgs(request, undefined).at(-1)).toContain(instructions);
  });

  test('does not advertise the host ask route when the turn has no ask_user tool', () => {
    const instructions = buildCodexInstructions(req());
    expect(instructions).toBe('CHARTER');
    expect(instructions).not.toContain('host-provided `ask_user` tool');
  });
});
