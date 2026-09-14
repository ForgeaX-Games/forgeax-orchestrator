import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelPermissionsRouter } from '../src/api/kernel-permissions';
import { createMemorySettingsRouter } from '../src/api/memory-settings';
let root: string;
let prior: string | undefined;
beforeEach(() => { prior = process.env.FORGEAX_PROJECT_ROOT; root = mkdtempSync(join(tmpdir(), 'settings-tabs-')); process.env.FORGEAX_PROJECT_ROOT = root; });
afterEach(() => { if (prior === undefined) delete process.env.FORGEAX_PROJECT_ROOT; else process.env.FORGEAX_PROJECT_ROOT = prior; rmSync(root, { recursive: true, force: true }); });
const init = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
test('independent permission changes preserve siblings and support explicit reset', async () => {
  const api = createKernelPermissionsRouter(() => []);
  expect((await api.request('/', init({ kernelId: 'codex', mode: 'gated' }))).status).toBe(200);
  const response = await api.request('/', init({ kernelId: 'claude-code', mode: 'planning' }));
  expect((await response.json() as { config: { perKernel: Record<string, string> } }).config.perKernel).toEqual({ codex: 'gated', 'claude-code': 'planning' });
  const reset = await api.request('/', init({ kernelId: 'codex', mode: null }));
  expect((await reset.json() as { config: { perKernel: Record<string, string> } }).config.perKernel).toEqual({ 'claude-code': 'planning' });
  expect((await api.request('/', init({ kernelId: 'codex', mode: 'invalid' }))).status).toBe(400);
});
test('memory kernel changes preserve another page master and sibling changes', async () => {
  const api = createMemorySettingsRouter();
  await api.request('/', init({ master: false }));
  await api.request('/', init({ kernelId: 'codex', enabled: true }));
  const response = await api.request('/', init({ kernelId: 'claude-code', enabled: false }));
  expect((await response.json() as { config: unknown }).config).toEqual({ master: false, perKernel: { codex: true, 'claude-code': false } });
  expect((await api.request('/', init({ kernelId: 'codex', enabled: 'false' }))).status).toBe(400);
});
