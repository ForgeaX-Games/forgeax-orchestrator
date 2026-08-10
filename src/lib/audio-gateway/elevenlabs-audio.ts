// ElevenLabs host-side audio generation gateway.
//
// The browser never receives the API key. ForgeaX server routes call these
// helpers and return the generated binary as base64 to the workbench.
// Official endpoints:
//   POST /v1/sound-generation  -> binary audio
//   POST /v1/music             -> binary audio

// Environment:
//   ELEVENLABS_API_KEY
//   ELEVENLABS_BASE_URL          (default https://api.elevenlabs.io/v1)
//   ELEVENLABS_SFX_MODEL         (default eleven_text_to_sound_v2)
//   ELEVENLABS_MUSIC_MODEL       (default music_v1)
//   ELEVENLABS_MUSIC_ENABLED     (must be true; Music requires a paid plan)

// MiniMax remains ForgeaX's primary music provider. ElevenLabs Music is a
// fallback and lets one provider cover both BGM and SFX when desired.

const DEFAULT_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_SFX_MODEL = 'eleven_text_to_sound_v2';
const DEFAULT_MUSIC_MODEL = 'music_v1';

function apiKey(): string {
  return (process.env.ELEVENLABS_API_KEY ?? '').trim();
}

function apiBase(): string {
  return (process.env.ELEVENLABS_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}

function sfxModel(): string {
  return (process.env.ELEVENLABS_SFX_MODEL ?? '').trim() || DEFAULT_SFX_MODEL;
}

function musicModel(): string {
  return (process.env.ELEVENLABS_MUSIC_MODEL ?? '').trim() || DEFAULT_MUSIC_MODEL;
}

export function elevenLabsAudioConfigured(): boolean {
  return Boolean(apiKey());
}

export function elevenLabsMusicConfigured(): boolean {
  return elevenLabsAudioConfigured()
    && (process.env.ELEVENLABS_MUSIC_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function clamp(value: number | undefined, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(minimum, value));
}

async function readBinaryResponse(
  response: Response,
  operation: string,
): Promise<{ bytes: Buffer; mime: string; requestId?: string }> {
  const mime = response.headers.get('content-type') || 'audio/mpeg';
  if (!response.ok || mime.includes('application/json')) {
    const raw = await response.text().catch(() => '');
    throw new Error(
      `elevenlabs-${operation}: HTTP ${response.status} · ${raw.slice(0, 300)}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`elevenlabs-${operation}: empty audio response`);
  return {
    bytes,
    mime,
    requestId: response.headers.get('request-id')
      || response.headers.get('x-trace-id')
      || undefined,
  };
}

export interface ElevenLabsSoundEffectInput {
  text: string;
  durationSeconds?: number;
  loop?: boolean;
  promptInfluence?: number;
  model?: string;
}

export interface ElevenLabsAudioOutput {
  bytes: Buffer;
  mime: string;
  model: string;
  requestId?: string;
}

export async function createElevenLabsSoundEffect(
  args: ElevenLabsSoundEffectInput,
): Promise<ElevenLabsAudioOutput> {
  const key = apiKey();
  if (!key) throw new Error('elevenlabs-sfx: ELEVENLABS_API_KEY not set');
  const text = args.text?.trim();
  if (!text) throw new Error('elevenlabs-sfx: empty prompt');
  const model = args.model?.trim() || sfxModel();
  const durationSeconds = clamp(args.durationSeconds, 0.5, 30);
  const promptInfluence = clamp(args.promptInfluence, 0, 1);
  const body: Record<string, unknown> = {
    text,
    loop: Boolean(args.loop),
    model_id: model,
  };
  if (durationSeconds !== undefined) body.duration_seconds = durationSeconds;
  if (promptInfluence !== undefined) body.prompt_influence = promptInfluence;

  const response = await fetch(`${apiBase()}/sound-generation?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const output = await readBinaryResponse(response, 'sfx');
  return { ...output, model };
}

export interface ElevenLabsMusicInput {
  prompt: string;
  durationSeconds?: number;
  instrumental?: boolean;
  model?: string;
}

export async function createElevenLabsMusic(
  args: ElevenLabsMusicInput,
): Promise<ElevenLabsAudioOutput> {
  const key = apiKey();
  if (!key) throw new Error('elevenlabs-music: ELEVENLABS_API_KEY not set');
  const prompt = args.prompt?.trim();
  if (!prompt) throw new Error('elevenlabs-music: empty prompt');
  const model = args.model?.trim() || musicModel();
  const durationSeconds = clamp(args.durationSeconds, 3, 600);
  const body: Record<string, unknown> = {
    prompt,
    model_id: model,
    force_instrumental: Boolean(args.instrumental),
  };
  if (durationSeconds !== undefined) {
    body.music_length_ms = Math.round(durationSeconds * 1000);
  }

  const response = await fetch(`${apiBase()}/music?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const output = await readBinaryResponse(response, 'music');
  return { ...output, model };
}
