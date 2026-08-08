/** 落盘 sink —— 保住"人机同门"这条账。
 *
 *  人点界面(source:'user')与 AI 派发(source:'ai')走同一条 topic,但总线只有
 *  2048 槽内存环,满了覆盖、重启即清 —— 人这一侧的操作历史因此永远留不下来。
 *  本测试锁住:两侧都落盘、都可区分,且落盘绝不影响事件投递。 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetEventBusForTests, getEventBus } from '../src/events/bus';
import { installEventJournal } from '../src/events/journal-sink';

interface JournalLine {
  ts: number;
  topic: string;
  threadId: string | null;
  payload: Record<string, unknown>;
}

describe('event journal sink', () => {
  let projectRoot: string;
  let dispose: (() => void) | null;

  beforeEach(() => {
    _resetEventBusForTests();
    projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-journal-'));
    dispose = null;
  });

  afterEach(async () => {
    dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    _resetEventBusForTests();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const journalPath = () => join(projectRoot, '.forgeax', 'ui-events.jsonl');

  function readLines(): JournalLine[] {
    if (!existsSync(journalPath())) return [];
    return readFileSync(journalPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalLine);
  }

  async function waitForLines(count: number): Promise<JournalLine[]> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const lines = readLines();
      if (lines.length >= count) return lines;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Journal did not reach ${count} lines`);
  }

  it('一条事件 = 磁盘上一行 JSON', async () => {
    dispose = installEventJournal({ projectRoot });
    const envelope = getEventBus().emit('ui.surface.registered', { id: 'host.menubar' });
    dispose(); dispose = null;

    expect(await waitForLines(1)).toEqual([{
      ts: envelope.ts,
      topic: envelope.topic,
      threadId: envelope.threadId,
      payload: envelope.payload as Record<string, unknown>,
    }]);
  });

  it('人与 AI 两侧都落盘,且靠 source 可区分 —— 这条是产品不变式', async () => {
    dispose = installEventJournal({ projectRoot });
    const bus = getEventBus();
    bus.emit('ui.surface.action', { id: 'host.menubar', action: 'invoke', source: 'user' });
    bus.emit('ui.surface.action', { id: 'host.sidebar', action: 'setMode', source: 'ai' });
    dispose(); dispose = null;

    const lines = await waitForLines(2);
    expect(lines.map((line) => line.payload.source)).toEqual(['user', 'ai']);
  });

  it('超长字符串就地截断,保住结构 —— 比整条换成摘要留下更多事实', async () => {
    // 2026-08-06:脱敏层(密钥防护)顺带把超长字符串截到 4096。于是这类 payload
    // 不再触发"整条换成 {truncated,bytes,keys} 摘要"的兜底,而是保留完整结构、
    // 只截那一个字段 —— 同一条纪律("宁可截断不丢行")的更好实现。整条摘要那条
    // 兜底仍然在(见下一个用例:字段多到把行撑爆时才触发)。
    dispose = installEventJournal({ projectRoot });
    getEventBus().emit('ui.surface.snapshot', { id: 'host.menubar', snapshot: { content: 'x'.repeat(40 * 1024) } });
    dispose(); dispose = null;

    const [line] = await waitForLines(1);
    const payload = line!.payload as { id: string; snapshot: { content: string } };
    expect(payload.id).toBe('host.menubar');
    expect(payload.snapshot.content.endsWith('[truncated]')).toBe(true);
    expect(payload.snapshot.content.length).toBeLessThan(5_000);
  });

  it('字段数量把行撑爆时,整条 payload 仍换成摘要', async () => {
    // 单个超长字符串走上面的就地截断;而"字段很多、每个都不长"截不动 —— 32KB
    // 行上限这道闸必须还在,否则一条快照能把账本行撑到几百 KB。
    dispose = installEventJournal({ projectRoot });
    const wide: Record<string, string> = {};
    for (let i = 0; i < 4_000; i += 1) wide[`field_${i}`] = 'value';
    getEventBus().emit('ui.surface.snapshot', wide);
    dispose(); dispose = null;

    const [line] = await waitForLines(1);
    expect((line!.payload as { truncated?: boolean }).truncated).toBe(true);
    expect((line!.payload as { keys: string[] }).keys.length).toBe(4_000);
  });

  it('循环引用不抛异常,环处占位而整条 payload 保住', async () => {
    // 旧行为:JSON.stringify 抛 → 整条 payload 换成 {unserializable:true},id 也没了。
    // 脱敏层现在在遍历时就把环换成 '[circular]',非环部分完整留下 —— 同样是
    // "宁可占位不丢事实",但丢得更少。
    dispose = installEventJournal({ projectRoot });
    const payload: Record<string, unknown> = { id: 'circular' };
    payload.self = payload;

    expect(() => { getEventBus().emit('ui.surface.action', payload); }).not.toThrow();
    dispose(); dispose = null;

    const [line] = await waitForLines(1);
    expect(line!.payload).toEqual({ id: 'circular', self: '[circular]' });
  });

  it('bus 铸造的关联 token 必须原样保留 —— 它是跨账本唯一连接键', async () => {
    // 2026-08-06 外审 MAJOR:上一轮的一刀切脱敏把 token 抹成 [redacted],而这个项目
    // 的整条跨账本链就靠它逐字相等(工具结果 ↔ ui-events 的 action/acked 两条)。
    // 判据按**值形状**(surfaceId-seq-6位base36),不是键名例外 —— 键名例外会让插件
    // 把真凭据塞进 token 字段直接泄漏。
    dispose = installEventJournal({ projectRoot });
    getEventBus().emit('ui.surface.action', { id: 'host.menubar', token: 'host.menubar-1-i0p5wt', source: 'ai' });
    getEventBus().emit('ui.surface.action', { id: 'host.menubar', token: 'sk-proj-realsecret', source: 'ai' });
    dispose(); dispose = null;

    const lines = await waitForLines(2);
    expect((lines[0]!.payload as { token: string }).token).toBe('host.menubar-1-i0p5wt');
    expect((lines[1]!.payload as { token: string }).token).toBe('[redacted]');
  });

  it('密钥不落盘:非 UI topic 整条不收,UI topic 内的凭据键脱敏', async () => {
    // 2026-08-06 外审实锤:总线上的 tool.starting 携带工具原始入参,审计用假的
    // COS_SECRET_KEY 实跑,密钥原文进了磁盘。两道防线各测一次。
    dispose = installEventJournal({ projectRoot });
    getEventBus().emit('tool.starting', { toolId: 'cos.upload', args: { COS_SECRET_KEY: 'AKIDsecret' } });
    getEventBus().emit('ui.surface.action', { id: 'host.menubar', args: { token: 'bearer-xyz', itemId: 'file.save' } });
    dispose(); dispose = null;

    const lines = await waitForLines(1);
    expect(lines).toHaveLength(1);                       // tool.starting 整条没收
    expect(lines[0]!.topic).toBe('ui.surface.action');
    const args = (lines[0]!.payload as { args: Record<string, unknown> }).args;
    expect(args.token).toBe('[redacted]');               // 白名单内也照脱
    expect(args.itemId).toBe('file.save');               // 非凭据键原样保留
    const raw = readFileSync(journalPath(), 'utf8');
    expect(raw).not.toContain('AKIDsecret');
    expect(raw).not.toContain('bearer-xyz');
  });

  it('二次轮转不覆盖第一次的归档 —— 归档只增不覆盖', async () => {
    // 2026-08-05 终审:归档名此前是安装时算一次的常量,第二次轮转会先 rm 掉第一次
    // 的归档再改名过去,确定性地销毁一整份历史。这里直接驱动 rotateIfNeeded 的
    // 两次触发,断言两份归档并存。
    const { mkdirSync, writeFileSync, readdirSync } = await import('node:fs');
    const dir = join(projectRoot, '.forgeax');
    mkdirSync(dir, { recursive: true });

    dispose = installEventJournal({ projectRoot });
    const bus = getEventBus();

    // 两轮:每轮先把 journal 撑到超过上限,再发一条事件触发 flush→rotate。
    for (let round = 0; round < 2; round += 1) {
      writeFileSync(join(dir, 'ui-events.jsonl'), 'x'.repeat(33 * 1024 * 1024));
      bus.emit('ui.surface.action', { id: `round-${round}`, source: 'user' });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    dispose(); dispose = null;
    await new Promise((resolve) => setTimeout(resolve, 200));

    const archives = readdirSync(dir).filter((f) => /^ui-events-.+\.jsonl$/.test(f));
    expect(archives.length).toBe(2); // 两次轮转 = 两份归档,一份都不能少
  });

  it('卸载后不再写入', async () => {
    dispose = installEventJournal({ projectRoot });
    const bus = getEventBus();
    bus.emit('ui.surface.action', { id: 'before-dispose', source: 'user' });
    dispose(); dispose = null;
    await waitForLines(1);

    bus.emit('ui.surface.action', { id: 'after-dispose', source: 'ai' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readLines()).toHaveLength(1);
    expect(readLines()[0]?.payload.id).toBe('before-dispose');
  });
});
