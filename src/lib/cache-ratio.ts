/**
 * cacheHitRatio —— prompt-cache 命中率的统一口径。
 *
 * 还原老 forgeax-studio `packages/orchestrator/src/session/xml.ts` 的 `cachedRatio` 打点:
 * 迁到 forgeax-core 内核路径后,原始 cache token 仍端到端贯通(core provider →
 * turn.usage → done.usage → observatory),但「命中率」这个派生指标 + 其可见化在
 * 迁移中遗失,这里补回。
 *
 * 框架统一口径:inputTokens 已经**含**缓存(= nakedInput + cacheRead + cacheCreate,
 * 见 src/llm/anthropic.ts 直连 provider 的既有算法;the reference agent CLI CLI 适配层在
 * claude-code-mapper.ts 的 captureUsage 换算成同款口径;Codex CLI 的 input_tokens
 * 原生也是这个口径)。命中率 = cacheRead 占 inputTokens 总量的比例,不需要再把
 * cacheRead/cacheCreation 加进分母,也不需要感知 provider(旧版按 provider 换算
 * 曾在这里导致 Codex 命中率被系统性拉低:2026-07-28 report 实例,66304/70289=94.3%
 * 被算成 66304/(70289+66304)=48.5%——现在从根上避免了这类重复计算)。
 * inputTokens<=0(无输入,如纯工具回合)返回 undefined,表示「无可报」而非 0%。
 */
export function cacheHitRatio(input: number, cacheRead: number): number | undefined {
  if ((input || 0) <= 0) return undefined;
  return ((cacheRead || 0) / input) * 100;
}

/** 格式化成 "XX.X%"(一位小数);无可报时返回 undefined。 */
export function formatCacheHitRatio(input: number, cacheRead: number): string | undefined {
  const r = cacheHitRatio(input, cacheRead);
  return r === undefined ? undefined : `${r.toFixed(1)}%`;
}
