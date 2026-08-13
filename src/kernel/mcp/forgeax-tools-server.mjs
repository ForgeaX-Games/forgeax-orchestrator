#!/usr/bin/env node
/** forgeax tools MCP server (stdio) — M3 机制证明。
 *
 *  把「编排层声明的 forgeax 工具」暴露给 the reference agent CLI(经 `--mcp-config`)。
 *  CC 把它们当 `mcp__fxt__<tool>` 调用;编排层用 `--allowedTools` 显式放行
 *  (= 权限归编排层),所以 headless 也能调、不卡审批。
 *
 *  M3 先内置一个 `echo` 演示工具,跑通「编排声明 → MCP 下发 → CC 调用 →
 *  工具事件经内核回流」整条路。真实工具(读世界 / 跑 forgeax kit)走 HTTP 回调
 *  server 执行,是下一步(M3b)。
 *
 *  Plain Node + JSON-RPC-over-stdio(无 SDK 依赖),与 permission-server.mjs 同构。
 *
 *  ── P2-14 对外驱动面(standalone / 任意 MCP client 驱动 Studio)──────────
 *  本进程可脱离内核 profile 独立起,给任何 MCP client(IDE / 另一个 agent CLI)
 *  当「驱动运行中 Studio」的标准入口:
 *
 *    FORGEAX_SERVER_URL=http://localhost:18900 FORGEAX_SID=<sid> \
 *      node src/kernel/mcp/forgeax-tools-server.mjs
 *
 *  (mcp-config 形态即 command+env 同上;工具以 mcp__fxt__* 出现。)
 *  收口环境变量:
 *    FORGEAX_FXT_EXPOSE=ui_snapshot,ui_invoke,ui_screenshot   只暴露白名单内工具
 *      (外部驱动面建议只开 ui_*;留空 = 全量,内核 profile 路径的历史行为)。
 *    FORGEAX_DISABLE_PERCEPTION=1 / FORGEAX_DISABLE_UI_BRIDGE=1  整类摘除。
 *  安全边界:本进程只有「查询/调用」两类工具;ui-lease / ui-manifest 写端点
 *  (权限闸的信任锚)**刻意不在** MCP 面上,外部 client 无法改写权限声明。
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createMcpDispatcher, serveStdio } from '../../mcp/protocol.mjs';
import {
  classifyAndWrite,
  searchMemory,
  soulMemoryRoot,
} from '../../soul/layered-memory-runtime.mjs';

const DEBUG = process.env.FORGEAX_CC_MCP_DEBUG;
const dbg = (m) => { if (DEBUG) { try { appendFileSync('/tmp/forgeax-cc-mcp.log', `${new Date().toISOString()} [tools] ${m}\n`); } catch {} } };
const PROJECT_ROOT = process.env.FORGEAX_PROJECT_ROOT || process.cwd();
const SOUL_AGENT = process.env.FORGEAX_SOUL_AGENT || 'default';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ── T-A host-tool 桥:回调宿主执行 agent 的真实 host-tools ───────────────
const SERVER_URL = (process.env.FORGEAX_SERVER_URL || '').replace(/\/$/, '');
const BRIDGE_SID = process.env.FORGEAX_SID || '';
const BRIDGE_AGENT = process.env.FORGEAX_AGENT || '';
const SPECS_FILE = process.env.FORGEAX_TOOL_SPECS_FILE || '';
const KERNEL_PERMISSION_MODE = process.env.FORGEAX_KERNEL_PERMISSION_MODE || '';

/** 从 specs 文件读非内置工具规格(name/description/inputSchema)。 */
function loadBridgedSpecs() {
  if (!SPECS_FILE || !existsSync(SPECS_FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(SPECS_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t.name === 'string') : [];
  } catch { return []; }
}
const BRIDGED = loadBridgedSpecs();

// 桥超时:多数 host-tool 是毫秒级,但 delegate_to_subagent 同步 scaffold 子 agent
// 可达 ~5s(waitForTreeNode 5s + grace)→ 留足 90s 上限,既不卡死 CC 又容纳慢工具。
const BRIDGE_TIMEOUT_MS = 90_000;

/** 一次宿主执行的自铸 id。**唯一铸造点**,四个出口共用。
 *
 *  为什么必须自铸:内核(codex)铸的 callId **结构上过不了 MCP** —— `tools/call` 的参数
 *  只有 `{name, arguments}`,没有携带调用 id 的位置。于是宿主侧两份旁账
 *  (kernel-tool-audit / ui-browse-metrics)历来只有 sid+agent+时间戳,"哪次模型调用
 *  导致了哪次宿主执行"只能靠时间猜 —— 同一轮里连着跑两个一模一样的 act 就彻底分不开。
 *
 *  为什么这样能连上:本 id 随 MCP 结果的 `structuredContent` 回给内核,内核把工具结果
 *  原样回报给编排层(实证:本机 codex rollout 里 2811 次真实回传,其中 1873 次来自一个
 *  **根本没声明 outputSchema** 的 server → 不需要 outputSchema 也照收),于是编排层拿到
 *  `内核 callId → toolExecutionId → 两份旁账`,整条链可机械行走。
 *
 *  为什么不叫 callId:两个语义不许互相冒充。内核 callId 标识"模型发起的那次调用",
 *  toolExecutionId 标识"经 MCP 落到宿主的那一次执行"。前缀 `fxt-` 一眼可辨。 */
function newToolExecutionId() {
  // 铸 id 失败也绝不能拖垮工具调用本身 —— 观测是旁路。拿不到就返回 undefined:
  // 下游据「有没有这个键」判断能不能 join,缺席是可观察的,阻断执行则是事故。
  try {
    return `fxt-${randomUUID()}`;
  } catch {
    return undefined;
  }
}

/** 桥接调用:HTTP POST 回宿主 /api/sessions/:sid/kernel-tool;带超时;fail-closed。
 *  返回 `{isError, text, toolExecutionId}` —— **失败分支也带 id**:宿主没记上这一行时,
 *  查得到"有这个 id 但旁账里查无此行"(可观察的缺席),而不是根本无从查起。 */
async function bridgeCall(toolName, args) {
  const toolExecutionId = newToolExecutionId();
  if (!SERVER_URL || !BRIDGE_SID) return { isError: true, text: 'bridge unavailable (no server url / sid)', toolExecutionId };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(BRIDGE_SID)}/kernel-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPath: BRIDGE_AGENT, toolName, args: args ?? {}, ...(toolExecutionId ? { toolExecutionId } : {}) }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      return { isError: true, text: String(body?.error ?? `bridge HTTP ${res.status}`), toolExecutionId };
    }
    const r = body.result;
    return { isError: false, text: typeof r === 'string' ? r : JSON.stringify(r ?? ''), toolExecutionId };
  } catch (e) {
    const msg = ac.signal.aborted ? `bridge timeout after ${BRIDGE_TIMEOUT_MS}ms (tool ${toolName})` : `bridge transport error: ${e?.message ?? e}`;
    return { isError: true, text: msg, toolExecutionId };
  } finally {
    clearTimeout(timer);
  }
}

