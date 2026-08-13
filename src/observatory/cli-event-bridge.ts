/** Bridge `cli-providers` ChatEvent stream → per-session `EventBus`.
 *
 *  Why: claude-code (and any future external CLI provider) yields
 *  ChatEvent through `/api/cli/chat` SSE only. The observatory wants
 *  to draw turn / tool / token timelines and replay them from the
 *  ledger — that requires the same events to land in
 *  `session.eventBus` so `_bindLedgerPersistence` writes them to
 *  `~/.forgeax/sessions/<sid>/agents/<agent>/events/events-*.jsonl`.
 *
 *  Lifecycle (one helper instance per `chat()` call):
 *    1. `start(model)` publishes `hook:turnStart`
 *    2. `forwardChatEvent(ev)` translates each ChatEvent (accumulating
 *       token text, batching `stream:tool_use` etc.) and publishes.
 *    3. `end(stopReason, durationMs?)` emits any pending assistant
 *       message text + `hook:turnEnd` and resolves.
 *
 *  We use `emitterId = agentPath` so per-agent ledger persistence
 *  routes correctly. Without an emitterId, `bindSystemEventLog`
 *  treats the events as session-broadcasts and writes them to
 *  `global-events.jsonl` instead (the wrong place for turn data).
 */

import type { Session } from '../core/session';
import type { ChatEvent } from '../cli-providers/types';
import type { FileActivityOp, FileActivityRecord } from '../ledger/file-activity-ledger';
import { canonicalToolName } from '../kernel/canonical-tool-name';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Tools (across all cli providers we currently bridge — claude-code today,
 *  codex/gemini in the future) that mutate a single file. Mapped to the
 *  ledger's FileActivityOp so AgentsPanel renders a sensible op badge. */
const FILE_TOOL_OPS: Record<string, FileActivityOp> = {
  write_file: 'write',
  edit_file: 'edit',
  multi_edit: 'edit',
  notebook_edit: 'edit',
  delete_file: 'delete',
  rename_file: 'rename',
  move_file: 'rename',
  apply_patch: 'patch',
};

interface MutationPath {
  path: string;
  fromPath?: string;
  expectedDelete?: boolean;
  existedBefore?: boolean;
}

const DESTINATION_KEYS = [
  'file_path',
  'filePath',
  'notebook_path',
  'path',
  'filename',
  'target',
  'destination',
  'destinationPath',
  'destination_path',
  'to',
  'toPath',
  'to_path',
  'newPath',
  'new_path',
] as const;

const SOURCE_KEYS = [
  'from',
  'fromPath',
  'from_path',
  'oldPath',
  'old_path',
  'source',
  'sourcePath',
  'source_path',
] as const;

function firstString(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Pull file paths out of the cross-kernel mutation contracts. Providers use
 * both Claude-style `file_path` and generic rename/move `{from,to}` shapes;
 * keeping this normalization here ensures the CLI bridge feeds the same
 * file-activity ledger as native agent-fs writes. */
function extractToolFilePaths(args: unknown, toolName: string): MutationPath[] {
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  if (toolName === 'apply_patch') {
    const patch = typeof a.patch === 'string' ? a.patch
      : typeof a.input === 'string' ? a.input
        : undefined;
    if (!patch) return [];
    const paths: MutationPath[] = [];
    for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/gm)) {
      const action = match[1];
      const source = match[2]!;
      if (action === 'Update') {
        const tail = patch.slice(match.index! + match[0].length);
        const move = tail.match(/^\r?\n\*\*\* Move to:\s*(.+?)\s*$/m);
        if (move) {
          paths.push({ path: move[1]!, fromPath: source });
          continue;
        }
      }
      paths.push({ path: source, ...(action === 'Delete' ? { expectedDelete: true } : {}) });
    }
    return paths;
  }
  if (toolName === 'multi_edit' && Array.isArray(a.edits)) {
    const paths: MutationPath[] = [];
    for (const edit of a.edits) {
      for (const item of extractToolFilePaths(edit, 'edit_file')) {
        if (!paths.some((candidate) => candidate.path === item.path)) paths.push(item);
      }
    }
    return paths;
  }
  const path = firstString(a, DESTINATION_KEYS);
  if (path) {
    const fromPath = FILE_TOOL_OPS[toolName] === 'rename' ? firstString(a, SOURCE_KEYS) : undefined;
    return [{ path, ...(fromPath && fromPath !== path ? { fromPath } : {}) }];
  }

  // Codex app-server reports one fileChange item as Edit({ changes: [...] }).
  // Keep the traversal deliberately narrow: only known mutation collections
  // are visited, so arbitrary tool prose cannot be mistaken for file paths.
  const nested = [a.changes, a.fileChanges, a.files, a.edits, a.operations];
  const paths: MutationPath[] = [];
  for (const collection of nested) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const nestedPath = firstString(item, DESTINATION_KEYS);
      if (!nestedPath) continue;
      const kind = String(item.kind ?? item.type ?? item.change ?? item.status ?? '').toLowerCase();
      const fromPath = firstString(item, SOURCE_KEYS);
      paths.push({
        path: nestedPath,
        ...(fromPath && fromPath !== nestedPath ? { fromPath } : {}),
        ...(/delete|remove/.test(kind) ? { expectedDelete: true } : {}),
      });
    }
  }
  return paths;
}

