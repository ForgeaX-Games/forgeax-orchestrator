import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentKernel, KernelCapabilities } from '@forgeax/agent-runtime';
import { composeTurnRequest } from '../src/kernel/compose-turn-request';
import { transcribeKernelTurn } from '../src/kernel/transcribe-turn';
import { RENTED_KERNEL_PROFILE } from '../src/kernel/kernel-profile';
import { getPathManager, initPathManager, resetPathManager } from '../src/fs/path-manager';
import { getSessionManager, initSessionManager, resetSessionManager } from '../src/core/session-manager';

const capabilities: KernelCapabilities = { streaming: true, thinking: true, toolCalls: true, midTurnInject: false, forkExtract: false };
const kernel = (id: string, resume = false): AgentKernel & { resume: boolean } => ({
  id,
  capabilities,
  resume,
  orchestrationProfile: RENTED_KERNEL_PROFILE,
  hasNativeHistoryResume(threadId: string) { return (this as { resume: boolean }).resume && threadId === 'thread-history-e2e'; },
  async *runTurn() {},
  async probe() { return { ok: true, kernelId: id }; },
} as unknown as AgentKernel & { resume: boolean });

let root: string;
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), 'shared-history-e2e-')); resetPathManager(); await resetSessionManager(); initSessionManager(initPathManager({ userRoot: root })); });
afterEach(async () => { await resetSessionManager(); resetPathManager(); rmSync(root, { recursive: true, force: true }); });

describe('shared history compose E2E', () => {
  test('rented kernels receive a snapshot once, then only the post-cursor gap after native resume', async () => {
    const session = await getSessionManager().create({ displayName: 'history-e2e' });
    const agentJson = getPathManager().session(session.sid).agent('forge').agentJson();
    mkdirSync(dirname(agentJson), { recursive: true });
    writeFileSync(agentJson, JSON.stringify({ models: { model: 'claude-fable-5' } }));
    const cc = kernel('claude-code');
    const codex = kernel('codex');
    const base = { agentId: 'forge', sessionId: session.sid, threadId: 'thread-history-e2e' };
    const firstCc = await composeTurnRequest({ message: 'remember nonce', kernel: cc, ...base });
    transcribeKernelTurn(session, 'forge', { message: 'nonce A7K9', asstText: 'decision A', thinkingText: '', stopReason: 'end_turn', providerId: cc.id, historyPlan: firstCc.historyPlan, toolEvents: [] });
    const firstCodex = await composeTurnRequest({ message: 'repeat nonce', kernel: codex, ...base });
    expect(firstCodex.historyPlan?.mode).toBe('snapshot');
    expect(firstCodex.systemPrompt.dynamicSuffix).toContain('nonce A7K9');
    expect(firstCodex.model).toBeUndefined();
    const selectedCodex = await composeTurnRequest({ message: 'explicit model', kernel: codex, model: 'gpt-5.6-luna', ...base });
    expect(selectedCodex.model).toBe('gpt-5.6-luna');
    transcribeKernelTurn(session, 'forge', { message: 'codex adds B', asstText: 'decision B', thinkingText: '', stopReason: 'end_turn', providerId: codex.id, historyPlan: firstCodex.historyPlan, toolEvents: [] });
    cc.resume = true;
    const backToCc = await composeTurnRequest({ message: 'what did Codex decide?', kernel: cc, ...base });
    expect(backToCc.historyPlan?.mode).toBe('delta');
    expect(backToCc.systemPrompt.dynamicSuffix).toContain('decision B');
    expect(backToCc.systemPrompt.dynamicSuffix).not.toContain('nonce A7K9');
    transcribeKernelTurn(session, 'forge', { message: 'ack B', asstText: 'acknowledged', thinkingText: '', stopReason: 'end_turn', providerId: cc.id, historyPlan: backToCc.historyPlan, toolEvents: [] });
    const sameCc = await composeTurnRequest({ message: 'continue', kernel: cc, ...base });
    expect(sameCc.historyPlan?.mode).toBe('none');
    expect(sameCc.systemPrompt.dynamicSuffix).toBeUndefined();
    await getSessionManager().close(session.sid);
    const reopened = await getSessionManager().open(session.sid);
    const afterRestart = await composeTurnRequest({ message: 'resume', kernel: kernel('codex'), ...base, sessionId: reopened.sid });
    expect(afterRestart.historyPlan?.mode).toBe('snapshot');
    expect(afterRestart.systemPrompt.dynamicSuffix).toContain('acknowledged');
  });
});
