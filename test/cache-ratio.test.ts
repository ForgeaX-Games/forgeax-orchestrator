import { describe, expect, test } from 'bun:test';
import { cacheHitRatio, formatCacheHitRatio } from '../src/lib/cache-ratio';

describe('cacheHitRatio — 框架统一口径(inputTokens 已含缓存)', () => {
  test('命中率 = cacheRead 占 inputTokens 总量的比例', () => {
    // input=70289 已含 cacheRead=66304 → 66304/70289=94.3%(2026-07-28 report 实例)。
    expect(cacheHitRatio(70289, 66304)).toBeCloseTo(94.3, 1);
  });

  test('input<=0(无输入,如纯工具回合)→ undefined,不污染成 0%', () => {
    expect(cacheHitRatio(0, 0)).toBeUndefined();
    expect(formatCacheHitRatio(0, 0)).toBeUndefined();
  });

  test('无缓存命中 → 0%', () => {
    expect(cacheHitRatio(1000, 0)).toBeCloseTo(0, 1);
  });

  test('formatCacheHitRatio 格式化成一位小数百分号字符串', () => {
    expect(formatCacheHitRatio(70289, 66304)).toBe('94.3%');
  });
});
