import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { initSessionManager, resetSessionManager, getSessionManager } from '../src/core/session-manager';
import { createSessionsRouter } from '../src/api/sessions';
import { clearUiStateForSession, validateUiLease } from '../src/api/lib/ui-manifest-registry';

test('UI lease HTTP route distinguishes focus, renewal and passive recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-lease-route-'));
  await resetSessionManager();
  resetPathManager();
  initSessionManager(initPathManager({ userRoot: root }));
  let sid = '';
  try {
    sid = (await getSessionManager().create({ displayName: 'ui-lease' })).sid;
    const router = createSessionsRouter();
    const post = async (body: object) => {
      const response = await router.request(`/${sid}/ui-lease`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ ok: boolean; leaseId?: string }>;
    };
    const background = await post({ clientId: 'background' });
    const foreground = await post({ clientId: 'foreground' });
    expect((await post({ clientId: 'background', leaseId: background.leaseId })).ok).toBe(false);
    expect((await post({ clientId: 'background', claimOnly: true })).ok).toBe(false);
    expect(validateUiLease(sid, foreground.leaseId)).toBe(true);
    expect((await post({ clientId: 'foreground', claimOnly: true })).leaseId).toBe(foreground.leaseId);
    const refocus = await post({ clientId: 'background' });
    expect(refocus.ok).toBe(true);
    expect(validateUiLease(sid, foreground.leaseId)).toBe(false);
  } finally {
    if (sid) clearUiStateForSession(sid);
    await resetSessionManager(); resetPathManager(); rmSync(root, { recursive: true, force: true });
  }
});
