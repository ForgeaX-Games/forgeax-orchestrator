import {
  PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
  ProductSnapshotSchema,
  type ProductAction,
  type ProductJsonObject,
  type ProductSnapshot,
  type ProductSurface,
} from '@forgeax/types/product-ai-native';
import type { ActionCatalogEntry } from './action-catalog';

export const FORGEAX_ACTION_CATALOG_SURFACE_ID = 'forgeax.action-catalog';
export const FORGEAX_ACTION_CATALOG_SCHEMA_VERSION = '1';

function cloneSchema(schema: ActionCatalogEntry['argsSchema']): ProductJsonObject {
  return JSON.parse(JSON.stringify(schema)) as ProductJsonObject;
}

export function projectCatalogAction(entry: ActionCatalogEntry): ProductAction {
  return {
    id: entry.id,
    description: entry.description,
    argsSchema: cloneSchema(entry.argsSchema),
    resultSchema: cloneSchema(entry.resultSchema),
    preconditions: entry.preconditions.map((item) => ({ ...item })),
    effect: entry.effect,
    exposedToAI: entry.exposedToAI,
    requireConfirm: entry.requireConfirm,
  };
}

export function projectActionCatalogSurface(): ProductSurface {
  return {
    protocolVersion: PRODUCT_AI_NATIVE_PROTOCOL_VERSION,
    id: FORGEAX_ACTION_CATALOG_SURFACE_ID,
    schemaVersion: FORGEAX_ACTION_CATALOG_SCHEMA_VERSION,
    snapshotSchema: {
      type: 'object',
      additionalProperties: true,
    },
  };
}

export function projectActionCatalogSnapshot(value: unknown): ProductSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const parsed = ProductSnapshotSchema.safeParse({
    surfaceId: FORGEAX_ACTION_CATALOG_SURFACE_ID,
    revision: source.revision,
    observedAt: source.observedAt,
    state: source.state,
  });
  return parsed.success ? parsed.data : undefined;
}
