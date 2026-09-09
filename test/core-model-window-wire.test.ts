import { expect, test } from 'bun:test';
import type { TurnRequest } from '@forgeax/agent-runtime';
import { toForgeaxCoreWireRequest } from '../src/kernel/forgeax-core-kernel';

test('Core transport preserves configured windows across JSON serialization', () => {
  const base: TurnRequest = {
    session: { threadId: 't', agentId: 'a' }, input: { text: 'hello' },
    systemPrompt: { charter: '', persona: '' }, tools: [], budget: {},
    model: 'primary', fallbackModels: ['backup'],
  };
  const req = { ...base, modelContextWindows: { primary: 512000, backup: 64000, child: 96000 } };
  const wire = JSON.parse(JSON.stringify(toForgeaxCoreWireRequest(req)));
  expect(wire.modelContextWindows).toEqual(req.modelContextWindows);
  expect(wire.model).toBe('primary');
  expect(wire.fallbackModels).toEqual(['backup']);
  const { modelContextWindows, ...oldHostRequest } = req;
  expect(JSON.parse(JSON.stringify(toForgeaxCoreWireRequest(oldHostRequest)))).not.toHaveProperty('modelContextWindows');
});
