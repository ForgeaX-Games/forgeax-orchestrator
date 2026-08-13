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
import { buildKindRegistry } from '../src/extensions/kinds';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import type { MergedManifest } from '../src/extensions/merger';
import { buildCapabilitySnapshot } from '../src/capabilities/catalog';
import { initOrchestrationSeams } from '../src/orchestration-seams';

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
  // `todo_write` is product opt-in. This test exercises the Studio/native
  // product contract rather than the standalone orchestration default.
  initOrchestrationSeams({ enabledBuiltinTools: ['todo_write'] });
});
afterEach(async () => {
  _resetSnapshotForTests();
  await resetSessionManager();
  resetPathManager();
  initOrchestrationSeams({});
  rmSync(root, { recursive: true, force: true });
});

describe('composeTurnRequest selected-kernel policy', () => {
  test('advertises the structured ask_user tool to rented kernels', async () => {
    const req = await composeTurnRequest({
      message: 'ask', agentId: 'forge', kernel: kernel('rented-ask', RENTED_KERNEL_PROFILE),
    });
    const ask = req.tools?.find((tool) => tool.name === 'ask_user');
    expect(ask).toBeDefined();
    expect(ask?.delivery).toBe('host');
    expect(ask?.description).toContain('renders clickable choices');
    expect(ask?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array' },
        multiSelect: { type: 'boolean' },
        questions: { type: 'array', minItems: 1, maxItems: 3 },
      },
    });
    expect(ask?.inputSchema?.anyOf).toEqual([
      { required: ['question', 'options'] },
      { required: ['questions'] },
    ]);
  });

  test('declares todo_write with the CLI schema and local delivery', async () => {
    const req = await composeTurnRequest({
      message: 'plan', agentId: 'forge', kernel: kernel('native-todo', NATIVE_KERNEL_PROFILE),
    });
    const todo = req.tools?.find((tool) => tool.name === 'todo_write');
    expect(todo).toBeDefined();
    expect(todo?.delivery).toBe('local');
    expect(todo?.inputSchema).toEqual({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full todo list (replaces the prior list).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id; keep it unchanged across updates for the same task.' },
              content: { type: 'string', description: 'Imperative task description.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: 'Present-continuous form shown while in_progress.' },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    });
  });

  test('keeps mutating file tools host-delivered so file activity and Artifacts stay causal', async () => {
    const req = await composeTurnRequest({
      message: 'write one file', agentId: 'forge', kernel: kernel('native-files', NATIVE_KERNEL_PROFILE),
      extraTools: [
        { name: 'write_file', inputSchema: {} },
        { name: 'edit_file', inputSchema: {} },
        { name: 'read_file', inputSchema: {} },
      ],
    });
    expect(req.tools?.find((tool) => tool.name === 'write_file')?.delivery).toBe('host');
    expect(req.tools?.find((tool) => tool.name === 'edit_file')?.delivery).toBe('host');
    expect(req.tools?.find((tool) => tool.name === 'read_file')?.delivery).toBe('local');
  });

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
    expect(req.tools?.some((tool) => tool.name === 'memory_search')).toBe(true);
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

  test('native history hydrates the durable agent ledger after session restart', async () => {
    const manager = getSessionManager();
    const session = await manager.create({ displayName: 'restart-history' });
    transcribeKernelTurn(session, 'forge', {
      message: 'add the guide ability',
      asstText: 'I can add that next',
      thinkingText: '',
      stopReason: 'end_turn',
      toolEvents: [],
    });
    await manager.close(session.sid);

    const reopened = await manager.open(session.sid);
    expect(reopened.ledgers.size).toBe(0);

    const req = await composeTurnRequest({
      message: 'do it',
      agentId: 'forge',
      sessionId: reopened.sid,
      kernel: kernel('restart-native', NATIVE_KERNEL_PROFILE),
    });

    expect(req.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'add the guide ability' }),
      expect.objectContaining({ role: 'assistant', content: 'I can add that next' }),
    ]));
    expect(reopened.ledgers.has('forge')).toBe(true);
  });

  test('prewarm composes the real capability surface without mutating turn history', async () => {
    const session = await getSessionManager().create({ displayName: 'prewarm' });
    transcribeKernelTurn(session, 'forge', {
      message: 'previous user turn', asstText: 'previous answer', thinkingText: '',
      stopReason: 'end_turn', toolEvents: [],
    });
    const ledger = session.getOrCreateLedger('forge');
    const before = await ledger.readAllEvents();
    const req = await composeTurnRequest({
      message: '',
      agentId: 'forge',
      sessionId: session.sid,
      threadId: 'prewarm-thread',
      kernel: kernel('prewarm-rented', RENTED_KERNEL_PROFILE),
      prewarm: true,
    });

    expect(req.hostSessionId).toBe(session.sid);
    expect(req.tools?.length).toBeGreaterThan(0);
    expect(req.history).toBeUndefined();
    expect(req.historyPlan).toBeUndefined();
    expect(await ledger.readAllEvents()).toEqual(before);
  });

  test('native history uses the live agent ledger without rediscovering its session singleton', async () => {
    const manager = getSessionManager();
    const session = await manager.create({ displayName: 'injected-history' });
    transcribeKernelTurn(session, 'forge', {
      message: 'remember the restart token',
      asstText: 'token remembered',
      thinkingText: '',
      stopReason: 'end_turn',
      toolEvents: [],
    });
    const historyLedger = session.getOrCreateLedger('forge');
    const historyBlackboard = session.blackboard;
    await manager.close(session.sid);
    expect(manager.peek(session.sid)).toBeNull();

    const req = await composeTurnRequest({
      message: 'what was it?',
      agentId: 'forge',
      sessionId: session.sid,
      kernel: kernel('injected-native', NATIVE_KERNEL_PROFILE),
      historyLedger,
      historyBlackboard,
    });

    expect(req.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'remember the restart token' }),
      expect.objectContaining({ role: 'assistant', content: 'token remembered' }),
    ]));
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
    // Path appears in text notes and (after ingress fix) image_file history parts.
    expect(JSON.stringify(current.history ?? []).split(priorPath).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(current.history ?? [])).not.toContain(currentPath);
    expect(current.input.text.split(currentPath)).toHaveLength(2);

    const subsequent = await composeTurnRequest({
      message: 'next', agentId: 'forge', sessionId: session.sid, kernel: selected,
    });
    const historyJson = JSON.stringify(subsequent.history ?? []);
    expect(historyJson.split(priorPath).length).toBeGreaterThanOrEqual(2);
    expect(historyJson.split(currentPath).length).toBeGreaterThanOrEqual(2);
  });

  test('projects a manifest skill into every kernel turn with catalog identity', async () => {
    const manifest = {
      schemaVersion: 1 as const,
      id: '@example/shared-skill',
      version: '1.0.0',
      kind: 'skill' as const,
      displayName: { en: 'Shared skill' },
      provides: { skills: [{ id: 'hello', entry: './SKILL.md', trigger: '/hello' }] },
    };
    const merged: MergedManifest = {
      manifest,
      origin: 'user',
      originPath: join(root, 'shared-skill', 'forgeax-extension.json'),
      shadowedBy: [],
    };
    const kinds = buildKindRegistry([merged]);
    _setSnapshotForTests({
      generation: 7,
      loadedAt: Date.now(),
      manifests: [merged],
      kinds,
      scanErrors: [],
      mergeIssues: [],
      capabilities: buildCapabilitySnapshot({
        generation: 7,
        loadedAt: Date.now(),
        manifests: [merged],
        kinds,
        scanErrors: [],
        mergeIssues: [],
      }),
    });

    for (const [name, profile] of [
      ['native', NATIVE_KERNEL_PROFILE],
      ['rented', RENTED_KERNEL_PROFILE],
    ] as const) {
      const session = await getSessionManager().create({ displayName: name });
      const req = await composeTurnRequest({
        message: 'use the shared skill',
        agentId: 'forge',
        sessionId: session.sid,
        kernel: kernel(`skill-${name}`, profile),
      });
      expect(req.tools).toContainEqual(expect.objectContaining({
        name: 'skill_hello',
        capabilityId: '@example/shared-skill#skill:hello',
        capabilityGeneration: 7,
        delivery: 'host',
      }));
    }
  });
});
