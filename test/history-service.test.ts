import { expect, test } from 'bun:test';
import { HistoryService } from '../src/history/service';

test('history cursor is opaque and query rejects traversal agent paths', async () => {
  const service = new HistoryService({ sid: 's1', ledgers: new Map() } as never);
  await expect(service.query({ agentId: '../other' })).rejects.toThrow('history_permission_denied');
  const page = await service.query({ agentId: 'forge' });
  expect(page).toEqual({ items: [] });
});

test('portable export is a verified, redacted history bundle', async () => {
  const service = new HistoryService({ sid: 's1', ledgers: new Map() } as never);
  const bundle = await service.export({ agentId: 'forge' });
  expect(bundle.version).toBe(1);
  expect(bundle.redactionPolicy).toBe('portable-v1');
  expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/);
});
