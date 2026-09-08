/** Cross-kernel tool aliases → the forgeax-cli builtin snake_case name. */
const ALIASES: Record<string, string> = {
  TodoWrite: 'todo_write',
  update_plan: 'todo_write',
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

/** Normalize source-specific arguments only where the canonical UI contract
 * differs structurally. Codex `update_plan` calls use `plan[].step`; the
 * ForgeaX task-flow contract uses `todos[].content`. */
export function canonicalToolArgs(rawName: string, args: unknown): unknown {
  const bareName = rawName.replace(/^(mcp__fxt__|fxt__)/, '');
  if (bareName !== 'update_plan' || !args || typeof args !== 'object') return args;
  const plan = (args as { plan?: unknown }).plan;
  if (!Array.isArray(plan)) return args;
  return {
    todos: plan.map((entry, index) => {
      const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      return {
        id: typeof row.id === 'string' && row.id.trim() ? row.id : `step-${index + 1}`,
        content: typeof row.step === 'string' ? row.step : '',
        status: row.status === 'in_progress' || row.status === 'completed' ? row.status : 'pending',
      };
    }),
  };
}
