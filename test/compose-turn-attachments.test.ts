import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerKernel, unregisterKernel, type AgentKernel, type KernelCapabilities } from '@forgeax/agent-runtime';
import { composeTurnRequest } from '../src/kernel/compose-turn-request';
import { resolveKernel } from '../src/kernel/resolve-kernel';
import { NATIVE_KERNEL_PROFILE, RENTED_KERNEL_PROFILE } from '../src/kernel/kernel-profile';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { getSessionManager, initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { transcribeKernelTurn } from '../src/kernel/transcribe-turn';
import { prepareUserAttachmentPayload } from '../src/message/materialize-user-attachments';
import { eventToSessionMessage } from '../src/message/message-ingress';

const capabilities: KernelCapabilities = {
  streaming: true, thinking: true, toolCalls: true, midTurnInject: false, forkExtract: false,
};
function kernel(id: string, profile: typeof RENTED_KERNEL_PROFILE): AgentKernel {
  return {
    id,
    capabilities,
    orchestrationProfile: profile,
    async *runTurn() {},
    openHandle() { throw new Error('unused'); },
    async probe() { return { ok: true, kernelId: id }; },
  } as AgentKernel;
}

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fx-compose-attachments-'));
  resetPathManager();
  await resetSessionManager();
  initSessionManager(initPathManager({ userRoot: root }));
});
afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

describe('composeTurnRequest selected-kernel policy', () => {
  test('rented kernel gets path notes only', async () => {
    const sid = (await getSessionManager().create({ displayName: 'rented' })).sid;
    const req = await composeTurnRequest({
      message: 'inspect', agentId: 'forge', sessionId: sid,
      kernel: kernel('rented-test', RENTED_KERNEL_PROFILE),
      attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' }],
    });
    expect(req.input.attachments).toBeUndefined();
    expect(req.input.text).toContain('/uploads/shot.png');
    expect(JSON.stringify(req)).not.toContain('QUJD');
  });

  test('native kernel gets path-only image/document and explicit override gets host history', async () => {
    const session = await getSessionManager().create({ displayName: 'native' });
    transcribeKernelTurn(session, 'forge', {
      message: 'previous', asstText: 'answer', thinkingText: '', stopReason: 'end_turn', toolEvents: [],
    });
    const explicitNative = kernel('explicit-native', NATIVE_KERNEL_PROFILE);
    registerKernel(explicitNative);
    const selected = resolveKernel('forge', 'explicit-native');
    const req = await composeTurnRequest({
      message: 'next', agentId: 'forge', sessionId: session.sid, kernel: selected,
      attachments: [
        { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' },
        { kind: 'document', name: 'brief.pdf', mediaType: 'application/pdf', data: 'REVG' },
        { kind: 'file', name: 'data.zip', mediaType: 'application/zip', data: 'R0hJ' },
      ],
    });
    expect(req.history?.some((m) => m.role === 'user' && m.content === 'previous')).toBe(true);
    expect(req.input.attachments).toEqual([
      { kind: 'image', path: expect.stringContaining('/uploads/shot.png'), mediaType: 'image/png' },
      { kind: 'document', path: expect.stringContaining('/uploads/brief.pdf'), mediaType: 'application/pdf' },
    ]);
    expect(JSON.stringify(req)).not.toMatch(/QUJD|REVG|R0hJ/);
    expect(req.input.text).toContain('/uploads/data.zip');
    unregisterKernel('explicit-native');
  });

  test('stable identity excludes only current inbound when timestamps collide', async () => {
    const session = await getSessionManager().create({ displayName: 'current-cutoff' });
    const selected = kernel('native-cutoff', NATIVE_KERNEL_PROFILE);
    const ts = Date.now();
    const makePayload = (name: string) => prepareUserAttachmentPayload({
      content: `inspect ${name}`,
      payload: { attachments: [{ kind: 'image', name, mediaType: 'image/png', data: 'QUJD' }] },
      uploadDir: join(session.paths.root(), 'uploads'),
      nativeAttachmentKinds: NATIVE_KERNEL_PROFILE.nativeAttachmentKinds,
    });
    const priorPayload = makePayload('prior.png');
    const currentPayload = makePayload('current.png');
    const priorIdentity = { sgen: 'generation', seq: 10 };
    const currentIdentity = { sgen: 'generation', seq: 11 };
    const ledger = session.getOrCreateLedger('forge');
    for (const [payload, identity] of [[priorPayload, priorIdentity], [currentPayload, currentIdentity]] as const) {
      const inbound = eventToSessionMessage({ source: 'user', type: 'user_input', payload, to: 'forge', ts });
      ledger.append({
        source: 'user', type: 'inbound_message',
        payload: { llmMessage: inbound, sourceEvent: identity, originalType: 'user_input' }, ts,
      } as any, 'forge');
    }

    const current = await composeTurnRequest({
      message: currentPayload.contextContent as string,
      agentId: 'forge', sessionId: session.sid, kernel: selected,
      attachments: currentPayload.attachments as Array<Record<string, unknown>>,
      historyExcludeEvents: [currentIdentity],
    });
    const priorPath = (priorPayload.attachments as Array<{ path: string }>)[0]!.path;
    const currentPath = (currentPayload.attachments as Array<{ path: string }>)[0]!.path;
    expect(JSON.stringify(current.history ?? []).split(priorPath)).toHaveLength(2);
    expect(JSON.stringify(current.history ?? [])).not.toContain(currentPath);
    expect(current.input.text.split(currentPath)).toHaveLength(2);

    const subsequent = await composeTurnRequest({
      message: 'next', agentId: 'forge', sessionId: session.sid, kernel: selected,
    });
    const historyJson = JSON.stringify(subsequent.history ?? []);
    expect(historyJson.split(priorPath)).toHaveLength(2);
    expect(historyJson.split(currentPath)).toHaveLength(2);
  });
});
