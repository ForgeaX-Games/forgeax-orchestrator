/** 内核工具调用审计追踪 —— append-only JSONL。
 *
 *  每次 bridge tool 调用（无论放行还是拒绝）都向**该 session 数据目录**下的
 *  `<session-root>/kernel-tool-audit.jsonl` 追加一行 JSON —— 经 path-manager
 *  解析(与 ledger / global-events 同根,落 `~/.forgeax/sessions/<sid>/`),与会话
 *  数据共置,而非 instance-local repo 根。
 *
 *  设计约束：
 *  - **不写 args**（可能体积大 / 包含敏感内容）。
 *  - **永不抛出**：审计失败只静默吞掉，不影响主流程。
 *  - 目录不存在时递归创建。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPathManager } from '../fs/path-manager';

export interface ToolAuditEntry {
  sid: string;
  agent: string;
  tool: string;
  trustTier: string;
  allow: boolean;
  ok?: boolean;
  error?: string;
  durationMs: number;
  ts: number;
  /** 与 agent 事件账本 `hook:toolCall.payload.callId` **逐字相等**的连接键。
   *  2026-08-06 外审:一次真实会话 39 次工具调用全在,但这份旁账只有 sid+agent+时间戳,
   *  "哪次用户请求导致了哪次工具调用"只能靠时间猜 —— 主账本的链是完整的,断的是旁账。
   *  **缺失时省略字段,不写 null/空串**:消费方据"有没有这个键"判断能不能 join,
   *  写空串会让它以为能 join 然后连到错的地方。 */
  callId?: string;
  /** 本轮 chat 请求级 id(比 callId 粗一层,用于把一轮里的多次工具调用归组)。 */
  turnCallId?: string;
  /** MCP shim 自铸的**这一次宿主执行**的 id(`fxt-<uuid>`)。租用内核(codex 等)经 MCP
   *  调宿主工具时,内核铸的 callId 结构上过不来(`tools/call` 只有 name+arguments),
   *  这条路上就只有它。它随工具结果的 `structuredContent` 回给内核,编排层再据此把
   *  `内核 callId → toolExecutionId → 本行` 连起来。
   *  **与 callId 是两个语义,谁都不许顶替谁** —— 前者标识模型发起的那次调用,后者标识
   *  落到宿主的那一次执行。同一轮里连跑两个一模一样的 act,只有后者分得开。 */
  toolExecutionId?: string;
}

export function appendToolAudit(entry: ToolAuditEntry): void {
  try {
    const dir = getPathManager().session(entry.sid).root();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'kernel-tool-audit.jsonl');
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // 审计绝不影响主流程 —— 吞掉所有异常
  }
}
