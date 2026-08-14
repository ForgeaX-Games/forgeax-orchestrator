/**
 * 内核权限姿态 —— 默认全权限 + 每内核一个控制点 的回归钉子。
 *
 * 钉三件事(对应验收):
 *  1. 四内核**默认启动 = 全权限**(各自方言里最高放行档);
 *  2. 默认档是**派生**的:改 DEFAULT_KERNEL_PERMISSION_MODE 一处即四内核同时翻
 *     (以「每内核默认档 === 全内核默认档」证明,而非各自硬编码同一个字面量);
 *  3. 表达不了的档位**降级而非假装**(codex 无 gated/planning,cursor 只有一档)。
 *
 * 不在此文件:`permissions.deny` 在全权限下仍能拦 rm —— 那是跨进程真跑行为,
 * 见 kernel-permission-hooks / permission-settings-rules 及 e2e 证据。
 */
import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PermissionMode, TurnRequest, ComposedPrompt } from '@forgeax/agent-runtime/contract';
import { buildCcArgs, CC_DEFAULT_PERMISSION_MODE, CC_SUPPORTED_PERMISSION_MODES } from '../src/kernel/cc-profile';
import { buildCbcArgs, CBC_DEFAULT_PERMISSION_MODE } from '../src/kernel/cbc-profile';
import {
  buildCodexArgs,
  toCodexPermission,
  toCodexAppServerPermission,
  CODEX_DEFAULT_PERMISSION_MODE,
  CODEX_SUPPORTED_PERMISSION_MODES,
} from '../src/kernel/codex-profile';
import {
  buildCursorArgs,
  toCursorPermissionArgs,
  CURSOR_DEFAULT_PERMISSION_MODE,
  CURSOR_SUPPORTED_PERMISSION_MODES,
} from '../src/kernel/cursor-profile';
import { toWire } from '../src/kernel/forgeax-core-wire';
import { planKimiPermission } from '../src/kernel/kimi-code-kernel';
import { listKernelPermissionCaps } from '../src/kernel/permission-catalog';
import { listAvailableKernels } from '../src/kernel/resolve-kernel';
import {
  DEEPSEEK_HARNESS_DEFAULT_PERMISSION_MODE,
  DEEPSEEK_HARNESS_SUPPORTED_PERMISSION_MODES,
  toDeepSeekHarnessPermission,
} from '../src/kernel/deepseek-harness-profile';
import {
  DEFAULT_KERNEL_PERMISSION_MODE,
  clampMode,
  coercePerKernelModes,
  readKernelPermissions,
  writeKernelPermissions,
  standingModeFor,
} from '../src/kernel/permission-config';

const ROOT = tmpdir();

function req(over: { systemPrompt?: Partial<ComposedPrompt> } & Partial<Omit<TurnRequest, 'systemPrompt'>> = {}): TurnRequest {
  const { systemPrompt, ...rest } = over;
  return {
    session: { threadId: '', agentId: 'forge' },
    input: { text: 'hello' },
    systemPrompt: { charter: 'CHARTER', persona: '', ...(systemPrompt ?? {}) },
    tools: [],
    budget: {},
    ...rest,
  } as TurnRequest;
}

/** `--flag value` 里紧跟 flag 的那个值。 */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('默认档 = 全权限(危险方式启动)', () => {
  test('全内核默认档就是 unrestricted', () => {
    expect(DEFAULT_KERNEL_PERMISSION_MODE).toBe('unrestricted');
  });

  test('cc 默认 ⇒ --permission-mode bypassPermissions', () => {
    expect(valueAfter(buildCcArgs(req(), ROOT, []), '--permission-mode')).toBe('bypassPermissions');
  });

  test('cbc 默认 ⇒ --permission-mode bypassPermissions', () => {
    expect(valueAfter(buildCbcArgs(req(), ROOT, []), '--permission-mode')).toBe('bypassPermissions');
  });

  test('codex 默认 ⇒ approval_policy=never + sandbox_mode=danger-full-access(首轮 -s)', () => {
    const args = buildCodexArgs(req(), undefined);
    expect(args).toContain('approval_policy="never"');
    expect(valueAfter(args, '-s')).toBe('danger-full-access');
  });

  test('codex resume 默认 ⇒ -c sandbox_mode="danger-full-access"(不带 -s)', () => {
    const args = buildCodexArgs(req(), 'thread-1');
    expect(args).toContain('sandbox_mode="danger-full-access"');
    expect(args).not.toContain('-s');
  });

  test('cursor 默认 ⇒ --force(且仍带 headless 必需的 --trust)', () => {
    const { args } = buildCursorArgs(req(), undefined);
    expect(args).toContain('--force');
    expect(args).toContain('--trust');
  });
});

