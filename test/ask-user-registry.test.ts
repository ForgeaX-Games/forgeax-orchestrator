import { describe, expect, it } from 'bun:test';
import {
  registerAsk,
  resolveAsk,
  resolveAskReply,
  setExternalAskReplyResolver,
} from '../src/core/ask-user-registry';

describe('ask user registry', () => {
  it('does not expire a zero-timeout ask before the user answers', async () => {
    const handle = registerAsk('no-timeout-ask-session', 'forge', 0);
    const early = await Promise.race([
      handle.promise.then(() => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);

    expect(early).toBe('pending');
    expect(resolveAsk('no-timeout-ask-session', 'forge', [
      { questionId: 'direction', values: ['Platformer'] },
    ])).toBe(true);
    expect(await handle.promise).toEqual([
      { questionId: 'direction', values: ['Platformer'] },
    ]);
    handle.dispose();
  });

  it('returns all grouped question answers without flattening them', async () => {
    const handle = registerAsk('grouped-ask-session', 'forge', 0);
    const answers = [
      { questionId: 'direction', values: ['Platformer'] },
      { questionId: 'priorities', values: ['Feel', 'Visuals'] },
    ];
    expect(resolveAsk('grouped-ask-session', 'forge', answers)).toBe(true);
    expect(await handle.promise).toEqual(answers);
    handle.dispose();
  });

  it('shares pending asks across duplicate package entry module instances', async () => {
    // @ts-expect-error Bun supports query-suffixed module identities; TypeScript
    // intentionally has no declaration for this synthetic duplicate entry.
    const duplicate = await import('../src/core/ask-user-registry.ts?entry=duplicate');
    const handle = registerAsk('duplicate-entry-ask-session', 'forge', 0);
    const answers = [{ questionId: 'mode', values: ['A'] }];

    expect(duplicate.resolveAsk('duplicate-entry-ask-session', 'forge', answers)).toBe(true);
    expect(await handle.promise).toEqual(answers);
    handle.dispose();
  });

  it('falls back to the product resolver when the local module graph misses', async () => {
    const answers = [{ questionId: 'mode', values: ['B'] }];
    let received: unknown;
    setExternalAskReplyResolver((_sid, _agent, values) => {
      received = values;
      return true;
    });

    expect(await resolveAskReply('external-ask-session', 'forge', answers)).toBe(true);
    expect(received).toEqual(answers);
    setExternalAskReplyResolver(() => false);
  });
});
