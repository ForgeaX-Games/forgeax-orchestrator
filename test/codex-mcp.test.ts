/**
 * codex-mcp 单测 —— Codex 动态工具能力对齐(codex-mcp-tool-parity-plan)的纯函数
 * 与进程级验证:
 *   - TOML serializer(转义 / 数组 / 绝对路径 / 无 shell 拼接)
 *   - buildCodexMcpOverrides argv 形状(required/enabled_tools/approve/timeouts)
 *   - 版本能力闸(低版本 + 非空 tools 明确失败;空 tools 放行;解析)
 *   - config 校验(缺失 / 污染 / allowlist 不一致)
 *   - runtime materializer(唯一目录 / 0600 specs / cleanup 幂等 / hostSessionId 优先)
 *   - keyed mutex(同 home 串行,不同 home 并行)
 *   - forgeax-tools-server.mjs 进程级双层 allowlist(list + call,未曝光/未知 → not_found)
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { TurnRequest } from '@forgeax/agent-runtime';
import {
  assertCodexMcpSupported,
  buildCodexMcpOverrides,
  CodexMcpError,
  codexSupportsMcpTools,
  parseCodexVersion,
  tomlString,
  tomlStringArray,
  validateCodexMcpConfig,
} from '../src/kernel/codex-mcp';
import {
  materializeForgeaxToolsRuntime,
  type ForgeaxToolsRuntime,
} from '../src/kernel/mcp/forgeax-tools-runtime';
import { KeyedMutex, codexHomeKey } from '../src/kernel/codex-session-home';

const SERVER = resolvePath(import.meta.dir, '../src/kernel/mcp/forgeax-tools-server.mjs');

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    session: { threadId: 't-thread', agentId: 'forge' },
    input: { text: 'hi' },
    systemPrompt: { charter: 'C', persona: '' },
    tools: [],
    budget: {},
    ...over,
  } as TurnRequest;
}

// ─── TOML serializers ────────────────────────────────────────────────

describe('codex-mcp — TOML serializers', () => {
  test('tomlString quotes + escapes backslash/quote/control', () => {
    expect(tomlString('abc')).toBe('"abc"');
    expect(tomlString('a"b')).toBe('"a\\"b"');
    expect(tomlString('a\\b')).toBe('"a\\\\b"');
    expect(tomlString('a\nb\tc')).toBe('"a\\nb\\tc"');
    // C0 control other than named escapes → \uXXXX
    expect(tomlString('\u0001')).toBe('"\\u0001"');
  });

  test('tomlStringArray emits an inline array of escaped basic strings', () => {
    expect(tomlStringArray([])).toBe('[]');
    expect(tomlStringArray(['a', 'b'])).toBe('["a","b"]');
    expect(tomlStringArray(['/abs/path/node', 'x"y'])).toBe('["/abs/path/node","x\\"y"]');
  });

  test('absolute paths survive verbatim (no shell quoting/expansion)', () => {
    const p = '/opt/homebrew/bin/node';
    expect(tomlString(p)).toBe(`"${p}"`);
  });
});

// ─── buildCodexMcpOverrides ──────────────────────────────────────────

describe('codex-mcp — buildCodexMcpOverrides', () => {
  const runtime: ForgeaxToolsRuntime = {
    command: '/abs/node',
    args: ['/abs/forgeax-tools-server.mjs'],
    enabledTools: ['ui_act_role_create', 'ui_act_role_list'],
    env: {},
    dir: '/tmp/x',
    specsFile: '/tmp/x/tool-specs.json',
    cleanup: async () => {},
  };

  test('emits -c pairs with required=true, enabled_tools, approve, timeouts', () => {
    const argv = buildCodexMcpOverrides(runtime);
    // every override is a `-c` followed by a key=value
    for (let i = 0; i < argv.length; i += 2) expect(argv[i]).toBe('-c');
    const kv = argv.filter((_, i) => i % 2 === 1);
    expect(kv).toContain('mcp_servers.fxt.command="/abs/node"');
    expect(kv).toContain('mcp_servers.fxt.args=["/abs/forgeax-tools-server.mjs"]');
    expect(kv).toContain('mcp_servers.fxt.required=true');
    expect(kv).toContain('mcp_servers.fxt.enabled_tools=["ui_act_role_create","ui_act_role_list"]');
    expect(kv).toContain('mcp_servers.fxt.default_tools_approval_mode="approve"');
    expect(kv).toContain('mcp_servers.fxt.startup_timeout_sec=10');
    expect(kv).toContain('mcp_servers.fxt.tool_timeout_sec=100');
  });

  test('no secrets in argv (only config keys)', () => {
    const argv = buildCodexMcpOverrides({ ...runtime, env: { OPENAI_API_KEY: 'sk-secret' } });
    expect(argv.join(' ')).not.toContain('sk-secret');
    expect(argv.join(' ')).not.toContain('OPENAI_API_KEY');
  });
});

// ─── version gate ────────────────────────────────────────────────────

describe('codex-mcp — version gate', () => {
  test('parseCodexVersion extracts semver triple', () => {
    expect(parseCodexVersion('codex-cli 0.143.0')).toEqual([0, 143, 0]);
    expect(parseCodexVersion('0.122.0')).toEqual([0, 122, 0]);
    expect(parseCodexVersion('garbage')).toBeNull();
  });

  test('codexSupportsMcpTools compares against baseline', () => {
    expect(codexSupportsMcpTools('codex-cli 0.143.0')).toBe(true);
    expect(codexSupportsMcpTools('0.122.0')).toBe(true);
    expect(codexSupportsMcpTools('0.121.9')).toBe(false);
    expect(codexSupportsMcpTools('')).toBe(false); // unparseable → unsupported
  });

  test('assertCodexMcpSupported: empty tools allowed on any version', () => {
    expect(() => assertCodexMcpSupported('0.0.1', false)).not.toThrow();
  });

  test('assertCodexMcpSupported: tools + old version → codex_mcp_unsupported', () => {
    try {
      assertCodexMcpSupported('0.100.0', true);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CodexMcpError);
      expect((e as CodexMcpError).code).toBe('codex_mcp_unsupported');
    }
  });

  test('assertCodexMcpSupported: tools + supported version → ok', () => {
    expect(() => assertCodexMcpSupported('codex-cli 0.143.0', true)).not.toThrow();
  });
});

// ─── config validation ───────────────────────────────────────────────

describe('codex-mcp — validateCodexMcpConfig', () => {
  test('passes when only fxt registered with exact enabled_tools', () => {
    expect(() => validateCodexMcpConfig({ servers: ['fxt'], fxtEnabledTools: ['a', 'b'] }, ['b', 'a'])).not.toThrow();
  });

  test('missing fxt → config_mismatch', () => {
    try {
      validateCodexMcpConfig({ servers: [] }, ['a']);
      throw new Error('nope');
    } catch (e) {
      expect((e as CodexMcpError).code).toBe('codex_mcp_config_mismatch');
    }
  });

  test('extra MCP server → contaminated', () => {
    try {
      validateCodexMcpConfig({ servers: ['fxt', 'evil'] }, ['a']);
      throw new Error('nope');
    } catch (e) {
      expect((e as CodexMcpError).code).toBe('codex_mcp_contaminated');
    }
  });

  test('enabled_tools mismatch → config_mismatch', () => {
    try {
      validateCodexMcpConfig({ servers: ['fxt'], fxtEnabledTools: ['a'] }, ['a', 'b']);
      throw new Error('nope');
    } catch (e) {
      expect((e as CodexMcpError).code).toBe('codex_mcp_config_mismatch');
    }
  });

  test('unreadable introspection (null fields) → tolerant, no throw', () => {
    expect(() => validateCodexMcpConfig({ servers: null, fxtEnabledTools: null }, ['a'])).not.toThrow();
  });
});

// ─── runtime materializer ────────────────────────────────────────────

describe('forgeax-tools-runtime — materialize', () => {
  test('empty tools → undefined (no MCP)', async () => {
    expect(await materializeForgeaxToolsRuntime(req({ tools: [] }), { runtimeId: 'x' })).toBeUndefined();
  });

  test('writes 0600 specs, dedupes enabledTools, cleanup idempotent', async () => {
    const rt = await materializeForgeaxToolsRuntime(
      req({ tools: [{ name: 'echo' }, { name: 'echo' }, { name: 'ui_act_role_list' }] as TurnRequest['tools'] }),
      { runtimeId: 'call-1' },
    );
    expect(rt).toBeDefined();
    expect(rt!.enabledTools).toEqual(['echo', 'ui_act_role_list']);
    expect(rt!.command).toBe(process.execPath);
    expect(rt!.env.FORGEAX_FXT_EXPOSE).toBe('echo,ui_act_role_list');
    // specs file present + mode 0600
    const mode = statSync(rt!.specsFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const specs = JSON.parse(readFileSync(rt!.specsFile, 'utf8'));
    expect(specs.map((s: any) => s.name)).toEqual(['echo', 'echo', 'ui_act_role_list']);
    await rt!.cleanup();
    await rt!.cleanup(); // idempotent
    expect(() => statSync(rt!.specsFile)).toThrow();
  });

  test('FORGEAX_SID prefers hostSessionId over synthetic thread id', async () => {
    const rt = await materializeForgeaxToolsRuntime(
      req({ hostSessionId: 'real-sid', session: { threadId: 'synthetic-uuid', agentId: 'forge' }, tools: [{ name: 'echo' }] as TurnRequest['tools'] }),
      { runtimeId: 'x' },
    );
    expect(rt!.env.FORGEAX_SID).toBe('real-sid');
    await rt!.cleanup();
  });

  test('concurrent turns of same sid get distinct temp dirs', async () => {
    const mk = () => materializeForgeaxToolsRuntime(
      req({ hostSessionId: 'sid', tools: [{ name: 'echo' }] as TurnRequest['tools'] }),
      { runtimeId: 'sid' },
    );
    const [a, b] = await Promise.all([mk(), mk()]);
    expect(a!.dir).not.toBe(b!.dir);
    await Promise.all([a!.cleanup(), b!.cleanup()]);
  });

  test('disablePerception / disableUiBridge flags flow into env', async () => {
    const rt = await materializeForgeaxToolsRuntime(
      req({ tools: [{ name: 'echo' }] as TurnRequest['tools'] }),
      { runtimeId: 'x', disablePerception: true, disableUiBridge: true },
    );
    expect(rt!.env.FORGEAX_DISABLE_PERCEPTION).toBe('1');
    expect(rt!.env.FORGEAX_DISABLE_UI_BRIDGE).toBe('1');
    await rt!.cleanup();
  });
});

// ─── keyed mutex + home key ──────────────────────────────────────────

describe('codex-session-home — keyed mutex', () => {
  test('same key serializes; different keys run in parallel', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const run = async (key: string, tag: string, ms: number) => {
      const rel = await m.acquire(key);
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
      rel();
    };
    // A and B share key → strictly serial; C on another key overlaps freely.
    await Promise.all([run('home', 'A', 30), run('home', 'B', 10), run('other', 'C', 5)]);
    // A must fully finish before B starts (or vice-versa) — no interleave on 'home'.
    const aStart = order.indexOf('A:start');
    const aEnd = order.indexOf('A:end');
    const bStart = order.indexOf('B:start');
    const bEnd = order.indexOf('B:end');
    const serial = (aEnd < bStart) || (bEnd < aStart);
    expect(serial).toBe(true);
  });

  test('release is idempotent', async () => {
    const m = new KeyedMutex();
    const rel = await m.acquire('k');
    rel();
    rel(); // no throw, no double-unlock
    const rel2 = await m.acquire('k'); // still acquirable
    rel2();
    expect(true).toBe(true);
  });

  test('codexHomeKey prefers hostSessionId and is filesystem-safe', () => {
    const key = codexHomeKey(req({ hostSessionId: 'sid/../weird', session: { threadId: 't', agentId: 'forge' } }));
    expect(key.split('/').length).toBe(3);
    expect(key).not.toContain('..');
  });
});

// ─── process-level double allowlist ──────────────────────────────────

/** Drive forgeax-tools-server.mjs over stdio; resolve responses by id. */
function spawnServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (v: any) => void>();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch { /* ignore */ }
    }
  });
  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((res) => {
      const mid = ++id;
      pending.set(mid, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
    });
  return { child, rpc, close: () => child.kill('SIGTERM') };
}

