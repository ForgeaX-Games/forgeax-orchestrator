// `@forgeax/orchestrator/gateways` — the single MediaGateways capability face.
//
// WHY THIS EXISTS (architecture-principles §2.5, plan-strategy D-2):
//   packages/server's ce-api-shim used to import 24 per-vendor symbols
//   (`createDoubaoSpeech` / `doubaoTtsConfigured` / `createArkVideoTask` /
//   `isArkTaskId` / …) and then re-encode the provider enum on the consumer
//   side (`if (litellmTtsConfigured()) … else if (minimaxTtsConfigured()) …`).
//   That is a downstream consumer holding its producers' concrete variants —
//   every new provider forced a consumer edit. This module inverts the
//   dependency: server depends on the *media capability* (an abstraction), and
//   the provider-selection branches live here, inside orchestrator.
//
// The exported surface is verbs only — `tts.synthesize` / `music.generate` /
// `sfx.generate` / `image.generate` / `video.{create,status,download}` /
// `llm.complete` + `capabilities()`. No `{provider}Configured` predicate,
// no `create{Provider}X` factory, and no vendor type name crosses the export
// boundary. Adding a provider = appending to an internal chain (data-driven),
// never a signature change (proven by the AC-09 falsification test).
//
// This module only *consumes* the existing lib/{audio,video,image,llm}-gateway
// modules; it never modifies their internals. Provider `isConfigured()` checks
// keep reading `process.env` exactly as the vendor modules already do, so
// runtime behavior is equivalent to the pre-collapse ce-api-shim branches.

import {
  createDoubaoSpeech,
  doubaoTtsConfigured,
} from './../audio-gateway/doubao-tts';
import {
  createMinimaxSpeech,
  minimaxTtsConfigured,
} from './../audio-gateway/minimax-tts';
import {
  createLitellmSpeech,
  litellmTtsConfigured,
} from './../audio-gateway/litellm-tts';
import {
  createMinimaxMusic,
  minimaxMusicConfigured,
  type MinimaxMusicInput,
  type MinimaxMusicOutput,
} from './../audio-gateway/minimax-music';
import {
  createElevenLabsSoundEffect,
  elevenLabsAudioConfigured,
  type ElevenLabsSoundEffectInput,
  type ElevenLabsAudioOutput,
} from './../audio-gateway/elevenlabs-audio';
import {
  arkVideoConfigured,
  createArkVideoTask,
  getArkVideoStatus,
  downloadArkVideoContent,
  isArkTaskId,
  type CreateArkVideoInput,
} from './../video-gateway/ark-video';
import {
  createLitellmVideoTask,
  getLitellmVideoStatus,
  downloadLitellmVideoContent,
  litellmVideoConfigured,
  type CreateVideoTaskInput,
} from './../video-gateway/litellm-video';
import { ImageDispatcher, type ChannelRole } from './../image-gateway/clients/dispatcher';
import { vendorForModel, type ImageGenRequest } from './../image-gateway';
import { complete, type CompleteRequest, type CompleteResponse } from './../llm-gateway';

// ── capability I/O contracts (abstraction, not vendor enums) ────────────────

/** Synthesized audio bytes + mime. Shared by tts / music / sfx returns. */
export interface AudioBytes {
  bytes: Buffer;
  mime: string;
}

export interface TtsSynthesizeInput {
  /** Text to synthesize. */
  input: string;
  /** Voice code (provider-native voice id; passed through unchanged). */
  voice: string;
  /** Optional model override; provider default applies when omitted. */
  model?: string;
  /** Optional speed knob. */
  speed?: number;
}

/** Music generation reuses the underlying gateway's input/output contract. */
export type MusicGenerateInput = MinimaxMusicInput;
export type MusicGenerateOutput = MinimaxMusicOutput;

/** Sound-effect generation reuses the underlying gateway's contract. */
export type SfxGenerateInput = ElevenLabsSoundEffectInput;
export type SfxGenerateOutput = ElevenLabsAudioOutput;

export interface ImageGenerateInput {
  prompt: string;
  size?: ImageGenRequest['size'];
  refImageBase64?: string | null;
  /** Provider-agnostic model hint; the facade routes it to the right vendor. */
  model?: string;
  role?: ChannelRole;
}

export interface ImageGenerateResult {
  pngBytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Runtime provenance for debug/telemetry only — a value, never a switched-on enum. */
  vendor: string;
  modelId: string;
  triedVendors: string[];
}

