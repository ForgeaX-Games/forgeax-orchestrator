// M2 acceptance anchor (D-2, AC-09): MediaGateways provider dispatch.
//
// Verifies the capability face selects the right provider for the env, falls
// back down the chain, and fails *explicitly* when nothing is configured
// (charter P3) — never a silent empty result. Providers read process.env, so
// each test stubs the relevant keys and restores them afterward.
//
// This test drives the collapse of ce-api-shim's `if (xConfigured()) … else`
// branches into the facade: the consumer no longer sees a provider enum.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMediaGateways } from '@forgeax/orchestrator/gateways';

// Keys the audio/video providers probe. Saved + wiped before each test so an
// ambient .env does not leak provider readiness into assertions.
const PROVIDER_KEYS = [
  'LITELLM_PROXY_BASE_URL',
  'LITELLM_PROXY_KEY',
  'MINIMAX_API_KEY',
  'DOUBAO_TTS_KEY',
  'DOUBAO_TTS_APP_ID',
  'MINIMAX_MUSIC_KEY',
  'ELEVENLABS_API_KEY',
  'ARK_VIDEO_KEY',
] as const;

let saved: Record<string, string | undefined> = {};
let realFetch: typeof fetch;

beforeEach(() => {
  saved = {};
  for (const k of PROVIDER_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  realFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of PROVIDER_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
});

describe('MediaGateways.tts', () => {
  test('no provider configured → explicit failure (charter P3)', async () => {
    const gw = createMediaGateways(process.env);
    await expect(gw.tts.synthesize({ input: 'hello', voice: 'BV001_streaming' })).rejects.toThrow(
      /no provider configured/,
    );
  });

  test('selects litellm first when the proxy is configured', async () => {
    process.env.LITELLM_PROXY_BASE_URL = 'https://proxy.invalid/v1';
    process.env.LITELLM_PROXY_KEY = 'sk-test';
    let hitUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      hitUrl = String(url);
      return new Response(Buffer.from('AUDIO'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as typeof fetch;

    const gw = createMediaGateways(process.env);
    const out = await gw.tts.synthesize({ input: 'hi', voice: 'BV001_streaming' });
    expect(hitUrl).toContain('/audio/speech'); // litellm endpoint
    expect(out.mime).toContain('audio');
    expect(out.bytes.toString()).toBe('AUDIO');
  });

  test('falls through to the next provider when the first throws', async () => {
    // litellm configured but failing; minimax configured and succeeding.
    process.env.LITELLM_PROXY_BASE_URL = 'https://proxy.invalid/v1';
    process.env.LITELLM_PROXY_KEY = 'sk-test';
    process.env.MINIMAX_API_KEY = 'mm-test';
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/audio/speech')) {
        // litellm returns JSON error even on 200 → gateway throws.
        return new Response(JSON.stringify({ error: 'nope' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // minimax t2a path succeeds with a hex audio envelope.
      return new Response(
        JSON.stringify({ data: { audio: Buffer.from('MM').toString('hex') }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const gw = createMediaGateways(process.env);
    const out = await gw.tts.synthesize({ input: 'hi', voice: 'female-tianmei' });
    expect(seen.some((u) => u.includes('/audio/speech'))).toBe(true); // litellm tried
    expect(out.bytes.toString()).toBe('MM'); // minimax served
  });
});

describe('MediaGateways.music / sfx', () => {
  test('music: unconfigured → explicit failure', async () => {
    const gw = createMediaGateways(process.env);
    await expect(gw.music.generate({ prompt: 'calm' })).rejects.toThrow(/not configured/);
  });
  test('sfx: unconfigured → explicit failure', async () => {
    const gw = createMediaGateways(process.env);
    await expect(gw.sfx.generate({ text: 'whoosh' })).rejects.toThrow(/not configured/);
  });
});

describe('MediaGateways.video', () => {
  test('no gateway configured → explicit failure', async () => {
    const gw = createMediaGateways(process.env);
    await expect(gw.video.create({ prompt: 'a cat' })).rejects.toThrow(/no gateway configured/);
  });

  test('prefers ARK when ARK_VIDEO_KEY is set', async () => {
    process.env.ARK_VIDEO_KEY = 'ark-test';
    let hitUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      hitUrl = String(url);
      return new Response(JSON.stringify({ id: 'cgt-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const gw = createMediaGateways(process.env);
    const ref = await gw.video.create({ prompt: 'a cat' });
    expect(ref.id).toBe('cgt-123');
    expect(hitUrl).toContain('tasks'); // ARK task-create endpoint
  });

  test('status routes ARK ids to ARK without the caller naming the provider', async () => {
    process.env.ARK_VIDEO_KEY = 'ark-test';
    globalThis.fetch = (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ id: 'cgt-1', status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const gw = createMediaGateways(process.env);
    const st = await gw.video.status('cgt-1'); // ARK-shaped id
    expect(st.status).toBe('in_progress'); // ARK 'running' → normalized
  });
});

describe('MediaGateways.capabilities', () => {
  test('reports per-capability readiness from the env', () => {
    process.env.MINIMAX_MUSIC_KEY = 'mm-music';
    const gw = createMediaGateways(process.env);
    const caps = gw.capabilities();
    expect(caps.tts.configured).toBe(false); // no tts provider set
    expect(caps.music.configured).toBe(true); // music key set
    expect(caps.music.providers).toContain('minimax-music');
    expect(caps.sfx.configured).toBe(false);
    // image + llm route internally (transport/vendor auto-resolved) → always "available".
    expect(caps.image.configured).toBe(true);
    expect(caps.llm.configured).toBe(true);
  });
});
