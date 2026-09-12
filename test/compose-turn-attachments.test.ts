import { FORGEAX_TOOLS } from '../src/kernel/builtin-tool-roster';
import { firstClassUiToolSpecs } from '../src/api/lib/ui-manifest-registry';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerKernel, unregisterKernel, type AgentKernel, type KernelCapabilities } from '@forgeax/agent-runtime';
import {
  composeTurnRequest,
  FORGEAX_BUILTIN_TOOL_NAMES,
} from '../src/kernel/compose-turn-request';
import { resolveKernel } from '../src/kernel/resolve-kernel';
import { NATIVE_KERNEL_PROFILE, RENTED_KERNEL_PROFILE } from '../src/kernel/kernel-profile';
import { getPathManager, initPathManager, resetPathManager } from '../src/fs/path-manager';
import { getSessionManager, initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { transcribeKernelTurn } from '../src/kernel/transcribe-turn';
import { prepareUserAttachmentPayload } from '../src/message/materialize-user-attachments';
import { eventToSessionMessage } from '../src/message/message-ingress';
import { buildKindRegistry } from '../src/extensions/kinds';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import type { MergedManifest } from '../src/extensions/merger';
import { buildCapabilitySnapshot } from '../src/capabilities/catalog';
import { initOrchestrationSeams } from '../src/orchestration-seams';
import {
  hostToolSurfaceForAgent,
} from '../src/api/lib/host-tools-for-agent';
import { buildActionCatalog } from './fixtures/host-action-catalog';
import { normalizeManifest } from '@forgeax/types';
import { drainPerceptionNotes, pushPerceptionNote } from '../src/api/lib/perception-registry';

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
  // All builtins are opt-in. This test exercises the Studio/native product
  // contract (the full enablement list mirrors packages/server/src/main.ts)
  // rather than the standalone orchestration default.
  initOrchestrationSeams({
    enabledBuiltinTools: [
      'ask_user', 'delegate_to_subagent', 'list_subagents', 'todo_write',
      'memory_search', 'remember', 'soul_create', 'npc_wire',
      'ui_snapshot', 'ui_invoke', 'ui_screenshot',
    ],
  });
});
afterEach(async () => {
  _resetSnapshotForTests();
  await resetSessionManager();
  resetPathManager();
  initOrchestrationSeams({});
  rmSync(root, { recursive: true, force: true });
});

describe('composeTurnRequest selected-kernel policy', () => {
  test('真实 turn 组装把目录前置条件投影进 first-class ToolSpec', async () => {
    buildActionCatalog();
    const sid = (await getSessionManager().create({ displayName: 'preconditions' })).sid;
    const req = await composeTurnRequest({
      message: 'open a role',
      agentId: 'forge',
      sessionId: sid,
      kernel: kernel('preconditions-rented', RENTED_KERNEL_PROFILE),
      extraTools: firstClassUiToolSpecs(sid).map((tool) => ({ ...tool, inputSchema: tool.inputSchema as Record<string, unknown> })),
    });
    const roleOpen = req.tools.find((tool) => tool.name === 'ui_act_role_open');
    const consoleRead = req.tools.find((tool) => tool.name === 'ui_act_console_read');

    expect(roleOpen?.description).toContain(
      'Preconditions (state facts, not operation order):\n'
        + '- When id is provided, it must identify a role in the current roster.\n'
        + '- When id is provided, an active chat session must exist for the role binding.',
    );
    expect(consoleRead?.description).not.toContain('Preconditions (state facts, not operation order):');
  });

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
    const session = await getSessionManager().create({ displayName: 'rented' });
    transcribeKernelTurn(session, 'forge', {
      message: 'previous rented turn',
      asstText: 'previous rented answer',
      thinkingText: '',
      stopReason: 'end_turn',
      toolEvents: [],
    });
    const req = await composeTurnRequest({
      message: 'inspect', agentId: 'forge', sessionId: session.sid,
      kernel: kernel('rented-test', RENTED_KERNEL_PROFILE),
      attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' }],
    });
    expect(req.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'previous rented turn' }),
      expect.objectContaining({ role: 'assistant', content: 'previous rented answer' }),
    ]));
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
    expect(req.input.text).not.toContain('/uploads/data.zip');
    expect(req.input.text).toContain('content unavailable for direct model input');
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
    expect(current.input.text).not.toContain(currentPath);

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
      normalizedManifest: normalizeManifest(manifest),
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
        extraTools: [{ name: 'skill_hello' }],
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