describe('每内核一个控制点:默认档是派生的,不是各自硬编码', () => {
  test('四内核默认档 === 全内核默认档(改一处即四处同时翻)', () => {
    for (const mode of [
      CC_DEFAULT_PERMISSION_MODE,
      CBC_DEFAULT_PERMISSION_MODE,
      CODEX_DEFAULT_PERMISSION_MODE,
      CURSOR_DEFAULT_PERMISSION_MODE,
    ]) {
      expect(mode).toBe(DEFAULT_KERNEL_PERMISSION_MODE);
    }
  });

  test('显式档位覆盖默认:cc 四档各自翻对方言', () => {
    const expected: Record<PermissionMode, string> = {
      gated: 'default',
      autoEdits: 'acceptEdits',
      planning: 'plan',
      unrestricted: 'bypassPermissions',
    };
    for (const [neutral, dialect] of Object.entries(expected) as [PermissionMode, string][]) {
      expect(valueAfter(buildCcArgs(req(), ROOT, [], neutral), '--permission-mode')).toBe(dialect);
    }
  });

  test('codex 两档映射到两个 sandbox_mode', () => {
    expect(toCodexPermission('autoEdits').sandboxMode).toBe('workspace-write');
    expect(toCodexPermission('unrestricted').sandboxMode).toBe('danger-full-access');
    // approval_policy 恒 never:headless 无人应答,其它值会挂死(诚实约束)。
    expect(toCodexPermission('autoEdits').approvalPolicy).toBe('never');
  });

  test('codex app-server 档位映射到 thread/turn controls', () => {
    expect(toCodexAppServerPermission('autoEdits')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
    expect(toCodexAppServerPermission('unrestricted')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(toCodexAppServerPermission('planning')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    });
  });
});

describe('fail-safe 缺省:漏传第 4 参时走 req.permissionMode,不静默升到全权限', () => {
  // 这条是 e2e 期间真抓到的坑:profile 同时收 `req`(自带 permissionMode)和一个独立
  // 档位参数,漏传时曾静默落到最高放行档 —— 权限的默认必须往紧的方向兜。
  test('cc:只给 req.permissionMode ⇒ 翻出对应方言(不是 bypassPermissions)', () => {
    const args = buildCcArgs(req({ permissionMode: 'planning' }), ROOT, []);
    expect(valueAfter(args, '--permission-mode')).toBe('plan');
  });

  test('cbc:只给 req.permissionMode ⇒ default(gated)', () => {
    const args = buildCbcArgs(req({ permissionMode: 'gated' }), ROOT, []);
    expect(valueAfter(args, '--permission-mode')).toBe('default');
  });

  test('codex:只给 req.permissionMode ⇒ workspace-write(autoEdits)', () => {
    expect(valueAfter(buildCodexArgs(req({ permissionMode: 'autoEdits' }), undefined), '-s')).toBe(
      'workspace-write',
    );
  });

  test('cursor:只给 req.permissionMode ⇒ 仍带 --force(它只有这一档)', () => {
    expect(buildCursorArgs(req({ permissionMode: 'unrestricted' }), undefined).args).toContain('--force');
  });
});

describe('表达不了的档位:降级而非假装', () => {
  test('supported 表如实反映能力(cc 四档 / codex 两档 / cursor 一档)', () => {
    expect([...CC_SUPPORTED_PERMISSION_MODES].sort()).toEqual(
      ['autoEdits', 'gated', 'planning', 'unrestricted'],
    );
    expect([...CODEX_SUPPORTED_PERMISSION_MODES].sort()).toEqual(['autoEdits', 'unrestricted']);
    expect([...CURSOR_SUPPORTED_PERMISSION_MODES]).toEqual(['unrestricted']);
  });

  test('clamp:越界档往**紧**的方向收敛,绝不抬成全权限', () => {
    // codex 给不出 planning(只读);退到它支持的最严档 autoEdits(=workspace-write),
    // 而不是默认档 unrestricted —— 否则「你要只读」会变成「给你全权限」。
    expect(clampMode('planning', CODEX_SUPPORTED_PERMISSION_MODES)).toEqual({
      mode: 'autoEdits',
      downgraded: true,
    });
    // kimi 给不出 planning;退到它支持的最严档 gated。
    expect(clampMode('planning', ['gated', 'unrestricted'])).toEqual({
      mode: 'gated',
      downgraded: true,
    });
    // cursor 只有一档,退无可退 —— 如实返回 unrestricted 并标记降级。
    expect(clampMode('gated', CURSOR_SUPPORTED_PERMISSION_MODES)).toEqual({
      mode: 'unrestricted',
      downgraded: true,
    });
  });

  test('clamp:请求更松而内核只支持更严时,不会被抬松', () => {
    expect(clampMode('unrestricted', ['gated'])).toEqual({ mode: 'gated', downgraded: true });
  });

  test('clamp:支持的档位原样通过,不标 downgraded', () => {
    expect(clampMode('autoEdits', CODEX_SUPPORTED_PERMISSION_MODES)).toEqual({
      mode: 'autoEdits',
      downgraded: false,
    });
  });

  test('cursor 即便收到越界档也不会丢 --force(丢了等于静默瘫掉)', () => {
    expect(toCursorPermissionArgs('gated')).toEqual(['--force']);
  });
});

describe('deepseek-harness 权限姿态:只声明公开 headless 能兑现的两档', () => {
  test('registered capabilities are exactly autoEdits/unrestricted with safe default', () => {
    const kernel = listAvailableKernels().find((item) => item.id === 'deepseek-harness');
    expect(kernel).toBeDefined();
    expect([...DEEPSEEK_HARNESS_SUPPORTED_PERMISSION_MODES]).toEqual(['autoEdits', 'unrestricted']);
    expect(DEEPSEEK_HARNESS_DEFAULT_PERMISSION_MODE).toBe('autoEdits');
    expect(kernel!.permissionCapabilities).toEqual({
      supported: DEEPSEEK_HARNESS_SUPPORTED_PERMISSION_MODES,
      defaultMode: 'autoEdits',
    });
  });

  test('maps only supported modes and rejects planning/gated', () => {
    expect(toDeepSeekHarnessPermission('autoEdits')).toBe('workspace-write');
    expect(toDeepSeekHarnessPermission('unrestricted')).toBe('danger-full-access');
    expect(() => toDeepSeekHarnessPermission('planning')).toThrow('does not support');
    expect(() => toDeepSeekHarnessPermission('gated')).toThrow('does not support');
  });
});

describe('forgeax-core(原生):档位必须过得了 unix-socket 白名单', () => {
  // 真机核查时发现:toWire 是白名单式序列化,原来漏了 permissionMode → sidecar 侧虽然会
  // applyMode,但永远收不到档位 = 原生内核的权限设置静默失效。这条钉住它。
  test('toWire 携带 permissionMode', () => {
    const wire = toWire(req({ permissionMode: 'planning' }));
    expect(wire.permissionMode).toBe('planning');
  });

  test('未设档位时字段为 undefined(不伪造默认,由 sidecar 自己兜)', () => {
    expect(toWire(req()).permissionMode).toBeUndefined();
  });
});

describe('kimi(ACP):档位在 per-call 闸里兑现,规则对档位免疫', () => {
  test('全权限档:无规则命中 ⇒ 直接放行(不弹审批)', () => {
    expect(planKimiPermission(undefined, 'unrestricted', true)).toBe('allow');
  });

  test('gated 档:无规则命中 ⇒ 交 host 闸询问', () => {
    expect(planKimiPermission(undefined, 'gated', true)).toBe('ask');
  });

  test('deny 规则压过全权限档(默认全权限不等于拆闸)', () => {
    expect(planKimiPermission('deny', 'unrestricted', true)).toBe('deny-by-rule');
  });

  test('内容级 ask 规则也压过全权限档', () => {
    expect(planKimiPermission('ask', 'unrestricted', true)).toBe('ask');
  });

  test('ask 规则但无 prompt ⇒ fail-closed 拒绝', () => {
    expect(planKimiPermission('ask', 'unrestricted', false)).toBe('deny-no-prompt');
  });

  test('gated 档但无 prompt ⇒ 也 fail-closed(不能悄悄变成全权限)', () => {
    expect(planKimiPermission(undefined, 'gated', false)).toBe('deny-no-prompt');
  });
});

describe('catalog 必须覆盖全部已注册内核(漏了会静默不出现在设置页)', () => {
  test('每个注册内核都在权限目录里', () => {
    const registered = listAvailableKernels();
    expect(registered.every((kernel) => kernel.permissionCapabilities)).toBe(true);
    const listed = new Set(listKernelPermissionCaps(mkdtempSync(resolve(tmpdir(), 'fx-cat-'))).map((k) => k.id));
    for (const id of ['claude-code', 'codebuddy', 'codex', 'cursor-agent', 'kimi-code', 'deepseek-harness']) {
      expect(listed.has(id)).toBe(true);
    }
  });

  test('cbc 标了低档卡死风险(UI 据此出提示)', () => {
    const caps = listKernelPermissionCaps(mkdtempSync(resolve(tmpdir(), 'fx-cat2-')));
    expect(caps.find((k) => k.id === 'codebuddy')?.lowGearHangs).toBe(true);
  });
});

describe('standing 配置(项目级落盘)', () => {
  test('净化:只留中立轴上的合法档位', () => {
    expect(
      coercePerKernelModes({ 'claude-code': 'gated', codex: 'bogus', cursor: 5, x: null }),
    ).toEqual({ 'claude-code': 'gated' });
  });

  test('落盘 → 读回 → standingModeFor 命中;未配的内核为 undefined', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'fx-perm-'));
    try {
      writeKernelPermissions({ perKernel: { codex: 'autoEdits' } }, dir);
      expect(readKernelPermissions(dir).perKernel).toEqual({ codex: 'autoEdits' });
      expect(standingModeFor('codex', dir)).toBe('autoEdits');
      expect(standingModeFor('claude-code', dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('损坏的 json ⇒ 退回空覆盖(不抛,让内核落默认档)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'fx-perm-bad-'));
    try {
      mkdirSync(resolve(dir, '.forgeax'), { recursive: true });
      writeFileSync(resolve(dir, '.forgeax', 'kernel-permissions.json'), '{ not json');
      expect(readKernelPermissions(dir).perKernel).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