export interface CliBridgeOptions {
  session: Session;
  /** agent-tree path inside the session (eg "forge", "iori/suzu"). */
  agentPath: string;
  /** Model name surfaced in `hook:turnStart`. */
  model: string;
  /** User message that opened this legacy-provider turn. */
  message?: string;
  /** Server-owned checkpoint identity for the user message starting this turn. */
  msgId?: string;
}

export class CliEventBridge {
  private session: Session;
  private agentPath: string;
  private model: string;
  private message?: string;
  private msgId?: string;

  /** Accumulator for `token` events — claude-code-mapper streams text by
   *  small chunks; we collapse into one `hook:assistantMessage` at done. */
  private tokenBuffer = '';
  private startedAt = 0;
  private turnIndex = 0;
  private turnId = '';
  private readonly mutationCalls = new Map<string, Array<MutationPath & { op: FileActivityOp }>>();

  constructor(opts: CliBridgeOptions) {
    this.session = opts.session;
    this.agentPath = opts.agentPath;
    this.model = opts.model;
    this.message = opts.message;
    this.msgId = opts.msgId;
  }

  start(): void {
    this.startedAt = Date.now();
    this.turnIndex++;
    this.turnId = randomUUID();
    if (this.message) {
      this.session.eventBus.publish(
        {
          type: 'user_input',
          ts: this.startedAt,
          source: 'user',
          to: this.agentPath,
          handoff: 'turn',
          payload: {
            content: this.message,
            ...(this.msgId ? { msgId: this.msgId } : {}),
          },
        },
        this.agentPath,
      );
    }
    this.session.eventBus.publish(
      {
        type: 'hook:turnStart',
        ts: this.startedAt,
        source: `agent:${this.agentPath}`,
        payload: {
          model: this.model,
          turn: this.turnIndex,
          turnId: this.turnId,
          artifactResolutionExpected: true,
          schemaVersion: 2,
          ...(this.msgId ? { msgId: this.msgId } : {}),
        },
      },
      this.agentPath,
    );
  }

