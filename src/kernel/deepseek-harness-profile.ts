import type { PermissionMode, TurnRequest } from '@forgeax/agent-runtime';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';

export const DEEPSEEK_HARNESS_DRIVER_LABEL = 'DeepSeek Harness';
export const DEEPSEEK_HARNESS_SUPPORTED_PERMISSION_MODES = [
  'autoEdits',
  'unrestricted',
] as const satisfies readonly PermissionMode[];
export const DEEPSEEK_HARNESS_DEFAULT_PERMISSION_MODE: PermissionMode = 'autoEdits';

const DSH_PERMISSION_BY_MODE: Partial<Record<PermissionMode, string>> = {
  autoEdits: 'workspace-write',
  unrestricted: 'danger-full-access',
};

export function toDeepSeekHarnessPermission(mode?: PermissionMode): string {
  const requested = mode ?? DEEPSEEK_HARNESS_DEFAULT_PERMISSION_MODE;
  const mapped = DSH_PERMISSION_BY_MODE[requested];
  if (!mapped) {
    throw new Error(
      `deepseek-harness does not support permission mode "${requested}"; supported modes: autoEdits, unrestricted`,
    );
  }
  return mapped;
}

/** Resolve only public operator entry points, in documented precedence order. */
export async function resolveDeepSeekHarnessBinary(): Promise<string> {
  const primary = process.env.DEEPSEEK_HARNESS_CLI_PATH?.trim();
  if (primary) return primary;
  const alias = process.env.DSH_CLI_PATH?.trim();
  if (alias) return alias;
  return resolveBinary({ envVarName: 'DEEPSEEK_HARNESS_CLI_PATH', defaultBinary: 'dsh' });
}

/**
 * DSH headless has no separate system-prompt or history channel. Compose one
 * deterministic job while preserving the host's authoritative-history suffix
 * as prior context, after the current task, exactly as other rented kernels do.
 */
export function composeDeepSeekHarnessTask(req: TurnRequest): string {
  const sp = req.systemPrompt;
  const instructions = sp.persona?.trim()
    ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
    : sp.charter;
  const task = sp.dynamicSuffix?.trim()
    ? `${req.input.text}\n\n${sp.dynamicSuffix.trim()}`
    : req.input.text;
  return `${instructions}\n\n---\n\n## Current task\n\n${task}`;
}

export function buildDeepSeekHarnessArgs(req: TurnRequest): string[] {
  return ['--profile', 'headless', composeDeepSeekHarnessTask(req)];
}
