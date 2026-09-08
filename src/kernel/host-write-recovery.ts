/** Compatibility recovery for legacy Studio host-owned write_file calls. */

export type HostToolExecutor = (
  name: string,
  args: unknown,
  sid?: string,
  agentId?: string,
  callId?: string,
  turnCallId?: string,
) => Promise<unknown>;

/**
 * Legacy Studio host `write_file` accepts at most 12,000 JS characters per
 * call and exposes append semantics. The native CLI write tool has no such
 * limit, but Studio intentionally keeps this tool host-owned so its project
 * and ownership gates remain authoritative. Recover at this kernel/host
 * boundary instead of leaking the legacy limit back to the model.
 */
export const HOST_WRITE_FILE_CHUNK_CHARS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Split only the legacy host-shaped write_file call, preserving Unicode code points. */
export function chunkHostWriteFileArgs(
  name: string,
  args: unknown,
  maxChars = HOST_WRITE_FILE_CHUNK_CHARS,
): unknown[] {
  if (
    name !== 'write_file' ||
    !isRecord(args) ||
    typeof args.path !== 'string' ||
    typeof args.content !== 'string' ||
    args.content.length <= maxChars
  ) {
    return [args];
  }
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`invalid host write_file chunk size: ${maxChars}`);
  }

  const chunks: string[] = [];
  let current = '';
  // Iterate by code point so a boundary cannot write an unpaired UTF-16
  // surrogate when the content contains an emoji or another astral character.
  for (const codePoint of args.content) {
    if (current && current.length + codePoint.length > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += codePoint;
  }
  if (current) chunks.push(current);

  return chunks.map((content, index) => ({
    ...args,
    content,
    ...(index > 0 ? { append: true } : {}),
  }));
}

function hostResultText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
}

/** Execute a host tool, recovering oversized legacy write_file calls. */
export async function executeHostToolWithWriteRecovery(
  hostBridge: HostToolExecutor,
  name: string,
  args: unknown,
  sid?: string,
  agentId?: string,
  callId?: string,
  turnCallId?: string,
): Promise<unknown> {
  const calls = chunkHostWriteFileArgs(name, args);
  if (calls.length === 1) return hostBridge(name, args, sid, agentId, callId, turnCallId);

  const results: unknown[] = [];
  for (const callArgs of calls) {
    results.push(await hostBridge(name, callArgs, sid, agentId, callId, turnCallId));
  }
  // One model call still emits one kernel result; retain every host
  // acknowledgement so the model can see that the full file was committed.
  return results.map(hostResultText).join('\n');
}
