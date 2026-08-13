/**
 * cc-profile npc_text **npc_text Claude-Code-isms npc_text**(adaptor profile)npc_text
 *
 * npc_text R4(B2):npc_text spine npc_textCC npc_text(argv flagsnpc_textpermission-mode
 * npc_textstop-reason npc_textMCP-ismsnpc_textstream-json wirenpc_textKernelEvent npc_text)npc_text
 * npc_text,`claude-code-kernel.ts` npc_text
 * `packages/kernel-adaptors/claude-code` npc_text,npc_text + claude-code-kernel.tsnpc_text
 * npc_text,spine npc_text(@forgeax/agent-runtime)npc_text
 *
 * npc_text CC-isms:
 *  - {@link buildCcArgs}      `-p / --output-format stream-json / --permission-mode /
 *                              --session-id|--resume / --model / --append-system-prompt`
 *  - {@link buildMcpArgs}     `--mcp-config / --permission-prompt-tool / --allowedTools`
 *  - {@link toCcPermissionMode} npc_text PermissionMode npc_text CC npc_text permission-mode npc_text
 *  - {@link chatEventToKernel} wire ChatEvent npc_text npc_text KernelEvent
 *  - {@link wireStopToKernel}  CC stop-reason npc_text npc_text TurnDoneReason
 *  - {@link ccSessionExists}   CC on-disk session npc_text(npc_text resume vs npc_text)
 */
import type {
  KernelEvent,
  KernelModelInfo,
  PermissionCall,
  PermissionDecision,
  PermissionMode,
  TurnDoneReason,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { DEFAULT_KERNEL_PERMISSION_MODE } from './permission-config';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { ChatEvent } from '../cli-providers/types';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { isProjectMcpToolName, readProjectMcpServers } from './project-mcp';
import { canonicalToolFields } from './canonical-tool-name';

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';

// npc_text npc_text(CC-isms) npc_text
// npc_text = stream-json npc_text:`<binary> -p --input-format stream-json
// --output-format stream-json --verbose` npc_text `initialize` control_request,
// npc_text `models` npc_text TUI `/model` npc_text(CLI npc_text/npc_text/
// env npc_text,npc_text list npc_text,SDK npc_text getAvailableModels npc_text)npc_text LLM npc_text
// cbc npc_text cc npc_text,npc_text({@link probeStreamJsonModels})npc_text
// npc_text(npc_text + last-known npc_text)npc_text

export const CLAUDE_CODE_DRIVER_LABEL = 'claude-code npc_text subscription runtime npc_text no local cost';

export const CLAUDE_CODE_FALLBACK_MODELS = [
  'opus',
  'sonnet',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-4.6-sonnet-medium',
];

/** initialize npc_textcc npc_text `value/displayName/description`,
 *  cbc(npc_text)npc_text `id/name` npc_text npc_text */
interface StreamJsonModelRow {
  id?: string;
  value?: string;
  name?: string;
  displayName?: string;
  description?: string;
}

/**
 * npc_text stream-json npc_text CLI npc_text(cc npc_text cbc npc_text)npc_text
 *
 * npc_text:initialize npc_text `account`(npc_text token)npc_text npc_text**npc_text
 * models npc_text**,npc_text,npc_text/npc_text(last-known npc_text
 * npc_text,npc_text account)npc_text
 *
 * npc_text:npc_text SIGTERM;stdin npc_text(npc_text EOF
 * npc_text,npc_text kill npc_text)npc_text
 */
export function probeStreamJsonModels(binary: string, timeoutMs = 15000): Promise<KernelModelInfo[]> {
  return new Promise((resolve, reject) => {
    const reqId = `fx-models-${Date.now().toString(36)}`;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err as Error);
      return;
    }

    let buf = '';
    let stderrTail = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        `${binary} stream-json initialize timed out after ${timeoutMs}ms${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`,
      )));
    }, timeoutMs);

    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', (code) => {
      finish(() => reject(new Error(
        `${binary} exited (code=${code}) before answering initialize${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`,
      )));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => { stderrTail = (stderrTail + c).slice(-2000); });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { type?: string; response?: { subtype?: string; request_id?: string; response?: { models?: StreamJsonModelRow[] }; error?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== 'control_response' || msg.response?.request_id !== reqId) continue;
        if (msg.response.subtype !== 'success') {
          finish(() => reject(new Error(`initialize control_response error: ${msg.response?.error ?? 'unknown'}`)));
          return;
        }
        const rows = Array.isArray(msg.response.response?.models) ? msg.response.response.models : [];
        const models: KernelModelInfo[] = rows
          .map((m) => {
            const id = (m.id ?? m.value ?? '').trim();
            if (!id) return null;
            const label = (m.name ?? m.displayName ?? '').trim();
            return { id, ...(label && label !== id ? { label } : {}) };
          })
          .filter((m): m is KernelModelInfo => m !== null);
        finish(() => resolve(models));
        return;
      }
    });

    child.stdin?.on('error', () => { /* EPIPE npc_text finish npc_text */ });
    child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: reqId, request: { subtype: 'initialize' } }) + '\n');
  });
}

