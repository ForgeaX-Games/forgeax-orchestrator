import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  PermissionMode,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { spawn } from 'node:child_process';
import { runCapture, which } from '../lib/node-spawn';
import { scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { RENTED_KERNEL_PROFILE } from './kernel-profile';
import {
  buildDeepSeekHarnessArgs,
  DEEPSEEK_HARNESS_DEFAULT_PERMISSION_MODE,
  DEEPSEEK_HARNESS_DRIVER_LABEL,
  DEEPSEEK_HARNESS_SUPPORTED_PERMISSION_MODES,
  resolveDeepSeekHarnessBinary,
  toDeepSeekHarnessPermission,
} from './deepseek-harness-profile';

const IS_WINDOWS = process.platform === 'win32';
const STDERR_LIMIT = 4_096;

function safeErrorTail(stderr: string): string {
  return stderr
    .slice(-STDERR_LIMIT)
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN))\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|dsk|Bearer)[-_ ][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .trim();
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (!IS_WINDOWS && typeof pid === 'number' && pid > 0) {
    try { process.kill(-pid, signal); return; } catch { /* fall back to child */ }
  }
  if (IS_WINDOWS && signal === 'SIGKILL' && typeof pid === 'number' && pid > 0) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch { /* fall back to child */ }
  }
  try { child.kill(signal); } catch { /* already reaped */ }
}

interface CaptureResult { code: number | null; stdout: string; stderr: string; aborted: boolean }

function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: 'spawn failed', aborted: signal.aborted });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, aborted: signal.aborted });
    };
    const onAbort = () => {
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => {
      // DSH is final-only, so stderr is diagnostic evidence rather than a
      // stream. Retain only the bounded tail while the process is running;
      // slicing only when formatting the error would still allow unbounded
      // memory growth during a noisy or long-lived failed turn.
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => { stderr ||= error.message; finish(null); });
    child.once('close', (code) => finish(code));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class DeepSeekHarnessKernel implements AgentKernel {
  readonly id = 'deepseek-harness';
  readonly displayName = DEEPSEEK_HARNESS_DRIVER_LABEL;
  readonly orchestrationProfile = RENTED_KERNEL_PROFILE;
  readonly permissionCapabilities = {
    supported: DEEPSEEK_HARNESS_SUPPORTED_PERMISSION_MODES,
    defaultMode: DEEPSEEK_HARNESS_DEFAULT_PERMISSION_MODE,
  } as const;
  readonly capabilities: KernelCapabilities = {
    streaming: false,
    thinking: false,
    toolCalls: false,
    midTurnInject: false,
    forkExtract: false,
  };

  private binaryPromise?: Promise<string>;
  private static readonly inflight = new Map<string, AbortController>();

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveDeepSeekHarnessBinary());
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // Validate before binary resolution/spawn: unsupported modes must never run DSH.
    let permission: string;
    try {
      permission = toDeepSeekHarnessPermission(req.permissionMode);
    } catch (error) {
      yield { kind: 'turn.usage' };
      yield { kind: 'error', error: { code: 'protocol', message: (error as Error).message } };
      yield { kind: 'turn.done', reason: 'error' };
      return;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
    if (req.callId) DeepSeekHarnessKernel.inflight.set(req.callId, controller);

    try {
      const binary = await this.binary();
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (req.trustTier === 'imported') {
        for (const [key, value] of Object.entries(scrubbedSecretEnv())) {
          if (value === undefined) delete env[key];
          else env[key] = value;
        }
      }
      // Explicitly forward only the DSH fact needed by this turn after scrub.
      env.DSH_PERMISSION_MODE = permission;
      const result = await spawnCapture(
        binary,
        buildDeepSeekHarnessArgs(req),
        defaultProjectRoot(),
        env,
        controller.signal,
      );

      if (result.aborted) {
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'cancelled' };
        return;
      }

      const text = result.stdout.replace(/\r?\n$/, '');
      if (result.code === 0 && text.length > 0 && result.stderr.length === 0) {
        yield { kind: 'message.delta', role: 'assistant', text };
        yield { kind: 'turn.usage' };
        yield { kind: 'turn.done', reason: 'stop' };
        return;
      }

      const detail = safeErrorTail(result.stderr);
      const message = result.code === 0 && !text
        ? 'deepseek-harness completed without a final response'
        : `deepseek-harness exited ${result.code ?? 'spawn-failed'}${detail ? `: ${detail}` : ''}`;
      yield { kind: 'turn.usage' };
      yield { kind: 'error', error: { code: 'protocol', message } };
      yield { kind: 'turn.done', reason: 'error' };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (req.callId) DeepSeekHarnessKernel.inflight.delete(req.callId);
    }
  }

  openHandle(callId: string): TurnHandle {
    const cancel = async () => { DeepSeekHarnessKernel.inflight.get(callId)?.abort(); };
    return {
      async setPermissionMode(_mode: PermissionMode): Promise<void> {
        throw new Error('deepseek-harness does not support changing permission mode mid-turn');
      },
      async setModel(): Promise<void> {
        throw new Error('deepseek-harness model selection is managed by its profile');
      },
      interrupt: cancel,
      cancel,
    };
  }

  async probe(): Promise<KernelHealth> {
    try {
      const binary = await this.binary();
      const resolved = which(binary);
      if (!resolved) {
        return { ok: false, kernelId: this.id, detail: 'dsh binary not on PATH' };
      }
      const result = await runCapture(resolved, ['--version'], { timeoutMs: 10_000, captureStderr: true });
      const detail = (result.stdout || result.stderr).trim().slice(0, 256);
      return result.code === 0
        ? { ok: true, kernelId: this.id, detail: `${resolved}${detail ? ` (${detail})` : ''}` }
        : { ok: false, kernelId: this.id, detail: `dsh --version ${result.timedOut ? 'timed out' : `exit ${result.code ?? 'spawn-failed'}`}` };
    } catch (error) {
      return { ok: false, kernelId: this.id, detail: (error as Error).message };
    }
  }
}
