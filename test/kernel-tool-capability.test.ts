import { beforeEach, describe, expect, test } from 'bun:test';
import {
  authorizeKernelToolCapability,
  issueKernelToolCapability,
  resetKernelToolCapabilitiesForTests,
} from '../src/kernel/kernel-tool-capability';

describe('kernel-tool source capability', () => {
  beforeEach(() => resetKernelToolCapabilitiesForTests());

  test('binds one token to its session, actor, and exact tool allowlist', () => {
    const capability = issueKernelToolCapability({
      sid: 'sid-a',
      agentPath: 'root/worker',
      enabledTools: ['ui_invoke', 'echo'],
    });
    expect(capability).toBeDefined();
    expect(authorizeKernelToolCapability(capability!.token, 'sid-a', 'ui_invoke')).toEqual({
      sid: 'sid-a',
      agentPath: 'root/worker',
    });
    expect(authorizeKernelToolCapability(capability!.token, 'sid-b', 'ui_invoke')).toBeUndefined();
    expect(authorizeKernelToolCapability(capability!.token, 'sid-a', 'remember')).toBeUndefined();
    expect(authorizeKernelToolCapability('not-a-token', 'sid-a', 'ui_invoke')).toBeUndefined();
  });

  test('rejects invalid declarations and revoked tokens', () => {
    expect(issueKernelToolCapability({ sid: '', agentPath: 'forge', enabledTools: ['echo'] })).toBeUndefined();
    expect(issueKernelToolCapability({ sid: 'sid', agentPath: '', enabledTools: ['echo'] })).toBeUndefined();
    expect(issueKernelToolCapability({ sid: 'sid', agentPath: 'forge', enabledTools: [] })).toBeUndefined();

    const capability = issueKernelToolCapability({ sid: 'sid', agentPath: 'forge', enabledTools: ['echo'] })!;
    capability.revoke();
    expect(authorizeKernelToolCapability(capability.token, 'sid', 'echo')).toBeUndefined();
  });

  test('expires capabilities fail-closed', async () => {
    const capability = issueKernelToolCapability({
      sid: 'sid',
      agentPath: 'forge',
      enabledTools: ['echo'],
      ttlMs: 1,
    })!;
    await Bun.sleep(5);
    expect(authorizeKernelToolCapability(capability.token, 'sid', 'echo')).toBeUndefined();
  });
});
