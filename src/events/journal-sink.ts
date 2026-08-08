/**
 * journal-sink —— 把进程级 topic 总线的事件落盘。
 *
 * 为什么需要:`events/bus.ts` 只把事件放进 2048 槽的内存环,满了覆盖、重启即清。
 * 而人点界面(`source: 'user'`)与 AI 派发(`source: 'ai'`)**走的是同一条 topic**,
 * 这条流正是"人机同门、只用 source 区分"这个不变式的账本。不落盘,人这一侧的
 * 操作历史就永远留不下来 —— 而那恰恰是后续沉淀 skill 最该学的东西。
 *
 * 总线早就留好了 `setJournalSink()` 插槽并在注释里写明用途,但**生产代码从未
 * 调用过它**(全仓只有测试调过)。本模块就是把那个插座接上电。
 *
 * 三条纪律:
 *  - **绝不影响主流程**:sink 在 `emit()` 内被同步调用,处在热路径上。所以只在
 *    内存里攒行,靠定时器与阈值批量落盘;任何序列化/IO 失败一律吞掉。
 *  - **宁可截断不丢行**:循环引用的 payload 换成占位而不是丢弃;超大行(快照能到
 *    几十 KB,且实时值本来就可另取)换成摘要,保住"这件事发生过"这个事实。
 *  - **可退出**:定时器 unref,不拖住进程退出。
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getEventBus, type EventEnvelope } from './bus';

/** 攒够这么多就立刻刷,别等定时器(突发流量下防止内存堆积)。 */
const BUFFER_LIMIT_BYTES = 64 * 1024;
/** 定时刷新间隔。 */
const FLUSH_INTERVAL_MS = 1_000;
/** 单行上限:超过就把 payload 换成摘要(快照类事件可以很大)。 */
const LINE_LIMIT_BYTES = 32 * 1024;
/** 文件上限:超过就轮转。 */
const FILE_LIMIT_BYTES = 32 * 1024 * 1024;

/** 只有这些 topic 才落盘。**默认拒绝,不是默认放行**。
 *
 *  2026-08-06 外审实锤:总线上跑的不只有 UI 事件 —— `tool.starting` 携带工具的
 *  **原始入参**,审计用假的 COS_SECRET_KEY 实跑,密钥原文进了 .forgeax/ui-events.jsonl。
 *  上一轮外审其实点过"文件名叫 ui-events.jsonl 却收全部 topic",我当时判成 MINOR
 *  记了待办 —— 严重度判错了,它是密钥落盘。另有任意-topic 的 HTTP 入口,所以白名单
 *  必须是前缀精确匹配,新 topic 一律不落。 */
function isJournalTopic(topic: string): boolean {
  return topic.startsWith('ui.') || topic === 'workbench.active-game.changed';
}

/** 键名像凭据就把值换掉。白名单之内也照脱 —— 纵深防御:哪天有人往 ui.* 事件里
 *  塞了 token,这一层还在。 */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|apikey|api_key|credential|auth|cookie|session_key|private_key)/i;
/** bus 自己铸造的关联 id:`${surfaceId}-${seq}-${6位base36}`(如 host.menubar-1-i0p5wt)。
 *  它命中 SECRET_KEY_PATTERN 的 `token`,但**不是凭据** —— 它是工具结果与
 *  ui-events.jsonl 之间唯一的跨账本连接键,两侧必须逐字相等才能离线 grep 对上。
 *  2026-08-06 外审实测:上一轮的一刀切脱敏把 journalToken 抹成 [redacted],链当场断,
 *  而文档还在教人按 token 关联 —— 我修密钥泄漏时剪断了自己刚建的链。
 *  为什么按**值形状**而不是键名例外:`key === 'token'` 就放行的话,任何插件面
 *  往 token 字段塞真凭据都会直接泄漏;值形状是"这串东西由我们自己铸造"的证据。
 *  为什么不用稳定摘要:摘要能保关联,但两侧不再逐字相等,最简单的 grep 用法就废了,
 *  且低熵凭据的短摘要可爆破。 */
const BUS_CORRELATION_ID_PATTERN = /^[a-z][a-zA-Z0-9._-]*-\d+-[a-z0-9]{6}$/;
function isBusCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && BUS_CORRELATION_ID_PATTERN.test(value);
}
const MAX_REDACTION_DEPTH = 8;
const MAX_STRING_LENGTH = 4_096;

