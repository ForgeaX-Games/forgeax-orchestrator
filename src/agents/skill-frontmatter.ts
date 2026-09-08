/** Parse the minimal agentskills.io frontmatter used by prompt skills. */
export function parseSkillFrontmatter(raw: string): {
  body: string;
  name?: string;
  description?: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: raw };
  const body = raw.slice(match[0].length);
  let name: string | undefined;
  let description: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!keyValue) continue;
    let value = keyValue[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (keyValue[1] === "name") name = value;
    else description = value;
  }
  return { body, name, description };
}