// npc_text per-turn permission gate registry(B-4) npc_text
//
// npc_text(honest):headless CC npc_text**npc_text**npc_textspawn npc_text
// `mcp/permission-server.mjs`(permission-prompt npc_text)npc_text CLI npc_text HTTP npc_text
// `POST /:sid/permission-request`(npc_text `api/sessions.ts`),npc_text + npc_text
// npc_text/npc_text `TurnRequest.requestPermission` npc_text**npc_text**
// (compose-turn-request.ts npc_text)npc_text
//
// npc_text:CC npc_text runTurn npc_text,npc_text
// `req.requestPermission`,npc_text {@link registerTurnGate} npc_text in-process
// npc_text Map(npc_text=npc_text sid)npc_text**npc_text**:`/:sid/permission-request`
// npc_text(api/sessions.ts)npc_text {@link consultTurnGate} npc_text(allow/
// deny)npc_text,npc_text;npc_text(npc_text/npc_text)npc_text + npc_text
// npc_text checkTool/requestPermission npc_text CC npc_text
// `turn-gate.test.ts` npc_text(npc_text)npc_text
//
// npc_text Bun npc_text;npc_text sid npc_text turn,npc_text sid npc_text(npc_text
// permission-registry npc_text owner.sid npc_text)npc_text

const _turnGates = new Map<
  string,
  (call: PermissionCall) => Promise<PermissionDecision>
>();

/** npc_text(npc_text=npc_text sid)npc_text(sid npc_text gate)npc_text */
export function registerTurnGate(
  sid: string,
  gate: (call: PermissionCall) => Promise<PermissionDecision>,
): boolean {
  if (!sid) return false;
  _turnGates.set(sid, gate);
  return true;
}

/** npc_text sid npc_text(turn npc_text/npc_text,npc_text)npc_text */
export function releaseTurnGate(sid: string): void {
  if (sid) _turnGates.delete(sid);
}

/** npc_text(api/sessions.ts npc_text /:sid/permission-request)npc_text:
 *  npc_text {@link PermissionDecision},npc_text undefined(npc_text)npc_text
 *  npc_text HTTP npc_text = npc_text(npc_text)npc_text */
export async function consultTurnGate(
  sid: string,
  call: PermissionCall,
): Promise<PermissionDecision | undefined> {
  const gate = _turnGates.get(sid);
  if (!gate) return undefined;
  try {
    return await gate(call);
  } catch (e) {
    // fail closed:npc_text npc_text deny(npc_text)npc_text
    return { behavior: 'deny', message: `permission gate error: ${(e as Error).message}` };
  }
}

/** CC headless npc_text `--permission-mode` npc_text(CC-ism,npc_text profile npc_text)npc_text */
export type CcPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * npc_text {@link PermissionMode} npc_text CC `--permission-mode` npc_text(B2:spine npc_text CC npc_text)npc_text
 *   gated        npc_text 'default'           npc_text
 *   autoEdits    npc_text 'acceptEdits'       npc_text
 *   planning     npc_text 'plan'              npc_text
 *   unrestricted npc_text 'bypassPermissions' npc_text
 */
