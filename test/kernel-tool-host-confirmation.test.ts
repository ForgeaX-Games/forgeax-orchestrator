import { makeInProcessExecuteTool } from '../src/kernel/host-tool-bridge';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createSessionsRouter } from '../src/api/sessions';
import type { ToolDefinition } from '../src/core/types';
import { denyPermissionsForSession } from '../src/core/permission-registry';
import { initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { getEventBus, _resetEventBusForTests } from '../src/events/bus';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { markHostToolDefinition } from '../src/kernel/host-tool-confirmation';
import { resetProjectMcpPoolForTests } from '../src/kernel/project-mcp';
import { buildKindRegistry } from '../src/extensions/kinds';
import { mergeManifests } from '../src/extensions/merger';
import { _resetSnapshotForTests, _setSnapshotForTests } from '../src/extensions/registry';
import { scanAllExtensionOrigins } from '../src/extensions/scanner';
import { callTool, _resetConfirmsForTests, _resetToolHandlerCacheForTests } from '../src/tools/registry';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';
import {
  authorizeKernelToolCapability,
  issueKernelToolCapability,
  resetKernelToolCapabilitiesForTests,
} from '../src/kernel/kernel-tool-capability';

let root: string;
let extensionRoot: string;
let sid: string;
let app: Hono;
let outerCards: number;
let innerCards: number;
let innerDecision: 'allow' | 'deny';
let executionMarker: string;
let savedProjectRoot: string | undefined;
let savedConformanceFlag: string | undefined;

function bridgedTool(name: string, hostToolId: string): ToolDefinition {
  return markHostToolDefinition({
    name,
    description: name,
    input_schema: { type: 'object', properties: {} },
    execute: async (args) => {
      const result = await callTool({
        toolId: hostToolId,
        args,
        caller: { kind: 'ai', agentId: 'market-agent', sessionId: sid, threadId: sid },
      });
      return JSON.stringify(result.ok ? result.result : { error: result.error, code: result.code });
    },
  }, hostToolId);
}

async function loadTools(): Promise<void> {
  const dir = join(extensionRoot, 'user', 'host-tools');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: '@x/host-tools',
      version: '0.1.0',
      kind: 'tool',
      displayName: { zh: 'host-tools', en: 'host-tools' },
      entry: { backend: './handler.mjs' },
      provides: {
        tools: [
          { id: 'aiasset:import-to-engine', exposedToAI: true, requireConfirm: 'destructive' },
          { id: 'demo:plain', exposedToAI: true },
          { id: 'demo:scope', exposedToAI: true },
          { id: 'demo:get-token', exposedToAI: true, requireConfirm: 'always' },
          { id: 'remember', exposedToAI: true, requireConfirm: 'destructive' },
        ],
      },
    }),
  );
  writeFileSync(
    join(dir, 'handler.mjs'),
    `import { appendFileSync } from 'node:fs';
    export default {
      'aiasset:import-to-engine': async () => {
        appendFileSync(${JSON.stringify(executionMarker)}, 'import\\n');
        return { imported: true };
      },
      'demo:plain': async () => ({ plain: true }),
      'demo:scope': async (_args, ctx) => ({ game: ctx.game ?? null }),
      'demo:get-token': async () => ({ secret: true }),
    };\n`,
  );
  const roots = {
    builtin: join(extensionRoot, 'builtin'),
    user: join(extensionRoot, 'user'),
    project: join(extensionRoot, 'project'),
  };
  for (const dirPath of Object.values(roots)) mkdirSync(dirPath, { recursive: true });
  const scan = await scanAllExtensionOrigins(roots);
  const merged = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merged.manifests);
  _setSnapshotForTests({
    generation: 1,
    loadedAt: Date.now(),
    manifests: merged.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merged.issues,
  });
}

