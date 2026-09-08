import { describe, expect, test } from 'bun:test';
import type { AgentKernel } from '@forgeax/agent-runtime';
import {
  buildSoulForkComposeInput,
  SOUL_EXTRACT_INSTRUCTION,
} from '../src/soul/fork-extract';
import { kernelThreadId } from '../src/runtime/kernel-turn-runner';
import { visibleAgentManagementToolsFromConfig } from '../src/kits/agent-management-visibility';

const kernel = {} as AgentKernel;

describe('soul fork extract canonical agent-management visibility', () => {
  test('passes canonical disabled visibility into the fork compose input', () => {
    const input = { sid: 'sid-hidden', agentPath: 'forge', instanceId: 'instance-hidden' };
    const composeInput = buildSoulForkComposeInput(
      input,
      kernel,
      visibleAgentManagementToolsFromConfig({ disable: ['#agent_manage'] }),
    );

    expect(composeInput.message).toBe(SOUL_EXTRACT_INSTRUCTION);
    expect(composeInput.sessionId).toBe(input.sid);
    expect(composeInput.agentId).toBe(input.agentPath);
    expect(composeInput.threadId).toBe(kernelThreadId(input.sid, input.instanceId));
    expect(composeInput.visibleAgentManagementTools).toEqual([]);
    expect(composeInput.extraTools).toBeUndefined();
  });

  test('passes canonical enabled visibility into the fork prefix builder', () => {
    const input = { sid: 'sid-visible', agentPath: 'forge', instanceId: 'instance-visible' };
    const composeInput = buildSoulForkComposeInput(
      input,
      kernel,
      visibleAgentManagementToolsFromConfig({}),
    );

    expect(composeInput.visibleAgentManagementTools).toEqual([
      'delegate_to_subagent',
      'list_subagents',
    ]);
    expect(composeInput.extraTools).toBeUndefined();
  });
});
