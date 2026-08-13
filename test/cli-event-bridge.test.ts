import { describe, expect, it } from 'bun:test';
import type { Session } from '../src/core/session';
import { CliEventBridge } from '../src/observatory/cli-event-bridge';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fakeSession(
  events: Array<{ type: string; payload?: Record<string, unknown> }>,
  records: Array<Record<string, unknown>> = [],
  projectRoot = '/tmp',
): Session {
  return {
    eventBus: {
      publish(event: { type: string; payload?: Record<string, unknown> }) {
        events.push(event);
      },
    },
    fileActivity: { append(record: Record<string, unknown>) { records.push(record); } },
    artifactProjectRoot() { return projectRoot; },
  } as unknown as Session;
}

describe('CliEventBridge lifecycle contract', () => {
  it('mirrors AskUserQuestion as durable hook events while keeping stream events', () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const bridge = new CliEventBridge({
      session: fakeSession(events),
      agentPath: 'forge',
      model: 'claude-code',
    });

    bridge.start();
    bridge.forward({
      type: 'tool-call',
      name: 'AskUserQuestion',
      args: { questions: [] },
      callId: 'ask-1',
    });
    bridge.forward({
      type: 'tool-result',
      name: 'AskUserQuestion',
      callId: 'ask-1',
      ok: true,
      result: { ok: true, questions: [{ questionId: 'q1', values: ['A'] }] },
    });
    bridge.end();

    const call = events.find((event) => event.type === 'hook:toolCall');
    const result = events.find((event) => event.type === 'hook:toolResult');
    expect(call?.payload).toMatchObject({
      name: 'ask_user',
      callId: 'ask-1',
      permissionPrompt: true,
      bridgeSource: 'cli-event-bridge',
      toolCall: { id: 'ask-1', name: 'ask_user' },
    });
    expect(result?.payload).toMatchObject({
      name: 'ask_user',
      callId: 'ask-1',
      ok: true,
      bridgeSource: 'cli-event-bridge',
    });
    expect(events.some((event) => event.type === 'stream:tool_use')).toBe(true);
    expect(events.find((event) => event.type === 'stream:tool_use')?.payload).toMatchObject({
      permissionPrompt: true,
    });
    expect(events.some((event) => event.type === 'stream:tool_result')).toBe(true);
  });

  it('attributes cross-kernel file aliases, including rename source and destination', () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const records: Array<Record<string, unknown>> = [];
    const bridge = new CliEventBridge({
      session: fakeSession(events, records),
      agentPath: 'forge',
      model: 'codex',
    });

    bridge.start();
    bridge.forward({
      type: 'tool-call',
      name: 'RenameFile',
      args: { from: '/tmp/a.ts', to: '/tmp/b.ts' },
      callId: 'rename-1',
    });

    expect(records[0]).toMatchObject({
      op: 'rename',
      path: '/tmp/b.ts',
      fromPath: '/tmp/a.ts',
      toolCallId: 'rename-1',
    });
    expect(events.find((event) => event.type === 'hook:toolCall')?.payload).toMatchObject({
      name: 'rename_file',
      rawName: 'RenameFile',
    });
  });

  it('records apply_patch add/update/delete paths and classifies creations', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-cli-bridge-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'existing.md'), 'before\n');
    writeFileSync(join(root, 'docs', 'remove.md'), 'remove\n');
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const records: Array<Record<string, unknown>> = [];
    const bridge = new CliEventBridge({
      session: fakeSession(events, records, root),
      agentPath: 'forge',
      model: 'codex',
    });

    bridge.start();
    bridge.forward({
      type: 'tool-call',
      name: 'ApplyPatch',
      args: { patch: [
        '*** Begin Patch',
        '*** Add File: docs/new.md',
        '+new',
        '*** Update File: docs/existing.md',
        '@@',
        '-before',
        '+after',
        '*** Delete File: docs/remove.md',
        '*** End Patch',
      ].join('\n') },
      callId: 'patch-1',
    });

    expect(records).toHaveLength(3);
    expect(records.map(({ op, path, isCreate }) => ({ op, path, isCreate }))).toEqual([
      { op: 'patch', path: join(root, 'docs', 'new.md'), isCreate: true },
      { op: 'patch', path: join(root, 'docs', 'existing.md'), isCreate: undefined },
      { op: 'patch', path: join(root, 'docs', 'remove.md'), isCreate: undefined },
    ]);
    expect(records.every((record) => record.phase === 'intent')).toBe(true);
  });

  it('records Codex fileChange arrays instead of dropping their project paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-codex-file-change-'));
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const records: Array<Record<string, unknown>> = [];
    const bridge = new CliEventBridge({
      session: fakeSession(events, records, root),
      agentPath: 'forge',
      model: 'codex',
    });

    bridge.start();
    bridge.forward({
      type: 'tool-call',
      name: 'Edit',
      args: { changes: [{ path: 'docs/new.md', kind: 'add' }] },
      callId: 'file-change-1',
    });

    expect(records[0]).toMatchObject({
      op: 'edit',
      path: join(root, 'docs', 'new.md'),
      isCreate: true,
      toolCallId: 'file-change-1',
    });
  });
});
