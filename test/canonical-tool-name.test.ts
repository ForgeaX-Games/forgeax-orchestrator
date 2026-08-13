import { describe, expect, test } from 'bun:test';
import { canonicalToolFields, canonicalToolName } from '../src/kernel/canonical-tool-name';

describe('canonicalToolName', () => {
  test.each([
    ['TodoWrite', 'todo_write'],
    ['AskUserQuestion', 'ask_user'],
    ['Read', 'read_file'],
    ['Write', 'write_file'],
    ['Edit', 'edit_file'],
    ['MultiEdit', 'multi_edit'],
    ['NotebookEdit', 'notebook_edit'],
    ['WriteFile', 'write_file'],
    ['EditFile', 'edit_file'],
    ['Delete', 'delete_file'],
    ['DeleteFile', 'delete_file'],
    ['Rename', 'rename_file'],
    ['RenameFile', 'rename_file'],
    ['Move', 'move_file'],
    ['MoveFile', 'move_file'],
    ['Bash', 'bash'],
    ['Shell', 'bash'],
    ['shell', 'bash'],
    ['ApplyPatch', 'apply_patch'],
    ['Grep', 'grep'],
    ['Glob', 'glob'],
    ['Task', 'subagent'],
  ])('%s → %s', (rawName, expected) => {
    expect(canonicalToolName(rawName)).toBe(expected);
  });

  test('passes through canonical and unknown names', () => {
    expect(canonicalToolName('todo_write')).toBe('todo_write');
    expect(canonicalToolName('mcp__fxt__todo_write')).toBe('todo_write');
    expect(canonicalToolName('mcp__fxt__deliver_summary')).toBe('deliver_summary');
    expect(canonicalToolName('mcp__fxt__list_games')).toBe('list_games');
    expect(canonicalToolName('fxt__deliver_summary')).toBe('deliver_summary');
    expect(canonicalToolName('mcp__other__foo')).toBe('mcp__other__foo');
  });

  test('retains the raw alias only when normalization changes it', () => {
    expect(canonicalToolFields('TodoWrite')).toEqual({ name: 'todo_write', rawName: 'TodoWrite' });
    expect(canonicalToolFields('todo_write')).toEqual({ name: 'todo_write' });
  });
});
