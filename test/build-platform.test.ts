import { describe, expect, test } from 'bun:test';
import { buildPlatformOptions } from '../build-platform.mjs';

describe('orchestrator build platform options', () => {
  test('avoids the Bun Windows sourcemap path printer while preserving workspace symlinks', () => {
    expect(buildPlatformOptions('win32')).toEqual({ sourcemap: 'none', preserveSymlinks: true });
    expect(buildPlatformOptions('darwin')).toEqual({ sourcemap: 'linked', preserveSymlinks: true });
  });
});