export function toCcPermissionMode(mode: PermissionMode): CcPermissionMode {
  switch (mode) {
    case 'gated':
      return 'default';
    case 'autoEdits':
      return 'acceptEdits';
    case 'planning':
      return 'plan';
    case 'unrestricted':
      return 'bypassPermissions';
  }
}

/** cc 能兑现的档位 = 中立轴四档全支持(`--permission-mode` 原生四值一一对应)。
 *  设置页的下拉选项由本表派生,故 UI 永远只列该内核真能兑现的档。 */
export const CC_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = [
  'gated',
  'autoEdits',
  'planning',
  'unrestricted',
];

/** cc 默认档 —— **派生**自全内核默认,不独立持值;改默认去 permission-config.ts 那一处。
 *
 *  headless 无 MCP permission-prompt(见 buildMcpArgs),故默认档必须自足放行:
 *  基线 `unrestricted`(→ `bypassPermissions`)下 `permissions.deny` 与 PreToolUse
 *  hook 仍然生效(实测结论见 permission-config.ts 的默认档注释),收窄靠它们。 */
export const CC_DEFAULT_PERMISSION_MODE: PermissionMode = DEFAULT_KERNEL_PERMISSION_MODE;

/** session npc_text:UUID threadId npc_text `--session-id`,npc_text `--resume`npc_text
 *  npc_text argv npc_text + npc_text/npc_text(npc_text startedThreadIds)npc_text */
export function buildSessionArgs(
  tid: string | undefined,
  projectRoot: string,
  startedThreadIds: ReadonlySet<string>,
): { args: string[]; threadId?: string } {
  const t = tid?.trim();
  if (!t || !/^[0-9a-f-]{36}$/i.test(t)) return { args: [] };
  if (startedThreadIds.has(t) || ccSessionExists(projectRoot, t)) {
    return { args: ['--resume', t], threadId: t };
  }
  return { args: ['--session-id', t], threadId: t };
}

/**
 * systemPrompt npc_text argv:npc_text charter(+persona)**npc_text**,npc_text `mode` npc_text flagnpc_text
 *   - replace npc_text `--system-prompt-file <path>`(npc_text prompt)
 *   - append/npc_text npc_text `--append-system-prompt-file <path>`(npc_text,npc_text)
 * npc_text file npc_text inline npc_text:charter+npc_text,inline npc_text argv npc_text
 * npc_text npc_text npc_text inline `--append-system-prompt <text>`(npc_text)npc_text
 */
function buildSystemPromptArgs(text: string, mode: 'append' | 'replace', key: string): string[] {
  try {
    const path = resolvePath(tmpdir(), `forgeax-kernel-sysprompt-${key}.txt`);
    writeFileSync(path, text);
    return mode === 'replace'
      ? ['--system-prompt-file', path]
      : ['--append-system-prompt-file', path];
  } catch {
    // npc_text:replace npc_text append inline(headless npc_text),npc_text
    return ['--append-system-prompt', text];
  }
}

/**
 * npc_text argv(npc_text toolPolicy npc_text CC `--tools` / `--disallowedTools`)npc_text
 *   - allow npc_text `--tools a,b,c`(npc_text**npc_text**npc_text;CC npc_text)
 *   - deny  npc_text `--disallowedTools a b npc_text`(npc_text;CC npc_text)
 * npc_text opaque npc_text(spine npc_text,npc_text contract)npc_text npc_text npc_text npc_text npc_text
 * npc_text**npc_text `--flag` npc_text**npc_text(npc_text buildCcArgs npc_text),
 * npc_text `--disallowedTools` npc_text messagenpc_text
 */
function buildToolPolicyArgs(policy: TurnRequest['toolPolicy']): string[] {
  const out: string[] = [];
  const allow = policy?.allow?.filter((t) => typeof t === 'string' && t.trim());
  if (allow && allow.length) out.push('--tools', allow.join(','));
  const deny = new Set(['TodoWrite', ...(policy?.deny ?? [])].filter((t) => typeof t === 'string' && t.trim()));
  out.push('--disallowedTools', ...deny);
  return out;
}

/** npc_text argv:`--max-turns`(agentic npc_text)+ `--max-budget-usd`(npc_text spawn npc_text)npc_text
 *  npc_text `req.budget`(maxTurns/maxBudgetUsd)npc_text npc_text npc_text npc_text npc_text(npc_text)npc_text
 *  npc_text:npc_text claude **npc_text**npc_text/npc_text,npc_text sidecar cred-vault npc_text(R3-05)npc_text */