  forward(ev: ChatEvent): void {
    switch (ev.type) {
      case 'token':
        this.tokenBuffer += ev.text;
        // R1-b(多 tab 同步方案 §9):token 同时转发为 stream:llm text chunk,
        // 旁观 tab 才能逐字直播(stream:* 不落 WAL,_bindLedgerPersistence 跳过)。
        // 发送 tab 的 SSE 已渲染同一份文本,由前端 cli-SSE-active 标志去重。
        this.session.eventBus.publish(
          {
            type: 'stream:llm',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: { chunk: { type: 'text', text: ev.text }, turn: this.turnIndex },
          },
          this.agentPath,
        );
        return;

      case 'thinking':
        this.session.eventBus.publish(
          {
            type: 'agent_log',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: {
              level: 'info',
              subtype: 'thinking',
              content: ev.text,
              visibility: ev.visibility ?? 'private_reasoning',
            },
          },
          this.agentPath,
        );
        return;

      case 'tool-call': {
        this.flushAssistantText();
        const canonicalName = canonicalToolName(ev.name);
        this.session.eventBus.publish(
          {
            type: 'stream:tool_use',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: {
              toolUseId: ev.callId,
              name: canonicalName,
              ...(canonicalName !== ev.name ? { rawName: ev.name } : {}),
              input: ev.args,
              ...(canonicalName === 'ask_user' ? { permissionPrompt: true } : {}),
              bridgeSource: 'cli-event-bridge',
            },
          },
          this.agentPath,
        );
        // `stream:*` is transient. Mirror the same call into the durable hook
        // contract so the host can track AskUserQuestion waits, persist the
        // tool for replay, and attribute file effects consistently.
        this.session.eventBus.publish(
          {
            type: 'hook:toolCall',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: {
              name: canonicalName,
              ...(canonicalName !== ev.name ? { rawName: ev.name } : {}),
              args: ev.args,
              callId: ev.callId,
              toolCall: { id: ev.callId, name: canonicalName, arguments: ev.args },
              turnId: this.turnId,
              ...(canonicalName === 'ask_user' ? { permissionPrompt: true } : {}),
              bridgeSource: 'cli-event-bridge',
            },
          },
          this.agentPath,
        );
        this.recordFileActivity(canonicalName, ev.args, ev.callId);
        return;
      }

      case 'tool-result':
        this.session.eventBus.publish(
          {
            type: 'stream:tool_result',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: {
              toolUseId: ev.callId,
              output: ev.ok ? (ev.result ?? '') : (ev.error ?? ''),
              isError: !ev.ok,
              bridgeSource: 'cli-event-bridge',
            },
          },
          this.agentPath,
        );
        this.session.eventBus.publish(
          {
            type: 'hook:toolResult',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: {
              ...(ev.name ? { name: canonicalToolName(ev.name) } : {}),
              ...(ev.name && canonicalToolName(ev.name) !== ev.name ? { rawName: ev.name } : {}),
              callId: ev.callId,
              ok: ev.ok,
              ...(ev.result !== undefined ? { result: ev.result } : {}),
              ...(ev.error ? { error: ev.error } : {}),
              turnId: this.turnId,
              bridgeSource: 'cli-event-bridge',
            },
          },
          this.agentPath,
        );
        this.recordFileActivityResult(ev.callId, ev.ok);
        return;

      case 'error':
        this.session.eventBus.publish(
          {
            type: 'agent_log',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: { level: 'error', content: ev.message, code: ev.code },
          },
          this.agentPath,
        );
        return;

      // 'done' is handled via end(); 'stored-event' is forgeax-native
      // path only, already publishes through Session itself.
      case 'done':
      case 'stored-event':
        return;
    }
  }

  end(
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' = 'end_turn',
    durationMs?: number,
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): void {
    // Flush the accumulated assistant text *with* usage so the observatory
    // adapter's hook:assistantMessage → text branch can surface
    // `payload.usage` for the turn node. Without this the per-turn token
    // counts stay at 0 (the previous bridge dropped usage entirely).
    this.flushAssistantText(usage);
    const ts = Date.now();
    const elapsed = durationMs ?? (this.startedAt > 0 ? ts - this.startedAt : 0);
    this.session.eventBus.publish(
      {
        type: 'hook:turnEnd',
        ts,
        source: `agent:${this.agentPath}`,
        payload: {
          model: this.model,
          turn: this.turnIndex,
          turnId: this.turnId,
          artifactResolutionExpected: true,
          schemaVersion: 2,
          ...(this.msgId ? { msgId: this.msgId } : {}),
          stopReason,
          durationMs: elapsed,
          aborted: stopReason === 'cancelled',
          ...(usage ? { usage } : {}),
        },
      },
      this.agentPath,
    );
  }