/** 桥结果 → MCP tool result。**必须回带 content 数组的对象**:协议层的 toToolResult 只对
 *  「带 content 数组的对象」原样透传,回裸字符串会把 structuredContent 连同连接键一起丢掉。 */
function bridgeToolResult(r, content) {
  return {
    content: content ?? [{ type: 'text', text: r.text }],
    // 自铸内容收进 `forgeax` 命名空间:① 第三方 MCP server 的 structuredContent 里绝不会有
    // 这个键,消费方据此**确定性**区分"我们自造的信封"与"别人的业务结果",不靠数键个数
    // (上一版按形状剥,把第三方业务结果剥成了纯文本 —— 2026-08-06 外审 MAJOR-1);
    // ② 以后要加字段(版本 / 耗时)一律加在里面,消费端判据不用跟着改,形状不被冻死。
    // 铸不出 id 时不写空键 —— 消费方据键的有无判断能不能 join。
    ...(r.toolExecutionId ? { structuredContent: { forgeax: { toolExecutionId: r.toolExecutionId } } } : {}),
    ...(r.isError ? { isError: true } : {}),
  };
}

/** Direct project-MCP clients have no ACP approval callback. A gated native
 * project path must therefore fail closed instead of silently becoming
 * unrestricted. Host-bridged specs are different: their call enters the
 * server's /kernel-tool trust/approval gate, so they must not be denied here. */
