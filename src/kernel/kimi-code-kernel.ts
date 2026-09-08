import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelModelCatalog,
  PermissionCall,
  PermissionDecision,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import type { PermissionMode } from '@forgeax/agent-runtime';
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
import { buildKernelTask } from './kernel-context';
import { clampMode, DEFAULT_KERNEL_PERMISSION_MODE } from './permission-config';

export const KIMI_CODE_DRIVER_LABEL = 'kimi-code · subscription runtime · no local cost';
export const KIMI_CODE_FALLBACK_MODELS = [
  'k3',
  'k3-256k',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
];

export const KIMI_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ['gated', 'unrestricted'];
export const KIMI_DEFAULT_PERMISSION_MODE: PermissionMode = DEFAULT_KERNEL_PERMISSION_MODE;
export type KimiPermissionPlan = 'deny-by-rule' | 'deny-no-prompt' | 'ask' | 'allow';
export function planKimiPermission(
  ruleBehavior: 'allow' | 'deny' | 'ask' | undefined,
  mode: PermissionMode,
  hasPrompt: boolean,
): KimiPermissionPlan {
  if (ruleBehavior === 'deny') return 'deny-by-rule';
  if (ruleBehavior === 'allow') return 'allow';
  if (ruleBehavior === 'ask') return hasPrompt ? 'ask' : 'deny-no-prompt';
  if (mode === 'unrestricted') return 'allow';
  return hasPrompt ? 'ask' : 'deny-no-prompt';
}

interface KimiCodeKernelOptions {
  createClient?: (options: ConstructorParameters<typeof KimiAcpClient>[0]) => KimiAcpClient;
}

function* failure(message: string): Generator<KernelEvent> {
  yield { kind: 'turn.usage' };
  yield { kind: 'error', error: { code: 'protocol', message } };
  yield { kind: 'turn.done', reason: 'error' };
}

function promptText(req: TurnRequest, firstTurn: boolean): string {
  const task = buildKernelTask(req, firstTurn);
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
    const requestedMode = req.permissionMode ?? KIMI_DEFAULT_PERMISSION_MODE;
    const { mode: permissionMode, downgraded } = clampMode(
      requestedMode,
      KIMI_SUPPORTED_PERMISSION_MODES,
      KIMI_DEFAULT_PERMISSION_MODE,
    );
    if (downgraded) {
      process.stderr.write(
        `[kimi-code] permissionMode="${requestedMode}" unsupported; using "${permissionMode}".\n`,
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
      const nativeProjectTool = req.trustTier !== 'imported'
        && isProjectMcpToolName(call.name, projectRoot);
      if (nativeProjectTool) {
        const decision = checkKernelTool(req.trustTier, call.name, {
          args: call.args,
          projectRoot,
          ...(req.hostSessionId ? { sid: req.hostSessionId } : {}),
          rules: permissionRules,
        });
        if (decision.outcome === 'deny') {
          return { behavior: 'deny', message: decision.reason ?? 'denied by trust tier' };
        }
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
        return {
          behavior: 'deny',
          message: `denied by rule ${verdict?.rule ? ruleLabel(verdict.rule) : 'settings rule'}`,
        };
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
      // Keep fxt for the host bridge and mount only the requested project-local
      // MCP servers natively.  The runtime materializer removes the same
      // project tools from fxt, leaving one execution owner for each tool.
      const mcpServers = [
        ...(runtime ? [toMcpServer(runtime)] : []),
        ...(req.trustTier === 'imported'
          ? []
          : toProjectMcpServers(projectRoot, (req.tools ?? []).map(({ name }) => name))),
      ];
      let setup;
      let startedFresh = false;
      try {
        if (previousSessionId) {
          setup = await client.resumeSession(previousSessionId, mcpServers);
        } else {
          startedFresh = true;
          setup = await client.newSession(mcpServers);
        }
      } catch (error) {
        if (previousSessionId && !signal.aborted && !/auth|login/i.test((error as Error).message)) {
          startedFresh = true;
          setup = await client.newSession(mcpServers);
        } else {
          throw error;
        }
      }
      if (threadId) this.threadToSession.set(threadId, setup.sessionId);
      if (req.model?.trim()) await client.setModel(req.model.trim());

      const responsePromise = client.prompt(promptText(req, startedFresh));
      responsePromise.then(
        (response) => {
          const mapped = mapKimiAcpPromptResponse(response);
          if (!assistantOutputSeen && response.stopReason === 'end_turn') {
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
    const { stdout, stderr, code } = await runCapture(binary, ['--version'], {
      timeoutMs: 5000,
      captureStderr: true,
    });
    const detail = (stdout || stderr).trim().split('\n')[0] ?? '';
    if (code === 0) return { ok: true, kernelId: this.id, detail: detail || 'kimi ready' };
    return {
      ok: false,
      kernelId: this.id,
      detail: code == null
        ? 'kimi binary not on PATH (install: https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html)'
        : `kimi --version exit ${code}${detail ? `: ${detail}` : ''}`,
    };
  }
}