/** Video creation input. `provider` is never named — routing is internal. */
export type VideoCreateInput = CreateArkVideoInput & CreateVideoTaskInput;

export interface VideoTaskRef {
  /** Opaque task id; the facade routes subsequent status/download by it. */
  id: string;
}

export interface VideoTaskStatus {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | string;
  error?: string;
  /** Short-lived signed url when completed (provider-dependent, may be absent). */
  videoUrl?: string;
}

export interface CapabilityStatus {
  configured: boolean;
  /** Ready provider labels (informational — for greying-out UI, not for switching). */
  providers: string[];
}

export interface MediaCapabilities {
  tts: CapabilityStatus;
  music: CapabilityStatus;
  sfx: CapabilityStatus;
  image: CapabilityStatus;
  video: CapabilityStatus;
  llm: CapabilityStatus;
}

// ── provider chain abstraction (the §2.5 inversion seam) ────────────────────
//
// A provider is a shape: "am I configured?" + "do the work". The built-in chain
// below adapts the existing vendor modules to this shape. Adding a provider is
// an append to a chain, so the MediaGateways signature never grows a case.

interface TtsProvider {
  readonly id: string;
  isConfigured(): boolean;
  synthesize(input: TtsSynthesizeInput): Promise<AudioBytes>;
}

const builtinTtsChain: TtsProvider[] = [
  {
    id: 'litellm',
    isConfigured: litellmTtsConfigured,
    synthesize: (i) => createLitellmSpeech({ input: i.input, voice: i.voice, model: i.model, speed: i.speed }),
  },
  {
    id: 'minimax',
    isConfigured: minimaxTtsConfigured,
    synthesize: (i) => createMinimaxSpeech({ input: i.input, voice: i.voice, speed: i.speed, model: i.model }),
  },
  {
    id: 'doubao',
    isConfigured: doubaoTtsConfigured,
    synthesize: (i) => createDoubaoSpeech({ input: i.input, voice: i.voice, speed: i.speed }),
  },
];

/**
 * Internal/test extension seam: register an additional TTS provider so the
 * AC-09 falsification test can prove a new provider needs zero signature change.
 * Underscore-prefixed by convention (mirrors `_resetGateway` / `_resetImageGateway`).
 * Returns a disposer that removes the provider again.
 */
export function _registerTtsProvider(provider: TtsProvider): () => void {
  builtinTtsChain.push(provider);
  return () => {
    const idx = builtinTtsChain.indexOf(provider);
    if (idx >= 0) builtinTtsChain.splice(idx, 1);
  };
}

// ── the capability face ─────────────────────────────────────────────────────

export interface MediaGateways {
  tts: { synthesize(input: TtsSynthesizeInput): Promise<AudioBytes> };
  music: { generate(input: MusicGenerateInput): Promise<MusicGenerateOutput> };
  sfx: { generate(input: SfxGenerateInput): Promise<SfxGenerateOutput> };
  image: { generate(input: ImageGenerateInput): Promise<ImageGenerateResult> };
  video: {
    create(input: VideoCreateInput): Promise<VideoTaskRef>;
    status(taskId: string): Promise<VideoTaskStatus>;
    download(taskId: string, videoUrl?: string): Promise<AudioBytes>;
  };
  llm: { complete(req: CompleteRequest): Promise<CompleteResponse> };
  capabilities(): MediaCapabilities;
}

/**
 * Build the MediaGateways capability face. `env` is injected for the image
 * dispatcher (which registers vendors with the caller's env); audio/video/llm
 * providers keep reading `process.env` internally exactly as before, so runtime
 * behavior is identical to the pre-collapse ce-api-shim branches.
 */
