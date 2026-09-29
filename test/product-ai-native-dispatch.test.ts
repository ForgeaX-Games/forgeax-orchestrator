import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionsRouter } from '../src/api/sessions';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { getSessionManager, initSessionManager, resetSessionManager } from '../src/core/session-manager';
import { buildActionCatalog } from '../src/kernel/action-catalog';
import { makeInProcessExecuteTool } from '../src/kernel/host-tool-bridge';
import { readProductActionLedger } from '../src/kernel/product-ai-native-ledger';
import { initOrchestrationSeams, resetOrchestrationSeams } from '../src/orchestration-seams';
import {
  issueKernelToolCapability,
  resetKernelToolCapabilitiesForTests,
} from '../src/kernel/kernel-tool-capability';

let projectRoot: string;
let previousProjectRoot: string | undefined;
let sid: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-product-dispatch-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  resetPathManager();
  await resetSessionManager();
  const paths = initPathManager({ userRoot: join(projectRoot, 'user'), projectRoot });
  const session = await initSessionManager(paths).create({ autoStart: false });
  sid = session.sid;
  resetKernelToolCapabilitiesForTests();
  const fakeAgent = { agentContext: { tools: { list: () => [] } } };
  const fakeInstance = { templateRef: 'tpl_forge' };
  (session.tree as unknown as { resolve: () => unknown }).resolve = () => fakeInstance;
  (session.tree as unknown as { parent: (path: string) => unknown }).parent = (path) => (
    path === 'forge/child'
      ? { path: 'forge', display: 'forge', depth: 1, fullId: 'forge#1' }
      : undefined
  );
  (session.templateCatalog as unknown as { get: () => { trust: 'own' } }).get = () => ({ trust: 'own' });
  (session as unknown as { initializeAgentHost: () => Promise<unknown> }).initializeAgentHost = async () => fakeAgent;
  (session as unknown as { getAgentHost: () => unknown }).getAgentHost = () => fakeAgent;
});

