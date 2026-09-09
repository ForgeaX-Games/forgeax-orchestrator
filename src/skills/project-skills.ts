import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionSkillRoot } from '../orchestration-seams';
import { parseSkillFrontmatter } from '../agents/skill-frontmatter';

export const PROJECT_SKILL_SOURCE = 'project';

export function readProjectSkills(root?: string) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(root, entry.name, 'SKILL.md');
      if (!existsSync(path)) return [];
      const parsed = parseSkillFrontmatter(readFileSync(path, 'utf8'));
      return [{
        id: entry.name, extensionId: PROJECT_SKILL_SOURCE, kind: 'prompt' as const,
        triggers: [{ kind: 'slash' as const, command: entry.name }], requiresTools: [],
        displayName: parsed.name || entry.name, description: parsed.description || '',
        text: `Skill directory: ${join(root, entry.name)}\nResolve referenced files relative to this directory.\n\n${parsed.body}`,
      }];
    });
}

export function sessionProjectSkills(sessionId?: string) {
  return readProjectSkills(getSessionSkillRoot(sessionId));
}
