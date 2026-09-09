/** tool-approval 单测:ask → 弹卡 → 用户回执往返;本会话 remember。
 *  用真 EventBus + 真 permission-registry(模块级 Map,单进程安全),模拟 UI 回执。 */
import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/core/event-bus';
import { denyPermissionsForSession, resolvePermission } from '../src/core/permission-registry';
import {
  requestToolApproval,
  applyRememberOnReply,
  isApprovalRemembered,
  clearRememberedForSession,
} from '../src/kernel/tool-approval';

/** 起 requestToolApproval,捕获弹卡的 reqId,模拟用户在 UI 回执 allow/deny。 */
async function approveFlow(opts: {
  sid: string;
  capability: 'exec' | 'write' | 'network' | 'delete' | 'credential';
  reply: boolean;
  remember?: boolean;
}): Promise<boolean> {
  const bus = new EventBus();
  let reqId: string | undefined;
  let sawResolved = false;
  bus.observe((ev) => {
    if (ev.type === 'permission:request') reqId = (ev.payload as { reqId: string }).reqId;
    if (ev.type === 'permission:resolved') sawResolved = true;
  });

  const p = requestToolApproval({
    eventBus: bus,
    sid: opts.sid,
    agent: 'forge',
    toolName: 'Bash',
    capability: opts.capability,
    args: { command: 'echo hi' },
  });

  // 让 publish 同步落地后再回执。
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(reqId).toBeDefined();

  // 模拟 UI /permission-reply:先 applyRememberOnReply(resolve 前),再 resolvePermission。
  applyRememberOnReply(reqId as string, opts.reply, opts.remember ?? false);
  const ok = resolvePermission(reqId as string, opts.reply);
  expect(ok).toBe(true);

  const allow = await p;
  expect(sawResolved).toBe(true); // 撤卡通知必发(避免残留)
  return allow;
}

describe('requestToolApproval — 弹卡往返', () => {
  test('用户允许 → true', async () => {
    expect(await approveFlow({ sid: 'sid-allow', capability: 'exec', reply: true })).toBe(true);
  });

  test('用户拒绝 → false', async () => {
    expect(await approveFlow({ sid: 'sid-deny', capability: 'exec', reply: false })).toBe(false);
  });

  test('同步 resolver 在 permission:request publish observer 中也能完成 allow', async () => {
    const sid = 'sid-sync-resolve';
    const bus = new EventBus();
    let resolvedEvent = false;
    bus.observe((event) => {
      if (event.type === 'permission:request') {
        const reqId = (event.payload as { reqId: string }).reqId;
        expect(resolvePermission(reqId, true)).toBe(true);
      }
      if (event.type === 'permission:resolved') resolvedEvent = true;
    });

    await expect(requestToolApproval({
      eventBus: bus,
      sid,
      agent: 'forge',
      toolName: 'Bash',
      capability: 'exec',
      args: { command: 'echo sync' },
    })).resolves.toBe(true);
    expect(resolvedEvent).toBe(true);
  });

  test('同步 resolver 在 permission:request publish observer 中也能完成 deny', async () => {
    const sid = 'sid-sync-deny';
    const bus = new EventBus();
    let resolvedEvent = false;
    bus.observe((event) => {
      if (event.type === 'permission:request') {
        const reqId = (event.payload as { reqId: string }).reqId;
        expect(resolvePermission(reqId, false)).toBe(true);
      }
      if (event.type === 'permission:resolved') resolvedEvent = true;
    });

    await expect(requestToolApproval({
      eventBus: bus,
      sid,
      agent: 'forge',
      toolName: 'Bash',
      capability: 'exec',
      args: { command: 'echo sync-deny' },
    })).resolves.toBe(false);
    expect(resolvedEvent).toBe(true);
  });

  test('同步 abort/deny cleanup 在 publish observer 中也能 fail closed', async () => {
    const sid = 'sid-sync-abort';
    const bus = new EventBus();
    let reqId = '';
    let resolvedEvent = false;
    bus.observe((event) => {
      if (event.type === 'permission:request') {
        reqId = (event.payload as { reqId: string }).reqId;
        expect(denyPermissionsForSession(sid, 'forge')).toEqual([reqId]);
      }
      if (event.type === 'permission:resolved') resolvedEvent = true;
    });

    await expect(requestToolApproval({
      eventBus: bus,
      sid,
      agent: 'forge',
      toolName: 'Bash',
      capability: 'exec',
      args: { command: 'echo abort' },
    })).resolves.toBe(false);
    expect(resolvedEvent).toBe(true);
    expect(resolvePermission(reqId, true)).toBe(false);
  });
});