afterEach(async () => {
  resetKernelToolCapabilitiesForTests();
  resetOrchestrationSeams();
  await resetSessionManager();
  resetPathManager();
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('product action protocol at both AI execution mouths', () => {
  function sourceHeaders(agentPath: string, enabledTools = ['ui_invoke']): Record<string, string> {
    const capability = issueKernelToolCapability({ sid, agentPath, enabledTools });
    if (!capability) throw new Error('test source capability was not issued');
    return {
      'content-type': 'application/json',
      'x-forgeax-kernel-token': capability.token,
    };
  }

  test('native mouth mints its own executionId and records preflight rejection', async () => {
    let gateCalls = 0;
    const bridge = makeInProcessExecuteTool('forge', {
      getSessionManager,
      projectRoot: () => projectRoot,
      checkKernelTool: (...args) => {
        gateCalls += 1;
        const [trustTier, name] = args;
        return { allow: true, outcome: 'allow', capability: name === 'ui_invoke' ? 'write' : 'read', trustTier } as never;
      },
    });
    const receipt = await bridge(
      'ui_invoke',
      { actionId: 'missing.action', args: { apiToken: 'secret' } },
      sid,
      'forge',
      'native-call-1',
    ) as Record<string, unknown>;

    expect(receipt).toMatchObject({ status: 'rejected', started: false });
    expect(receipt.executionId).not.toBe('native-call-1');
    expect(gateCalls).toBe(0);
    const rows = readProductActionLedger(projectRoot, { sessionId: sid });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      phase: 'attempt',
      executionId: receipt.executionId,
      clientCallId: 'native-call-1',
      rootActorId: 'forge',
      argsSummary: { apiToken: '[redacted]' },
    });
    expect(rows[1]).toMatchObject({ phase: 'terminal', status: 'rejected' });
  });

  test('HTTP mouth preserves shim id only as clientCallId and exposes session-scoped query', async () => {
    const response = await createSessionsRouter().request(`/${sid}/kernel-tool`, {
      method: 'POST',
      headers: sourceHeaders('forge'),
      body: JSON.stringify({
        agentPath: 'forge',
        toolName: 'ui_invoke',
        args: { actionId: 'missing.http-action', args: {} },
        toolExecutionId: 'shim-tool-exec-1',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; result: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({ status: 'rejected', started: false });
    expect(body.result.executionId).not.toBe('shim-tool-exec-1');

    const query = await createSessionsRouter().request(
      `/${sid}/product-ai-native/ledger?clientCallId=${encodeURIComponent('shim-tool-exec-1')}`,
    );
    expect(query.status).toBe(200);
    const queried = await query.json() as { count: number; items: Array<Record<string, unknown>> };
    expect(queried.count).toBe(2);
    expect(queried.items[0]).toMatchObject({ clientCallId: 'shim-tool-exec-1', sessionId: sid });
    expect(queried.items.every((item) => item.sessionId === sid)).toBe(true);
  });

  test('both AI mouths inherit the same trusted root for a delegated child', async () => {
    const bridge = makeInProcessExecuteTool('forge', {
      getSessionManager,
      projectRoot: () => projectRoot,
      checkKernelTool: () => ({ allow: true, outcome: 'allow', capability: 'read', trustTier: 'own' }) as never,
    });
    const nativeReceipt = await bridge(
      'ui_invoke',
      { actionId: 'missing.native-delegated', args: {} },
      sid,
      'forge/child',
      'native-delegated-call',
    ) as Record<string, unknown>;

    const httpResponse = await createSessionsRouter().request(`/${sid}/kernel-tool`, {
      method: 'POST',
      headers: sourceHeaders('forge/child'),
      body: JSON.stringify({
        agentPath: 'forge',
        toolName: 'ui_invoke',
        args: { actionId: 'missing.http-delegated', args: {} },
        toolExecutionId: 'http-delegated-call',
        actor: { kind: 'human', id: 'spoofed' },
        rootActorId: 'spoofed-root',
      }),
    });
    const httpBody = await httpResponse.json() as { result: Record<string, unknown> };

    const nativeRows = readProductActionLedger(projectRoot, { executionId: String(nativeReceipt.executionId) });
    const httpRows = readProductActionLedger(projectRoot, { executionId: String(httpBody.result.executionId) });
    for (const rows of [nativeRows, httpRows]) {
      expect(rows[0]).toMatchObject({
        actor: { kind: 'ai', id: 'forge/child' },
        rootActorId: 'forge',
      });
      expect(rows[0]).not.toHaveProperty('parentExecutionId');
    }
  });

  test('HTTP mouth rejects an unbound actor claim before opening execution or writing an attempt', async () => {
    const response = await createSessionsRouter().request(`/${sid}/kernel-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentPath: 'forge',
        toolName: 'ui_invoke',
        args: { actionId: 'missing.spoofed', args: {} },
      }),
    });
    expect(response.status).toBe(401);
    expect(readProductActionLedger(projectRoot, { sessionId: sid })).toHaveLength(0);
  });

  // 此前本文件只有 `missing.*` 的失败路径 —— 成功那一半("受理 → 真跑 → completed
  // 回执 + 配对的 attempt/terminal")从未在两张嘴上被端到端钉过。用目录里真实暴露的
  // sessions.list(surface:'both', effect:'read'):UI 未在线时回落宿主 headless handler,
  // 走完与 UI 在线时同一条产品动作门。
  function installExposedActionSurface(): void {
    buildActionCatalog();
    initOrchestrationSeams({ enabledBuiltinTools: ['ui_invoke'] });
  }

  /** 一次执行必须留下**恰好一对**行:attempt 在前、终态在后,同一个 executionId。 */
  function expectAttemptTerminalPair(executionId: string, status: string): void {
    const rows = readProductActionLedger(projectRoot, { executionId });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ phase: 'attempt', executionId, actionId: 'sessions.list' });
    expect(rows[0]).not.toHaveProperty('queryState'); // 有终态 = 不是 incomplete
    expect(rows[1]).toMatchObject({ phase: 'terminal', executionId, status, errorCode: null });
  }

  test('native mouth executes a real exposed catalog action and settles completed/started', async () => {
    installExposedActionSurface();
    const bridge = makeInProcessExecuteTool('forge', {
      getSessionManager,
      projectRoot: () => projectRoot,
      checkKernelTool: () => ({ allow: true, outcome: 'allow', capability: 'read', trustTier: 'own' }) as never,
    });

    const receipt = await bridge(
      'ui_invoke',
      { actionId: 'sessions.list', args: {} },
      sid,
      'forge',
      'native-success-1',
    ) as Record<string, unknown>;

    expect(receipt).toMatchObject({
      status: 'completed',
      started: true,
      // effect:'read' 的回读语义就是 not-applicable —— 不是"没验证"。
      readback: { status: 'not-applicable' },
    });
    expect(receipt.result).toMatchObject({ status: 'completed', executedVia: 'headless' });
    expectAttemptTerminalPair(String(receipt.executionId), 'completed');
    expect(readProductActionLedger(projectRoot, { clientCallId: 'native-success-1' })).toHaveLength(2);
  });

  test('HTTP kernel-tool mouth executes the same exposed action through the real trust gate', async () => {
    installExposedActionSurface();
    const response = await createSessionsRouter().request(`/${sid}/kernel-tool`, {
      method: 'POST',
      headers: sourceHeaders('forge'),
      body: JSON.stringify({
        agentPath: 'forge',
        toolName: 'ui_invoke',
        args: { actionId: 'sessions.list', args: {} },
        toolExecutionId: 'http-success-1',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; result: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({
      status: 'completed',
      started: true,
      readback: { status: 'not-applicable' },
    });
    expectAttemptTerminalPair(String(body.result.executionId), 'completed');
    // 外部 id 只能落在 clientCallId 上,executionId 仍由服务端铸造。
    expect(body.result.executionId).not.toBe('http-success-1');
    expect(readProductActionLedger(projectRoot, { clientCallId: 'http-success-1' })).toHaveLength(2);
  });

  test('HTTP mouth rejects a valid source capability outside its per-turn tool allowlist', async () => {
    const response = await createSessionsRouter().request(`/${sid}/kernel-tool`, {
      method: 'POST',
      headers: sourceHeaders('forge', ['ui_snapshot']),
      body: JSON.stringify({
        agentPath: 'forge',
        toolName: 'ui_invoke',
        args: { actionId: 'missing.not-allowed', args: {} },
      }),
    });
    expect(response.status).toBe(401);
    expect(readProductActionLedger(projectRoot, { sessionId: sid })).toHaveLength(0);
  });
});
