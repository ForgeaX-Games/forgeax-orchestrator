import type { ToolSpec } from '@forgeax/agent-runtime';
import { listSkills } from './runner';

export function safeSkillToolId(skillId: string): string {
  return `skill_${skillId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function textOf(value: string | { zh?: string; en?: string; ja?: string }): string {
  return typeof value === 'string' ? value : value.en || value.zh || value.ja || '';
}

/** Neutral ToolSpecs for extension skills that the host bridge can execute. */
export function skillToolSpecs(excludeSkillIds?: ReadonlySet<string>, sessionId?: string): ToolSpec[] {
  // Prompt skills are materialized into the agent's system prompt by the
  // template composer. A resident agent's prompt skills are therefore
  // excluded by id at the composition seam; unrelated global prompt skills
  // remain available to legacy callers that have no resident template.
  const groups = new Map<string, ReturnType<typeof listSkills>>();
  for (const skill of listSkills(sessionId)) {
    if (excludeSkillIds?.has(skill.id)) continue;
    const name = safeSkillToolId(skill.id);
    groups.set(name, [...(groups.get(name) ?? []), skill]);
  }
  return [...groups].map(([name, skills]) => {
    const sources = [...new Set(skills.map((skill) => skill.extensionId))];
    const ambiguous = skills.length > 1;
    return {
      name,
      description: skills.map((skill) =>
        `${ambiguous ? `[${skill.extensionId}] ` : ''}${textOf(skill.description) || `Invoke skill ${skill.id}.`}`,
      ).join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'object' },
          ...(ambiguous ? {
            extensionId: { type: 'string', enum: sources, description: 'Choose the installed source listed here, not the skill id.' },
          } : {}),
        },
        ...(ambiguous ? { required: ['extensionId'] } : {}),
        additionalProperties: false,
      },
    };
  });
}
