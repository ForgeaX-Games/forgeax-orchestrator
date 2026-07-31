// LiteLLM proxy `/v1/chat/completions` transport.
//
// Studio's .env routes ANTHROPIC/OPENAI/LITELLM keys all at the same proxy host
// (`LITELLM_PROXY_BASE_URL`), so one OpenAI-compat transport covers Claude /
// GPT / Gemini / GLM / Kimi / Qwen / DeepSeek / Minimax / Hunyuan with the
// same wire shape. No per-vendor branching — the proxy adapts upstream. Other
// transports (native anthropic /v1/messages, gemini /generateContent etc) can
// be added if a deployment ever bypasses the proxy; current shipping path
// needs only this.

import type { CompleteRequest, CompleteResponse, LlmTransport, TransportOpts } from '../types';

interface LiteLLMChoice {
  message?: { content?: string };
  finish_reason?: string;
}
interface LiteLLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface LiteLLMResponse {
  id?: string;
  model?: string;
  choices?: LiteLLMChoice[];
  usage?: LiteLLMUsage;
  error?: { message?: string; type?: string };
}

export const litellmTransport: LlmTransport = {
  name: 'litellm',
  async complete(req: CompleteRequest, opts: TransportOpts): Promise<CompleteResponse> {
    // The generic gateway may be deployed with only the Anthropic-compatible
    // credential pair. Keep one OpenAI-compatible wire path and use that pair
    // as the final fallback when the dedicated LiteLLM variables are absent.
    const baseUrl = (opts.baseUrl
      ?? process.env.LITELLM_PROXY_BASE_URL
      ?? process.env.ANTHROPIC_BASE_URL
      ?? '').replace(/\/+$/, '');
    const apiKey = opts.apiKey
      ?? process.env.LITELLM_PROXY_KEY
      ?? process.env.ANTHROPIC_API_KEY
      ?? '';
    if (!baseUrl) throw new Error('generic LLM transport: LITELLM_PROXY_BASE_URL or ANTHROPIC_BASE_URL not set');
    if (!apiKey) throw new Error('generic LLM transport: LITELLM_PROXY_KEY or ANTHROPIC_API_KEY not set');

    const fetcher = opts.fetcher ?? fetch;
    const anthropicFallback = !process.env.LITELLM_PROXY_BASE_URL
      && !process.env.LITELLM_PROXY_KEY
      && Boolean(process.env.ANTHROPIC_API_KEY);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    // Compose abort: caller signal OR internal timeout, whichever fires first.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(req.signal?.reason);
    if (req.signal) {
      if (req.signal.aborted) ctrl.abort(req.signal.reason);
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    const anthropicModel = (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6').replace(/\[.*\]$/, '');
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const anthropicSystem = anthropicFallback && req.responseFormat
      ? `${system ? `${system}\n` : ''}Return only valid JSON for ${req.responseFormat.name}. Do not use markdown fences or prose. JSON schema: ${JSON.stringify(req.responseFormat.schema)}`
      : system;
    const body: Record<string, unknown> = anthropicFallback
      ? {
        model: anthropicModel,
        max_tokens: req.maxTokens ?? 500,
        ...(anthropicSystem ? { system: anthropicSystem } : {}),
        messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      }
      : {
        model: req.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.responseFormat && !anthropicFallback) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.responseFormat.name,
          schema: req.responseFormat.schema,
          strict: req.responseFormat.strict ?? true,
        },
      };
      // NPC Brain is a bounded, non-thinking decision path: DeepSeek V4 defaults
      // to thinking mode and can consume the entire output budget before any
      // JSON is emitted. Its wire-level off switch is `thinking.disabled`
      // (not `reasoning_effort: none`). Scope it to DeepSeek NPC schemas so
      // unrelated models and structured gateway callers keep their own policy.
      const isNpcDecision = req.responseFormat.name === 'npc_decision'
        || req.responseFormat.name === 'npc_decisions';
      if (isNpcDecision && req.model.startsWith('deepseek-v4-')) {
        body.thinking = { type: 'disabled' };
      }
    }

    const started = Date.now();
    try {
      const resp = await fetcher(anthropicFallback ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...(anthropicFallback ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { 'Authorization': `Bearer ${apiKey}` }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      const raw = await resp.text();
      let parsed: LiteLLMResponse;
      try {
        parsed = JSON.parse(raw) as LiteLLMResponse;
      } catch {
        throw new Error(`litellm transport: non-JSON response (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
      }
      if (!resp.ok) {
        const msg = parsed.error?.message ?? `HTTP ${resp.status}`;
        throw new Error(`litellm transport: ${msg}`);
      }
      const text = (anthropicFallback
        ? (parsed as unknown as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
        : parsed.choices?.[0]?.message?.content ?? '')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      return {
        text,
        model: anthropicFallback ? anthropicModel : req.model,
        upstreamModel: parsed.model,
        transport: anthropicFallback ? 'anthropic-fallback' : 'litellm',
        latencyMs: Date.now() - started,
        usage: parsed.usage ? {
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
        } : undefined,
      };
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
    }
  },
};
