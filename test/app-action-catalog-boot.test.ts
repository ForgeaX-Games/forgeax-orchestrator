import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForgeaxApp } from '../src/app';
import { HEADLESS_ACTION_GRANDFATHER_IDS as PACKAGE_GRANDFATHER_IDS } from '../src/index';
import {
  _resetActionCatalogValidationForTests,
  HEADLESS_ACTION_GRANDFATHER_IDS,
} from '../src/kernel/action-catalog';

afterEach(() => {
  _resetActionCatalogValidationForTests();
});

test('package root exports the ActionCatalog grandfather constant by identity', () => {
  expect(PACKAGE_GRANDFATHER_IDS).toBe(HEADLESS_ACTION_GRANDFATHER_IDS);
});

test('createForgeaxApp fails before filesystem boot when the headless registry is invalid', async () => {
  const projectRoot = join(tmpdir(), `forgeax-invalid-action-catalog-${randomUUID()}`);

  await expect(
    createForgeaxApp({
      instanceRoot: projectRoot,
      hostUiActions: [
        {
          actionId: 'outside.catalog',
          run: () => ({ status: 'completed' }),
        },
      ],
    }),
  ).rejects.toThrow('orphan headless handler "outside.catalog" is not declared');

  expect(existsSync(projectRoot)).toBe(false);
});
