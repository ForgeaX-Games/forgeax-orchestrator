import { runSkill, listSkills, type SkillRunRequest, type SkillRunResult } from './runner';
import { safeSkillToolId } from './tool-specs';

function resultToToolResult(result: SkillRunResult): { ok: true; result: unknown } | { ok: false; error: string; code: string } {
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return { ok: true, result: result.kind === 'prompt' ? { text: result.text } : result.result };
}

/** Execute a skill exposed as a neutral kernel tool. */
export async function runSkillKernelTool(
  toolName: string,
  args: unknown,
  caller: SkillRunRequest['caller'],
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code: string }> {
  const candidates = listSkills(caller.sessionId).filter((candidate) => safeSkillToolId(candidate.id) === toolName);
  if (!candidates.length) return { ok: false, error: `skill tool not found: ${toolName}`, code: 'not_found' };
  const input = args && typeof args === 'object' && 'input' in args
    ? (args as { input?: unknown }).input
    : args;
  const extensionId = args && typeof args === 'object' && typeof (args as { extensionId?: unknown }).extensionId === 'string'
    ? (args as { extensionId: string }).extensionId
    : undefined;
  // A unique tool already binds its source. Older callers may still send an
  // extensionId; never let it redirect a resolved tool to another source.
  // Re-read the current session catalog so installs/removals fail closed.
  const matching = candidates.length === 1 ? candidates : candidates.filter((candidate) => candidate.extensionId === extensionId);
  if (matching.length !== 1) return {
    ok: false,
    code: 'ambiguous_skill',
    error: `Choose an installed source for ${toolName}: ${[...new Set(candidates.map((candidate) => candidate.extensionId))].join(', ')}. Refresh the skill catalog if no unique source is available.`,
  };
  const skill = matching[0]!;
  const result = await runSkill({
    skillId: skill.id,
    extensionId: skill.extensionId,
    input,
    caller,
  });
  return resultToToolResult(result);
}
