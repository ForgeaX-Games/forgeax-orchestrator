import { expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { EventBus } from '../src/core/event-bus';
import type { Session } from '../src/core/session';
import { WsHub, type WsClientData } from '../src/ws';

function session(sid: string) {
  const eventBus = new EventBus();
  return { sid, eventBus } as Session;
}
function client(sid: string, sgen: string) {
  const frames: Array<{ event: { type: string; seq: number } }> = [];
  const ws = { data: { sid, sgen }, send: (json: string) => { frames.push(JSON.parse(json)); } } as unknown as ServerWebSocket<WsClientData>;
  return { ws, frames };
}
function completion(session: Session) {
  // The real delegation callback is an earlier observer. Its publication is
  // reentrant: the later WS observer sees the callback before the turn-end.
  session.eventBus.observe((event, emitter) => {
    if (event.type === 'hook:turnEnd') {
      session.eventBus.publish({ ts: Date.now(), type: 'message', source: 'agent', to: 'parent', payload: { content: 'delivered' } }, emitter);
    }
  });
}

test('live subscribers receive a terminal event before its reentrant completion callback', async () => {
  const s = session('ordered-live');
  completion(s);
  const hub = new WsHub();
  const a = client(s.sid, s.eventBus.sgen);
  const b = client(s.sid, s.eventBus.sgen);
  hub.attachSession(a.ws, s);
  hub.attachSession(b.ws, s);
  s.eventBus.publish({ ts: Date.now(), type: 'hook:turnStart', source: 'agent:child', payload: {} }, 'child');
  s.eventBus.publish({ ts: Date.now(), type: 'hook:turnEnd', source: 'agent:child', payload: {} }, 'child');
  await Promise.resolve();
  expect(a.frames.map(f => [f.event.type, f.event.seq])).toEqual([
    ['hook:turnStart', 1], ['hook:turnEnd', 2], ['message', 3],
  ]);
  expect(b.frames).toEqual(a.frames);
  // Exercise the receiver's monotonic dedup contract rather than only checking
  // the JSON order: the completion must actually clear the child's busy state.
  let cursor = 0;
  let busy = false;
  for (const { event } of a.frames) {
    if (event.seq <= cursor) continue;
    cursor = event.seq;
    if (event.type === 'hook:turnStart') busy = true;
    if (event.type === 'hook:turnEnd') busy = false;
  }
  expect(busy).toBe(false);
});

test('joining before the flush replays the same ordered ring without duplicate pending frames', async () => {
  const s = session('ordered-resume');
  completion(s);
  const hub = new WsHub();
  const a = client(s.sid, s.eventBus.sgen);
  hub.attachSession(a.ws, s);
  s.eventBus.publish({ ts: Date.now(), type: 'hook:turnEnd', source: 'agent:child', payload: {} }, 'child');
  const b = client(s.sid, s.eventBus.sgen);
  hub.attachSession(b.ws, s);
  expect(hub.resume(b.ws, s, 0)).toBe(true);
  await Promise.resolve();
  expect(a.frames.map(f => f.event.seq)).toEqual([1, 2]);
  expect(b.frames).toEqual(a.frames);
});

test('session queues remain independent and ring eviction still reports a resume gap', async () => {
  const hub = new WsHub();
  const s = session('bounded-ring');
  const other = session('independent');
  const a = client(s.sid, s.eventBus.sgen);
  const b = client(other.sid, other.eventBus.sgen);
  hub.attachSession(a.ws, s);
  hub.attachSession(b.ws, other);
  for (let i = 0; i < 520; i++) s.eventBus.publish({ ts: Date.now(), type: 'tick', source: 'test', payload: {} });
  other.eventBus.publish({ ts: Date.now(), type: 'tick', source: 'test', payload: {} });
  await Promise.resolve();
  expect(a.frames).toHaveLength(520);
  expect(b.frames.map(f => f.event.seq)).toEqual([1]);
  const replay = client(s.sid, s.eventBus.sgen);
  expect(hub.resume(replay.ws, s, 0)).toBe(false);
  expect(hub.resume(replay.ws, s, 518)).toBe(true);
  expect(replay.frames.map(f => f.event.seq)).toEqual([519, 520]);
});
