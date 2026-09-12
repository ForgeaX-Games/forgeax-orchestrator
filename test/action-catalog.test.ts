import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetActionCatalogValidationForTests,
  catalogAll,
  catalogFirstClass,
  catalogGet,
  type ActionCatalogBuildOptions,
  type ActionCatalogEntry,
} from '../src/kernel/action-catalog';
import { buildActionCatalog, HEADLESS_ACTION_GRANDFATHER_IDS } from './fixtures/host-action-catalog';

const CURRENT_HEADLESS_HANDLER_IDS = Object.freeze([
  'sessions.list',
  'session.create',
  'session.close',
  'role.create',
  'role.list',
]);

function registryOptions(
  overrides: Partial<ActionCatalogBuildOptions> = {},
): ActionCatalogBuildOptions {
  return {
    headlessHandlerActionIds: CURRENT_HEADLESS_HANDLER_IDS,
    grandfatheredHeadlessActionIds: HEADLESS_ACTION_GRANDFATHER_IDS,
    ...overrides,
  };
}

beforeEach(() => {
  _resetActionCatalogValidationForTests();
  buildActionCatalog();
});

afterEach(() => {
  _resetActionCatalogValidationForTests();
});

describe('ActionCatalog', () => {

  test('状态前置条件经构建存活,且首批声明只描述世界状态', () => {
    const preconditions = (id: string) =>
      (catalogGet(id) as ActionCatalogEntry & { preconditions?: readonly string[] } | undefined)?.preconditions;

    expect(preconditions('extension.open')).toEqual([
      'The target extension must contribute an available singleton page.',
    ]);
    expect(preconditions('role.open')).toEqual([
      'When id is provided, it must identify a role in the current roster.',
      'When id is provided, an active chat session must exist for the role binding.',
    ]);
    expect(catalogGet('game.switch')).toBeUndefined();
    expect(preconditions('overlay.open')).toEqual([
      'The requested id must identify an overlay currently registered by the product shell.',
    ]);
    expect(preconditions('role.create')).toEqual([
      'The requested id must not already exist in the role roster.',
    ]);
    expect(preconditions('game.create')).toEqual([
      'The requested slug must not already identify an existing game.',
    ]);
    expect(preconditions('panel.toggle_sidebar')).toBeUndefined();
  });

  test('三条已知 description 只解释能力,不夹带操作顺序', () => {
    expect(catalogGet('extension.open')?.description).toBe(
      'Open the Page contributed by a specific extension id. Discover valid ids via extension.list.',
    );
    expect(catalogGet('role.list')?.description).toBe(
      'List all currently dispatchable roles (plugin agents + built-ins). Returns { count, roles:[{id,role,displayName,source}] }.',
    );
    expect(catalogGet('game.create')?.description).toBe(
      'Create a new game (project) from the template and give it its own dedicated chat session. The action does not switch the UI to the new game.',
    );
  });

  test('preconditions 非空字符串数组以外的形状全部拒绝,且失败不替换现有目录', () => {
    const before = catalogAll();
    const base = before[0]!;
    const invalidValues: unknown[] = ['ready', [], [1], [''], ['   ']];

    for (const [index, preconditions] of invalidValues.entries()) {
      expect(() => buildActionCatalog([{ ...base, id: `invalid.preconditions.${index}`, preconditions }]))
        .toThrow(/preconditions/);
      expect(catalogAll()).toBe(before);
    }
  });

  test('preconditions 由构建器复制并冻结,调用方不能在发布后改写目录事实', () => {
    const source = ['The world must be ready.'];
    buildActionCatalog([{ ...catalogAll()[0], id: 'frozen.preconditions', preconditions: source }]);
    const stored = (catalogGet('frozen.preconditions') as ActionCatalogEntry & {
      preconditions?: readonly string[];
    }).preconditions!;

    expect(stored).toEqual(['The world must be ready.']);
    expect(stored).not.toBe(source);
    expect(Object.isFrozen(stored)).toBe(true);
    source[0] = 'mutated';
    expect(stored).toEqual(['The world must be ready.']);
  });

  test('door metadata survives compilation for registered actions', () => {
    const door = { menuCommandId: 'sample.open' };
    buildActionCatalog([{ id: 'sample.open', title: 'Open', capability: 'read', surface: 'ui', door }]);
    expect(catalogGet('sample.open')?.door).toEqual(door);
    expect(catalogGet('game.switch')).toBeUndefined();
  });
  test('atomically assembles all 22 trusted action declarations', () => {
    const catalog = catalogAll();

    expect(catalog).toHaveLength(22);
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(22);
    expect(catalogGet('role.create')).toMatchObject({
      capability: 'delegate',
      surface: 'both',
      firstClass: true,
      timeoutMs: 15_000,
    });
    expect(catalogGet('role.list')).toMatchObject({
      capability: 'read',
      surface: 'both',
      firstClass: true,
    });
    expect(catalogGet('role.open')).toMatchObject({
      capability: 'read',
      surface: 'ui',
      firstClass: true,
    });
    expect(catalogGet('panel.toggle_sidebar')?.schema).toBeUndefined();
    expect(catalogFirstClass()).toHaveLength(11);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    expect(catalog.every((entry) => !('run' in entry) && !('available' in entry))).toBe(true);
  });

  test('accepts the complete headless registry and the frozen three-item grandfather', () => {
    expect(HEADLESS_ACTION_GRANDFATHER_IDS).toEqual([
      'game.create',
      'session.rename',
      'sessions.refresh',
    ]);
    expect(Object.isFrozen(HEADLESS_ACTION_GRANDFATHER_IDS)).toBe(true);

    const catalog = buildActionCatalog(undefined, registryOptions());
    expect(catalog.filter((entry) => entry.surface === 'both' || entry.surface === 'server')).toHaveLength(8);
  });

  test('revalidates later bare rebuilds with the last successful registry options', () => {
    buildActionCatalog(undefined, registryOptions());
    const before = catalogAll();

    expect(() =>
      buildActionCatalog([
        ...before,
        {
          id: 'later.headless.action',
          title: 'Later headless action',
          capability: 'read',
          surface: 'both',
        },
      ]),
    ).toThrow('missing headless handler for action "later.headless.action"');
    expect(catalogAll()).toBe(before);
  });

  test('rejects a missing headless handler without replacing the catalog', () => {
    const before = catalogAll();
    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        headlessHandlerActionIds: CURRENT_HEADLESS_HANDLER_IDS.filter((id) => id !== 'role.list'),
      })),
    ).toThrow('missing headless handler for action "role.list"');
    expect(catalogAll()).toBe(before);
  });

  test('rejects duplicate headless handlers', () => {
    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        headlessHandlerActionIds: [...CURRENT_HEADLESS_HANDLER_IDS, 'role.list'],
      })),
    ).toThrow('duplicate headless handler action "role.list"');
  });

  test('rejects orphan and non-headless handlers', () => {
    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        headlessHandlerActionIds: [...CURRENT_HEADLESS_HANDLER_IDS, 'outside.catalog'],
      })),
    ).toThrow('orphan headless handler "outside.catalog" is not declared');

    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        headlessHandlerActionIds: [...CURRENT_HEADLESS_HANDLER_IDS, 'role.open'],
      })),
    ).toThrow('orphan headless handler "role.open" targets non-headless surface "ui"');
  });

  test('forces a stale grandfather entry to be removed when a handler lands', () => {
    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        headlessHandlerActionIds: [...CURRENT_HEADLESS_HANDLER_IDS, 'game.create'],
      })),
    ).toThrow('headless grandfather "game.create" has a handler and must be removed');
  });

  test('rejects unknown and non-headless grandfather entries', () => {
    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        grandfatheredHeadlessActionIds: [...HEADLESS_ACTION_GRANDFATHER_IDS, 'outside.catalog'],
      })),
    ).toThrow('headless grandfather "outside.catalog" is not declared');

    expect(() =>
      buildActionCatalog(undefined, registryOptions({
        grandfatheredHeadlessActionIds: [...HEADLESS_ACTION_GRANDFATHER_IDS, 'role.open'],
      })),
    ).toThrow('headless grandfather "role.open" targets non-headless surface "ui"');
  });

  test('rejects a duplicate id without publishing a partial catalog', () => {
    const before = catalogAll();
    const duplicate = { ...before[0] };

    expect(() => buildActionCatalog([...before, duplicate])).toThrow(
      'ActionCatalog: duplicate action id "panel.toggle_sidebar"',
    );
    expect(catalogAll()).toBe(before);
    expect(catalogAll()).toHaveLength(22);
  });

  test('rejects schemas that are not pure JSON objects without replacing the catalog', () => {
    const before = catalogAll();
    const base = before[0];

    expect(() => buildActionCatalog([
      { ...base, id: 'invalid.schema.array', schema: [] },
    ])).toThrow('ActionCatalog: action "invalid.schema.array" schema must be a plain JSON object');

    expect(() => buildActionCatalog([
      {
        ...base,
        id: 'invalid.schema.value',
        schema: { type: 'object', properties: { value: { default: () => true } } },
      },
    ])).toThrow(/ActionCatalog: action "invalid\.schema\.value" schema contains a non-JSON value/);

    const sparseEnum = new Array(1);
    expect(() => buildActionCatalog([
      { ...base, id: 'invalid.schema.sparse', schema: { type: 'object', enum: sparseEnum } },
    ])).toThrow(/ActionCatalog: action "invalid\.schema\.sparse" schema contains a non-JSON value/);

    expect(catalogAll()).toBe(before);
    expect(catalogAll()).toHaveLength(22);
  });

  test('preserves JSON __proto__ keys without mutating object prototypes', () => {
    const base = catalogAll()[0];
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;

    buildActionCatalog([{ ...base, id: 'json.proto-key', schema }]);
    const compiledSchema = catalogGet('json.proto-key')!.schema!;
    const properties = compiledSchema.properties as Record<string, unknown>;

    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(properties, '__proto__')).toBe(true);
    expect(properties.__proto__).toEqual({ type: 'string' });
  });

  test('rejects capabilities outside the eight-value policy enum', () => {
    const before = catalogAll();
    const invalid = {
      ...before[0],
      id: 'invalid.capability',
      capability: 'admin',
    } as unknown as ActionCatalogEntry;

    expect(() => buildActionCatalog([invalid])).toThrow(
      'ActionCatalog: action "invalid.capability" has unsupported capability "admin"',
    );
    expect(catalogAll()).toBe(before);
  });

  test('publishes deeply frozen arrays, entries, and schemas', () => {
    const all = catalogAll();
    const firstClass = catalogFirstClass();
    const entry = catalogGet('extension.open')!;
    const schema = entry.schema!;
    const properties = schema.properties as Record<string, unknown>;
    const extensionId = properties.extensionId as Record<string, unknown>;

    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(firstClass)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(extensionId)).toBe(true);

    expect(() => {
      (all as ActionCatalogEntry[]).push(entry);
    }).toThrow();
    expect(() => {
      (entry as { title: string }).title = 'mutated';
    }).toThrow();
    expect(() => {
      extensionId.type = 'number';
    }).toThrow();

    expect(catalogAll()).toHaveLength(22);
    expect(catalogGet('extension.open')?.title).toBe('打开扩展页面');
    expect((catalogGet('extension.open')?.schema?.properties as Record<string, unknown>).extensionId).toEqual({ type: 'string' });
  });
});