describe('本会话 remember', () => {
  test('allow + remember → 记住该 capability;后续同类免卡直放', async () => {
    const sid = 'sid-remember';
    expect(isApprovalRemembered(sid, 'exec')).toBe(false);

    // 首次:弹卡 + 勾「记住」→ allow。
    expect(await approveFlow({ sid, capability: 'exec', reply: true, remember: true })).toBe(true);
    expect(isApprovalRemembered(sid, 'exec')).toBe(true);

    // 第二次同 capability:命中 remember → requestToolApproval 直接 true,**不弹卡**。
    const bus = new EventBus();
    let popped = false;
    bus.observe((ev) => { if (ev.type === 'permission:request') popped = true; });
    const allow = await requestToolApproval({
      eventBus: bus,
      sid,
      agent: 'forge',
      toolName: 'Bash',
      capability: 'exec',
      args: { command: 'ls' },
    });
    expect(allow).toBe(true);
    expect(popped).toBe(false); // 未弹卡
  });

  test('allow 但不勾 remember → 不记住;clearRememberedForSession 清掉', async () => {
    const sid = 'sid-once';
    expect(await approveFlow({ sid, capability: 'network', reply: true, remember: false })).toBe(true);
    expect(isApprovalRemembered(sid, 'network')).toBe(false);

    // 勾记住后清会话 → 又不记得。
    expect(await approveFlow({ sid, capability: 'network', reply: true, remember: true })).toBe(true);
    expect(isApprovalRemembered(sid, 'network')).toBe(true);
    clearRememberedForSession(sid);
    expect(isApprovalRemembered(sid, 'network')).toBe(false);
  });

  test('deny + remember → 不记住(只有 allow 才记)', () => {
    const sid = 'sid-deny-remember';
    applyRememberOnReply('nonexistent-req', false, true);
    expect(isApprovalRemembered(sid, 'exec')).toBe(false);
  });

  test('records the remembered capability and shares only that capability in this live session', async () => {
    const sid = 'remember-audit';
    const bus = new EventBus();
    let resolved: unknown;
    bus.observe(event => {
      const p = event.payload as { reqId: string };
      if (event.type === 'permission:request') {
        applyRememberOnReply(p.reqId, true, true);
        resolvePermission(p.reqId, true);
      }
      if (event.type === 'permission:resolved') resolved = event.payload;
    });
    expect(await requestToolApproval({ eventBus: bus, sid, agent: 'suzu', toolName: 'write_file', capability: 'write' })).toBe(true);
    expect(resolved).toMatchObject({ allow: true, capability: 'write', remembered: true });
    let asked = false;
    const other = new EventBus();
    other.observe(event => { if (event.type === 'permission:request') asked = true; });
    expect(await requestToolApproval({ eventBus: other, sid, agent: 'iro', toolName: 'write_file', capability: 'write' })).toBe(true);
    expect(asked).toBe(false);
    expect(isApprovalRemembered(sid, 'exec')).toBe(false);
    expect(isApprovalRemembered('another-session', 'write')).toBe(false);
    clearRememberedForSession(sid);
    expect(isApprovalRemembered(sid, 'write')).toBe(false);
  });
});