function buildBudgetArgs(budget: TurnRequest['budget']): string[] {
  const out: string[] = [];
  if (typeof budget?.maxTurns === 'number' && budget.maxTurns > 0) out.push('--max-turns', String(budget.maxTurns));
  if (typeof budget?.maxBudgetUsd === 'number' && budget.maxBudgetUsd > 0) out.push('--max-budget-usd', String(budget.maxBudgetUsd));
  return out;
}

/** npc_text argv:`--fallback-model a,b`(npc_text/npc_text)npc_textopaque npc_text */
function buildFallbackArgs(models: TurnRequest['fallbackModels']): string[] {
  const list = models?.filter((m) => typeof m === 'string' && m.trim());
  return list && list.length ? ['--fallback-model', list.join(',')] : [];
}

/** Hermetic mode is a trust boundary, not a latency switch.
 * Imported/untrusted packs must not inherit operator capabilities; own Studio
 * turns must retain Claude's native MCP, plugin, skill, CLAUDE.md, hooks and
 * settings so the external capability manager remains semantically intact.
 */
function buildHermeticArgs(trustTier: TurnRequest['trustTier']): string[] {
  if (trustTier === 'imported') return ['--strict-mcp-config', '--setting-sources', ''];
  return [];
}

/**
 * settings.permissions npc_text argv(046 npc_text3):npc_text `hooks.PreToolUse` npc_text
 * settings JSON npc_text,`--settings <path>` npc_text npc_text hook npc_text forgeax
 * npc_text(`/:sid/hook-gate`,settings npc_text;ask npc_text Studio npc_text)npc_text
 * npc_text CC **npc_text**npc_text(Bash/Write/Editnpc_text CC npc_text)npc_text
 * npc_text acceptEdits npc_text permission-prompt npc_text(npc_textB)npc_text
 * npc_text 2026-07-14:`--settings` npc_text PreToolUse npc_text headless `-p` npc_textdeny npc_text
 *
 * npc_text argv(port/sid/agent;npc_text,npc_text shell env npc_text)npc_texttimeout 600s
 * (>= npc_text 10min server npc_text;hook npc_text 9.5min fetch npc_text)npc_text
 * npc_text npc_text npc_text(npc_text:npc_text hook npc_text,tier npc_text + permission-prompt npc_text,npc_text)npc_text
 *
 * npc_text imported npc_text `--setting-sources ''` npc_text user/project/local npc_text,`--settings`
 * flag npc_text npc_text npc_text,imported npc_text best-effort npc_text
 */
