import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { initSessionManager, resetSessionManager, getSessionManager } from '../src/core/session-manager';
import { NATIVE_KERNEL_PROFILE } from '../src/kernel/kernel-profile';
import { prepareUserAttachmentPayload } from '../src/message/materialize-user-attachments';
import { eventToSessionMessage } from '../src/message/message-ingress';
import { adapt, createAdapterState } from '../src/observatory/event-adapter';

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fx-native-attachment-ledger-'));
  resetPathManager();
  await resetSessionManager();
  initSessionManager(initPathManager({ userRoot: root }));
});
afterEach(async () => {
  await resetSessionManager();
  resetPathManager();
  rmSync(root, { recursive: true, force: true });
});

describe('native EventBus attachment persistence', () => {
  test('WAL has no base64, model context has durable path, UI derives one original bubble', async () => {
    const manager = getSessionManager();
    const created = await manager.create({ displayName: 'native-ingress' });
    const sid = created.sid;
    await manager.close(sid);
    const layer = (await import('../src/fs/path-manager')).getPathManager().session(sid).agent('forge');
    mkdirSync(layer.root(), { recursive: true });
    writeFileSync(layer.agentJson(), '{}\n');
    const session = await manager.open(sid);
    const payload = prepareUserAttachmentPayload({
      content: 'inspect this',
      payload: {
        attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' }],
      },
      uploadDir: join(session.paths.root(), 'uploads'),
      nativeAttachmentKinds: NATIVE_KERNEL_PROFILE.nativeAttachmentKinds,
    });
    session.eventBus.emit({
      source: 'user', type: 'user_input', payload, to: 'forge', handoff: 'turn', ts: Date.now(),
    });

    const events = await session.getOrCreateLedger('forge').readAllEvents();
    expect(events.filter((e) => e.type === 'user_input')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('QUJD');
    const stored = events[0]!;
    expect(stored.payload?.content).toBe('inspect this');
    expect(stored.payload?.contextContent).toContain('/uploads/shot.png');
    expect((stored.payload?.attachments as Array<Record<string, unknown>>)[0]).toEqual({
      kind: 'image', path: expect.stringContaining('/uploads/shot.png'), mediaType: 'image/png',
    });

    const modelMessage = eventToSessionMessage(stored as any);
    expect(modelMessage?.content[0]).toEqual({ type: 'text', text: expect.stringContaining('/uploads/shot.png') });
    const visible = adapt(stored, createAdapterState());
    expect(visible).toEqual([{ type: 'user_message', text: 'inspect this' }]);
  });
});
