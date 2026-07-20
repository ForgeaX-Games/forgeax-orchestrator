import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildActionCatalog,
  catalogAll,
  catalogFirstClass,
  catalogGet,
  type ActionCatalogEntry,
} from '../src/kernel/action-catalog';

beforeEach(() => {
  buildActionCatalog();
});

describe('ActionCatalog', () => {
  test('atomically assembles all 25 trusted action declarations', () => {
    const catalog = catalogAll();

    expect(catalog).toHaveLength(25);
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(25);
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
    expect(catalogFirstClass()).toHaveLength(14);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    expect(catalog.every((entry) => !('run' in entry) && !('available' in entry))).toBe(true);
  });

  test('rejects a duplicate id without publishing a partial catalog', () => {
    const before = catalogAll();
    const duplicate = { ...before[0] };

    expect(() => buildActionCatalog([...before, duplicate])).toThrow(
      'ActionCatalog: duplicate action id "app.set_mode"',
    );
    expect(catalogAll()).toBe(before);
    expect(catalogAll()).toHaveLength(25);
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
    expect(catalogAll()).toHaveLength(25);
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
    const entry = catalogGet('app.set_mode')!;
    const schema = entry.schema!;
    const properties = schema.properties as Record<string, unknown>;
    const mode = properties.mode as Record<string, unknown>;

    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(firstClass)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(mode)).toBe(true);
    expect(Object.isFrozen(mode.enum)).toBe(true);

    expect(() => {
      (all as ActionCatalogEntry[]).push(entry);
    }).toThrow();
    expect(() => {
      (entry as { title: string }).title = 'mutated';
    }).toThrow();
    expect(() => {
      mode.type = 'number';
    }).toThrow();

    expect(catalogAll()).toHaveLength(25);
    expect(catalogGet('app.set_mode')?.title).toBe('切换主模式');
    expect((catalogGet('app.set_mode')?.schema?.properties as Record<string, unknown>).mode).toEqual({
      type: 'string',
      enum: ['scene', 'ai'],
    });
  });
});
