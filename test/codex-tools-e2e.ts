/**
 * codex 内核工具 e2e —— 验证「Codex 真正经 fxt MCP 消费 TurnRequest.tools」。
 * 走真实链路:CodexKernel.runTurn → materialize fxt runtime → spawn `codex`(exec
 * 或 app-server)注入 `-c mcp_servers.fxt.*` → codex 起 forgeax-tools-server.mjs →
 * 模型调 mcp__fxt__echo → HTTP 无关的本地 echo 执行 → mcpToolCall 事件回流 KernelEvent。
 *
 * codex 自管凭据(~/.codex/auth.json,被复制进隔离 CODEX_HOME)或 OPENAI_API_KEY。
 * 非 .test.ts(真 CLI + 真模型)。手动跑:
 *   FORGEAX_KERNEL_IMPL=codex bun packages/orchestrator/test/codex-tools-e2e.ts
 * 默认同时跑 exec(imported)与 app-server(own)。普通模式允许环境性 SKIP;
 * golden 模式设 CODEX_TOOLS_E2E_REQUIRE_LIVE=1,任何模型侧 SKIP 都作为失败。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FORGEAX_KERNEL_IMPL = 'codex';
// Determinism: force the direct kernel spawn (no sidecar/agent-host wrapper). The
// MCP-parity surface lives on codex's own exec/app-server invocation; the sidecar
// is orthogonal transport infra. Set FORGEAX_SIDECAR=on to exercise it explicitly.
if (!process.env.FORGEAX_SIDECAR) process.env.FORGEAX_SIDECAR = 'off';

// 干净临时 project root(理由同 cbc-e2e:从大仓根跑会吞噪声上下文、行为非确定)。
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'codex-tools-e2e-root-'));
for (const g of ['alpha', 'beta']) mkdirSync(join(TMP_ROOT, '.forgeax', 'games', g), { recursive: true });
process.env.FORGEAX_PROJECT_ROOT = TMP_ROOT;

const { CodexKernel } = await import('../src/kernel/codex-kernel');
const { CodexAppServerClient } = await import('../src/kernel/codex-appserver-client');
const { materializeForgeaxToolsRuntime } = await import('../src/kernel/mcp/forgeax-tools-runtime');
const { buildCodexMcpOverrides, CODEX_MCP_SERVER_KEY } = await import('../src/kernel/codex-mcp');
const { ensureCodexSessionHome, codexHomeKey } = await import('../src/kernel/codex-session-home');
const { resolveBinary } = await import('../src/cli-providers/shared/resolve-binary');
const { randomUUID } = await import('node:crypto');
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';
import type { CodexTurnTransport } from '../src/kernel/codex-kernel';

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: Array<{ name: string; status: Status; detail: string }> = [];
const record = (name: string, status: Status, detail = '') => results.push({ name, status, detail });
const requireLiveModel = process.env.CODEX_TOOLS_E2E_REQUIRE_LIVE === '1';

async function safe(name: string, fn: () => Promise<{ ok: boolean; skip?: string; detail?: string }>): Promise<void> {
  try {
    const { ok, skip, detail } = await fn();
    if (skip) {
      record(name, requireLiveModel ? 'FAIL' : 'SKIP', skip);
    }
    else record(name, ok ? 'PASS' : 'FAIL', ok ? 'PASS' : detail ?? '');
  } catch (e) {
    record(name, 'FAIL', e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  }
}

/** Did the tool plumbing reach codex + start a turn (thread.started/turn.*)?
 *  Proves the fxt MCP registration didn't block startup, independent of the model. */
function reachedModel(events: KernelEvent[]): boolean {
  return events.some((e) => e.kind === 'turn.usage' || e.kind === 'message.delta' || e.kind === 'thinking.delta' || e.kind === 'tool.call' || e.kind === 'turn.done');
}

