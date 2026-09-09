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
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const keyValue = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!keyValue) continue;
    let value = keyValue[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const separator = value.startsWith('>') ? ' ' : '\n';
      const continuation: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || !lines[index + 1])) {
        continuation.push(lines[++index].trim());
      }
      value = continuation.join(separator).trim();
    }
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
