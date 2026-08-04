import { expect, test } from 'bun:test';
import { authorizeHistory } from '../src/history/authorizer';

test('history authorization is scoped to sid, agent and capability', () => {
  const principal = { sid: 's1', agentId: 'forge', capabilities: ['history.query'] as const };
  expect(() => authorizeHistory(principal, { sid: 's1', agentId: 'forge', capability: 'history.query' })).not.toThrow();
  expect(() => authorizeHistory(principal, { sid: 's2', agentId: 'forge', capability: 'history.query' })).toThrow('history_permission_denied');
  expect(() => authorizeHistory(principal, { sid: 's1', agentId: 'other', capability: 'history.query' })).toThrow('history_permission_denied');
  expect(() => authorizeHistory(principal, { sid: 's1', agentId: 'forge', capability: 'history.export' })).toThrow('history_permission_denied');
});
