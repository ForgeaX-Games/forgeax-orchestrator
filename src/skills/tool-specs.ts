import type { ToolSpec } from '@forgeax/agent-runtime';
import { getExtensionSnapshot } from '../extensions/registry';

export function safeSkillToolId(skillId: string): string {
  return `skill_${skillId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function textOf(value: string | { zh?: string; en?: string; ja?: string }): string {
  return typeof value === 'string' ? value : value.en || value.zh || value.ja || '';
}

/** Neutral ToolSpecs for extension skills that the host bridge can execute. */
export function skillToolSpecs(): ToolSpec[] {
  return getExtensionSnapshot().kinds.skills.map((skill) => ({
    name: safeSkillToolId(skill.definition.id),
    description: textOf(skill.definition.description) || `Invoke skill ${skill.definition.id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'object' },
        extensionId: { type: 'string' },
      },
    },
  }));
}