function buildHookSettingsArgs(realSid: string, agentId: string, key: string): string[] {
  if (!realSid) return [];
  try {
    const script = resolvePath(import.meta.dirname, 'hooks/kernel-permission-hook.mjs');
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${SERVER_PORT} ${realSid} ${agentId} claude-code`;
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 600 }] }],
      },
    };
    const path = resolvePath(tmpdir(), `forgeax-kernel-hook-settings-${key}.json`);
    writeFileSync(path, JSON.stringify(settings));
    return ['--settings', path];
  } catch {
    return []; // npc_text:npc_text(npc_text,npc_text)npc_text
  }
}

/**
 * npc_text TurnRequest npc_text `claude -p` argv(systemPrompt npc_text composeTurnRequest)npc_text
 * `permissionMode` 收**中立**档位(缺省 {@link CC_DEFAULT_PERMISSION_MODE}),方言翻译
 * 只发生在本函数内一次({@link toCcPermissionMode})—— 调用方(kernel)不碰 CC-ism。
 */
export function buildCcArgs(
  req: TurnRequest,
  projectRoot: string,
  sessionArgs: string[],
  // 缺省先看 `req.permissionMode` 再落默认档 —— **fail-safe**:漏传第 4 参的调用方
  // 会拿到本轮请求的档位,而不是静默跳到最高放行档(权限相关的默认必须往紧的方向兜)。
  permissionMode: PermissionMode = req.permissionMode ?? CC_DEFAULT_PERMISSION_MODE,
): string[] {
  const sp = req.systemPrompt;
  const systemPrompt = sp.persona?.trim()
    ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
    : sp.charter;

  // MCP:npc_text(permission-prompt npc_text forgeax MCP)+ npc_text(fxt server)npc_text
  const tid = req.session.threadId?.trim();
  const mcpArgs = buildMcpArgs(req, tid || '', projectRoot);

  // npc_text(--tools/--disallowedTools)npc_text mcpArgs npc_textsystemPromptArgs npc_text
  // systemPromptArgs npc_text `--*-system-prompt*` flag npc_text,npc_text `--disallowedTools`,
  // npc_text messagenpc_text
  const toolPolicyArgs = buildToolPolicyArgs(req.toolPolicy);

  // Hermetic flags apply only to imported/untrusted turns; they are not a
  // global performance optimization and must not hide native capabilities.
  const hermeticArgs = buildHermeticArgs(req.trustTier);
  const budgetArgs = buildBudgetArgs(req.budget);
  const fallbackArgs = buildFallbackArgs(req.fallbackModels);

  // systemPrompt npc_text(replace/append),npc_text inlinenpc_textkey npc_text+npc_text
  const spKey = req.hostSessionId?.trim() || tid || req.session.agentId?.trim() || 'x';
  const systemPromptArgs = buildSystemPromptArgs(systemPrompt, sp.mode ?? 'append', spKey);

  // settings.permissions npc_text(046 npc_text3):PreToolUse hook npc_text forgeax npc_text
  const realSid = req.hostSessionId?.trim() || tid || '';
  const hookSettingsArgs = buildHookSettingsArgs(realSid, req.session.agentId?.trim() || 'forge', spKey);

  // npc_text(dynamicSuffix npc_text user npc_text,npc_text system prompt)npc_text
  const message = buildCcInput(req);

  return [
    '-p',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    // Claude moves only machine/session-specific sections of its default
    // prompt into the first user payload. The native MCP/plugin/skill surface
    // and the appended CLAUDE.md/system prompt remain enabled; this keeps the
    // stable capability prefix reusable without disabling any capability.
    '--exclude-dynamic-system-prompt-sections',
    '--permission-mode', toCcPermissionMode(permissionMode),
    ...hermeticArgs,
    ...hookSettingsArgs,
    ...mcpArgs,
    ...toolPolicyArgs,
    ...budgetArgs,
    ...fallbackArgs,
    ...(req.model ? ['--model', req.model] : []),
    ...sessionArgs,
    ...systemPromptArgs,
    message,
  ];
}

/** The exact user payload used by both one-shot and persistent stream-json turns. */
export function buildCcInput(req: TurnRequest): string {
  return req.systemPrompt.dynamicSuffix?.trim()
    ? `${req.input.text}\n\n${req.systemPrompt.dynamicSuffix.trim()}`
    : req.input.text;
}

/**
 * Persistent variant of {@link buildCcArgs}. It keeps every capability,
 * permission, MCP, plugin and settings flag, removes the one-shot positional
 * message, and switches stdin to Claude's documented stream-json protocol.
 */
export function buildCcPersistentArgs(
  req: TurnRequest,
  projectRoot: string,
  sessionArgs: string[],
  permissionMode: PermissionMode = req.permissionMode ?? CC_DEFAULT_PERMISSION_MODE,
): string[] {
  const oneShot = buildCcArgs(req, projectRoot, sessionArgs, permissionMode);
  return [...oneShot.slice(0, -1), '--input-format', 'stream-json'];
}

/** npc_text thread npc_text on-disk session npc_text(npc_text resume vs npc_text,npc_text)npc_text */
export function ccSessionExists(cwd: string, tid: string): boolean {
  try {
    // CC encodes the project cwd into its on-disk dir name by replacing path
    // punctuation with '-'. Must cover Windows separators/drive too (`\` and
    // `:`), else e.g. `C:\Users\me\proj` npc_text wrong dir, the probe misses an
    // existing session, and the next turn re-issues `--session-id` npc_text CC errors
    // "Session ID npc_text is already in use". Matches CC: `C:\Users\npc_text` npc_text `C--Users-npc_text`.
    const encoded = cwd.replace(/[/\\.:]/g, '-');
    return existsSync(resolvePath(homedir(), '.claude', 'projects', encoded, `${tid}.jsonl`));
  } catch {
    return false;
  }
}

/** npc_text MCP npc_text + npc_text/npc_text flags:
 *   - permission server `forgeax`(npc_text sid npc_text)npc_text `--permission-prompt-tool mcp__forgeax__approve`
 *   - npc_text server `fxt`(npc_text)npc_text `--allowedTools mcp__fxt__<tool>...`(npc_text)
 *  npc_text server npc_text npc_text(npc_text permission-mode npc_text)npc_text */
export function buildMcpArgs(req: TurnRequest, permSid: string, projectRoot = defaultProjectRoot()): string[] {
  const mcpServers: Record<string, unknown> = {};
  const flags: string[] = [];

  if (permSid) {
    // npc_text**npc_text sid**(UI npc_text sid),npc_text threadId(permSid=uuidv5)npc_text
    // npc_text /api/sessions/<uuid>/permission-request npc_text session npc_text npc_text deny,Bash npc_text
    // npc_text(ship-gate npc_text#2 parity npc_text)npc_texthostSessionId = compose npc_text sidnpc_text
    const realSid = req.hostSessionId?.trim() || permSid;
    mcpServers.forgeax = {
      command: process.execPath,
      args: [resolvePath(import.meta.dirname, '../cli-providers/mcp/permission-server.mjs')],
      env: {
        FORGEAX_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
        FORGEAX_SID: realSid,
        FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
      },
    };
    flags.push('--permission-prompt-tool', 'mcp__forgeax__approve');
  }

  if (req.tools.length > 0) {
    const env: Record<string, string> = {
      FORGEAX_PROJECT_ROOT: defaultProjectRoot(),
      // FORGEAX_SOUL_AGENT npc_text memory_search npc_text soul npc_text
      FORGEAX_SOUL_AGENT: req.session.agentId?.trim() || 'default',
      // npc_text + npc_text sid + agentPath:**npc_text**npc_text host-tool npc_text,npc_text
      // npc_text(query_world/capture_frame)npc_text HTTP npc_text /:sid/perception-querynpc_text
      // threadId npc_text UUID,npc_text agent / session npc_text hostSessionIdnpc_text
      FORGEAX_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
      FORGEAX_SID: req.hostSessionId?.trim() || permSid,
      FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
      FORGEAX_FXT_EXPOSE: req.tools.map((tool) => tool.name).join(','),
      // Claude's own/default turns mount project MCP natively below. Imported
      // turns keep the same tools in the fxt specs so the host trust gate is
      // the only execution path. The fxt child itself never spawns project
      // servers, preventing duplicate MCP processes in either case.
      FORGEAX_DISABLE_PROJECT_MCP: '1',
    };

    // T-A host-tool npc_text:npc_text MCPnpc_textHTTP npc_text
    // npc_text fxt server(npc_text = echo + R6 memory_search/remember/soul_create + legacy
    // rented-CLI list_games/query_world/capture_frame npc_text mcp server npc_text,npc_text host-tool npc_text)npc_text
    const BUILTIN_FXT = new Set(['echo', 'list_games', 'memory_search', 'remember', 'soul_create', 'npc_wire', 'query_world', 'capture_frame']);
    const nativeProjectMcp = req.trustTier !== 'imported';
    const bridged = req.tools.filter((t) =>
      !BUILTIN_FXT.has(t.name)
      && (!nativeProjectMcp || !isProjectMcpToolName(t.name, projectRoot)),
    );
    if (bridged.length > 0) {
      try {
        const specsPath = resolvePath(tmpdir(), `forgeax-kernel-tools-${permSid || req.session.agentId || 'x'}.json`);
        writeFileSync(specsPath, JSON.stringify(bridged));
        env.FORGEAX_TOOL_SPECS_FILE = specsPath;
      } catch {
        /* specs npc_text npc_text npc_text(npc_text,npc_text) */
      }
    }

    mcpServers.fxt = {
      command: process.execPath,
      args: [resolvePath(import.meta.dirname, 'mcp/forgeax-tools-server.mjs')],
      env,
    };
    const requestedProjectServers = new Set(
      req.tools
        .map((tool) => tool.name)
        .filter((name) => nativeProjectMcp && isProjectMcpToolName(name, projectRoot))
        .map((name) => name.slice('mcp__'.length).split('__', 1)[0]),
    );
    const projectServerKeys = new Map<string, string>();
    for (const server of readProjectMcpServers(projectRoot)) {
      const normalizedServer = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!requestedProjectServers.has(normalizedServer) || mcpServers[server.name]) continue;
      mcpServers[server.name] = {
        command: server.config.command,
        args: server.config.args,
        ...(server.config.env ? { env: server.config.env } : {}),
      };
      projectServerKeys.set(normalizedServer, server.name);
    }
    // npc_text npc_text headless npc_text(= npc_text)npc_text
    // `--allowedTools <tools...>` npc_text:npc_text argv npc_text
    const allowedTools = req.tools.flatMap((tool) => {
      const fxtName = `mcp__fxt__${tool.name}`;
      if (!tool.name.startsWith('mcp__')) return [fxtName];
      const separator = tool.name.indexOf('__', 'mcp__'.length);
      const serverName = separator >= 0 ? tool.name.slice('mcp__'.length, separator) : '';
      const configName = projectServerKeys.get(serverName) ?? serverName;
      return serverName && mcpServers[configName] ? [tool.name] : [fxtName];
    });
    flags.push('--allowedTools', ...allowedTools);
  }

  if (Object.keys(mcpServers).length === 0) return [];
  try {
    const cfgPath = resolvePath(tmpdir(), `forgeax-kernel-mcp-${permSid || req.session.agentId || 'x'}.json`);
    writeFileSync(cfgPath, JSON.stringify({ mcpServers }));
    return ['--mcp-config', cfgPath, ...flags];
  } catch {
    return [];
  }
}

/** wire ChatEvent(claude stream-json npc_text mapClaudeEvent npc_text)npc_text npc_text KernelEventnpc_text */
export function* chatEventToKernel(ev: ChatEvent): Generator<KernelEvent> {
  switch (ev.type) {
    case 'token':
      yield { kind: 'message.delta', role: 'assistant', text: ev.text };
      return;
    case 'thinking':
      yield { kind: 'thinking.delta', text: ev.text, visibility: ev.visibility ?? 'private_reasoning' };
      return;
    case 'tool-call':
      yield {
        kind: 'tool.call',
        callId: ev.callId,
        ...canonicalToolFields(ev.rawName ?? ev.name),
        args: ev.args,
      };
      return;
    case 'tool-call-delta':
      yield {
        kind: 'tool.call.delta',
        callId: ev.callId,
        ...canonicalToolFields(ev.rawName ?? ev.name),
        argsDelta: ev.argumentsDelta,
      };
      return;
    case 'tool-result':
      yield {
        kind: 'tool.result',
        callId: ev.callId,
        ...(ev.name || ev.rawName ? canonicalToolFields(ev.rawName ?? ev.name!) : {}),
        ok: ev.ok,
        result: ev.result,
        error: ev.error,
      };
      return;
    case 'done':
      yield {
        kind: 'turn.usage',
        inputTokens: ev.usage?.inputTokens,
        outputTokens: ev.usage?.outputTokens,
        cacheRead: ev.usage?.cacheReadTokens,
        cacheCreation: ev.usage?.cacheCreationTokens,
        costUsd: ev.cost,
        durationMs: ev.durationMs,
      };
      yield { kind: 'turn.done', reason: wireStopToKernel(ev.stopReason) };
      return;
    case 'error':
      yield { kind: 'turn.usage' };
      yield { kind: 'error', error: { code: 'protocol', message: ev.message } };
      yield { kind: 'turn.done', reason: 'error' };
      return;
    case 'stored-event':
      yield { kind: 'stored-event', payload: ev.storedEvent };
      return;
  }
}

/** CC stop-reason npc_text npc_text TurnDoneReasonnpc_text */
export function wireStopToKernel(s: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled'): TurnDoneReason {
  switch (s) {
    case 'end_turn': return 'stop';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'cancelled': return 'cancelled';
  }
}
