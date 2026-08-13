/** Host-side mutation evidence for tools executed locally by a rented kernel.
 *
 * Local-capable tools run inside the kernel process, so they bypass the
 * orchestrator AgentFs recorder. Capture the target before execution and turn
 * it into an applied FileActivityRecord only after a successful tool result. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { FileActivityOp, FileActivityRecord } from '../ledger/file-activity-ledger';
import { canonicalToolName } from './canonical-tool-name';

export interface KernelMutationIntent {
  path: string;
  op: FileActivityOp;
  existedBefore: boolean;
}

const MUTATION_OPS: Record<string, FileActivityOp> = {
  write_file: 'write',
  edit_file: 'edit',
  multi_edit: 'edit',
  apply_patch: 'patch',
  delete_file: 'delete',
  rename_file: 'rename',
  move_file: 'rename',
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pathValues(args: unknown, name: string): string[] {
  const object = asObject(args);
  if (!object) return [];
  if (name === 'apply_patch') {
    const patch = typeof object.patch === 'string' ? object.patch : typeof object.input === 'string' ? object.input : '';
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)].map((match) => match[1]!);
  }
  if (name === 'multi_edit') {
    const edits = Array.isArray(object.edits) ? object.edits : Array.isArray(object.changes) ? object.changes : [];
    return edits.flatMap((edit) => pathValues(edit, 'edit_file'));
  }
  // Codex app-server exposes a batched edit_file shape even for one file:
  // { changes: [{ path, kind, diff }] }. Derive every mutation target.
  if (name === 'edit_file' && Array.isArray(object.changes)) {
    return object.changes.flatMap((change) => pathValues(change, 'edit_file'));
  }
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'target', 'destination', 'to']) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return [value];
  }
  return [];
}

function hashFile(path: string): string | undefined {
  try {
    if (statSync(path).size > 1024 * 1024) return undefined;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

export function captureKernelMutationIntents(
  rawName: string,
  args: unknown,
  projectRoot: string,
): KernelMutationIntent[] {
  const name = canonicalToolName(rawName);
  const op = MUTATION_OPS[name];
  if (!op) return [];
  const unique = new Set<string>();
  return pathValues(args, name).flatMap((candidate): KernelMutationIntent[] => {
    const path = isAbsolute(candidate) ? resolve(candidate) : resolve(projectRoot, candidate);
    if (unique.has(path)) return [];
    unique.add(path);
    return [{ path, op, existedBefore: existsSync(path) }];
  });
}

export function appliedKernelMutationRecords(
  intents: readonly KernelMutationIntent[],
  options: { agentPath: string; toolCallId: string; turnId?: string; ts?: number },
): FileActivityRecord[] {
  return intents.map((intent) => {
    const existsAfter = existsSync(intent.path);
    const hash = existsAfter ? hashFile(intent.path) : undefined;
    return {
      ts: options.ts ?? Date.now(),
      agentPath: options.agentPath,
      op: intent.op,
      path: intent.path,
      ...(!intent.existedBefore && existsAfter ? { isCreate: true } : {}),
      ...(intent.op === 'delete' && !existsAfter ? { deleted: true } : {}),
      ...(hash ? { hash } : {}),
      toolCallId: options.toolCallId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      phase: 'applied',
    };
  });
}
