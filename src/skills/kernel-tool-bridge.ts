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
  const skill = listSkills().find((candidate) => safeSkillToolId(candidate.id) === toolName);
  if (!skill) return { ok: false, error: `skill tool not found: ${toolName}`, code: 'not_found' };
  const input = args && typeof args === 'object' && 'input' in args
    ? (args as { input?: unknown }).input
    : args;
  const extensionId = args && typeof args === 'object' && typeof (args as { extensionId?: unknown }).extensionId === 'string'
    ? (args as { extensionId: string }).extensionId
    : undefined;
  const result = await runSkill({
    skillId: skill.id,
    ...(extensionId ? { extensionId } : {}),
    input,
    caller,
  });
  return resultToToolResult(result);
}
