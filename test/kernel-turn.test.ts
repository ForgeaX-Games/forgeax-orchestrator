/** inferKernelTurnError —— kernel turn 失败不被吞成「空响应」的兜底契约
 *  (bug-empty-response-2026-07-13)。
 *
 *  背景:内核只发 `turn.done { reason: "error" }` 而不带 error payload 时,
 *  runKernelTurn 的 error 保持 undefined → hook:turnEnd 无 error → 前端把
 *  消息标成 status:'done' → ForgeCard 渲染 emptyResponse 占位,失败被吞。
 *  本函数在 reason=error 且无显式 error 时合成可读错误字符串。锁三个行为:
 *    (a) 已有显式 error → 原样保留,不覆盖
 *    (b) reason=error 且无 error → 合成(带/不带 model 两种拼法)
 *    (c) stop / cancelled / undefined 等非-error reason → 不合成
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerKernel,
  unregisterKernel,
  type AgentKernel,
  type KernelCapabilities,
  type KernelEvent,
  type TurnRequest,
} from '@forgeax/agent-runtime';
import {
  inferKernelTurnError,
  projectKernelCompactionDiagnostic,
  runKernelTurn,
} from '../src/runtime/kernel-turn-runner';
import type { Event, EventBusAPI, EventPayload, SelfEvent } from '../src/core/types';
import { EventStore } from '../src/ledger/event-store';
import { SessionEventPaths } from '../src/ledger/session-event-paths';
import type { StoredEvent } from '../src/ledger/types';
import { eventsToMessages } from '../src/context-window/history-pipeline';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { materializeTurnContext } from '../src/runtime/turn-context';

const COMPACTION_KERNEL_ID = 'compaction-boundary-test';

afterEach(() => {
  unregisterKernel(COMPACTION_KERNEL_ID);
});

describe('inferKernelTurnError', () => {
  test('保留显式 error,不被合成文案覆盖', () => {
    expect(inferKernelTurnError('error', 'rate_limit: 429 too many requests', 'claude-fable-5')).toBe(
      'rate_limit: 429 too many requests',
    );
    // 显式 error 优先级最高:即便 reason 不是 error 也原样透传
    expect(inferKernelTurnError('stop', 'boom')).toBe('boom');
  });

  test('reason=error 且无 payload → 合成可读错误', () => {
    expect(inferKernelTurnError('error', undefined, 'claude-fable-5')).toBe(
      'kernel turn ended with reason=error but produced no error payload (model: claude-fable-5)',
    );
    expect(inferKernelTurnError('error', undefined)).toBe(
      'kernel turn ended with reason=error but produced no error payload',
    );
  });

  test('stop / cancelled / max_turns / undefined → 不合成', () => {
    expect(inferKernelTurnError('stop', undefined, 'claude-fable-5')).toBeUndefined();
    expect(inferKernelTurnError('cancelled', undefined)).toBeUndefined();
    expect(inferKernelTurnError('max_turns', undefined)).toBeUndefined();
    expect(inferKernelTurnError(undefined, undefined)).toBeUndefined();
  });
});

describe('runKernelTurn compaction persistence', () => {
  test('persists the canonical replacement and materializes summary plus retained tail', async () => {
    const kernel: AgentKernel = {
      id: COMPACTION_KERNEL_ID as AgentKernel['id'],
      capabilities: {} as AgentKernel['capabilities'],
      async *runTurn(_request: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
        if (signal.aborted) return;
        yield {
          kind: 'stored-event',
          payload: {
            type: 'compaction.applied',
            payload: {
              trigger: 'pre-message',
              coveredFrom: 0,
              coveredTo: 2,
              replacement: {
                role: 'user',
                content: 'SUMMARY_FROM_REAL_KERNEL with EARLY_SENTINEL',
              },
              keepCount: 1,
              preTokens: 145_200,
              postTokens: 31_400,
            },
          },
        };
        yield { kind: 'message.delta', role: 'assistant', text: 'continued' };
        yield { kind: 'turn.done', reason: 'stop' };
      },
      openHandle: () => ({ cancel: async () => {} }) as ReturnType<AgentKernel['openHandle']>,
      probe: async () => ({ ok: true }) as Awaited<ReturnType<AgentKernel['probe']>>,
    };
    registerKernel(kernel);

    const root = mkdtempSync(join(tmpdir(), 'forgeax-canonical-compaction-reload-'));
    const binding = {
      ownerInstanceId: 'forge-instance',
      runtimeEpochId: 'epoch-1',
      storeId: 'store:forge-instance',
      locator: { relativeDir: 'agents/forge/events' },
    } as const;
    resetPathManager();
    initPathManager({ userRoot: root });
    const paths = new SessionEventPaths(root).resolve(binding.locator);
    let store = new EventStore(binding, paths);
    const publish = (event: Event, emitterId = 'forge'): void => {
      store.ledger.append(event, emitterId);
    };
    const eventBus: EventBusAPI = {
      publish,
      emit: publish,
      emitToSelf(event: SelfEvent) {
        publish({ ...event, to: 'forge' } as Event);
      },
      hook(type: string, payload: EventPayload): Event {
        const event = { type, payload, source: 'agent:forge', ts: Date.now() } as Event;
        publish(event);
        return event;
      },
      observe: () => () => {},
      observeAgent: () => () => {},
    };
    for (const event of [
      { type: 'inbound_message', ts: 1, source: 'user', payload: { llmMessage: { role: 'user', content: [{ type: 'text', text: 'OLD_RAW_SHOULD_DROP' }], ts: 1 } } },
      { type: 'inbound_message', ts: 2, source: 'agent', payload: { llmMessage: { role: 'assistant', content: [{ type: 'text', text: 'OLD_ASSISTANT_SHOULD_DROP' }], ts: 2 } } },
      { type: 'inbound_message', ts: 3, source: 'user', payload: { llmMessage: { role: 'user', content: [{ type: 'text', text: 'RETAINED_TAIL_MESSAGE' }], ts: 3 } } },
    ] as Event[]) publish(event);

    try {
      const result = await runKernelTurn({
        agentId: 'forge',
        instanceId: 'resident-forge',
        runtimeEpochId: 'epoch-test',
        kernelId: COMPACTION_KERNEL_ID,
        userText: 'continue after automatic compaction',
        eventBus,
        signal: new AbortController().signal,
        turn: 7,
        model: 'claude-fable-5',
      });
      expect(result).toMatchObject({ status: 'completed', output: 'continued' });
      expect(await store.ledger.readAllEvents()).toContainEqual(expect.objectContaining({
        type: 'compact_boundary',
        source: `kernel:${COMPACTION_KERNEL_ID}`,
        payload: expect.objectContaining({
          summary: 'SUMMARY_FROM_REAL_KERNEL with EARLY_SENTINEL',
          keepCount: 1,
          coveredFrom: 0,
          coveredTo: 2,
        }),
      }));

      store.dispose();
      store = new EventStore(binding, paths);
      const context = await materializeTurnContext({ agentId: 'forge', ledger: store.ledger });
      const materialized = JSON.stringify(context);
      expect(materialized).toContain('SUMMARY_FROM_REAL_KERNEL');
      expect(materialized).toContain('EARLY_SENTINEL');
      expect(materialized).toContain('RETAINED_TAIL_MESSAGE');
      expect(materialized).not.toContain('OLD_RAW_SHOULD_DROP');
      expect(materialized).not.toContain('OLD_ASSISTANT_SHOULD_DROP');
    } finally {
      store.dispose();
      resetPathManager();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('malformed canonical applied events fail closed across durable reload', async () => {
    const valid = {
      replacement: { role: 'user', content: 'VALID SUMMARY' },
      keepCount: 1,
      coveredFrom: 0,
      coveredTo: 0,
      llmMessage: { role: 'user', content: 'MUST_NOT_PERSIST' },
    };
    const cases: Array<{ name: string; payload: Record<string, unknown> }> = [
      { name: 'bare replacement string', payload: { ...valid, replacement: 'SUMMARY' } },
      { name: 'wrong replacement role', payload: { ...valid, replacement: { role: 'assistant', content: 'SUMMARY' } } },
      { name: 'malformed replacement content', payload: { ...valid, replacement: { role: 'user', content: [{ type: 'image', data: 'x' }] } } },
      { name: 'non-text block with text field', payload: { ...valid, replacement: { role: 'user', content: [{ type: 'image', text: 'SUMMARY' }] } } },
      { name: 'missing keepCount', payload: (({ keepCount: _drop, ...rest }) => rest)(valid) },
      { name: 'negative keepCount', payload: { ...valid, keepCount: -1 } },
      { name: 'NaN keepCount', payload: { ...valid, keepCount: Number.NaN } },
      { name: 'fractional keepCount', payload: { ...valid, keepCount: 1.5 } },
      { name: 'infinite keepCount', payload: { ...valid, keepCount: Number.POSITIVE_INFINITY } },
      { name: 'missing coveredFrom', payload: (({ coveredFrom: _drop, ...rest }) => rest)(valid) },
      { name: 'reversed range', payload: { ...valid, coveredFrom: 1, coveredTo: 0 } },
      { name: 'non-prefix range', payload: { ...valid, coveredFrom: 1, coveredTo: 1 } },
    ];

    for (const [index, scenario] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `forgeax-malformed-compaction-${index}-`));
      const kernelId = `malformed-compaction-${index}`;
      const binding = {
        ownerInstanceId: `forge-instance-${index}`,
        runtimeEpochId: 'epoch-1',
        storeId: `store:forge-instance-${index}`,
        locator: { relativeDir: 'agents/forge/events' },
      } as const;
      resetPathManager();
      initPathManager({ userRoot: root });
      const paths = new SessionEventPaths(root).resolve(binding.locator);
      let store = new EventStore(binding, paths);
      const publish = (event: Event, emitterId = 'forge'): void => {
        store.ledger.append(event, emitterId);
      };
      const eventBus: EventBusAPI = {
        publish,
        emit: publish,
        emitToSelf(event: SelfEvent) { publish({ ...event, to: 'forge' } as Event); },
        hook(type: string, payload: EventPayload): Event {
          const event = { type, payload, source: 'agent:forge', ts: Date.now() } as Event;
          publish(event);
          return event;
        },
        observe: () => () => {},
        observeAgent: () => () => {},
      };
      const kernel: AgentKernel = {
        id: kernelId as AgentKernel['id'],
        capabilities: {} as AgentKernel['capabilities'],
        async *runTurn(): AsyncIterable<KernelEvent> {
          yield {
            kind: 'stored-event',
            payload: { type: 'compaction.applied', payload: scenario.payload },
          };
          yield { kind: 'turn.done', reason: 'stop' };
        },
        openHandle: () => ({ cancel: async () => {} }) as ReturnType<AgentKernel['openHandle']>,
        probe: async () => ({ ok: true }) as Awaited<ReturnType<AgentKernel['probe']>>,
      };
      registerKernel(kernel);
      publish({
        type: 'inbound_message',
        ts: 1,
        source: 'user',
        payload: { llmMessage: { role: 'user', content: [{ type: 'text', text: 'OLD_HISTORY_MUST_SURVIVE' }], ts: 1 } },
      });
      publish({
        type: 'inbound_message',
        ts: 2,
        source: 'user',
        payload: { llmMessage: { role: 'user', content: [{ type: 'text', text: 'TAIL_MUST_SURVIVE' }], ts: 2 } },
      });

      try {
        await runKernelTurn({
          agentId: 'forge',
          kernelId,
          userText: scenario.name,
          eventBus,
          signal: new AbortController().signal,
          turn: 1,
        });
        store.dispose();
        store = new EventStore(binding, paths);
        const persisted = await store.ledger.readAllEvents();
        expect(persisted.some((event) => event.type === 'compact_boundary')).toBe(false);
        const audit = persisted.find((event) => event.type === 'compaction.applied');
        expect(audit?.payload?.reconstruction).toMatchObject({ status: 'unavailable' });
        expect(audit?.payload?.llmMessage).toBeUndefined();
        const materialized = JSON.stringify(
          await materializeTurnContext({ agentId: 'forge', ledger: store.ledger }),
        );
        expect(materialized).toContain('OLD_HISTORY_MUST_SURVIVE');
        expect(materialized).toContain('TAIL_MUST_SURVIVE');
      } finally {
        unregisterKernel(kernelId);
        store.dispose();
        resetPathManager();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('persists structured CompactionFailed recovery evidence', async () => {
    const kernel: AgentKernel = {
      id: COMPACTION_KERNEL_ID as AgentKernel['id'],
      capabilities: {} as AgentKernel['capabilities'],
      async *runTurn(): AsyncIterable<KernelEvent> {
        yield {
          kind: 'stored-event',
          payload: {
            type: 'compaction.failed',
            payload: {
              error: 'summary request rejected',
              trigger: 'auto',
              type: 'pre-message-auto',
              tokenCount: 145_200,
              recovery: {
                action: 'continue_without_compaction',
                history: 'unchanged',
                retryable: true,
              },
            },
          },
        };
        yield { kind: 'message.delta', role: 'assistant', text: 'continued safely' };
        yield { kind: 'turn.done', reason: 'stop' };
      },
      openHandle: () => ({ cancel: async () => {} }) as ReturnType<AgentKernel['openHandle']>,
      probe: async () => ({ ok: true }) as Awaited<ReturnType<AgentKernel['probe']>>,
    };
    registerKernel(kernel);

    const published: Event[] = [];
    const eventBus: EventBusAPI = {
      publish(event) { published.push(event); },
      emit() {},
      emitToSelf() {},
      hook() { return {} as Event; },
      observe() { return () => {}; },
      observeAgent() { return () => {}; },
    };

    const result = await runKernelTurn({
      agentId: 'forge',
      kernelId: COMPACTION_KERNEL_ID,
      userText: 'continue',
      eventBus,
      signal: new AbortController().signal,
      turn: 1,
    });

    expect(result).toMatchObject({ status: 'completed', output: 'continued safely' });
    expect(published).toContainEqual({
      type: 'compaction.failed',
      ts: expect.any(Number),
      source: `kernel:${COMPACTION_KERNEL_ID}`,
      payload: {
        error: 'summary request rejected',
        trigger: 'auto',
        type: 'pre-message-auto',
        tokenCount: 145_200,
        recovery: {
          action: 'continue_without_compaction',
          history: 'unchanged',
          retryable: true,
        },
        kernelEventKind: 'stored-event',
        providerId: COMPACTION_KERNEL_ID,
        kernelId: COMPACTION_KERNEL_ID,
      },
    });
  });

  test('keeps legacy compact_boundary observational and non-truncating', async () => {
    const kernel: AgentKernel = {
      id: COMPACTION_KERNEL_ID as AgentKernel['id'],
      capabilities: {} as AgentKernel['capabilities'],
      async *runTurn(): AsyncIterable<KernelEvent> {
        yield { kind: 'compact_boundary', coveredFrom: 0, coveredTo: 3, trigger: 'auto' };
        yield { kind: 'turn.done', reason: 'stop' };
      },
      openHandle: () => ({ cancel: async () => {} }) as ReturnType<AgentKernel['openHandle']>,
      probe: async () => ({ ok: true }) as Awaited<ReturnType<AgentKernel['probe']>>,
    };
    registerKernel(kernel);
    const published: Event[] = [];
    const eventBus: EventBusAPI = {
      publish(event) { published.push(event); },
      emit() {},
      emitToSelf() {},
      hook() { return {} as Event; },
      observe() { return () => {}; },
      observeAgent() { return () => {}; },
    };

    await runKernelTurn({
      agentId: 'forge',
      kernelId: COMPACTION_KERNEL_ID,
      userText: 'continue',
      eventBus,
      signal: new AbortController().signal,
      turn: 1,
    });

    expect(published.some((event) => event.type === 'compact_boundary')).toBe(false);
    expect(published).toContainEqual({
      type: 'compaction.observed',
      ts: expect.any(Number),
      source: `kernel:${COMPACTION_KERNEL_ID}`,
      payload: {
        coveredFrom: 0,
        coveredTo: 3,
        trigger: 'auto',
        providerId: COMPACTION_KERNEL_ID,
        kernelId: COMPACTION_KERNEL_ID,
      },
    });
  });
});

describe('kernel compaction diagnostics', () => {
  test('projects only failed/post diagnostics and strips history-bearing payloads', () => {
    const event = projectKernelCompactionDiagnostic({
      kind: 'stored-event',
      payload: {
        type: 'compaction.post',
        payload: {
          usedLLM: true,
          rehydrate: { attached: 1, failed: 0 },
          llmMessage: { role: 'user', content: 'must not materialize' },
        },
      },
    }, 'forge', 1234);
    expect(event).toEqual({
      type: 'compaction.post',
      ts: 1234,
      source: 'agent:forge',
      payload: {
        usedLLM: true,
        rehydrate: { attached: 1, failed: 0 },
        kernelEventKind: 'stored-event',
      },
    });
    expect(projectKernelCompactionDiagnostic({
      kind: 'stored-event',
      payload: { type: 'unrelated', payload: { value: 1 } },
    }, 'forge')).toBeUndefined();
  });

  test('runKernelTurn persists forgeax-core diagnostics in the agent ledger without changing materialized history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-kernel-compaction-diagnostics-'));
    const kernelId = 'test-compaction-diagnostics';
    const capabilities: KernelCapabilities = {
      streaming: true,
      thinking: false,
      toolCalls: false,
      midTurnInject: false,
      forkExtract: false,
    };
    const kernel: AgentKernel = {
      id: kernelId as AgentKernel['id'],
      capabilities,
      async *runTurn(): AsyncIterable<KernelEvent> {
        yield {
          kind: 'stored-event',
          payload: {
            type: 'compaction.failed',
            payload: { error: 'summary overflow', diagnostics: { reason: 'split_exhausted' } },
          },
        };
        yield {
          kind: 'stored-event',
          payload: {
            type: 'compaction.post',
            payload: { usedLLM: true, rehydrate: { attached: 2, failed: 1 } },
          },
        };
        yield { kind: 'message.delta', role: 'assistant', text: 'answer' };
        yield { kind: 'turn.done', reason: 'stop' };
      },
      openHandle: () => ({
        setPermissionMode: async () => {},
        setModel: async () => {},
        interrupt: async () => {},
        cancel: async () => {},
      }),
      probe: async () => ({ ok: true, kernelId }),
    };

    resetPathManager();
    initPathManager({ userRoot: root });
    const paths = new SessionEventPaths(root);
    const locator = { relativeDir: 'agents/forge/events' };
    const store = new EventStore({
      ownerInstanceId: 'forge-instance',
      runtimeEpochId: 'epoch-1',
      storeId: 'store:forge-instance',
      locator,
    }, paths.resolve(locator));
    const publish = (event: Event, emitterId = 'forge'): void => {
      store.ledger.append(event, emitterId);
    };
    const eventBus: EventBusAPI = {
      publish,
      emit: publish,
      emitToSelf(event: SelfEvent) {
        publish({ ...event, to: 'forge' } as Event);
      },
      hook(type: string, payload: EventPayload): Event {
        const event = { type, payload, source: 'agent:forge', ts: Date.now() } as Event;
        publish(event);
        return event;
      },
      observe: () => () => {},
      observeAgent: () => () => {},
    };

    unregisterKernel(kernelId);
    registerKernel(kernel);
    try {
      const result = await runKernelTurn({
        agentId: 'forge',
        kernelId,
        userText: 'continue',
        eventBus,
        signal: new AbortController().signal,
        turn: 1,
      });
      expect(result.status).toBe('completed');
      const stored = await store.ledger.readAllEvents();
      const diagnostics = stored.filter(
        (event) => event.type === 'compaction.failed' || event.type === 'compaction.post',
      );
      expect(diagnostics.map((event) => event.type)).toEqual([
        'compaction.failed',
        'compaction.post',
      ]);
      expect(diagnostics.every((event) => event.emitterId === 'forge')).toBe(true);
      expect(diagnostics[0]?.payload).toMatchObject({
        error: 'summary overflow',
        diagnostics: { reason: 'split_exhausted' },
        kernelEventKind: 'stored-event',
      });
      expect(diagnostics[1]?.payload).toMatchObject({
        usedLLM: true,
        rehydrate: { attached: 2, failed: 1 },
        kernelEventKind: 'stored-event',
      });
      expect(stored.some((event) => event.type === 'compact_boundary')).toBe(false);
      expect(eventsToMessages(stored)).toEqual(eventsToMessages(
        stored.filter(
          (event) => event.type !== 'compaction.failed' && event.type !== 'compaction.post',
        ),
      ));
    } finally {
      unregisterKernel(kernelId);
      store.dispose();
      resetPathManager();
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('provider failure output', () => {
  for (const text of ['', 'I will inspect the project.']) {
    test(`preserves structured errors without synthetic assistant prose (${text ? 'partial' : 'empty'})`, async () => {
      const kernel: AgentKernel = {
        id: COMPACTION_KERNEL_ID as AgentKernel['id'],
        capabilities: {} as AgentKernel['capabilities'],
        async *runTurn(): AsyncIterable<KernelEvent> {
          if (text) yield { kind: 'message.delta', role: 'assistant', text };
          yield { kind: 'error', error: { code: 'protocol', message: 'Invalid schema for function ask_user' } };
          yield { kind: 'turn.done', reason: 'error' };
        },
        openHandle: () => ({ cancel: async () => {} }) as ReturnType<AgentKernel['openHandle']>,
        probe: async () => ({ ok: true }) as Awaited<ReturnType<AgentKernel['probe']>>,
      };
      registerKernel(kernel);
      const events: Event[] = [];
      const eventBus: EventBusAPI = {
        publish(event) { events.push(event); }, emit() {}, emitToSelf() {},
        hook(type, payload) {
          const event = { type, payload, source: 'agent:forge', ts: Date.now() } as Event;
          events.push(event); return event;
        },
        observe: () => () => {}, observeAgent: () => () => {},
      };
      const result = await runKernelTurn({ agentId: 'forge', kernelId: COMPACTION_KERNEL_ID,
        userText: 'hello', eventBus, signal: new AbortController().signal, turn: 1 });
      expect(result).toMatchObject({ status: 'failed', error: 'protocol: Invalid schema for function ask_user' });
      const assistant = events.filter(event => event.type === 'hook:assistantMessage');
      expect(assistant).toHaveLength(text ? 1 : 0);
      expect(JSON.stringify(assistant)).not.toContain('Invalid schema');
      if (text) expect(JSON.stringify(assistant)).toContain(text);
    });
  }
});