function truncateSecretish(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}[truncated]`;
}

/** 递归脱敏并**返回新对象**——原 envelope 还要发给别的订阅者,绝不能改它。
 *  深度上限防炸;循环引用在这里换成 '[circular]',而整条 payload 的
 *  `{unserializable:true}` 兜底仍由 serialize 的 try/catch 负责(两层各管各的)。 */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return truncateSecretish(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (typeof value === 'symbol' || typeof value === 'function') return '[unsupported]';
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_REDACTION_DEPTH) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      try { return sanitize(item, depth + 1, seen); } catch { return '[unreadable]'; }
    });
  }
  let keys: string[];
  try { keys = Object.keys(value); } catch { return '[unreadable]'; }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    let fieldValue: unknown;
    try { fieldValue = Reflect.get(value, key); } catch { out[key] = '[unreadable]'; continue; }
    if (SECRET_KEY_PATTERN.test(key) && !isBusCorrelationId(fieldValue)) { out[key] = '[redacted]'; continue; }
    try { out[key] = sanitize(fieldValue, depth + 1, seen); } catch { out[key] = '[unreadable]'; }
  }
  return out;
}

function payloadKeys(payload: unknown): string[] {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload as Record<string, unknown>)
    : [];
}

/**
 * 安装落盘 sink,返回卸载函数(卸载时会把残余缓冲刷出去,fire-and-forget)。
 */
export function installEventJournal(opts: { projectRoot: string }): () => void {
  const journalDir = join(opts.projectRoot, '.forgeax');
  const journalPath = join(journalDir, 'ui-events.jsonl');

  let lines: string[] = [];
  let bufferedBytes = 0;
  let flushChain: Promise<void> = Promise.resolve();
  let disposed = false;

  const serialize = (envelope: EventEnvelope): string => {
    let serialized: string;
    try {
      // 脱敏产出新对象,不动原 envelope(它还要发给别的订阅者)。
      serialized = JSON.stringify({ ...envelope, payload: sanitize(envelope.payload) });
    } catch {
      serialized = JSON.stringify({
        ...envelope,
        payload: { unserializable: true },
      });
    }

    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes <= LINE_LIMIT_BYTES) {
      return serialized;
    }

    return JSON.stringify({
      ...envelope,
      payload: {
        truncated: true,
        bytes,
        keys: payloadKeys(envelope.payload),
      },
    });
  };

  const rotateIfNeeded = async (incomingBytes: number): Promise<void> => {
    let currentBytes = 0;

    try {
      currentBytes = (await stat(journalPath)).size;
    } catch {
      currentBytes = 0;
    }

    if (currentBytes + incomingBytes <= FILE_LIMIT_BYTES) {
      return;
    }

    // 归档名**每次轮转现算**,并逐个探测直到找到没被占用的名字。此前它是安装时
    // 算一次的常量,于是第二次轮转会先 rm 掉第一次的归档再改名过去 —— 确定性
    // 地销毁一整份历史。归档只增不覆盖:宁可多一个文件,不可少一份记录。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = join(journalDir, `ui-events-${stamp}${attempt ? `-${attempt}` : ''}.jsonl`);
      try {
        await stat(candidate);
        continue; // 已存在 → 换个名字,绝不覆盖
      } catch { /* 不存在,可用 */ }
      try {
        await rename(journalPath, candidate);
      } catch {
        // 源文件可能还不存在,或重命名不可用 —— 本批仍会追加到 journalPath。
      }
      return;
    }
  };

  const flush = (): void => {
    if (lines.length === 0) {
      return;
    }

    const batch = lines;
    const batchBytes = bufferedBytes;
    lines = [];
    bufferedBytes = 0;

    flushChain = flushChain
      .then(async () => {
        await mkdir(journalDir, { recursive: true });
        await rotateIfNeeded(batchBytes);
        await appendFile(journalPath, batch.join(''), 'utf8');
      })
      .catch(() => {
        // Journaling is best-effort and must never throw.
      });
  };

  const sink = (envelope: EventEnvelope): void => {
    try {
      if (disposed || !isJournalTopic(envelope.topic)) {
        return;
      }

      const line = `${serialize(envelope)}\n`;
      lines.push(line);
      bufferedBytes += Buffer.byteLength(line, 'utf8');

      if (bufferedBytes > BUFFER_LIMIT_BYTES) {
        flush();
      }
    } catch {
      // Journaling must never affect event delivery.
    }
  };

  const timer = setInterval(() => {
    try {
      flush();
    } catch {
      // Journaling must never affect event delivery.
    }
  }, FLUSH_INTERVAL_MS);
  timer.unref();

  try {
    getEventBus().setJournalSink(sink);
  } catch {
    clearInterval(timer);
  }

  return () => {
    try {
      if (disposed) {
        return;
      }

      disposed = true;
      clearInterval(timer);
      getEventBus().setJournalSink(null);
      flush();
    } catch {
      // Uninstalling the journal must never throw.
    }
  };
}
