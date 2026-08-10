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
  buildCodexAppServerGlobalArgs,
  buildCodexAppServerTurnInput,
  buildCodexArgs,
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

  test('image attachment ⇒ uses --image path and never inline data', () => {
    const args = buildCodexArgs(req({
      input: {
        text: 'describe this',
        attachments: [{ kind: 'image', path: '/tmp/uploads/large.png', data: 'not-on-wire' }],
      },
    }), undefined);
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/uploads/large.png');
    expect(args).not.toContain('not-on-wire');
  });

  test('resume image attachment ⇒ uses --image after the resume thread id', () => {
    const args = buildCodexArgs(req({
      input: { text: 'next', attachments: [{ kind: 'image', path: '/tmp/uploads/large.png' }] },
    }), 'thread-123');
    expect(args.indexOf('--image')).toBeGreaterThan(args.indexOf('thread-123'));
    expect(args).toContain('/tmp/uploads/large.png');
  });
});

describe('codex-profile — buildCodexAppServerTurnInput', () => {
  test('large image uses localImage path and never enters text/base64', () => {
    const input = buildCodexAppServerTurnInput(req({
      input: {
        text: 'describe this',
        attachments: [{ kind: 'image', path: '/tmp/uploads/large.png', data: 'not-on-wire' }],
      },
    }));
    expect(input).toEqual([
      { type: 'text', text: 'describe this', text_elements: [] },
      { type: 'localImage', path: '/tmp/uploads/large.png' },
    ]);
    expect(JSON.stringify(input)).not.toContain('not-on-wire');
  });
});
