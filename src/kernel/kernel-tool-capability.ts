import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 2 * 60 * 60_000;
export const CONFORMANCE_KERNEL_TOOL_TTL_MS = 5 * 60_000;
export const CONFORMANCE_KERNEL_TOOL_NAMES = ['ui_snapshot', 'ui_invoke'] as const;

interface KernelToolCapabilityRecord {
  sid: string;
  agentPath: string;
  enabledTools: ReadonlySet<string>;
  expiresAt: number;
}

export interface KernelToolCapabilityBinding {
  sid: string;
  agentPath: string;
}

export interface IssuedKernelToolCapability extends KernelToolCapabilityBinding {
  token: string;
  expiresAt: number;
  revoke(): void;
}

const capabilities = new Map<string, KernelToolCapabilityRecord>();

function pruneExpired(now = Date.now()): void {
  for (const [token, record] of capabilities) {
    if (record.expiresAt <= now) capabilities.delete(token);
  }
}

/** Bind one rented-kernel MCP child to the trusted turn source and tool set. */
export function issueKernelToolCapability(input: {
  sid: string;
  agentPath: string;
  enabledTools: readonly string[];
  ttlMs?: number;
}): IssuedKernelToolCapability | undefined {
  const sid = input.sid.trim();
  const agentPath = input.agentPath.trim();
  const enabledTools = new Set(input.enabledTools.map((name) => name.trim()).filter(Boolean));
  if (!sid || !agentPath || enabledTools.size === 0) return undefined;
  pruneExpired();
  const token = randomBytes(32).toString('base64url');
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_TTL_MS);
  const expiresAt = Date.now() + ttlMs;
  capabilities.set(token, { sid, agentPath, enabledTools, expiresAt });
  return {
    token,
    sid,
    agentPath,
    expiresAt,
    revoke() {
      capabilities.delete(token);
    },
  };
}

export function issueConformanceKernelToolCapability(input: {
  sid: string;
  agentPath: string;
}): IssuedKernelToolCapability | undefined {
  return issueKernelToolCapability({
    ...input,
    enabledTools: CONFORMANCE_KERNEL_TOOL_NAMES,
    ttlMs: CONFORMANCE_KERNEL_TOOL_TTL_MS,
  });
}

/** Verify source and per-turn allowlist before opening a session or writing an attempt. */
export function authorizeKernelToolCapability(
  token: string | undefined,
  sid: string,
  toolName: string,
): KernelToolCapabilityBinding | undefined {
  if (!token) return undefined;
  pruneExpired();
  const record = capabilities.get(token);
  if (!record || record.sid !== sid || !record.enabledTools.has(toolName)) return undefined;
  return { sid: record.sid, agentPath: record.agentPath };
}

export function resetKernelToolCapabilitiesForTests(): void {
  capabilities.clear();
}
