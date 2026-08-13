/** Cross-kernel tool aliases → the forgeax-cli builtin snake_case name. */
const ALIASES: Record<string, string> = {
  TodoWrite: 'todo_write',
  AskUserQuestion: 'ask_user',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'multi_edit',
  NotebookEdit: 'notebook_edit',
  WriteFile: 'write_file',
  EditFile: 'edit_file',
  Delete: 'delete_file',
  DeleteFile: 'delete_file',
  Rename: 'rename_file',
  RenameFile: 'rename_file',
  Move: 'move_file',
  MoveFile: 'move_file',
  Bash: 'bash',
  Shell: 'bash',
  shell: 'bash',
  ApplyPatch: 'apply_patch',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'subagent',
};

export function canonicalToolName(raw: string): string {
  const bare = raw.replace(/^(mcp__fxt__|fxt__)/, '');
  return ALIASES[bare] ?? bare;
}

/** Return the canonical name and retain the source name when it changed. */
export function canonicalToolFields(rawName: string): { name: string; rawName?: string } {
  const name = canonicalToolName(rawName);
  return name === rawName ? { name } : { name, rawName };
}
