/** 工具审计账的连接键 —— 声明了就必须真的下发。
 *
 *  2026-08-06 外审:一次真实会话 6 轮对话 / 39 次工具调用全都完整,但
 *  `<sid>/kernel-tool-audit.jsonl` 只有 sid + agent + 时间戳,"哪次用户请求导致了
 *  哪次工具调用"只能靠时间猜。根因很难看:`HostExecuteToolFn` 的类型**早就声明**了
 *  `callId` / `turnCallId`,而实现只解构了前四个参数 —— id 就在边界上被扔掉。
 *
 *  本文件钉两条:①有 id 时必须落进审计行;②没有时必须**省略键**而不是写 null/空串
 *  (消费方据"有没有这个键"判断能不能 join,写空串会让它连到错的地方)。 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeInProcessExecuteTool } from '../src/kernel/host-tool-bridge';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';

const SID = 'audit-trace-key';
let root: string;

function auditRows(): Array<Record<string, unknown>> {
  const p = join(root, 'sessions', SID, 'kernel-tool-audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function bridge() {
  const fakeSession = {
    scheduler: { getAgent: () => ({ agentContext: { tools: { list: () => [] } } }) },
    eventBus: { publish: () => {} },
    config: {},
  };
  return makeInProcessExecuteTool('forge', {
    getSessionManager: (() => ({ peek: () => fakeSession, open: async () => fakeSession })) as never,
    loadAgentRecord: (async () => ({ trustTier: 'own' })) as never,
    checkKernelTool: (() => ({ outcome: 'deny', reason: 'denied for test' })) as never,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fx-audit-trace-'));
  resetPathManager();
  initPathManager({ userRoot: root });
});
afterEach(() => {
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

describe('kernel-tool-audit 的连接键', () => {
  it('传了 callId 就必须落进审计行 —— 包括被拒绝的那一行', async () => {
    // 拒绝路径尤其重要:审计账最有价值的恰恰是失败/被拒那几行,只给成功路径连链
    // 等于把最需要追因的场景排除在外。
    await bridge()('echo', { text: 'hi' }, SID, 'forge', 'exec-abc123', 'turn-xyz').catch(() => {});
    const rows = auditRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ callId: 'exec-abc123', turnCallId: 'turn-xyz', allow: false });
  });

  it('没传就**省略键**,不写 null/空串 —— 空值会让消费方以为能 join', async () => {
    await bridge()('echo', { text: 'hi' }, SID, 'forge').catch(() => {});
    const rows = auditRows();
    expect(rows.length).toBeGreaterThan(0);
    expect('callId' in rows[0]!).toBe(false);
    expect('turnCallId' in rows[0]!).toBe(false);
  });
});

/** 租用内核(codex)走的是 HTTP 那口,而不是上面的进程内桥。它的连接键是 MCP shim 自铸的
 *  `toolExecutionId`(内核 callId 结构上过不了 MCP)。两口各测各的 —— 只测一口正是本
 *  工作流犯过三次的病。 */
describe('kernel-tool HTTP 口的连接键(租用内核)', () => {
  it('body 里的 toolExecutionId 必须落进审计行,且不冒充 callId', async () => {
    const { createSessionsRouter } = await import('../src/api/sessions');
    const { initSessionManager, resetSessionManager } = await import('../src/core/session-manager');
    const { getPathManager } = await import('../src/fs/path-manager');
    await resetSessionManager();
    const session = await initSessionManager(getPathManager()).create({ autoStart: false });
    try {
      const res = await createSessionsRouter().request(`/${session.sid}/kernel-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // agentPath 不在线 → 命中第一个审计出口(被拒/失败那几行恰恰最该带键)。
        body: JSON.stringify({ agentPath: 'not-live', toolName: 'echo', args: {}, toolExecutionId: 'fxt-http-1' }),
      });
      expect(res.status).toBe(200);

      const p = join(root, 'sessions', session.sid, 'kernel-tool-audit.jsonl');
      const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.toolExecutionId).toBe('fxt-http-1');
      // 自铸 id 绝不能顶替内核 callId —— 两个语义,消费方据键名判断连到链上哪一层。
      expect('callId' in rows[0]!).toBe(false);
    } finally {
      await resetSessionManager();
    }
  });

  it('body 没带就省略键 —— 缺席可观察', async () => {
    const { createSessionsRouter } = await import('../src/api/sessions');
    const { initSessionManager, resetSessionManager } = await import('../src/core/session-manager');
    const { getPathManager } = await import('../src/fs/path-manager');
    await resetSessionManager();
    const session = await initSessionManager(getPathManager()).create({ autoStart: false });
    try {
      await createSessionsRouter().request(`/${session.sid}/kernel-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentPath: 'not-live', toolName: 'echo', args: {} }),
      });
      const p = join(root, 'sessions', session.sid, 'kernel-tool-audit.jsonl');
      const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect('toolExecutionId' in rows[0]!).toBe(false);
    } finally {
      await resetSessionManager();
    }
  });
});