async function postTool(
  toolName: string,
  identity: { toolExecutionId?: string; callId?: string; turnCallId?: string } = {},
): Promise<any> {
  const capability = issueKernelToolCapability({
    sid,
    agentPath: 'market-agent',
    enabledTools: [toolName],
  });
  if (!capability) throw new Error('failed to issue kernel-tool capability for test');
  const response = await app.request(`/api/sessions/${sid}/kernel-tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forgeax-kernel-token': capability.token,
    },
    body: JSON.stringify({ agentPath: 'market-agent', toolName, args: {}, ...identity }),
  });
  return response.json();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'forgeax-kernel-confirm-'));
  extensionRoot = mkdtempSync(join(tmpdir(), 'forgeax-kernel-confirm-plugins-'));
  executionMarker = join(root, 'import-executions.log');
  savedProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  savedConformanceFlag = process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
  process.env.FORGEAX_PROJECT_ROOT = root;
  const importedSoul = join(root, '.forgeax', 'souls-imported', 'market-agent', 'persona');
  mkdirSync(importedSoul, { recursive: true });
  writeFileSync(join(importedSoul, 'identity.md'), '# Imported test agent\n');
  resetPathManager();
  await resetSessionManager();
  _resetSnapshotForTests();
  _resetToolHandlerCacheForTests();
  _resetConfirmsForTests();
  _resetEventBusForTests();
  resetKernelToolCapabilitiesForTests();
  await loadTools();

  const pathManager = initPathManager({ userRoot: root });
  const sessionManager = initSessionManager(pathManager);
  const session = await sessionManager.create({ autoStart: false });
  sid = session.sid;
  session.config.defaultDir = 'game-bound-to-session';
  const tools = [
    bridgedTool('aiasset_import-to-engine', 'aiasset:import-to-engine'),
    bridgedTool('demo_plain', 'demo:plain'),
    bridgedTool('demo_scope', 'demo:scope'),
    bridgedTool('demo_get-token', 'demo:get-token'),
    bridgedTool('remember', 'remember'),
  ];
  const fakeAgent = {
    agentContext: {
      signal: new AbortController().signal,
      tools: { list: () => tools },
    },
  };
  // Model the current runtime contract: authorization starts from a live
  // instance's templateRef, then resolves trust through the Catalog.
  const fakeInstance = {
    sid: session.sid,
    runtimeConfig: { current: () => ({ value: {} }) },
    instanceId: 'res_market_agent',
    templateRef: 'tpl_market_agent',
    residentPath: 'market-agent',
    parentInstanceId: null,
    lifetime: 'resident',
    template: { definition: { id: 'market-agent' }, configuration: { toolGrants: { projectMcp: ['mcp__project__read'] } } },
  };
  const fakeChildInstance = {
    ...fakeInstance,
    instanceId: 'child-instance',
    residentPath: undefined,
    parentInstanceId: fakeInstance.instanceId,
  };
  (session.tree as unknown as { resolve: () => unknown }).resolve = () =>
    fakeInstance;
  (
    session.templateCatalog as unknown as {
      get: () => { trust: 'imported' };
    }
  ).get = () => ({ trust: 'imported' });
  (
    session as unknown as { initializeAgentHost: () => Promise<unknown> }
  ).initializeAgentHost = async () => fakeAgent;
  (session as unknown as { getAgentHost: () => unknown }).getAgentHost = () => fakeAgent;
  (session.runtimeTree as unknown as { list: () => readonly unknown[] }).list = () => [
    fakeInstance,
    fakeChildInstance,
  ];

  app = new Hono().route('/api/sessions', createSessionsRouter());
  outerCards = 0;
  innerCards = 0;
  innerDecision = 'allow';
  session.eventBus.observe((event) => {
    if (event.type !== 'permission:request') return;
    outerCards += 1;
    const reqId = (event.payload as { reqId: string }).reqId;
    queueMicrotask(() => {
      void app.request(`/api/sessions/${sid}/permission-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reqId, allow: true }),
      });
    });
  });
  getEventBus().subscribe('tool.confirm-required', (event) => {
    innerCards += 1;
    const token = (event.payload as { token: string }).token;
    queueMicrotask(() => getEventBus().emit('tool.confirm-acked', { token, decision: innerDecision }));
  });
});

