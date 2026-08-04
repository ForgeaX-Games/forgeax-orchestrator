import { expect, test } from 'bun:test';
import { cloneHistoryBundle, createHistoryBundle, verifyHistoryBundle } from '../src/history/bundle';

const item = { cursor: { shard: 1, line: 1, eventId: 'e1' }, turnId: 't1', message: { role: 'user' as const, content: 'hello' } };

test('history bundle verifies digest and clone creates a new import identity', () => {
  const bundle = createHistoryBundle('sid-a', 'forge', [{ ...item, message: { role: 'user', content: 'hello sk-live-secret-123456' } }]);
  expect(bundle.items[0]?.message).toMatchObject({ role: 'user', content: 'hello [REDACTED]' });
  expect(bundle.redactedParts).toBe(1);
  expect(() => verifyHistoryBundle(bundle)).not.toThrow();
  expect(cloneHistoryBundle(bundle, 'sid-b', 'forge')[0]?.cursor.eventId).toBe('import:e1');
  const tampered = { ...bundle, items: [{ ...item, turnId: 'changed' }] };
  expect(() => verifyHistoryBundle(tampered)).toThrow('history_bundle_digest_mismatch');
});
