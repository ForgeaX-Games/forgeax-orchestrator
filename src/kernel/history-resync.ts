import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';

/**
 * A Codex app-server thread is process-local.  When its owner changes after
 * history composition, the first attempt must not start a blank native thread.
 * The kernel emits this exact protocol sentinel before `turn/start`; callers
 * may therefore safely compose one complete history snapshot and try once.
 */
export const HISTORY_RESYNC_REQUIRED_MESSAGE =
  'codex native history changed; retrying with a full history snapshot';

export function isHistoryResyncRequired(event: KernelEvent): boolean {
  return event.kind === 'error'
    && event.error.code === 'protocol'
    && event.error.message === HISTORY_RESYNC_REQUIRED_MESSAGE;
}

function isBareUsage(event: KernelEvent): boolean {
  return event.kind === 'turn.usage'
    && !event.inputTokens
    && !event.outputTokens
    && !event.cacheRead
    && !event.cacheCreation
    && !event.costUsd
    && !event.durationMs;
}

/**
 * Run a composed turn and, only for the pre-admission history sentinel, rebuild
 * it once from the host-owned full snapshot.  Control frames from the rejected
 * attempt never escape to UI/WAL callers.  Any model text, tool, stored event,
 * non-bare usage, or second failure is final and is forwarded unchanged.
 */
export async function* runWithHistoryResync(options: {
  initial: TurnRequest;
  retrySnapshot: () => Promise<TurnRequest>;
  run: (request: TurnRequest) => AsyncIterable<KernelEvent>;
  onRetrySnapshot?: (request: TurnRequest) => void;
}): AsyncIterable<KernelEvent> {
  let request = options.initial;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deferred: KernelEvent[] = [];
    let awaitingResyncTerminal = false;
    let substantive = false;

    for await (const event of options.run(request)) {
      if (!substantive && !awaitingResyncTerminal && isBareUsage(event)) {
        deferred.push(event);
        continue;
      }
      if (!substantive && !awaitingResyncTerminal && attempt === 0 && isHistoryResyncRequired(event)) {
        awaitingResyncTerminal = true;
        continue;
      }

      // A first-attempt sentinel is followed only by its terminal frame.  If a
      // future kernel violates that contract, preserve the event rather than
      // silently dropping potentially visible or durable work.
      if (awaitingResyncTerminal) {
        if (event.kind === 'turn.done') continue;
        for (const pending of deferred) yield pending;
        deferred.length = 0;
        substantive = true;
        yield {
          kind: 'error',
          error: { code: 'protocol', message: HISTORY_RESYNC_REQUIRED_MESSAGE },
        };
        awaitingResyncTerminal = false;
      }

      for (const pending of deferred) yield pending;
      deferred.length = 0;
      if (event.kind !== 'turn.done') substantive = true;
      yield event;
    }

    if (awaitingResyncTerminal && !substantive) {
      request = await options.retrySnapshot();
      options.onRetrySnapshot?.(request);
      continue;
    }
    for (const pending of deferred) yield pending;
    return;
  }
}