afterEach(async () => {
  resetOrchestrationSeams();
  denyPermissionsForSession(sid);
  _resetConfirmsForTests();
  _resetEventBusForTests();
  _resetToolHandlerCacheForTests();
  _resetSnapshotForTests();
  resetKernelToolCapabilitiesForTests();
  await resetSessionManager();
  resetPathManager();
  if (savedProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = savedProjectRoot;
  if (savedConformanceFlag === undefined) delete process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
  else process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE = savedConformanceFlag;
  rmSync(root, { recursive: true, force: true });
  rmSync(extensionRoot, { recursive: true, force: true });
});

describe('POST /:sid/kernel-tool Host confirmation delegation', () => {
  test('capability route is disabled by default', async () => {
    delete process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE;
    const response = await app.request(`/api/sessions/${sid}/kernel-tool-capability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPath: 'market-agent', tools: ['echo'] }),
    });

    expect(response.status).toBe(404);
  });

  test('capability route rejects an agent that is not live', async () => {
    process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE = '1';
    const response = await app.request(`/api/sessions/${sid}/kernel-tool-capability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPath: 'missing-agent' }),
    });

    expect(response.status).toBe(404);
  });

  test('conformance capability is fixed to ui tools and binds the live agent', async () => {
    process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE = '1';
    const response = await app.request(`/api/sessions/${sid}/kernel-tool-capability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPath: 'market-agent', tools: ['echo'] }),
    });
    const json = await response.json() as {
      ok: boolean;
      sid: string;
      agentPath: string;
      token: string;
      expiresAt: number;
      tools: string[];
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sid).toBe(sid);
    expect(json.agentPath).toBe('market-agent');
    expect(json.tools).toEqual(['ui_snapshot', 'ui_invoke']);
    expect(json.expiresAt).toBeGreaterThan(Date.now());
    expect(authorizeKernelToolCapability(json.token, sid, 'ui_snapshot')).toMatchObject({
      sid,
      agentPath: 'market-agent',
    });
    expect(authorizeKernelToolCapability(json.token, sid, 'ui_invoke')).toMatchObject({
      sid,
      agentPath: 'market-agent',
    });
    expect(authorizeKernelToolCapability(json.token, sid, 'echo')).toBeUndefined();
  });

  test('conformance capability binds a child runtime instance independently', async () => {
    process.env.FORGEAX_PRODUCT_AI_NATIVE_CONFORMANCE = '1';
    const response = await app.request(`/api/sessions/${sid}/kernel-tool-capability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPath: 'child-instance' }),
    });
    const json = await response.json() as {
      ok: boolean;
      sid: string;
      agentPath: string;
      token: string;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sid).toBe(sid);
    expect(json.agentPath).toBe('child-instance');
    expect(authorizeKernelToolCapability(json.token, sid, 'ui_invoke')).toMatchObject({
      sid,
      agentPath: 'child-instance',
    });
    expect(authorizeKernelToolCapability(json.token, sid, 'ui_snapshot')).toMatchObject({
      sid,
      agentPath: 'child-instance',
    });
  });

  test('下游 requireConfirm 工具只出现一张 ToolRegistry 卡', async () => {
    const json = await postTool('aiasset_import-to-engine');

    expect(json.ok).toBe(true);
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(1);
    expect(readFileSync(executionMarker, 'utf8')).toBe('import\n');
  });

  test('下游 ToolRegistry 拒绝时保持单卡且 handler 执行零次', async () => {
    innerDecision = 'deny';
    const json = await postTool('aiasset_import-to-engine');

    expect(json.ok).toBe(true);
    expect(JSON.parse(json.result)).toMatchObject({ code: 'user-rejected' });
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(1);
    expect(existsSync(executionMarker)).toBe(false);
  });

  test('下游无 requireConfirm 时保留原 trust-gate 卡', async () => {
    const json = await postTool('demo_plain');

    expect(json.ok).toBe(true);
    expect(outerCards).toBe(1);
    expect(innerCards).toBe(0);
  });

  test('ToolRegistry 向插件注入调用会话绑定的 game，而非模型参数', async () => {
    const json = await postTool('demo_scope');

    expect(json.ok).toBe(true);
    expect(JSON.parse(json.result)).toEqual({ game: 'game-bound-to-session' });
    expect(outerCards).toBe(1);
    expect(innerCards).toBe(0);
  });

  test('credential 硬拒绝优先，不会进入任一确认或执行', async () => {
    const json = await postTool('demo_get-token');

    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('denied');
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(0);
  });

  test('内置工具同名时保留外层确认，不会假设 ToolRegistry 会执行', async () => {
    initOrchestrationSeams({ enabledBuiltinTools: ['remember'] });
    const json = await postTool('remember');

    expect(json.ok).toBe(false);
    expect(outerCards).toBe(1);
    expect(innerCards).toBe(0);
  });

  test('host-routed project MCP goes through the pooled bridge instead of ToolRegistry lookup', async () => {
    const script = join(root, 'project-mcp-fixture.mjs');
    const mode = join(root, 'project-mcp-mode');
    mkdirSync(join(root, '.forgeax'), { recursive: true });
    writeFileSync(mode, 'read', 'utf8');
    writeFileSync(script, `
const { readFileSync } = await import('node:fs');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }) + '\\n');
    if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: readFileSync(process.env.FX_MCP_MODE, 'utf8').trim(), inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
    if (request.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'project-ok' }] } }) + '\\n');
  }
});
`, 'utf8');
    writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
      mcpServers: { project: { command: process.execPath, args: [script], env: { FX_MCP_MODE: mode } } },
    }), 'utf8');
    resetProjectMcpPoolForTests();
    const invokeHook = async (name: string) => {
      const response = await app.request(`/api/sessions/${sid}/hook-gate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'market-agent', kernel: 'claude-code', toolName: name, input: {} }),
      });
      return response.json() as Promise<any>;
    };
    const bridge = makeInProcessExecuteTool('market-agent');
    const denied = await postTool('mcp__project__read_other');
    expect(denied).toMatchObject({ ok: false, error: 'tool not granted to agent: mcp__project__read_other' });
    await expect(bridge('mcp__project__read_other', {}, sid, 'market-agent')).rejects.toThrow('not granted');
    expect((await invokeHook('mcp__project__read_other')).decision).toBe('deny');
    expect((await invokeHook('mcp__project__read')).decision).toBe('allow');
    expect(await bridge('mcp__project__read', {}, sid, 'market-agent')).toContain('project-ok');
    const json = await postTool('mcp__project__read');
    expect(json.ok).toBe(true);
    expect(json.result).toBe('project-ok');
    expect(outerCards).toBe(0);
    expect(innerCards).toBe(0);
    writeFileSync(mode, 'other', 'utf8');
    writeFileSync(join(root, '.forgeax', 'mcp.json'), JSON.stringify({
      mcpServers: { project: { command: process.execPath, args: [script], env: { FX_MCP_MODE: mode }, version: 2 } },
    }), 'utf8');
    const stale = await postTool('mcp__project__read', {
      toolExecutionId: 'fxt-stale-1',
      callId: 'call-stale-1',
      turnCallId: 'turn-stale-1',
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('project_mcp_tool_not_found');
    expect(String(stale.error)).toContain('project MCP tool not found');
    const audit = readFileSync(join(root, 'sessions', sid, 'kernel-tool-audit.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({
      tool: 'mcp__project__read',
      allow: true,
      ok: false,
      toolExecutionId: 'fxt-stale-1',
      callId: 'call-stale-1',
      turnCallId: 'turn-stale-1',
    });
    resetProjectMcpPoolForTests();
  });
});
