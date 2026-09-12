import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  _resetActionCatalogValidationForTests,
  buildActionCatalog,
  catalogAll,
  catalogGet,
} from '../src/kernel/action-catalog';
import {
  acquireUiLease,
  clearUiStateForSession,
  firstClassUiToolSpecs,
  getUiAction,
  resolveFirstClassUiTool,
  setUiManifest,
} from '../src/api/lib/ui-manifest-registry';

const handlerIds = ['role.create', 'role.list', 'session.create', 'session.close', 'sessions.list'];
const strict = { headlessHandlerActionIds: handlerIds, grandfatheredHeadlessActionIds: [] };
const sid = 'host-catalog-boundary';
afterEach(() => {
  clearUiStateForSession(sid);
  _resetActionCatalogValidationForTests();
  buildActionCatalog();
});

test('a host with no product contribution exposes only role/session lifecycle', () => {
  buildActionCatalog(undefined, strict);
  expect(catalogAll().map(e => e.id).sort()).toEqual([...handlerIds].sort());
  for (const id of ['game.create', 'game.switch', 'role.open', 'session.switch', 'console.read', 'overlay.open']) {
    expect(catalogGet(id)).toBeUndefined();
    expect(resolveFirstClassUiTool(sid, `ui_act_${id.replaceAll('.', '_')}`)).toBeUndefined();
  }
  expect(catalogGet('session.create')?.description).not.toContain('switch');
  expect(catalogGet('sessions.list')?.description).not.toContain('game');
});

test('a non-game host supplies tool facts; a browser cannot mint or escalate them', () => {
  const defaults = buildActionCatalog(undefined, strict);
  buildActionCatalog([...defaults, {
    id: 'repository.inspect', title: 'Inspect repository', capability: 'read',
    surface: 'ui', firstClass: true,
    schema: { type: 'object', properties: { revision: { type: 'string' } } },
  }], strict);
  const lease = acquireUiLease(sid, 'client');
  setUiManifest(sid, [
    { id: 'repository.inspect', title: 'tampered', capability: 'delete', surface: 'both', firstClass: false },
    { id: 'game.switch', title: 'injected', capability: 'write', firstClass: true },
  ], lease.leaseId);
  expect(getUiAction(sid, 'repository.inspect')?.capability).toBe('read');
  expect(getUiAction(sid, 'repository.inspect')?.surface).toBe('ui');
  expect(catalogGet('game.switch')).toBeUndefined();
  expect(firstClassUiToolSpecs(sid).some(tool => tool.name === 'ui_act_repository_inspect')).toBe(true);
  expect(resolveFirstClassUiTool(sid, 'ui_act_repository_inspect')).toEqual({ actionId: 'repository.inspect' });
});

test('a later host clears both prior product declarations and compatibility policy', () => {
  const defaults = buildActionCatalog(undefined, strict);
  buildActionCatalog([...defaults, {
    id: 'repository.refresh', title: 'Refresh', capability: 'read', surface: 'both', firstClass: true,
  }], { ...strict, grandfatheredHeadlessActionIds: ['repository.refresh'] });
  expect(resolveFirstClassUiTool(sid, 'ui_act_repository_refresh')).toBeDefined();
  buildActionCatalog(undefined, strict);
  expect(resolveFirstClassUiTool(sid, 'ui_act_repository_refresh')).toBeUndefined();
  expect(() => buildActionCatalog([...catalogAll(), {
    id: 'repository.refresh', title: 'Refresh', capability: 'read', surface: 'both',
  }])).toThrow('missing headless handler');
});

test('invalid host declarations fail atomically and explicit handlers close compatibility debt', () => {
  const defaults = buildActionCatalog(undefined, strict);
  const action = { id: 'repository.refresh', title: 'Refresh', capability: 'read', surface: 'both' };
  expect(() => buildActionCatalog([...defaults, action], strict)).toThrow('missing headless handler');
  expect(catalogAll()).toBe(defaults);
  buildActionCatalog([...defaults, action], {
    headlessHandlerActionIds: [...handlerIds, 'repository.refresh'], grandfatheredHeadlessActionIds: [],
  });
  expect(catalogGet('repository.refresh')).toBeDefined();
});

test('normal application boot supplies the complete host catalog and resets absent exceptions', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  expect(source).toContain('buildActionCatalog(ctx.actionCatalog, {');
  expect(source).toContain('grandfatheredHeadlessActionIds: ctx.headlessActionCompatibilityIds ?? []');
  expect(source.indexOf('buildActionCatalog(ctx.actionCatalog')).toBeLessThan(source.indexOf('const pm = initPathManager'));
});


test('a complete host catalog can opt out of generic actions without phantom handlers', () => {
  buildActionCatalog([], {
    builtinHeadlessHandlerActionIds: handlerIds,
    headlessHandlerActionIds: [], grandfatheredHeadlessActionIds: [],
  });
  expect(catalogAll()).toEqual([]);
  expect(firstClassUiToolSpecs(sid)).toEqual([]);
});

test('host overrides of generic handlers validate once while duplicate host registrations fail', () => {
  buildActionCatalog(undefined, {
    builtinHeadlessHandlerActionIds: handlerIds,
    headlessHandlerActionIds: ['session.create'], grandfatheredHeadlessActionIds: [],
  });
  expect(catalogGet('session.create')).toBeDefined();
  expect(() => buildActionCatalog(undefined, {
    builtinHeadlessHandlerActionIds: handlerIds,
    headlessHandlerActionIds: ['session.create', 'session.create'], grandfatheredHeadlessActionIds: [],
  })).toThrow('duplicate headless handler');
});
