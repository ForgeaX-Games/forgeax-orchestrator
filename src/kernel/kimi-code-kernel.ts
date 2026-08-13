import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelModelCatalog,
  PermissionCall,
  PermissionDecision,
  PermissionMode,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { clampMode, DEFAULT_KERNEL_PERMISSION_MODE } from './permission-config';
import type { McpServer } from '@agentclientprotocol/sdk';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import { scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { runCapture } from '../lib/node-spawn';
import {
  evaluateSettingsRules,
  loadSettingsPermissionRules,
  ruleLabel,
} from '../api/lib/permission-settings';
import { checkKernelTool } from './trust-gate';
import { RENTED_KERNEL_PROFILE } from './kernel-profile';
import { KimiAcpAuthRequiredError, KimiAcpClient } from './kimi-acp-client';
import { mapKimiAcpPromptResponse } from './kimi-acp-mapper';
import {
  materializeForgeaxToolsRuntime,
  type ForgeaxToolsRuntime,
} from './mcp/forgeax-tools-runtime';
import {
  acquireProjectMcpNativeLease,
  isProjectMcpToolName,
  readProjectMcpServers,
  type ProjectMcpNativeLease,
} from './project-mcp';

export const KIMI_CODE_DRIVER_LABEL = 'kimi-code · subscription runtime · no local cost';
export const KIMI_CODE_FALLBACK_MODELS = [
  'k3',
  'k3-256k',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
];

interface KimiCodeKernelOptions {
  createClient?: (options: ConstructorParameters<typeof KimiAcpClient>[0]) => KimiAcpClient;
}

function* failure(message: string): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message } };
  yield { kind: 'turn.done', reason: 'error' };
}

function promptText(req: TurnRequest, firstTurn: boolean): string {
  const suffix = req.systemPrompt.dynamicSuffix?.trim();
  const task = suffix ? `${req.input.text}\n\n${suffix}` : req.input.text;
  if (!firstTurn) return task;
  const persona = req.systemPrompt.persona?.trim();
  const instructions = persona
    ? `${req.systemPrompt.charter}\n\n---\n\n## Persona\n\n${persona}`
    : req.systemPrompt.charter;
  return instructions?.trim()
    ? `# Instructions\n\n${instructions.trim()}\n\n# Task\n\n${task}`
    : task;
}

function toMcpServer(runtime: ForgeaxToolsRuntime): McpServer {
  return {
    name: 'fxt',
    command: runtime.command,
    args: runtime.args,
    env: Object.entries(runtime.env).map(([name, value]) => ({ name, value })),
  };
}