describe('builtin tools are advertised only via the enabledBuiltinTools seam', () => {
  async function createReadableForgeAgent(
    displayName: string,
    agentJson: Record<string, unknown> = {},
  ): Promise<string> {
    const session = await getSessionManager().create({ displayName });
    const layer = getPathManager().session(session.sid).agent('forge');
    mkdirSync(layer.root(), { recursive: true });
    writeFileSync(layer.agentJson(), `${JSON.stringify(agentJson)}\n`, 'utf8');
    return session.sid;
  }

  test('empty seam advertises no builtins and no ui_act_* aliases (standalone default)', async () => {
    initOrchestrationSeams({});
    const sid = (await getSessionManager().create({ displayName: 'standalone' })).sid;
    const req = await composeTurnRequest({
      message: 'hello', agentId: 'forge', sessionId: sid,
      kernel: kernel('standalone', RENTED_KERNEL_PROFILE),
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    for (const builtin of FORGEAX_BUILTIN_TOOL_NAMES) {
      expect(names.has(builtin)).toBe(false);
    }
    // ui_act_* are per-action aliases of ui_invoke and must not leak either,
    // even though a session id is present (aliases are sid-derived).
    expect([...names].some((name) => name.startsWith('ui_act_'))).toBe(false);
  });

  test('full seam restores the product surface, rented kernels stay host-delivered', async () => {
    const sid = (await getSessionManager().create({ displayName: 'full-seam' })).sid;
    const req = await composeTurnRequest({
      message: 'hello', agentId: 'forge', sessionId: sid,
      kernel: kernel('full-seam', RENTED_KERNEL_PROFILE),
      extraTools: FORGEAX_TOOLS,
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    for (const builtin of FORGEAX_BUILTIN_TOOL_NAMES) {
      expect(names.has(builtin)).toBe(true);
    }
    expect(req.tools?.find((tool) => tool.name === 'todo_write')?.delivery).toBe('host');
  });

  test('ui_act_* first-class aliases ride the ui_invoke opt-in', async () => {
    buildActionCatalog(); // publish the default catalog so firstClass entries exist
    // Two fresh sessions: a second compose on the same rented-kernel lane is
    // rejected (history_unavailable without resume proof) by design.
    const sidOn = (await getSessionManager().create({ displayName: 'ui-gate-on' })).sid;
    const sidOff = (await getSessionManager().create({ displayName: 'ui-gate-off' })).sid;
    const compose = (sid: string) => composeTurnRequest({
      message: 'hello', agentId: 'forge', sessionId: sid,
      kernel: kernel('ui-gate', RENTED_KERNEL_PROFILE),
      extraTools: [...FORGEAX_TOOLS, ...firstClassUiToolSpecs(sid).map((tool) => ({ ...tool, inputSchema: tool.inputSchema as Record<string, unknown> }))],
    });

    initOrchestrationSeams({ enabledBuiltinTools: ['ui_invoke'] });
    const withInvoke = await compose(sidOn);
    expect((withInvoke.tools ?? []).some((tool) => tool.name.startsWith('ui_act_'))).toBe(true);
    expect((withInvoke.tools ?? []).some((tool) => tool.name === 'ui_invoke')).toBe(true);

    initOrchestrationSeams({ enabledBuiltinTools: ['ui_snapshot'] });
    const withoutInvoke = await compose(sidOff);
    expect((withoutInvoke.tools ?? []).some((tool) => tool.name.startsWith('ui_act_'))).toBe(false);
    expect((withoutInvoke.tools ?? []).some((tool) => tool.name === 'ui_invoke')).toBe(false);
    expect((withoutInvoke.tools ?? []).some((tool) => tool.name === 'ui_snapshot')).toBe(true);
  });

  test('empty seam remains closed when hostToolSpecsForAgent supplies agent-management extraTools', async () => {
    const sid = await createReadableForgeAgent('empty-seam-host-tools');
    const hostToolSurface = hostToolSurfaceForAgent(sid, 'forge');
    const extraTools = hostToolSurface.specs;
    const visibleAgentManagementTools = hostToolSurface.visibleAgentManagementTools;
    expect(visibleAgentManagementTools).toEqual(['delegate_to_subagent', 'list_subagents']);

    initOrchestrationSeams({});
    const req = await composeTurnRequest({
      message: 'hello',
      agentId: 'forge',
      sessionId: sid,
      kernel: kernel('empty-seam-host-tools', RENTED_KERNEL_PROFILE),
      extraTools: [
        ...extraTools,
        ...FORGEAX_BUILTIN_TOOL_NAMES.map((name) => ({ name })),
        { name: 'agent_custom_host_tool' },
      ],
      visibleAgentManagementTools,
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    for (const builtin of FORGEAX_BUILTIN_TOOL_NAMES) {
      expect(names.has(builtin)).toBe(false);
    }
    expect(names.has('agent_custom_host_tool')).toBe(true);
  });

  test('product opt-in still respects kits.disable #agent_manage', async () => {
    const sid = await createReadableForgeAgent(
      'agent-management-disabled',
      { kits: { disable: ['#agent_manage'] } },
    );
    const hostToolSurface = hostToolSurfaceForAgent(sid, 'forge');
    const extraTools = hostToolSurface.specs;
    const visibleAgentManagementTools = hostToolSurface.visibleAgentManagementTools;
    expect(extraTools.some((tool) => tool.name === 'delegate_to_subagent')).toBe(false);
    expect(visibleAgentManagementTools).toEqual([]);

    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });
    const req = await composeTurnRequest({
      message: 'hello',
      agentId: 'forge',
      sessionId: sid,
      kernel: kernel('agent-management-disabled', RENTED_KERNEL_PROFILE),
      extraTools,
      visibleAgentManagementTools,
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    expect(names.has('delegate_to_subagent')).toBe(false);
    expect(names.has('list_subagents')).toBe(false);
  });

  test('same-name extension tools cannot spoof disabled canonical agent_manage visibility', async () => {
    const manifest: MergedManifest['manifest'] = {
      schemaVersion: 1,
      id: '@example/agent-management-name-spoof',
      version: '1.0.0',
      kind: 'tool',
      displayName: { en: 'agent-management-name-spoof' },
      entry: { backend: './handlers.mjs' },
      provides: {
        tools: [
          { id: 'delegate_to_subagent', exposedToAI: true },
          { id: 'list_subagents', exposedToAI: true },
        ],
      },
    };
    const merged: MergedManifest = {
      manifest,
      normalizedManifest: normalizeManifest(manifest),
      origin: 'user',
      originPath: join(root, 'agent-management-name-spoof', 'forgeax-extension.json'),
      shadowedBy: [],
    };
    const kinds = buildKindRegistry([merged]);
    _setSnapshotForTests({
      generation: 8,
      loadedAt: Date.now(),
      manifests: [merged],
      kinds,
      scanErrors: [],
      mergeIssues: [],
    });

    const sid = await createReadableForgeAgent(
      'agent-management-name-spoof',
      { kits: { disable: ['#agent_manage'], config: { 'host-tools': { allow: ['*'] } } } },
    );
    const hostToolSurface = hostToolSurfaceForAgent(sid, 'forge');
    expect(hostToolSurface.visibleAgentManagementTools).toEqual([]);
    expect(hostToolSurface.specs.filter(({ name }) =>
      name === 'delegate_to_subagent' || name === 'list_subagents',
    )).toHaveLength(2);

    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });
    const req = await composeTurnRequest({
      message: 'hello',
      agentId: 'forge',
      sessionId: sid,
      kernel: kernel('agent-management-name-spoof', RENTED_KERNEL_PROFILE),
      extraTools: hostToolSurface.specs,
      visibleAgentManagementTools: hostToolSurface.visibleAgentManagementTools,
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    expect(names.has('delegate_to_subagent')).toBe(false);
    expect(names.has('list_subagents')).toBe(false);
  });

  test('qualified canonical agent_manage tools cannot bypass disabled visibility', async () => {
    const sid = await createReadableForgeAgent(
      'agent-management-qualified-hidden',
      { kits: { disable: ['#agent_manage'] } },
    );

    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });
    const req = await composeTurnRequest({
      message: 'hello',
      agentId: 'forge',
      sessionId: sid,
      kernel: kernel('agent-management-qualified-hidden', RENTED_KERNEL_PROFILE),
      extraTools: [
        { name: 'agent_manage/tools/delegate_to_subagent' },
        { name: 'agent_manage/tools/list_subagents' },
      ],
      visibleAgentManagementTools: [],
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    expect(names.has('agent_manage/tools/delegate_to_subagent')).toBe(false);
    expect(names.has('agent_manage/tools/list_subagents')).toBe(false);
  });

  test('product opt-in advertises agent-management tools for a normal visible agent', async () => {
    const sid = await createReadableForgeAgent('agent-management-visible');
    const hostToolSurface = hostToolSurfaceForAgent(sid, 'forge');
    const extraTools = hostToolSurface.specs;
    const visibleAgentManagementTools = hostToolSurface.visibleAgentManagementTools;
    expect(visibleAgentManagementTools).toEqual(['delegate_to_subagent', 'list_subagents']);

    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });
    const req = await composeTurnRequest({
      message: 'hello',
      agentId: 'forge',
      sessionId: sid,
      kernel: kernel('agent-management-visible', RENTED_KERNEL_PROFILE),
      extraTools,
      visibleAgentManagementTools,
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    expect(names.has('delegate_to_subagent')).toBe(true);
    expect(names.has('list_subagents')).toBe(true);
  });

  test('product opt-in stays fail-closed without a session-scoped host config', async () => {
    const hostToolSurface = hostToolSurfaceForAgent(undefined, 'forge');
    const extraTools = hostToolSurface.specs;
    const visibleAgentManagementTools = hostToolSurface.visibleAgentManagementTools;
    expect(extraTools).toEqual([]);
    expect(visibleAgentManagementTools).toEqual([]);

    initOrchestrationSeams({
      enabledBuiltinTools: ['delegate_to_subagent', 'list_subagents'],
    });
    const req = await composeTurnRequest({
      message: 'hello',
      agentId: 'forge',
      kernel: kernel('no-session-host-tools', RENTED_KERNEL_PROFILE),
      extraTools,
      visibleAgentManagementTools,
    });
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    expect(names.has('delegate_to_subagent')).toBe(false);
    expect(names.has('list_subagents')).toBe(false);
  });
});