function permissionDenied(name) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Permission to use ${name} has been denied: the active kernel posture is gated and this MCP path has no interactive approval channel.` }],
  };
}

// ── 感知接地(R5/M8):query_world / capture_frame 的真实后端 ────────────
// 这两个内置工具不在本进程取数(真值在浏览器里的 preview iframe),而是 HTTP 回打
// server 的 /:sid/perception-query;server 经 WS 让 interface 去 preview iframe 取真值,
// 拿到后回灌解开。镜像 bridgeCall 的 fetch+timeout 写法。
const PERCEPTION_TIMEOUT_MS = 12_000;
async function perceptionQuery(kind, query) {
  if (!SERVER_URL || !BRIDGE_SID) return { unavailable: true, reason: 'no server url / sid' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PERCEPTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(BRIDGE_SID)}/perception-query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, query: query ?? null, agent: BRIDGE_AGENT }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    return body?.snapshot ?? { unavailable: true, reason: `perception HTTP ${res.status}` };
  } catch (e) {
    return { unavailable: true, reason: ac.signal.aborted ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── R6 数字生命:memory_search / remember ──────────────────────────────
// Plain-Node runtime SSOT is shared with `src/soul/layered-memory.ts`; this
// copied MCP asset imports it directly instead of mirroring FS/search logic.
function activeGame() {
  try {
    const p = join(PROJECT_ROOT, '.forgeax/active-game.json');
    if (!existsSync(p)) return undefined;
    const slug = JSON.parse(readFileSync(p, 'utf-8'))?.slug;
    return typeof slug === 'string' && SLUG_RE.test(slug) ? slug : undefined;
  } catch { return undefined; }
}
/** 写一条记忆:general→traits;game→episodes/<当前game>;无 kind+有 game→episodes,否则 traits。 */
function rememberMemory(args) {
  const text = String(args?.text ?? '').trim();
  if (!text) return { ok: false, error: 'remember: empty text' };
  const kind = args?.kind === 'general' || args?.kind === 'game' ? args.kind : undefined;
  const game = activeGame();
  if (kind === 'game' && !game) {
    return { ok: false, error: 'remember: game-bound memory needs an active game' };
  }
  const ref = { root: soulMemoryRoot(PROJECT_ROOT, SOUL_AGENT), ...(game ? { game } : {}) };
  const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
  const written = classifyAndWrite(ref, [{ text, ...(kind ? { kind } : {}), ...(title ? { title } : {}) }]);
  if (!written.length) return { ok: false, error: 'remember: nothing written (no active game for game-bound memory)' };
  return { ok: true, ...written[0] };
}

function searchLayeredMemory(query) {
  const game = activeGame();
  const ref = { root: soulMemoryRoot(PROJECT_ROOT, SOUL_AGENT), ...(game ? { game } : {}) };
  return searchMemory(ref, String(query ?? ''));
}

/** 列出工作区里的游戏(`.forgeax/games/` + 兼容旧 `games/`),过滤 _template / 隐藏。 */
function listGames() {
  const out = [];
  for (const base of [join(PROJECT_ROOT, '.forgeax/games'), join(PROJECT_ROOT, 'games')]) {
    if (!existsSync(base)) continue;
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')) out.push(e.name);
      }
    } catch {}
  }
  return [...new Set(out)];
}

/** 内置工具表。echo = 机制 demo;list_games = 真实只读 forgeax 能力(读文件系统)。
 *  需 kit-ctx 的真实工具(写世界/跑 kit)走 HTTP 回调 server,后续接入。 */
const TOOLS = {
  echo: {
    spec: {
      name: 'echo',
      description: 'Echo back the given text. A forgeax demo tool to verify MCP tool delivery.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    run: (args) => `[forgeax_echo] ${String(args?.text ?? '')}`,
  },
  list_games: {
    spec: {
      name: 'list_games',
      description: 'List the game projects in this ForgeaX instance (under .forgeax/games/). Returns { count, games }.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: () => { const games = listGames(); return JSON.stringify({ count: games.length, games }); },
  },
  // 数字生命(R6)按需召回通道 —— 真实后端 = soul 分层记忆库(identity/traits/episodes,
  // 含前世 game)。纯 FS · 朴素关键词 · 无 RAG(规格:模型驱动检索)。
  memory_search: {
    spec: {
      name: 'memory_search',
      description: "Search your long-term layered memory (identity / traits / episodes, including past-life worlds) for relevant entries. Returns { query, matches:[{tier, game?, file, text}] }.",
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    run: (args) => JSON.stringify(searchLayeredMemory(args?.query)),
  },
  // 数字生命(R6)成长通道 —— 模型驱动写入:agent 自己决定记什么。general→traits(可移植),
  // game→episodes/<当前game>;写时分类 + 维护 MEMORY.md 索引。真实后端 = soul 分层记忆库。
  remember: {
    spec: {
      name: 'remember',
      description: "Persist a durable memory about the user or this game into your long-term layered memory so you recall it in future sessions. Use kind:'general' for portable facts about the user (carry across games), kind:'game' for facts bound to the current game world. Returns { ok, tier, game?, file }.",
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['general', 'game'] }, title: { type: 'string' } }, required: ['text'] },
    },
    run: (args) => JSON.stringify(rememberMemory(args)),
  },
  // 感知接地(R5/M8)—— 向运行中的游戏取真值。仅取数,裁判 = 模型 + 结构/不变量。
  query_world: {
    spec: {
      name: 'query_world',
      description: "Query the RUNNING game's live world for ground truth: a structural ECS snapshot { entityCount, archetypes:[{componentNames, entityCount}], activeComponents, systems, resourceKeys }. Use it to VERIFY what the game actually contains/does (e.g. after writing code) instead of guessing. Data only — you are the judge. Returns the snapshot (or { unavailable } if no preview is open).",
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    run: async (args) => JSON.stringify(await perceptionQuery('world', args?.query)),
  },
  capture_frame: {
    spec: {
      name: 'capture_frame',
      description: 'Capture the running game preview current rendered frame as a PNG data URL (best-effort; may be blank on some GPUs — judge by structure/invariants, not pixels). Returns { bytes, dataUrl(truncated) } or { unavailable }.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: async () => {
      const snap = await perceptionQuery('frame');
      const dataUrl = snap && typeof snap === 'object' && typeof snap.dataUrl === 'string' ? snap.dataUrl : '';
      if (!dataUrl) return JSON.stringify({ unavailable: true, reason: snap?.reason ?? 'no frame' });
      return JSON.stringify({ bytes: dataUrl.length, dataUrl: dataUrl.slice(0, 64) + '…' });
    },
  },
};

// FORGEAX_DISABLE_PERCEPTION=1 → omit the perception tools (query_world /
// capture_frame) from this server entirely. Set by the codebuddy (cbc) kernel:
// cbc carries a ~20x larger baseline context than cc and defers MCP tools behind
// ToolSearch, so the agent reflexively calling query_world (then waiting on an
// unavailable preview) stacks model round-trips into a 60-90s "stuck" turn. cc /
// forgeax-core keep perception (they're light enough). See cbc-profile.ts.
if (process.env.FORGEAX_DISABLE_PERCEPTION === '1') {
  delete TOOLS.query_world;
  delete TOOLS.capture_frame;
}

// ── UI 语义操作层(产品 AI 化 P0):ui_snapshot / ui_invoke / ui_screenshot ──
// 契约 SSOT = ../ui-bridge-contract.json(与 compose-turn-request.ts 共读同一文件,
// 各内核看到字节一致的工具说明)。
// 执行**必须经 bridgeCall → 宿主 /:sid/kernel-tool**,而不是像 world/frame 那样
// 直打 /:sid/perception-query:ui_invoke 能触达 delete 级 action(如删会话),必须过
// 宿主的 per-action 信任闸(checkKernelTool + 审批卡)。kernel-tool 里
// runForgeaxBuiltinTool(ui_*) 再做真正的 perception 往返 + headless 回落。这样
// 租用内核路径与 forgeax-core 原生路径共用同一道闸(对称)。ui-lease / ui-manifest
// 两个写端点仍刻意不进 MCP 面(信任锚不外放)。
const UI_CONTRACT = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../ui-bridge-contract.json', import.meta.url), 'utf-8'));
  } catch (e) {
    dbg(`ui-bridge contract load failed: ${e?.message ?? e}`);
    return { tools: [] };
  }
})();
for (const spec of UI_CONTRACT.tools ?? []) {
  if (spec?.name === 'ui_snapshot') {
    // ui_snapshot 只读,但仍走 kernel-tool 以复用同一执行口(read → 信任闸直放)。
    TOOLS.ui_snapshot = { spec, run: async (args) => bridgeToolResult(await bridgeCall('ui_snapshot', args ?? {})) };
  } else if (spec?.name === 'ui_invoke') {
    TOOLS.ui_invoke = {
      spec,
      run: async (args) =>
        bridgeToolResult(await bridgeCall('ui_invoke', { actionId: args?.actionId ?? null, args: args?.args ?? {} })),
    };
  } else if (spec?.name === 'ui_screenshot') {
    // ui_screenshot(P3)只读兜底证据,同 ui_snapshot 走 kernel-tool 闸。宿主成功时
    // 回 ContentPart 数组([{type:'image',data,mimeType},{type:'text',text:meta}]),
    // 这里翻成 MCP image content block(base64 不当文本喂模型);其余形状(unavailable /
    // captured:false)原样文本透传。
    TOOLS.ui_screenshot = {
      spec,
      run: async (args) => {
        const r = await bridgeCall('ui_screenshot', args ?? {});
        if (r.isError) return bridgeToolResult(r);
        try {
          const parts = JSON.parse(r.text);
          // 守卫不绑定 image 在数组中的位置(§2.5:勿硬编码生产端形状),只认「存在一枚
          // 带 string data 的 image part」;下方 map 逐项按 p.type 处理,与顺序无关。
          if (Array.isArray(parts) && parts.some((p) => p?.type === 'image' && typeof p?.data === 'string')) {
            // 连接键仍走 bridgeToolResult 这唯一一处拼装(只换 content)—— 在这里手抄一份
            // structuredContent 就是第二份事实源,本工作流已经因此栽过四次。
            return bridgeToolResult(r, parts.map((p) =>
              p.type === 'image'
                ? { type: 'image', data: p.data, mimeType: p.mimeType ?? 'image/png' }
                : { type: 'text', text: String(p.text ?? '') },
            ));
          }
        } catch {
          /* 非 JSON → 按文本透传 */
        }
        return bridgeToolResult(r);
      },
    };
  }
}
// FORGEAX_DISABLE_UI_BRIDGE=1 → 整体摘除 ui_* 工具(per-kernel profile 开关,同
// FORGEAX_DISABLE_PERCEPTION 的先例:等 UI 往返的工具在重上下文内核上会反射式滥调)。
if (process.env.FORGEAX_DISABLE_UI_BRIDGE === '1') {
  delete TOOLS.ui_snapshot;
  delete TOOLS.ui_invoke;
  delete TOOLS.ui_screenshot;
}

// Snapshot every builtin name BEFORE the expose trim so we can dedupe bridged
// specs against builtins regardless of the allowlist (a builtin name must never
// be host-bridged — the local impl is authoritative).
const BUILTIN_NAMES = new Set(Object.keys(TOOLS));

// P2-14 对外驱动面收口 + 双层白名单(codex-mcp-tool-parity §5.2):
// FORGEAX_FXT_EXPOSE=名单(逗号分隔)= 本轮精确工具集。留空 = 全量(内核 profile
// 历史路径零回归)。allowlist 必须**同时**约束 tools/list(下发面)与 tools/call
// (执行面)——client 端 enabled_tools 是第一道闸,server 端 allowlist 是纵深第二道。
const EXPOSE = (process.env.FORGEAX_FXT_EXPOSE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const EXPOSE_SET = EXPOSE.length > 0 ? new Set(EXPOSE) : null;
/** 空 allowlist(未设 env)= 全量放行;否则只放行名单内。 */
function isExposed(name) {
  return EXPOSE_SET === null || EXPOSE_SET.has(name);
}
// Trim builtin TOOLS to the exposed set (removes unexposed builtins from the map).
if (EXPOSE_SET) {
  for (const name of Object.keys(TOOLS)) {
    if (!EXPOSE_SET.has(name)) delete TOOLS[name];
  }
}

// Bridged (host-tool) specs, deduped against builtins: a name implemented as a
// builtin is served locally, never host-bridged. Keyed by name for O(1) call-side
// existence checks (prevents bridging ARBITRARY unknown tool names — §5.2 rule 5).
function buildBridgedByName(specs) {
  const byName = new Map();
  for (const t of specs) {
    if (t && typeof t.name === 'string' && !BUILTIN_NAMES.has(t.name)) {
      byName.set(t.name, t);
    }
  }
  return byName;
}
let BRIDGED_BY_NAME = buildBridgedByName(BRIDGED);

// The kernel can rewrite FORGEAX_TOOL_SPECS_FILE as the turn's wired tools
// evolve (e.g. deferred tools loaded by tool_search). Do not keep a stale
// process-start snapshot: refresh before list/call, then fail closed if the name
// is still absent.
function refreshBridgedByName() {
  BRIDGED_BY_NAME = buildBridgedByName(loadBridgedSpecs());
  return BRIDGED_BY_NAME;
}

// Project MCP servers are proxied here for kernels whose native MCP surface
// cannot receive a per-turn project config (notably Codex and forgeax-core's
// fxt path). The process is itself per-turn, so keeping one client per server
// avoids a second initialize/list handshake for every tool call.
function readProjectMcpServers() {
  // Project-local MCP has one authoritative execution path per provider:
  // native providers mount it themselves; host-routed providers call the
  // server-side pooled bridge. The fxt shim must never spawn a second copy.
  if (process.env.FORGEAX_DISABLE_PROJECT_MCP === '1') return [];
  for (const path of [join(PROJECT_ROOT, '.forgeax/mcp.json'), join(PROJECT_ROOT, '.mcp.json'), join(PROJECT_ROOT, 'mcp.json')]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const entries = raw?.mcpServers;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
      return Object.entries(entries).flatMap(([name, cfg]) => {
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || (cfg.type && cfg.type !== 'stdio') || typeof cfg.command !== 'string') return [];
        return [{ name, cfg: {
          command: cfg.command,
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          env: cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? cfg.env : {},
        } }];
      });
    } catch { return []; }
  }
  return [];
}

class ProjectMcpClient {
  constructor(server) {
    this.server = server;
    this.child = spawn(server.cfg.command, server.cfg.args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...server.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.accept(chunk));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', (code, signal) => this.rejectAll(new Error(`MCP server ${server.name} exited (${code ?? signal ?? 'unknown'})`)));
  }
  accept(chunk) {
    this.buffer += chunk;
    for (;;) {
      const i = this.buffer.indexOf('\n');
      if (i < 0) return;
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id !== 'number') continue;
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || 'MCP error')); else pending.resolve(msg);
      } catch {}
    }
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${this.server.name} ${method} timeout`)); }, 8000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async listTools() {
    if (!this.initialized) {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'forgeax-fxt', version: '0.1.0' } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      this.initialized = true;
    }
    const response = await this.request('tools/list');
    return Array.isArray(response?.result?.tools) ? response.result.tools : [];
  }
  async callTool(name, args) {
    if (!this.initialized) await this.listTools();
    const response = await this.request('tools/call', { name, arguments: args || {} });
    return response?.result || {};
  }
  close() { try { this.child.kill(); } catch {} }
}

