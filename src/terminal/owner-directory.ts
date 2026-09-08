import { createHash } from 'node:crypto';

/** Cache identity, not a display name. Preserve the complete owner identity
 * without unsafe characters, case-folding aliases or unbounded path length. */
export function terminalOwnerDirectory(agentId: string): string {
  return `agent-${createHash('sha256').update(agentId).digest('hex')}`;
}