describe('forgeax-tools-server — double allowlist (process-level)', () => {
  test('EXPOSE=echo: list shows only echo; call echo ok; others not_found', async () => {
    const srv = spawnServer({
      FORGEAX_FXT_EXPOSE: 'echo',
      // A bridged spec that is NOT exposed → must be hidden + not callable.
      // (no server url set → a bridged call would be a bridge error, not not_found;
      //  the point is the allowlist blocks it BEFORE bridging.)
    });
    try {
      await srv.rpc('initialize', { protocolVersion: '2024-11-05' });
      const list = await srv.rpc('tools/list');
      const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain('echo');
      expect(names).not.toContain('list_games'); // builtin, not exposed
      expect(names).not.toContain('memory_search');

      const ok = await srv.rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
      expect(ok.result.isError).toBeFalsy();
      expect(JSON.stringify(ok.result)).toContain('[forgeax_echo] hi');

      const nf1 = await srv.rpc('tools/call', { name: 'list_games', arguments: {} });
      expect(nf1.result.isError).toBe(true);
      expect(nf1.result.structuredContent?.code).toBe('not_found');

      const nf2 = await srv.rpc('tools/call', { name: 'totally_unknown', arguments: {} });
      expect(nf2.result.isError).toBe(true);
      expect(nf2.result.structuredContent?.code).toBe('not_found');
    } finally {
      srv.close();
    }
  });

  test('bridged spec must be BOTH declared and exposed; unexposed bridged → not_found', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fxt-specs-'));
    const specsFile = join(dir, 'specs.json');
    writeFileSync(
      specsFile,
      JSON.stringify([{ name: 'my_host_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }]),
    );
    // Only echo exposed; my_host_tool declared in specs but NOT exposed.
    const srv = spawnServer({ FORGEAX_FXT_EXPOSE: 'echo', FORGEAX_TOOL_SPECS_FILE: specsFile });
    try {
      await srv.rpc('initialize', { protocolVersion: '2024-11-05' });
      const list = await srv.rpc('tools/list');
      const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).not.toContain('my_host_tool'); // declared but not exposed → hidden
      const nf = await srv.rpc('tools/call', { name: 'my_host_tool', arguments: {} });
      expect(nf.result.isError).toBe(true);
      expect(nf.result.structuredContent?.code).toBe('not_found');
    } finally {
      srv.close();
    }
  });

  test('no EXPOSE env → full builtin set exposed (zero-regression)', async () => {
    const srv = spawnServer({});
    try {
      await srv.rpc('initialize', { protocolVersion: '2024-11-05' });
      const list = await srv.rpc('tools/list');
      const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain('echo');
      expect(names).toContain('list_games');
    } finally {
      srv.close();
    }
  });

  test('refreshes wired host-tool specs before list/call in the same MCP server process', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fxt-refresh-'));
    const specsFile = join(dir, 'specs.json');
    writeFileSync(
      specsFile,
      JSON.stringify([{ name: 'old_host_tool', description: 'old', inputSchema: { type: 'object', properties: {} } }]),
    );
    const srv = spawnServer({ FORGEAX_TOOL_SPECS_FILE: specsFile });
    try {
      await srv.rpc('initialize', { protocolVersion: '2024-11-05' });
      const before = await srv.rpc('tools/list');
      const beforeNames = (before.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(beforeNames).toContain('old_host_tool');
      expect(beforeNames).not.toContain('late_host_tool');

      writeFileSync(
        specsFile,
        JSON.stringify([{ name: 'late_host_tool', description: 'late', inputSchema: { type: 'object', properties: {} } }]),
      );

      const after = await srv.rpc('tools/list');
      const afterNames = (after.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(afterNames).toContain('late_host_tool');
      expect(afterNames).not.toContain('old_host_tool');

      const call = await srv.rpc('tools/call', { name: 'late_host_tool', arguments: {} });
      expect(call.result.isError).toBe(true);
      expect(call.result.structuredContent?.code).not.toBe('not_found');
      expect(call.result.content?.[0]?.text).toContain('bridge unavailable');
    } finally {
      srv.close();
    }
  });

  test('not_found carries active tools and a corrective hint for the model', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fxt-hint-'));
    const specsFile = join(dir, 'specs.json');
    writeFileSync(
      specsFile,
      JSON.stringify([{ name: 'my_host_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }]),
    );
    const srv = spawnServer({ FORGEAX_TOOL_SPECS_FILE: specsFile });
    try {
      await srv.rpc('initialize', { protocolVersion: '2024-11-05' });
      const nf = await srv.rpc('tools/call', { name: 'totally_unknown', arguments: {} });
      expect(nf.result.isError).toBe(true);
      expect(nf.result.structuredContent?.code).toBe('not_found');
      expect(nf.result.structuredContent?.activeTools).toContain('echo');
      expect(nf.result.structuredContent?.activeTools).toContain('my_host_tool');
      expect(nf.result.structuredContent?.hint).toContain('Active tools this turn');
      expect(nf.result.content?.[0]?.text).toContain('stop retrying this name');
    } finally {
      srv.close();
    }
  });
});
