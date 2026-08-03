/**
 * deriveThreadId —— 内核会话续接用的确定性 threadId(SSOT)。
 *
 * `sessionId::agentId` → UUIDv5(RFC 4122, sha1)。稳定 key 换稳定 UUID,满足
 * CC `--resume` 的 UUID 格式门槛。任何构造「本轮该用哪个 threadId」的调用点
 * (正常轮次 `kernel-turn.ts` / soul fork-extract cache-warm `fork-extract.ts`)
 * 都必须走这一个函数 —— 否则同一 session+agent 在不同调用点算出不同 threadId,
 * 内核侧缓存前缀对不上,白丢一次 cache-warm。
 */
import { createHash } from 'node:crypto';

/** 确定性 UUIDv5(RFC 4122,sha1)——稳定 key → 稳定 UUID(CC resume 要求 UUID)。 */
function uuidv5(name: string): string {
  const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // 标准 DNS 命名空间
  const nsBytes = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `sessionId`(缺省时 `'nosid'`)+ `agentId` → 该 agent 在该 session 下的确定性 threadId。 */
export function deriveThreadId(sessionId: string | undefined, agentId: string): string {
  return uuidv5(`${sessionId ?? 'nosid'}::${agentId}`);
}
