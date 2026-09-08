/**
 * User-selected specialist id carried out-of-band from chat text.
 *
 * This is deliberately only a wire-safety validator. Whether an id is a
 * registered, dispatchable teammate remains the agent_manage kit's existing
 * responsibility at execution time; accepting arbitrary strings here would
 * let prompt-shaped values leak into the dynamic instruction suffix.
 */
export function isValidSummonAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

export function summonAgentDirective(agentId: string): string {
  return [
    '# Summoned specialist',
    `The user summoned \`${agentId}\` for this turn. If the task genuinely needs that specialist, delegate to them (delegate_to_subagent). If it does not, answer yourself and do not mention this note.`,
  ].join('\n');
}