function toProjectMcpServers(projectRoot: string, requestedTools: readonly string[]): McpServer[] {
  const requestedServers = new Set(
    requestedTools
      .filter((name) => name.startsWith('mcp__'))
      .map((name) => name.slice('mcp__'.length).split('__', 1)[0]),
  );
  return readProjectMcpServers(projectRoot)
    .filter(({ name }) => requestedServers.has(name.replace(/[^a-zA-Z0-9_-]/g, '_')))
    .map(({ name, config }) => ({
    name,
    command: config.command,
    args: config.args,
    env: Object.entries(config.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
    }));
}

/**
 * kimi 能兑现的档位:只有 `gated` / `unrestricted` 两档。
 *
 * 它走 ACP,**没有 spawn 期的放行 flag**,权限面就是 runTurn 里的 per-call `onPermission`
 * 回调。所以:
 *  - `unrestricted` = 无规则命中即放行(不弹审批);
 *  - `gated`        = 无规则命中就交 host 闸(有 prompt 则问);
 *  - `autoEdits` / `planning` **不声明** —— 前者要能区分「编辑类工具」、后者要能强制只读,
 *    kimi 侧都没有可靠的工具分类可依,硬映射等于猜。不猜。
 */
export const KIMI_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ['gated', 'unrestricted'];

/** kimi 默认档 —— 派生自全内核默认,不独立持值。 */
export const KIMI_DEFAULT_PERMISSION_MODE: PermissionMode = DEFAULT_KERNEL_PERMISSION_MODE;

/** kimi per-call 闸的决策(纯函数,便于单测 —— 它是本内核唯一的权限落点)。
 *
 *  求值顺序刻意与 cc 一致:**规则先行且对档位免疫**。deny 规则、内容级 ask 永远压过
 *  「全权限」档,否则「默认全权限」就等于把闸拆了。只有无规则命中时,档位才说话。 */
export type KimiPermissionPlan = 'deny-by-rule' | 'deny-no-prompt' | 'ask' | 'allow';
export function planKimiPermission(
  ruleBehavior: 'allow' | 'deny' | 'ask' | undefined,
  mode: PermissionMode,
  hasPrompt: boolean,
): KimiPermissionPlan {
  if (ruleBehavior === 'deny') return 'deny-by-rule';
  if (ruleBehavior === 'allow') return 'allow';
  if (ruleBehavior === 'ask') return hasPrompt ? 'ask' : 'deny-no-prompt';
  // 无规则命中 → 档位说话:unrestricted = 基线放行(不弹审批);gated = 交 host 闸。
  if (mode === 'unrestricted') return 'allow';
  // gated 且没有审批通道 → **fail-closed**。用户显式要求逐项把闸,这时静默放行
  // 就等于把 gated 悄悄变成 unrestricted;与上面规则级 ask 的处理保持同一姿态。
  return hasPrompt ? 'ask' : 'deny-no-prompt';
}

export class KimiCodeKernel implements AgentKernel {
  readonly id = 'kimi-code';
  readonly displayName = KIMI_CODE_DRIVER_LABEL;
  readonly orchestrationProfile = RENTED_KERNEL_PROFILE;
  readonly fallbackModels = KIMI_CODE_FALLBACK_MODELS;
  readonly permissionCapabilities = {
    supported: KIMI_SUPPORTED_PERMISSION_MODES,
    defaultMode: KIMI_DEFAULT_PERMISSION_MODE,
  } as const;
  readonly capabilities: KernelCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
    forkExtract: false,
  };

  private binaryPromise?: Promise<string>;
  private readonly threadToSession = new Map<string, string>();
  private static readonly inflight = new Map<string, KimiAcpClient>();

  constructor(private readonly options: KimiCodeKernelOptions = {}) {}

  private binary(): Promise<string> {
    return (this.binaryPromise ??= (async () => {
      const resolved = await resolveBinary({
        envVarName: 'KIMI_CLI_PATH',
        defaultBinary: 'kimi',
      });
      if (resolved !== 'kimi') return resolved;
      const nativeInstall = join(homedir(), '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
      return existsSync(nativeInstall) ? nativeInstall : resolved;
    })());
  }

  hasNativeHistoryResume(threadId: string): boolean {
    return this.threadToSession.has(threadId);
  }

  private createClient(options: ConstructorParameters<typeof KimiAcpClient>[0]): KimiAcpClient {
    return this.options.createClient?.(options) ?? new KimiAcpClient(options);
  }

  async listModels(): Promise<KernelModelCatalog> {
    const binary = await this.binary();
    const out = await runCapture(binary, ['provider', 'list', '--json'], {
      timeoutMs: 5000,
      captureStderr: true,
    });
    if (out.code !== 0) {
      const detail = (out.stderr || out.stdout).trim();
      throw new Error(`kimi provider list --json exit ${out.code ?? 'spawn-failed'}${detail ? `: ${detail}` : ''}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(out.stdout);
    } catch (error) {
      throw new Error(`kimi provider list --json returned invalid JSON: ${(error as Error).message}`);
    }
    const models = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { models?: unknown }).models
      : undefined;
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      throw new Error('kimi provider list --json returned no model catalog');
    }
    const rows = Object.entries(models as Record<string, unknown>).map(([id, value]) => {
      const entry = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      const label = typeof entry.display_name === 'string'
        ? entry.display_name
        : typeof entry.displayName === 'string'
          ? entry.displayName
          : undefined;
      return { id, ...(label && label !== id ? { label } : {}) };
    });
    if (rows.length === 0) throw new Error('kimi provider list --json returned no models');
    return { models: rows, source: 'kernel' };
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const projectRoot = defaultProjectRoot();
    const threadId = req.session.threadId?.trim();
    const previousSessionId = threadId ? this.threadToSession.get(threadId) : undefined;
    let runtime: ForgeaxToolsRuntime | undefined;
    let nativeLease: ProjectMcpNativeLease | undefined;
    const events: KernelEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let assistantOutputSeen = false;
    // Kimi's native ACP permission callback does not observe calls made by the
    // per-turn fxt MCP server. Resolve the supported posture before mounting
    // that server and carry it through its environment as a fail-closed gate.
    const requestedMode = req.permissionMode ?? KIMI_DEFAULT_PERMISSION_MODE;
    const { mode: permissionMode, downgraded } = clampMode(
      requestedMode,
      KIMI_SUPPORTED_PERMISSION_MODES,
      KIMI_DEFAULT_PERMISSION_MODE,
    );
    if (downgraded) {
      process.stderr.write(
        `[kimi-code] permissionMode="${requestedMode}" 在 kimi 无落点(无 spawn 期放行档、无只读强制),已按 "${permissionMode}" 运行。\n`,
      );
    }
    const push = (event: KernelEvent) => {
      if (
        event.kind === 'message.delta'
        || event.kind === 'thinking.delta'
        || event.kind === 'tool.call'
        || event.kind === 'tool.result'
      ) assistantOutputSeen = true;
      events.push(event);
      if (wake) {
        const current = wake;
        wake = null;
        current();
      }
    };

    try {
      if ((req.tools?.length ?? 0) > 0) {
        runtime = await materializeForgeaxToolsRuntime(req, {
          runtimeId: req.callId || req.hostSessionId || threadId || 'kimi-code',
          permissionMode: permissionMode === 'gated' ? 'gated' : 'unrestricted',
          projectMcpMode: req.trustTier === 'imported' ? 'host' : 'native',
        });
      }
    } catch (error) {
      yield* failure(`kimi_mcp_materialize_failed: ${(error as Error).message}`);
      return;
    }

    const permissionRules = loadSettingsPermissionRules(projectRoot);
    const onPermission = async (call: PermissionCall): Promise<PermissionDecision> => {
      // Native project MCP calls do not pass through /kernel-tool. Apply the
      // same trust-tier gate here so own credential/delete tools still ask and
      // settings/tier denies remain effective without disabling native MCP.
      const nativeProjectTool = req.trustTier !== 'imported'
        && isProjectMcpToolName(call.name, projectRoot);
      if (nativeProjectTool) {
        const decision = checkKernelTool(req.trustTier, call.name, {
          args: call.args,
          projectRoot,
          ...(req.hostSessionId ? { sid: req.hostSessionId } : {}),
          rules: permissionRules,
        });
        if (decision.outcome === 'deny') return { behavior: 'deny', message: decision.reason ?? 'denied by trust tier' };
        if (decision.outcome === 'ask') {
          return req.requestPermission
            ? req.requestPermission(call)
            : { behavior: 'deny', message: decision.reason ?? 'permission requires confirmation' };
        }
        if (permissionMode === 'gated') {
          return req.requestPermission
            ? req.requestPermission(call)
            : { behavior: 'deny', message: 'permission requires confirmation, but no prompt is available' };
        }
        return { behavior: 'allow' };
      }
      const verdict = evaluateSettingsRules(permissionRules, call.name, call.args);
      const plan = planKimiPermission(verdict?.behavior, permissionMode, !!req.requestPermission);
      if (plan === 'deny-by-rule') {
        return { behavior: 'deny', message: `denied by rule ${ruleLabel(verdict!.rule)}` };
      }
      if (plan === 'deny-no-prompt') {
        return { behavior: 'deny', message: 'permission requires confirmation, but no prompt is available' };
      }
      if (plan === 'ask') return req.requestPermission!(call);
      return { behavior: 'allow' };
    };

    const envOverride = req.trustTier === 'imported' ? scrubbedSecretEnv() : undefined;

    const client = this.createClient({
      binary: await this.binary(),
      cwd: projectRoot,
      ...(envOverride ? { envOverride } : {}),
      onEvent: push,
      onPermission,
      onExit: (code, tail) => {
        if (ended) return;
        push({ kind: 'turn.usage' });
        push({
          kind: 'error',
          error: { code: 'protocol', message: `kimi acp exited ${code}${tail ? `: ${tail}` : ''}` },
        });
        push({ kind: 'turn.done', reason: 'error' });
        ended = true;
        if (wake) { const current = wake; wake = null; current(); }
      },
    });
    if (req.callId) KimiCodeKernel.inflight.set(req.callId, client);

    const onAbort = () => {
      void client.cancel().finally(() => client.shutdown());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (req.trustTier !== 'imported' && readProjectMcpServers(projectRoot).length > 0) {
        nativeLease = await acquireProjectMcpNativeLease(projectRoot);
      }
      // Keep fxt for the host bridge and mount project-local stdio servers as
      // native ACP MCP servers as well. Kimi's ACP implementation does not
      // reliably surface tools proxied behind another MCP server in its tool
      // catalog, so the project server must be visible at the ACP boundary.
      const mcpServers = [
        ...(runtime ? [toMcpServer(runtime)] : []),
        ...(req.trustTier === 'imported'
          ? []
          : toProjectMcpServers(projectRoot, (req.tools ?? []).map(({ name }) => name))),
      ];
      let setup;
      try {
        setup = previousSessionId
          ? await client.resumeSession(previousSessionId, mcpServers)
          : await client.newSession(mcpServers);
      } catch (error) {
        if (previousSessionId && threadId) this.threadToSession.delete(threadId);
        if (previousSessionId && !signal.aborted) {
          yield* failure(`kimi native session resume failed; retry to synchronize a fresh history snapshot: ${(error as Error).message}`);
          return;
        }
        throw error;
      }
      if (threadId) this.threadToSession.set(threadId, setup.sessionId);
      if (req.model?.trim()) await client.setModel(req.model.trim());

      const responsePromise = client.prompt(promptText(req, previousSessionId === undefined));
      responsePromise.then(
        (response) => {
          const mapped = mapKimiAcpPromptResponse(response);
          if (!assistantOutputSeen && response.stopReason === 'end_turn') {
            // A configured Kimi ACP session should emit at least one assistant
            // or tool event. The installed CLI currently exits cleanly with an
            // empty response when its provider catalog is empty; surfacing that
            // as success makes the Studio look like it received a blank answer.
            for (const event of mapped) {
              if (event.kind === 'turn.usage') push(event);
            }
            push({
              kind: 'error',
              error: {
                code: 'protocol',
                message: 'Kimi ACP returned no assistant content; configure a Kimi provider or run `kimi login`.',
              },
            });
            push({ kind: 'turn.done', reason: 'error' });
          } else {
            for (const event of mapped) push(event);
          }
          ended = true;
          if (wake) { const current = wake; wake = null; current(); }
        },
        (error) => {
          if (signal.aborted) {
            push({ kind: 'turn.usage' });
            push({ kind: 'turn.done', reason: 'cancelled' });
          } else {
            push({ kind: 'turn.usage' });
            push({
              kind: 'error',
              error: {
                code: 'protocol',
                message: error instanceof KimiAcpAuthRequiredError
                  ? error.message
                  : `kimi acp prompt failed: ${(error as Error).message}`,
              },
            });
            push({ kind: 'turn.done', reason: 'error' });
          }
          ended = true;
          if (wake) { const current = wake; wake = null; current(); }
        },
      );

      while (!ended || events.length > 0) {
        while (events.length > 0) yield events.shift()!;
        if (ended) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } catch (error) {
      if (signal.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
      } else {
        const message = error instanceof KimiAcpAuthRequiredError
          ? error.message
          : `kimi acp start failed: ${(error as Error).message}`;
        yield* failure(message);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      client.shutdown();
      if (req.callId) KimiCodeKernel.inflight.delete(req.callId);
      await runtime?.cleanup();
      await nativeLease?.release();
    }
  }

  openHandle(callId: string): TurnHandle {
    const cancel = async () => {
      const client = KimiCodeKernel.inflight.get(callId);
      await client?.cancel();
      client?.shutdown();
    };
    return {
      async setPermissionMode(): Promise<void> {},
      async setModel(): Promise<void> {},
      interrupt: cancel,
      cancel,
    };
  }

  async probe(): Promise<KernelHealth> {
    const binary = await this.binary();
    // Kimi's `--version` enters its interactive bootstrap on the installed
    // 0.31 CLI; `-h` is the supported bounded command for readiness.
    const { stdout, stderr, code, timedOut } = await runCapture(binary, ['-h'], {
      timeoutMs: 10000,
      captureStderr: true,
    });
    const detail = (stdout || stderr).trim().split('\n')[0] ?? '';
    if (code !== 0) return {
      ok: false,
      kernelId: this.id,
      detail: code == null
        ? timedOut
          ? 'kimi probe timed out after 10000ms'
          : 'kimi binary not on PATH (install: https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html)'
        : `kimi -h exit ${code}${detail ? `: ${detail}` : ''}`,
    };

    // `kimi -h` only proves that the CLI is installed. An unconfigured
    // installation can still start ACP and return an empty successful turn;
    // require a non-empty provider/model catalog for an honest health result.
    const catalog = await runCapture(binary, ['provider', 'list', '--json'], {
      timeoutMs: 5000,
      captureStderr: true,
    });
    if (catalog.code !== 0) {
      const catalogDetail = (catalog.stderr || catalog.stdout).trim().split('\n')[0] ?? '';
      return {
        ok: false,
        kernelId: this.id,
        detail: `kimi provider catalog unavailable${catalogDetail ? `: ${catalogDetail}` : ''}`,
      };
    }
    try {
      const raw = JSON.parse(catalog.stdout) as { providers?: unknown; models?: unknown };
      const providers = raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)
        ? Object.keys(raw.providers)
        : [];
      const models = raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)
        ? Object.keys(raw.models)
        : [];
      if (providers.length === 0 && models.length === 0) {
        return {
          ok: false,
          kernelId: this.id,
          detail: 'kimi provider catalog is empty; configure a provider or run `kimi login`',
        };
      }
    } catch {
      return { ok: false, kernelId: this.id, detail: 'kimi provider list --json returned invalid JSON' };
    }
    return { ok: true, kernelId: this.id, detail: detail || 'kimi ready' };
  }
}
