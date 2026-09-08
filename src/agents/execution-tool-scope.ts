import type { FrozenAgentTemplate } from './template-types';
import { loadNativeSoulOverlay } from '../soul';
import { createAgentToolScope } from './tool-grants';
import { safeSkillToolId } from '../skills/tool-specs';

/** Re-resolve declared soul tools against the same frozen template used by
 * composition. Execution never trusts a caller-supplied list of allowed names. */
export async function executionToolScope(
  template: FrozenAgentTemplate | undefined,
  visibleNames: readonly string[],
  projectRoot: string,
  game?: string,
) {
  const overlay = template
    ? await loadNativeSoulOverlay(template.definition.id, { projectRoot, ...(game ? { game } : {}) })
    : undefined;
  return createAgentToolScope(template?.configuration?.toolGrants, [
    ...visibleNames.flatMap((name) => [name, name.slice(name.lastIndexOf('/') + 1)]),
    ...(overlay?.tools ?? []).map((tool) => tool.name),
    ...(overlay?.skills ?? []).map((skill) => safeSkillToolId(skill.skillId)),
    ...(template?.execution?.skills ?? [])
      .filter((skill) => (skill.executor ?? 'prompt') !== 'prompt')
      .map((skill) => safeSkillToolId(skill.id)),
  ]);
}