let PROJECT_MCP_PROMISE;
function loadProjectMcp() {
  return (PROJECT_MCP_PROMISE ??= (async () => {
  const byName = new Map();
  const clients = [];
  for (const server of readProjectMcpServers()) {
    const prefix = `mcp__${normalizeMcpName(server.name)}__`;
    if (EXPOSE_SET && ![...EXPOSE_SET].some((name) => name.startsWith(prefix))) continue;
    const client = new ProjectMcpClient(server);
    try {
      const listed = await client.listTools();
      clients.push(client);
      for (const tool of listed) {
        if (typeof tool?.name !== 'string' || !tool.name.trim()) continue;
        const name = `mcp__${normalizeMcpName(server.name)}__${normalizeMcpName(tool.name)}`;
        byName.set(name, { client, remoteName: tool.name, spec: {
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        } });
      }
    } catch { client.close(); }
  }
  return { byName, clients };
  })());
}

function normalizeMcpName(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_'); }

function activeToolNames(bridgedByName = BRIDGED_BY_NAME) {
  const names = new Set(Object.keys(TOOLS));
  for (const t of bridgedByName.values()) {
    if (isExposed(t.name)) names.add(t.name);
  }
  return [...names].sort();
}

/** Structured MCP `not_found` for an unknown / unexposed / undeclared tool call.
 *  Returned as an `isError` tool result (not a JSON-RPC error) so the model sees
 *  a clean "tool not found" instead of the call silently succeeding or hanging.
 *  Carries a machine-readable `structuredContent.code:'not_found'` for callers
 *  that parse it, plus a `not_found:` text prefix for humans/tests. */
function notFound(name, tools) {
  const activeTools = tools.map((tool) => tool.name).sort();
  const hint = activeTools.length > 0
    ? `Active tools this turn: ${activeTools.join(', ')}. If the tool you need is listed, call it directly; otherwise stop retrying this name and choose an available tool.`
    : 'No active tools are exposed this turn; stop retrying this name.';
  const why = isExposed(name) ? 'unknown tool' : 'not exposed this turn';
  return {
    isError: true,
    content: [{ type: 'text', text: `not_found: tool "${name ?? ''}" ${why}. ${hint}` }],
    structuredContent: { code: 'not_found', tool: name ?? null, activeTools, hint },
  };
}

async function currentTools() {
    const bridgedByName = refreshBridgedByName();
    const projectMcp = await loadProjectMcp();
    // 下发面 allowlist:内置工具(已按 EXPOSE 裁过)+ 桥接工具(去内置重名 + EXPOSE 过滤)。
    const builtin = Object.values(TOOLS).map((tool) => ({ ...tool.spec, run: tool.run }));
    const project = [...projectMcp.byName.values()]
      .filter((entry) => isExposed(entry.spec.name))
      .map((entry) => ({
        ...entry.spec,
        async run(args) {
          if (KERNEL_PERMISSION_MODE === 'gated') return permissionDenied(entry.spec.name);
          return entry.client.callTool(entry.remoteName, args);
        },
      }));
    const projectNames = new Set(projectMcp.byName.keys());
    const bridged = [];
    for (const t of bridgedByName.values()) {
      if (!isExposed(t.name)) continue;
      if (projectNames.has(t.name)) continue;
      bridged.push({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        async run(args) {
          // The host route is the authoritative trust/approval gate for this
          // tool. Applying the Kimi posture again in this MCP shim would cut
          // off imported agents before their host permission policy runs.
          return bridgeToolResult(await bridgeCall(t.name, args));
        },
      });
    }
    return [...builtin, ...project, ...bridged];
}

const dispatch = createMcpDispatcher({
  serverInfo: { name: 'fxt', version: '0.1.0' },
  tools: currentTools,
  onUnknownTool: notFound,
});
await serveStdio(async (message) => {
  if (message?.method === 'tools/call') {
    dbg(`call ${message.params?.name} ${JSON.stringify(message.params?.arguments ?? {})}`);
  }
  return dispatch(message);
});

dbg('mcp forgeax-tools server up');