export function createMediaGateways(env: Record<string, string | undefined>): MediaGateways {
  return {
    tts: {
      async synthesize(input) {
        const ready = builtinTtsChain.filter((p) => p.isConfigured());
        if (ready.length === 0) {
          // Explicit failure (charter P3) — never a silent empty result.
          throw new Error(
            'tts: no provider configured (set LITELLM_PROXY_* for the proxy, MINIMAX_API_KEY for direct MiniMax, or DOUBAO_TTS_KEY + DOUBAO_TTS_APP_ID for direct Doubao)',
          );
        }
        const text = input.input?.trim();
        if (!text) throw new Error('tts: empty input');
        if (!input.voice) throw new Error('tts: empty voice');
        const errors: string[] = [];
        for (const provider of ready) {
          try {
            return await provider.synthesize(input);
          } catch (e) {
            errors.push(`${provider.id}: ${(e as Error).message}`);
          }
        }
        throw new Error(errors.join(' · ') || 'tts: synthesis failed');
      },
    },
    music: {
      async generate(input) {
        if (!minimaxMusicConfigured()) {
          throw new Error('music: not configured (set MINIMAX_MUSIC_KEY for direct MiniMax music)');
        }
        return createMinimaxMusic(input);
      },
    },
    sfx: {
      async generate(input) {
        if (!elevenLabsAudioConfigured()) {
          throw new Error('sfx: not configured (set ELEVENLABS_API_KEY)');
        }
        return createElevenLabsSoundEffect(input);
      },
    },
    image: {
      async generate(input) {
        const dispatcher = new ImageDispatcher(env);
        const role: ChannelRole = input.role ?? 'concept-art';
        const requestedModel = input.model?.trim() || undefined;
        const preferredVendor = vendorForModel(requestedModel);
        try {
          const r = await dispatcher.generate(
            role,
            {
              prompt: input.prompt,
              size: input.size ?? '2k',
              refImageBase64: input.refImageBase64,
              modelOverride: requestedModel,
            },
            preferredVendor,
          );
          return {
            pngBytes: r.pngBytes,
            mime: r.mime,
            vendor: r.vendor,
            modelId: r.modelId,
            triedVendors: r.triedVendors,
          };
        } finally {
          dispatcher.dispose();
        }
      },
    },
    video: {
      async create(input) {
        // ARK (multi-image reference R2V) is preferred; litellm proxy is the
        // single-image fallback. Neither configured ⇒ explicit failure.
        const useArk = arkVideoConfigured();
        if (!useArk && !litellmVideoConfigured()) {
          throw new Error('video: no gateway configured (missing ARK_VIDEO_KEY or LITELLM_PROXY_BASE_URL/KEY)');
        }
        if (useArk) {
          return createArkVideoTask(input);
        }
        return createLitellmVideoTask(input);
      },
      async status(taskId) {
        // Route by task-id shape (isArkTaskId) — the consumer never learns which
        // provider minted the id.
        if (isArkTaskId(taskId)) {
          return getArkVideoStatus(taskId);
        }
        const st = await getLitellmVideoStatus(taskId);
        return { id: st.id, status: st.status, error: st.error };
      },
      async download(taskId, videoUrl) {
        if (isArkTaskId(taskId)) {
          if (!videoUrl) throw new Error('video: ARK download requires the completed videoUrl');
          return downloadArkVideoContent(videoUrl);
        }
        return downloadLitellmVideoContent(taskId);
      },
    },
    llm: {
      complete(req) {
        return complete(req);
      },
    },
    capabilities() {
      const ttsProviders = builtinTtsChain.filter((p) => p.isConfigured()).map((p) => p.id);
      const videoProviders = [
        arkVideoConfigured() ? 'ark' : '',
        litellmVideoConfigured() ? 'litellm' : '',
      ].filter(Boolean);
      return {
        tts: { configured: ttsProviders.length > 0, providers: ttsProviders },
        music: {
          configured: minimaxMusicConfigured(),
          providers: minimaxMusicConfigured() ? ['minimax-music'] : [],
        },
        sfx: {
          configured: elevenLabsAudioConfigured(),
          providers: elevenLabsAudioConfigured() ? ['elevenlabs'] : [],
        },
        image: { configured: true, providers: [] },
        video: { configured: videoProviders.length > 0, providers: videoProviders },
        llm: { configured: true, providers: [] },
      };
    },
  };
}

// Re-export the gateway-owned llm contract types so consumers building a
// `llm.complete` call get the message/response shapes without reaching into
// `lib/llm-gateway` (these are gateway abstractions, not vendor names).
export type { ChatMessage, CompleteRequest, CompleteResponse } from './../llm-gateway';

// Gateway catalog helpers (a3-port-mapping P2: `lib/llm-gateway/gateway-catalog
// <- kernel/forgeax-core-adapter`; tradeoff 1 folds the catalog onto this single
// ./gateways capability face). The server's kernel adapter reads the merged
// disk+live gateway catalog and projects it into the kernel model catalog; both
// helpers stay in `lib/llm-gateway/gateway-catalog` unchanged — pure additive
// re-export so the M5 server rewrite drops its deep import.
export { loadGatewayCatalog, gatewayCatalogToKernelModels } from './../llm-gateway/gateway-catalog';
