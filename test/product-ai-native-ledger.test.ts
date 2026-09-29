import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PRODUCT_ACTION_LEDGER_FILE,
  PRODUCT_ACTION_LEDGER_RETENTION_MS,
  ProductActionLedgerRegistry,
  beginProductActionInvocation,
  enforceProductActionLedgerRetention,
  inspectProductActionInvocation,
  readProductActionLedger,
  resolveTrustedRootActorId,
} from '../src/kernel/product-ai-native-ledger';
import { hostToolRunCtx } from '../src/kernel/forgeax-builtin-tools';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'forgeax-product-ledger-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('product AI native ledger', () => {
  test('derives a delegated root only from the trusted parent projection', () => {
    const parents = new Map([
      ['forge/child/grandchild', { path: 'forge/child', display: 'child', depth: 2, fullId: 'child#2' }],
      ['forge/child', { path: 'forge', display: 'forge', depth: 1, fullId: 'forge#1' }],
    ]);
    const tree = { parent: (path: string) => parents.get(path) };
    expect(resolveTrustedRootActorId(tree, 'forge')).toBe('forge');
    expect(resolveTrustedRootActorId(tree, 'forge/child/grandchild')).toBe('forge');
  });

  test('fails closed when the trusted parent projection cycles', () => {
    const tree = {
      parent: (path: string) => ({
        path: path === 'forge/a' ? 'forge/b' : 'forge/a',
        display: 'cycle',
        depth: 2,
        fullId: 'cycle#2',
      }),
    };
    expect(() => resolveTrustedRootActorId(tree, 'forge/a')).toThrow('trusted agent parent cycle');
  });

  test('writes attempt before terminal, redacts secrets, and keeps external id as clientCallId', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: { id: 'level-designer', apiToken: 'secret-value' },
      effect: 'write',
      clientCallId: 'external-call-1',
    });
    const receipt = handle.reject('role-not-found', 'Role not found');
    expect(receipt.status).toBe('rejected');
    expect(receipt.executionId).toBe(handle.executionId);

    const rows = readFileSync(join(projectRoot, PRODUCT_ACTION_LEDGER_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].phase).toBe('attempt');
    expect(rows[0].executionId).not.toBe('external-call-1');
    expect(rows[0].clientCallId).toBe('external-call-1');
    expect(rows[0].rootActorId).toBe('forge');
    expect(rows[0].argsSummary.apiToken).toBe('[redacted]');
    expect(rows[1]).toMatchObject({
      phase: 'terminal',
      executionId: handle.executionId,
      status: 'rejected',
      effectState: 'none',
    });
  });

  // 协议 v0.1 §6:顺序是 脱敏 → 摘要 → 截断,且**任何**截断都要记 truncated:true。
  // 回归对象:sanitizeJournalValue 在 4096 字符处剪单个字符串,而 summarizeArgs 此前
  // 只在整条摘要超 8KB 时才置位 —— 一个 6KB 字段被悄悄剪掉,盘上完全看不出来。
  test('records truncated:true for a clipped field while key redaction still wins over truncation', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      // 两个字段都超长:一个键名像凭据,一个不像 —— 用来分辨两步的先后。
      actionArgs: { apiToken: 'S'.repeat(6_000), prompt: 'P'.repeat(6_000) },
      effect: 'write',
    });
    handle.reject('role-not-found', 'Role not found');

    const attempt = readProductActionLedger(projectRoot, { executionId: handle.executionId })[0] as
      Record<string, any>;
    // 先脱敏:凭据整值换掉,绝不允许以 `[truncated]` 的名义留下 4096 字符的密钥前缀。
    expect(attempt.argsSummary.apiToken).toBe('[redacted]');
    expect(String(attempt.argsSummary.apiToken)).not.toContain('S');
    // 再截断:非凭据字段被剪,而这件事必须记在行上。
    expect(String(attempt.argsSummary.prompt).endsWith('[truncated]')).toBe(true);
    expect(String(attempt.argsSummary.prompt)).toHaveLength(4_096 + '[truncated]'.length);
    expect(attempt.truncated).toBe(true);
    // 整条摘要远不到 8KB —— 只靠旧的整体上限判据,这一行必然漏标。
    expect(Buffer.byteLength(JSON.stringify(attempt.argsSummary), 'utf8')).toBeLessThan(8 * 1024);
  });

  test('an oversized secret that was redacted is not reported as truncated', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: { apiToken: 'S'.repeat(6_000) },
      effect: 'write',
    });
    handle.reject('role-not-found', 'Role not found');

    const attempt = readProductActionLedger(projectRoot, { executionId: handle.executionId })[0] as
      Record<string, any>;
    // 值被整个换掉 = 没有任何东西"被剪短",标记必须保持缺省。
    expect(attempt.argsSummary.apiToken).toBe('[redacted]');
    expect(attempt.truncated).toBeUndefined();
  });

  test('a clipped completed result records truncated:true on the terminal row only', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: { id: 'level-designer' },
      effect: 'write',
    });
    handle.complete({ status: 'completed', stateDigest: 'D'.repeat(6_000) });

    const rows = readProductActionLedger(projectRoot, { executionId: handle.executionId }) as
      Array<Record<string, any>>;
    expect(rows[0]).not.toHaveProperty('truncated'); // 入参没被剪
    expect(rows[1]).toMatchObject({ phase: 'terminal', status: 'completed', truncated: true });
  });

  test('maps ambiguous post-dispatch rejection and accepted-only result to failed/unknown', () => {
    const projectRoot = root();
    const first = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'overlay.open',
      actionArgs: { id: 'settings' },
      effect: 'write',
    });
    expect(first.settleBusinessResult({ status: 'rejected', reason: 'handler threw' })).toMatchObject({
      status: 'failed',
      started: true,
      effectState: 'unknown',
    });
    const second = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'overlay.open',
      actionArgs: { id: 'settings' },
      effect: 'write',
    });
    expect(second.settleBusinessResult({ status: 'accepted' })).toMatchObject({
      status: 'failed',
      started: true,
      effectState: 'unknown',
    });
  });

  test('preserves a known partial business result in the receipt and terminal ledger row', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'overlay.open',
      actionArgs: { id: 'settings' },
      effect: 'write',
    });

    expect(handle.fail('partially-applied', 'Only part of the requested change applied', 'partial', true)).toMatchObject({
      status: 'failed',
      started: true,
      effectState: 'partial',
    });

    expect(readProductActionLedger(projectRoot, { executionId: handle.executionId })).toEqual([
      expect.objectContaining({ phase: 'attempt', executionId: handle.executionId }),
      expect.objectContaining({
        phase: 'terminal',
        executionId: handle.executionId,
        status: 'failed',
        effectState: 'partial',
      }),
    ]);
  });

  test('completed writes carry verified readback only when the product returned it', () => {
    const projectRoot = root();
    const verified = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: { id: 'level-designer' },
      effect: 'write',
    }).settleBusinessResult({
      status: 'completed',
      stateDigest: 'not-proof',
      readback: { status: 'verified', revision: 'opaque-r2', fields: { boundRole: 'level-designer' } },
    });
    expect(verified).toMatchObject({
      status: 'completed',
      readback: { status: 'verified', revision: 'opaque-r2' },
    });

    const unverified = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: { id: 'level-designer' },
      effect: 'write',
    }).settleBusinessResult({ status: 'completed', stateDigest: 'digest-only' });
    expect(unverified).toMatchObject({ status: 'completed', readback: { status: 'unverified' } });
  });

  test('query is session-isolated and marks attempt-only records incomplete', () => {
    const projectRoot = root();
    const incomplete = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: {},
      effect: 'write',
    });
    beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-b',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: {},
      effect: 'write',
    }).reject('no-role', 'No role');

    expect(readProductActionLedger(projectRoot, { sessionId: 'sid-a' })).toEqual([
      expect.objectContaining({ executionId: incomplete.executionId, queryState: 'incomplete' }),
    ]);
    expect(readProductActionLedger(projectRoot, { sessionId: 'sid-b' })).toHaveLength(2);
  });

  test('query filters by external clientCallId without treating it as executionId', () => {
    const projectRoot = root();
    const first = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: {},
      effect: 'write',
      clientCallId: 'client-call-a',
    });
    first.fail('started-failure', 'Started and failed');
    beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge',
      actionId: 'role.open',
      actionArgs: {},
      effect: 'write',
      clientCallId: 'client-call-b',
    }).reject('not-started', 'Rejected before start');

    const rows = readProductActionLedger(projectRoot, { clientCallId: 'client-call-a' });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.clientCallId === 'client-call-a')).toBe(true);
    expect(rows.every((row) => row.executionId === first.executionId)).toBe(true);
  });

  test('retention removes expired executions while preserving both rows of a retained execution', () => {
    const projectRoot = root();
    const now = Date.parse('2026-08-28T12:00:00.000Z');
    const recentAt = new Date(now - PRODUCT_ACTION_LEDGER_RETENTION_MS + 1_000).toISOString();
    const expiredAt = new Date(now - PRODUCT_ACTION_LEDGER_RETENTION_MS - 1_000).toISOString();
    const base = {
      protocolVersion: '0.1',
      rootActorId: 'forge',
      productInstanceId: 'forgeax:test',
      actor: { kind: 'ai', id: 'forge' },
      surfaceId: 'forgeax.action-catalog',
      actionId: 'overlay.open',
    };
    const rows = [
      { ...base, phase: 'attempt', executionId: 'expired', argsSummary: {}, startedAt: expiredAt },
      { ...base, phase: 'terminal', executionId: 'expired', startedAt: expiredAt, endedAt: expiredAt, status: 'completed', errorCode: null },
      { ...base, phase: 'attempt', executionId: 'retained', argsSummary: {}, startedAt: expiredAt },
      { ...base, phase: 'terminal', executionId: 'retained', startedAt: expiredAt, endedAt: recentAt, status: 'completed', errorCode: null },
    ];
    const path = join(projectRoot, PRODUCT_ACTION_LEDGER_FILE);
    mkdirSync(join(projectRoot, '.forgeax'), { recursive: true });
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    enforceProductActionLedgerRetention(projectRoot, { now, force: true });

    const retained = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(retained).toHaveLength(2);
    expect(retained.every((entry) => entry.executionId === 'retained')).toBe(true);
  });

  test('recognizes ui_invoke and first-class tool candidates only', () => {
    expect(inspectProductActionInvocation('ui_invoke', {
      actionId: 'role.open',
      args: { id: 'level-designer' },
    }, 'sid-a')).toMatchObject({ actionId: 'role.open', actionArgs: { id: 'level-designer' } });
    expect(inspectProductActionInvocation('echo', {}, 'sid-a')).toBeUndefined();
  });

  test('human attempts may be sessionless and remain queryable without inventing a session', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      actorKind: 'human',
      actorId: 'human:studio-local',
      actionId: 'session.create',
      actionArgs: { displayName: 'First session' },
      effect: 'write',
    });
    handle.complete({ status: 'completed' });
    expect(readProductActionLedger(projectRoot, {})).toEqual([
      expect.objectContaining({
        phase: 'attempt',
        actor: { kind: 'human', id: 'human:studio-local' },
        rootActorId: 'human:studio-local',
      }),
      expect.objectContaining({ phase: 'terminal', status: 'completed' }),
    ]);
    expect(readProductActionLedger(projectRoot, { sessionId: 'missing' })).toEqual([]);
  });

  test('persists a server-derived delegated root without inventing a parent execution', () => {
    const projectRoot = root();
    const handle = beginProductActionInvocation({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'ai',
      actorId: 'forge/child',
      trustedRootActorId: 'forge',
      actionId: 'sessions.list',
      actionArgs: {},
      effect: 'read',
    });
    handle.complete({ status: 'completed' });
    const rows = readProductActionLedger(projectRoot, { executionId: handle.executionId });
    expect(rows[0]).toMatchObject({
      actor: { kind: 'ai', id: 'forge/child' },
      rootActorId: 'forge',
    });
    expect(rows[0]).not.toHaveProperty('parentExecutionId');
  });

  test('projects the minted execution id into the host action context', () => {
    const context = hostToolRunCtx({
      projectRoot: root(),
      agentId: 'forge',
      executionId: 'execution-context-1',
    });
    expect(context.executionId).toBe('execution-context-1');
  });

  test('completion registry rejects wrong or duplicate tokens and leaves expired attempts incomplete', () => {
    const projectRoot = root();
    let now = 1_000;
    const registry = new ProductActionLedgerRegistry({ now: () => now, ttlMs: 100 });
    const pending = registry.begin({
      projectRoot,
      sessionId: 'sid-a',
      actorKind: 'human',
      actorId: 'human:sid-a',
      actionId: 'overlay.open',
      actionArgs: { id: 'settings' },
      effect: 'write',
    });
    expect(registry.settle({
      ...pending,
      completionToken: 'wrong-token',
      result: { status: 'completed' },
      started: true,
    })).toMatchObject({ ok: false, code: 'completion-token-mismatch' });
    expect(registry.settle({
      ...pending,
      result: { status: 'rejected', reason: 'not available' },
      started: false,
    })).toMatchObject({ ok: true, receipt: { status: 'rejected', started: false } });
    expect(registry.settle({
      ...pending,
      result: { status: 'completed' },
      started: true,
    })).toMatchObject({ ok: false, code: 'pending-not-found' });

    const expiring = registry.begin({
      projectRoot,
      actorKind: 'human',
      actorId: 'human:studio-local',
      actionId: 'session.create',
      actionArgs: {},
      effect: 'write',
    });
    now += 101;
    expect(registry.settle({
      ...expiring,
      result: { status: 'completed' },
      started: true,
    })).toMatchObject({ ok: false, code: 'pending-not-found' });
    expect(readProductActionLedger(projectRoot, {}).at(-1)).toMatchObject({
      executionId: expiring.executionId,
      queryState: 'incomplete',
    });
  });
});