  /** Bridge file-mutating tool calls into the per-session file-activity ledger.
   *  cli-provider agents (claude-code today) execute Write/Edit/NotebookEdit
   *  inside their own subprocess and never touch agentContext.fs, so the
   *  wrapAgentFsWithRecorder hook that normally feeds the ledger doesn't
   *  fire. Without this bridge AgentsPanel (which attributes files via the
   *  ledger when ?sid= is supplied) shows empty files[] for them. */
  private recordFileActivity(name: string, args: unknown, callId: string): void {
    const canonicalName = canonicalToolName(name);
    const op = FILE_TOOL_OPS[canonicalName];
    if (!op) return;
    const root = this.session.artifactProjectRoot();
    const paths = extractToolFilePaths(args, canonicalName).map((mutation) => {
      const path = isAbsolute(mutation.path) ? resolve(mutation.path) : resolve(root, mutation.path);
      const fromPath = mutation.fromPath
        ? (isAbsolute(mutation.fromPath) ? resolve(mutation.fromPath) : resolve(root, mutation.fromPath))
        : undefined;
      return {
        ...mutation,
        path,
        ...(fromPath ? { fromPath } : {}),
        existedBefore: existsSync(path),
      };
    });
    if (paths.length === 0) return;
    const mutations = paths.map((mutation) => ({ ...mutation, op }));
    this.mutationCalls.set(callId, mutations);
    for (const mutation of mutations) {
      const ts = Date.now();
      const record: FileActivityRecord = {
        ts,
        agentPath: this.agentPath,
        op,
        path: mutation.path,
        ...(mutation.fromPath ? { fromPath: mutation.fromPath } : {}),
        ...(!mutation.existedBefore && !mutation.expectedDelete ? { isCreate: true } : {}),
        toolCallId: callId,
        turnId: this.turnId,
        phase: 'intent',
      };
      try {
        this.session.fileActivity.append(record);
      } catch {
        /* ledger write must never abort event forwarding */
      }
      // Publish file-activity:done so the WS bridge wakes up
      // useFileActivityVersion(sid) on the client and AgentsPanel refetches.
      // Shape mirrors session-manager.ts's recorder hook (the canonical emitter
      // for native fs writes) so a single dispatcher on the client handles both.
      this.session.eventBus.publish(
        {
          type: 'file-activity:done',
          ts,
          source: `agent:${this.agentPath}`,
          payload: record as unknown as Record<string, unknown>,
        },
        this.agentPath,
      );
    }
  }

  /** External CLI tools write outside the host fs wrapper. Once their result
   * arrives, append a compact post-write fingerprint so artifact derivation
   * can reject same-path concurrent edits without broadcasting a duplicate UI
   * file-touch row. */
  private recordFileActivityResult(callId: string, ok: boolean): void {
    if (!ok) return;
    const mutations = this.mutationCalls.get(callId);
    if (!mutations) return;
    this.mutationCalls.delete(callId);
    for (const mutation of mutations) {
      const record: FileActivityRecord = {
        ts: Date.now(),
        agentPath: this.agentPath,
        op: mutation.op,
        path: mutation.path,
        ...(mutation.fromPath ? { fromPath: mutation.fromPath } : {}),
        ...(!mutation.existedBefore && !mutation.expectedDelete ? { isCreate: true } : {}),
        toolCallId: callId,
        turnId: this.turnId,
        phase: 'applied',
      };
      if (!existsSync(mutation.path)) {
        if (mutation.op === 'delete' || mutation.expectedDelete) record.deleted = true;
      } else {
        try {
          const bytes = readFileSync(mutation.path);
          if (bytes.byteLength <= 1 * 1024 * 1024) {
            record.hash = createHash('sha256').update(bytes).digest('hex');
          }
        } catch {
          continue;
        }
      }
      try { this.session.fileActivity.append(record); } catch { /* best effort */ }
    }
  }

  private flushAssistantText(usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    const text = this.tokenBuffer;
    if (!text && !usage) return;
    this.tokenBuffer = '';
    this.session.eventBus.publish(
      {
        type: 'hook:assistantMessage',
        ts: Date.now(),
        source: `agent:${this.agentPath}`,
        payload: {
          msg: { content: text },
          ...(usage ? { usage } : {}),
        },
      },
      this.agentPath,
    );
  }
}
