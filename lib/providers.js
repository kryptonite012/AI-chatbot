import { env, envBool, envList } from './env.js';

/*
 * Provider registry and streaming adapters.
 *
 * Every adapter is an async generator that yields normalized events:
 *   { type: 'text', text }        answer tokens
 *   { type: 'reasoning', text }   "thinking" tokens (when the model exposes them)
 *   { type: 'sources', items }    web sources [{ url, title }]
 *   { type: 'usage', usage }      { input, output } token counts
 *   { type: 'model', model }      the model that actually served the request
 *   { type: 'notice', text }      short informational message
 */

const ANTHROPIC_VERSION = '2026-10-21';
const ANTHROPIC_MAX_TOKENS = 64000;
// Claude models that take adaptive thinking (older ones reject it).
const ADAPTIVE_THINKING = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|(?:opus|sonnet)-4-[6-9])/;
// Claude models that support server-side refusal fallbacks.
const DEFAULT_FALLBACKS = /^claude-(?:fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
// Model ids returned by /models endpoints that are not chat models.
const NON_CHAT = /(embed|tts|whisper|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|guard|imagen|veo|aqa|computer-use|sora|search-preview|-instruct$)/i;

const DEFINITIONS = [
  {
    id: 'openai',
    name: 'ChatGPT',
    vendor: 'OpenAI',
    badge: 'G',
    color: '#10a37f',
    kind: 'openai',
    prefix: 'OPENAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5-mini', 'gpt-5', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'GPT-5 family. Pay as you go.',
    filterModels: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    badge: 'Ge',
    color: '#4f7cff',
    kind: 'openai',
    prefix: 'GEMINI',
    altKeys: ['GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Generous free tier from Google AI Studio.',
    free: true,
    filterModels: true,
  },
  {
    id: 'anthropic',
    name: 'Claude',
    vendor: 'Anthropic',
    badge: 'C',
    color: '#d97757',
    kind: 'anthropic',
    prefix: 'ANTHROPIC',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Claude models. Pay as you go.',
  },
  {
    id: 'xai',
    name: 'Grok',
    vendor: 'xAI',
    badge: 'X',
    color: '#71717a',
    kind: 'openai',
    prefix: 'XAI',
    altKeys: ['GROK_API_KEY'],
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai',
    note: 'Grok models from xAI.',
    filterModels: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    badge: 'D',
    color: '#4d6bfe',
    kind: 'openai',
    prefix: 'DEEPSEEK',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Very low-cost chat and reasoning models.',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    vendor: 'Perplexity',
    badge: 'P',
    color: '#1fb8cd',
    kind: 'openai',
    prefix: 'PERPLEXITY',
    altKeys: ['PPLX_API_KEY'],
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    keyUrl: 'https://www.perplexity.ai/account/api/keys',
    note: 'Answers with live web sources.',
    noModelList: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    vendor: 'Llama & open models',
    badge: 'L',
    color: '#f55036',
    kind: 'openai',
    prefix: 'GROQ',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    keyUrl: 'https://console.groq.com/keys',
    note: 'Free tier with extremely fast open models.',
    free: true,
    filterModels: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: '300+ models, one key',
    badge: 'R',
    color: '#6467f2',
    kind: 'openai',
    prefix: 'OPENROUTER',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'openrouter/auto',
      'deepseek/deepseek-chat',
      'google/gemini-2.5-flash',
    ],
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for hundreds of models, including free ones.',
    free: true,
    reportModel: true,
  },
  {
    id: 'ollama',
    name: 'Local AI',
    vendor: 'Ollama · offline',
    badge: 'Lo',
    color: '#16a34a',
    kind: 'openai',
    prefix: 'OLLAMA',
    baseUrl: 'http://localhost:11434',
    models: ['llama3.2', 'qwen3', 'gemma3'],
    keyUrl: 'https://ollama.com/download',
    note: 'Runs open models on your own computer. No key, no internet.',
    local: true,
    free: true,
  },
];

function normalizeBaseUrl(def, value) {
  let url = String(value || '').trim().replace(/\/+$/, '');
  // Ollama and Anthropic are often configured without the /v1 suffix.
  if ((def.id === 'ollama' || def.kind === 'anthropic') && !/\/v1$/.test(url)) url += '/v1';
  return url;
}

let cache = null;

/** Providers configured for this server (built lazily so .env is loaded first). */
export function getProviders() {
  if (cache) return cache;

  const list = DEFINITIONS.map((def) => ({
    ...def,
    baseUrl: normalizeBaseUrl(def, env(`${def.prefix}_BASE_URL`, def.baseUrl)),
    models: envList(`${def.prefix}_MODELS`, def.models),
    enabled: envBool(`${def.prefix}_ENABLED`, true),
  }));

  // Any OpenAI-compatible server: LM Studio, vLLM, LocalAI, Together, Mistral...
  const customUrl = env('CUSTOM_BASE_URL');
  if (customUrl) {
    list.push({
      id: 'custom',
      name: env('CUSTOM_NAME', 'Custom'),
      vendor: 'OpenAI-compatible',
      badge: env('CUSTOM_NAME', 'Custom').slice(0, 2),
      color: '#0ea5e9',
      kind: 'openai',
      prefix: 'CUSTOM',
      baseUrl: customUrl.replace(/\/+$/, ''),
      models: envList('CUSTOM_MODELS', []),
      keyUrl: '',
      note: 'Your own OpenAI-compatible endpoint.',
      local: true,
      enabled: true,
    });
  }

  cache = list.filter((p) => p.enabled);
  return cache;
}

/** Test helper: rebuild the registry after changing environment variables. */
export function resetProviders() {
  cache = null;
  probes.clear();
}

export function findProvider(id) {
  return getProviders().find((p) => p.id === id) || null;
}

export function serverKey(p) {
  for (const name of [`${p.prefix}_API_KEY`, ...(p.altKeys || [])]) {
    const value = env(name);
    if (value) return value;
  }
  return '';
}

/** Browser-supplied key wins (if allowed), then the server key. */
export function resolveKey(p, clientKey) {
  const key = typeof clientKey === 'string' ? clientKey.trim() : '';
  return key || serverKey(p);
}

// ---------------------------------------------------------------------------
// Local servers (Ollama / custom): check if they are running and list models.
// ---------------------------------------------------------------------------

const probes = new Map();

export async function probeLocal(p) {
  const cached = probes.get(p.id);
  if (cached && Date.now() - cached.at < 15000) return cached;

  const result = { at: Date.now(), ok: false, models: [] };
  try {
    const headers = {};
    const key = serverKey(p);
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${p.baseUrl}/models`, { headers, signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      result.ok = true;
      result.models = (data.data || data.models || [])
        .map((m) => m.id || m.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    }
  } catch {
    // not running
  }
  probes.set(p.id, result);
  return result;
}

/** Safe-to-share provider info for the browser (never includes keys). */
export async function publicProviders() {
  return Promise.all(
    getProviders().map(async (p) => {
      const info = {
        id: p.id,
        name: p.name,
        vendor: p.vendor,
        badge: p.badge,
        color: p.color,
        keyUrl: p.keyUrl,
        note: p.note,
        free: !!p.free,
        local: !!p.local,
        serverKey: !!serverKey(p),
        models: p.models,
      };
      if (p.local) {
        const probe = await probeLocal(p);
        info.online = probe.ok;
        if (probe.models.length) {
          const preferred = envList(`${p.prefix}_MODELS`, []);
          info.models = [...new Set([...preferred.filter((m) => probe.models.includes(m)), ...probe.models])];
        }
      }
      return info;
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep only user/assistant text, merge consecutive roles, start with a user turn. */
export function normalizeMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out;
}

async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
  } finally {
    reader.cancel().catch(() => {});
  }
}

function extractMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const root = Array.isArray(data) ? data[0] : data;
  const err = root?.error ?? root;
  if (typeof err === 'string') return err;
  return err?.message || root?.message || root?.detail || '';
}

async function httpError(res, p) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    // ignore
  }
  let message = '';
  try {
    message = extractMessage(JSON.parse(raw));
  } catch {
    message = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  const hints = {
    401: 'The API key looks invalid or expired.',
    402: 'Your account is out of credits.',
    403: 'This key is not allowed to use that model.',
    404: 'Model not found. Pick another model in the column header.',
    429: 'Rate limit or quota reached. Wait a bit or check your plan.',
  };
  const detail = message || res.statusText || 'Request failed';
  const hint = hints[res.status] && !detail.toLowerCase().includes(hints[res.status].toLowerCase()) ? ` ${hints[res.status]}` : '';
  const error = new Error(`${p.name} (${res.status}): ${detail}${hint}`);
  error.status = res.status;
  error.raw = raw;
  return error;
}

function toSources(list) {
  return list
    .map((s) => (typeof s === 'string' ? { url: s } : { url: s?.url, title: s?.title }))
    .filter((s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url));
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (OpenAI, Gemini, Grok, DeepSeek, Perplexity, Groq,
// OpenRouter, Ollama, custom servers)
// ---------------------------------------------------------------------------

function openaiHeaders(p, apiKey, appName) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (p.id === 'openrouter') {
    headers['HTTP-Referer'] = env('PUBLIC_URL', 'http://localhost');
    headers['X-Title'] = appName || 'AI Chatbot';
  }
  return headers;
}

async function* streamOpenAI(p, { model, messages, system, apiKey, signal, appName }) {
  const payload = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: true,
  };
  if (p.id === 'openai' || p.id === 'deepseek') payload.stream_options = { include_usage: true };

  const url = `${p.baseUrl}/chat/completions`;
  const headers = openaiHeaders(p, apiKey, appName);
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });

  if (!res.ok) {
    const error = await httpError(res, p);
    // Some OpenAI models only stream for verified organisations: fall back to a normal request.
    if (res.status === 400 && /stream/i.test(error.raw) && /verif/i.test(error.raw)) {
      yield* completeOpenAI(p, url, headers, { ...payload, stream: false, stream_options: undefined }, signal);
      return;
    }
    throw error;
  }

  let sourceCount = 0;
  let reportedModel = !p.reportModel;
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(`${p.name}: ${extractMessage(chunk) || 'stream error'}`);

    if (!reportedModel && chunk.model) {
      reportedModel = true;
      yield { type: 'model', model: chunk.model };
    }

    const delta = chunk.choices?.[0]?.delta || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };

    const rawSources = Array.isArray(chunk.search_results) && chunk.search_results.length ? chunk.search_results : chunk.citations;
    if (Array.isArray(rawSources) && rawSources.length !== sourceCount) {
      sourceCount = rawSources.length;
      yield { type: 'sources', items: toSources(rawSources) };
    }

    if (chunk.usage) {
      yield { type: 'usage', usage: { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens } };
    }
  }
}

async function* completeOpenAI(p, url, headers, payload, signal) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
  if (!res.ok) throw await httpError(res, p);
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
  if (message.content) yield { type: 'text', text: message.content };
  if (data.usage) yield { type: 'usage', usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } };
}

// ---------------------------------------------------------------------------
// Anthropic (Claude) adapter - Messages API over SSE
// ---------------------------------------------------------------------------

async function* streamAnthropic(p, { model, messages, system, apiKey, signal }) {
  const payload = { model, max_tokens: ANTHROPIC_MAX_TOKENS, stream: true, messages };
  if (system) payload.system = system;
  if (ADAPTIVE_THINKING.test(model)) payload.thinking = { type: 'adaptive', display: 'summarized' };

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (DEFAULT_FALLBACKS.test(model)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const res = await fetch(`${p.baseUrl}/messages`, { method: 'POST', headers, body: JSON.stringify(payload), signal });
  if (!res.ok) throw await httpError(res, p);

  const usage = { input: 0, output: 0 };
  for await (const data of sseData(res)) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    switch (event.type) {
      case 'message_start': {
        usage.input = event.message?.usage?.input_tokens || 0;
        const served = event.message?.model;
        if (served && served !== model) yield { type: 'model', model: served };
        break;
      }
      case 'content_block_start':
        if (event.content_block?.type === 'fallback') {
          const to = event.content_block.to?.model;
          yield { type: 'notice', text: `Continued on ${to || 'a fallback model'}.` };
          if (to) yield { type: 'model', model: to };
        }
        break;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) yield { type: 'text', text: event.delta.text };
        else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) yield { type: 'reasoning', text: event.delta.thinking };
        break;
      case 'message_delta':
        if (event.usage?.output_tokens) usage.output = event.usage.output_tokens;
        if (event.delta?.stop_reason === 'refusal') yield { type: 'notice', text: 'Claude declined to answer this request.' };
        if (event.delta?.stop_reason === 'max_tokens') yield { type: 'notice', text: 'The answer was cut off because it hit the length limit.' };
        break;
      case 'error':
        throw new Error(`${p.name}: ${event.error?.message || 'stream error'}`);
      case 'message_stop':
        yield { type: 'usage', usage };
        return;
      default:
        break;
    }
  }
  yield { type: 'usage', usage };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function streamChat(p, options) {
  return p.kind === 'anthropic' ? streamAnthropic(p, options) : streamOpenAI(p, options);
}

/** Live model list straight from the provider. */
export async function listModels(p, apiKey) {
  if (p.noModelList) return p.models;

  let ids = [];
  if (p.kind === 'anthropic') {
    const res = await fetch(`${p.baseUrl}/models?limit=1000`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw await httpError(res, p);
    const data = await res.json();
    ids = (data.data || []).map((m) => m.id);
  } else {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: openaiHeaders(p, apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw await httpError(res, p);
    const data = await res.json();
    ids = (data.data || data.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, ''));
  }

  ids = ids.filter(Boolean);
  if (p.filterModels) ids = ids.filter((id) => !NON_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Cheap check that a key works. */
export async function verifyKey(p, apiKey) {
  if (!p.noModelList) {
    await listModels(p, apiKey);
    return true;
  }
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(p, apiKey),
    body: JSON.stringify({ model: p.models[0], messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw await httpError(res, p);
  return true;
}