/** Run one echo tool turn against a fresh CodexKernel; collect KernelEvents. */
async function echoTurn(
  trustTier: 'own' | 'imported',
): Promise<{ events: KernelEvent[]; token: string; transports: CodexTurnTransport[] }> {
  const token = `CDXTOK-${randomUUID().slice(0, 8)}`;
  const req: TurnRequest = {
    session: { threadId: randomUUID(), agentId: 'forge' },
    hostSessionId: `codex-e2e-${Date.now()}`,
    input: {
      text: `Call the echo tool with text set to "${token}". Then reply with EXACTLY the string the tool returned, and nothing else.`,
    },
    systemPrompt: {
      charter: 'You are a terse test agent. When asked to use a tool, call it, then return its result verbatim.',
      persona: '',
      mode: 'replace',
    },
    tools: [
      { name: 'echo', description: 'Echo back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ],
    budget: { maxTurns: 6 },
    trustTier,
  };
  const events: KernelEvent[] = [];
  const transports: CodexTurnTransport[] = [];
  const kernel = new CodexKernel({
    onTransportSelected: (transport) => transports.push(transport),
  });
  for await (const ev of kernel.runTurn(req, new AbortController().signal)) events.push(ev);
  return { events, token, transports };
}

/** Environmental block: the shared LLM proxy rejected the call (budget/quota/auth)
 *  before the model could act. This is NOT a code failure of the MCP-parity path;
 *  the tool wiring already reached codex and started the turn. */
function envBlockReason(events: KernelEvent[]): string | null {
  const blob = events
    .filter((e) => e.kind === 'error')
    .map((e) => JSON.stringify((e as any).error))
    .join(' | ')
    .toLowerCase();
  if (/budget_exceeded|budget has been exceeded|insufficient_quota|quota|rate.?limit|401|invalid api key|unauthorized/.test(blob)) {
    return blob.slice(0, 240);
  }
  return null;
}

function assertEcho(events: KernelEvent[], token: string): { ok: boolean; detail: string } {
  const call = events.find(
    (e): e is Extract<KernelEvent, { kind: 'tool.call' }> => e.kind === 'tool.call' && e.name.includes('echo'),
  );
  const result = events.find(
    (e): e is Extract<KernelEvent, { kind: 'tool.result' }> =>
      e.kind === 'tool.result' && e.ok && JSON.stringify(e.result ?? '').includes(`[forgeax_echo] ${token}`),
  );
  const errored = events.filter((e) => e.kind === 'error').map((e) => JSON.stringify((e as any).error)).join(' | ');
  return {
    ok: Boolean(call) && Boolean(result),
    detail: `call=${Boolean(call)} result=${Boolean(result)} err=${errored || 'none'} token=${token}`,
  };
}

/**
 * LLM-free plumbing acceptance: materialize the same fxt runtime the kernel
 * uses, spawn `codex app-server` with the identical `-c mcp_servers.fxt.*`
 * overrides, then assert `mcpServerStatus/list` reports the `fxt` server with
 * `echo` enabled. Proves Codex accepted our per-process MCP config without
 * needing a model call (budget/quota independent).
 */
async function assertMcpRegistered(): Promise<{ ok: boolean; detail: string }> {
  const req: TurnRequest = {
    session: { threadId: randomUUID(), agentId: 'forge' },
    hostSessionId: `codex-e2e-plumbing-${Date.now()}`,
    input: { text: 'plumbing only' },
    systemPrompt: { charter: 'n/a', persona: '', mode: 'replace' },
    tools: [
      { name: 'echo', description: 'Echo back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ],
    budget: { maxTurns: 1 },
    trustTier: 'own',
  };
  const runtime = await materializeForgeaxToolsRuntime(req, { runtimeId: `plumbing-${Date.now()}` });
  if (!runtime) return { ok: false, detail: 'runtime materialize returned undefined' };

  const homeKey = codexHomeKey(req);
  const codexHome = await ensureCodexSessionHome(homeKey);
  const binary = await resolveBinary({ envVarName: 'CODEX_CLI_PATH', defaultBinary: 'codex' });
  const overrides = buildCodexMcpOverrides(runtime);
  const env: Record<string, string> = {
    ...runtime.env,
    CODEX_HOME: codexHome,
    ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
  };

  const client = new CodexAppServerClient({
    binary,
    cwd: TMP_ROOT,
    env,
    globalArgs: overrides,
    onServerRequest: async () => ({ decision: 'declined' }),
    onNotification: () => {},
  });

  try {
    await client.ensureStarted();
    // Give Codex a short window to initialize the required MCP server.
    let status: any = null;
    let lastErr = '';
    for (let i = 0; i < 20; i++) {
      try {
        status = await client.request('mcpServerStatus/list', {});
        const rows: any[] = Array.isArray(status?.data) ? status.data : Array.isArray(status?.servers) ? status.servers : [];
        const fxt = rows.find((r) => (r?.name ?? r?.id ?? r?.server) === CODEX_MCP_SERVER_KEY);
        if (fxt) {
          const tools: string[] = Array.isArray(fxt.enabled_tools)
            ? fxt.enabled_tools
            : Array.isArray(fxt.enabledTools)
              ? fxt.enabledTools
              : Array.isArray(fxt.tools)
                ? fxt.tools.map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
                : [];
          // Some Codex builds only report server presence (tools nested elsewhere).
          // Server presence + our overrides having echo is enough for plumbing;
          // if tools are listed, require echo among them.
          const toolsOk = tools.length === 0 || tools.includes('echo');
          return {
            ok: toolsOk,
            detail: `fxt registered; tools=[${tools.join(',')}] status=${JSON.stringify(fxt).slice(0, 400)}`,
          };
        }
        lastErr = `no fxt yet (rows=${rows.length})`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, detail: `mcpServerStatus/list never showed fxt: ${lastErr}; raw=${JSON.stringify(status)?.slice(0, 400)}` };
  } finally {
    client.shutdown();
    await runtime.cleanup();
  }
}

async function main(): Promise<void> {
  await safe('probe · codex binary + auth ready', async () => {
    const h = await new CodexKernel().probe();
    return { ok: h.ok, detail: h.detail ?? '' };
  });

  // LLM-free: proves Codex accepted our -c MCP overrides and registered fxt.
  await safe('plumbing · app-server registers fxt MCP with echo (no LLM)', async () => {
    return assertMcpRegistered();
  });

  // Primary (deterministic): force the EXEC path via trustTier='imported'.
  await safe('exec path · echo delivered → invoked → executed (fxt MCP round-trip)', async () => {
    const { events, token, transports } = await echoTurn('imported');
    if (transports.length !== 1 || transports[0] !== 'exec')
      return { ok: false, detail: `imported turn selected unexpected transports: ${transports.join(',') || 'none'}` };
    const verdict = assertEcho(events, token);
    if (verdict.ok) return verdict;
    const envBlock = envBlockReason(events);
    if (envBlock) {
      return { ok: false, skip: `LLM proxy blocked the model call (env, not code): ${envBlock} · plumbing-reached-codex=${reachedModel(events)}` };
    }
    return verdict;
  });

  await safe('app-server path · echo delivered → invoked → executed (fxt MCP round-trip)', async () => {
    const { events, token, transports } = await echoTurn('own');
    if (transports.length !== 1 || transports[0] !== 'app-server')
      return { ok: false, detail: `own turn selected unexpected transports: ${transports.join(',') || 'none'}` };
    const verdict = assertEcho(events, token);
    if (verdict.ok) return verdict;
    const envBlock = envBlockReason(events);
    if (envBlock) {
      return { ok: false, skip: `LLM proxy blocked the model call (env, not code): ${envBlock} · plumbing-reached-codex=${reachedModel(events)}` };
    }
    return verdict;
  });
}

main()
  .then(() => {
    console.log('\n========== codex 内核工具 e2e ==========');
    let fails = 0;
    let skips = 0;
    for (const r of results) {
      if (r.status === 'FAIL') fails++;
      else if (r.status === 'SKIP') skips++;
      console.log(`${r.status}  ${r.name}${r.status === 'PASS' ? '' : '  -- ' + r.detail}`);
    }
    console.log('=======================================');
    const passed = results.length - fails - skips;
    console.log(`${passed} passed · ${skips} skipped (env) · ${fails} failed  (of ${results.length})`);
    // Golden mode turns environment blocks into FAIL inside safe().
    process.exit(fails);
  })
  .catch((e) => {
    console.error('e2e crashed:', e);
    process.exit(1);
  });
