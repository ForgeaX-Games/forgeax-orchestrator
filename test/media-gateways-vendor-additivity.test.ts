// M2 acceptance anchor (AC-09 falsification, architecture-principles §2.5):
//
// The whole point of MediaGateways is that adding a provider is additive —
// server needs ZERO change because the provider enum was recalled into
// orchestrator. This test proves the orchestrator-side invariant: a brand-new
// (mock) TTS provider can be registered and dispatched to, and the exported
// `MediaGateways` capability face is byte-for-byte the same *shape* — no new
// member, no vendor-named symbol. If a future edit re-leaks a provider into the
// signature (e.g. a `mockConfigured()` predicate or a `createMockSpeech`
// factory on the face), the structural assertions below fail.
//
// "server source + typecheck unchanged" (AC-09 wording) is proven here on the
// producer side: the face type is closed against provider growth. The consumer
// half is exercised in M4 when ce-api-shim is rewritten.

import { afterEach, expect, test } from 'bun:test';
import { createMediaGateways, _registerTtsProvider, type MediaGateways } from '@forgeax/orchestrator/gateways';

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

test('a new mock TTS provider dispatches without any signature change (AC-09)', async () => {
  // Snapshot the public face key set *before* adding a provider.
  const before = createMediaGateways(process.env);
  const keysBefore = Object.keys(before).sort();

  // Register a mock provider — this is the only edit a "new vendor" costs.
  let mockCalled = false;
  const dispose = _registerTtsProvider({
    id: 'mock-vendor',
    isConfigured: () => true,
    synthesize: async () => {
      mockCalled = true;
      return { bytes: Buffer.from('MOCK'), mime: 'audio/mpeg' };
    },
  });
  disposers.push(dispose);

  const after = createMediaGateways(process.env);
  const keysAfter = Object.keys(after).sort();

  // (1) The capability face shape did not grow a member for the new provider.
  expect(keysAfter).toEqual(keysBefore);
  expect(keysAfter).toEqual(['capabilities', 'image', 'llm', 'music', 'sfx', 'tts', 'video']);

  // (2) The mock provider is genuinely reachable through the same verb — the
  //     dispatch is data-driven, not a hard-coded provider switch.
  const out = await after.tts.synthesize({ input: 'hi', voice: 'v' });
  expect(mockCalled).toBe(true);
  expect(out.bytes.toString()).toBe('MOCK');

  // (3) capabilities() picks the new provider up by its label, again with no
  //     signature change (the providers list is a value, not a typed enum).
  expect(after.capabilities().tts.providers).toContain('mock-vendor');
});

test('the exported face exposes only capability verbs — no vendor symbols leak', () => {
  const gw: MediaGateways = createMediaGateways(process.env);
  // Verb face is present …
  expect(typeof gw.tts.synthesize).toBe('function');
  expect(typeof gw.music.generate).toBe('function');
  expect(typeof gw.sfx.generate).toBe('function');
  expect(typeof gw.image.generate).toBe('function');
  expect(typeof gw.video.create).toBe('function');
  expect(typeof gw.video.status).toBe('function');
  expect(typeof gw.video.download).toBe('function');
  expect(typeof gw.llm.complete).toBe('function');
  expect(typeof gw.capabilities).toBe('function');

  // … and no per-vendor predicate / factory bled onto the face. A consumer can
  // never write `gw.doubaoConfigured()` or `gw.createArkVideoTask()`.
  const bag = gw as unknown as Record<string, unknown>;
  for (const banned of [
    'doubaoTtsConfigured',
    'minimaxTtsConfigured',
    'litellmTtsConfigured',
    'arkVideoConfigured',
    'isArkTaskId',
    'vendorForModel',
    'createArkVideoTask',
    'createDoubaoSpeech',
  ]) {
    expect(bag[banned], `vendor symbol leaked onto face: ${banned}`).toBeUndefined();
  }
});
