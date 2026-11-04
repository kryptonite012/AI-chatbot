import crypto from 'node:crypto';
import { env, envBool } from './env.js';
import {
  findProvider,
  listModels,
  normalizeMessages,
  publicProviders,
  resolveKey,
  streamChat,
  verifyKey,
} from './providers.js';

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_CHARS = 1_000_000;

export function appInfo() {
  return {
    appName: env('APP_NAME', 'Sangam AI'),
    tagline: env('APP_TAGLINE', 'Every top AI. One conversation.'),
  };
}

const allowClientKeys = () => envBool('ALLOW_CLIENT_KEYS', true);

function json(res, status, data) {
  if (res.headersSent) return res.end();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value || '';
}

function clientIp(req) {
  const forwarded = header(req, 'x-forwarded-for').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

// --- access password -------------------------------------------------------

function passwordRequired() {
  return !!env('APP_PASSWORD');
}

function isAuthorized(req) {
  const password = env('APP_PASSWORD');
  if (!password) return true;
  const given = crypto.createHash('sha256').update(String(header(req, 'x-app-password'))).digest();
  const expected = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(given, expected);
}

// --- simple in-memory rate limit (per IP, per minute) ----------------------

const buckets = new Map();

function rateLimited(req, weight = 1) {
  const limit = Number(env('RATE_LIMIT_PER_MINUTE', '60'));
  if (!limit || limit < 0) return false;
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > 60_000) {
    bucket = { start: now, count: 0 };
    buckets.set(ip, bucket);
  }
  bucket.count += weight;
  if (buckets.size > 10_000) {
    for (const [key, value] of buckets) if (now - value.start > 60_000) buckets.delete(key);
  }
  return bucket.count > limit;
}

// --- body parsing (works on plain Node and on Vercel functions) ------------

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('Request is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('Invalid JSON body.');
    error.status = 400;
    throw error;
  }
}

function friendlyError(err, provider) {
  const code = err?.cause?.code || err?.code;
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || err?.message === 'fetch failed') {
    if (provider.id === 'ollama') {
      return `Can't reach Ollama at ${provider.baseUrl.replace(/\/v1$/, '')}. Start it with "ollama serve" (and pull a model, e.g. "ollama pull llama3.2").`;
    }
    return `Can't reach ${provider.name} at ${provider.baseUrl}. Check your internet connection.`;
  }
  return err?.message || 'Something went wrong.';
}

// --- routes -----------------------------------------------------------------

async function getConfig(req, res) {
  const authorized = isAuthorized(req);
  if (!authorized && header(req, 'x-app-password') && rateLimited(req, 5)) {
    return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
  }
  const data = {
    ...appInfo(),
    authRequired: passwordRequired(),
    authorized,
    allowClientKeys: allowClientKeys(),
  };
  if (authorized) data.providers = await publicProviders();
  json(res, 200, data);
}

async function getModels(req, res, url) {
  const provider = findProvider(url.searchParams.get('provider'));
  if (!provider) return json(res, 400, { error: 'Unknown provider.' });
  if (rateLimited(req)) return json(res, 429, { error: 'Too many requests. Slow down a little.' });

  const apiKey = resolveKey(provider, allowClientKeys() ? header(req, 'x-provider-key') : '');
  if (!apiKey && !provider.local) {
    return json(res, 400, { error: `No API key for ${provider.name}.`, code: 'no_key' });
  }
  try {
    if (url.searchParams.get('verify') === '1') {
      await verifyKey(provider, apiKey);
      return json(res, 200, { ok: true });
    }
    const models = await listModels(provider, apiKey);
    json(res, 200, { models });
  } catch (err) {
    json(res, 502, { error: friendlyError(err, provider) });
  }
}

async function postChat(req, res) {
  if (rateLimited(req)) return json(res, 429, { error: 'Too many requests. Slow down a little.' });

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON body.' });
  }

  const provider = findProvider(body?.provider);
  if (!provider) return json(res, 400, { error: 'Unknown provider.' });

  const model = String(body.model || '').trim();
  if (!MODEL_ID.test(model)) return json(res, 400, { error: 'Pick a valid model first.' });

  const messages = normalizeMessages(Array.isArray(body.messages) ? body.messages.slice(-200) : []);
  if (!messages.length) return json(res, 400, { error: 'Message is empty.' });
  const size = messages.reduce((n, m) => n + m.content.length, 0);
  if (size > MAX_CHARS) return json(res, 413, { error: 'This conversation is too long. Start a new chat.' });

  const system = typeof body.system === 'string' ? body.system.trim().slice(0, 20_000) : '';
  const apiKey = resolveKey(provider, allowClientKeys() ? body.apiKey : '');
  if (!apiKey && !provider.local) {
    return json(res, 400, { error: `No API key for ${provider.name}. Add one in Settings → API keys.`, code: 'no_key' });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Number(env('REQUEST_TIMEOUT_MS', '300000'));
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const send = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const started = Date.now();
  try {
    const stream = streamChat(provider, {
      model,
      messages,
      system,
      apiKey,
      signal: controller.signal,
      appName: appInfo().appName,
    });
    for await (const event of stream) send(event);
    send({ type: 'done', ms: Date.now() - started });
  } catch (err) {
    if (timedOut) send({ type: 'error', message: `${provider.name} took too long to respond.` });
    else if (!controller.signal.aborted) send({ type: 'error', message: friendlyError(err, provider) });
  } finally {
    clearTimeout(timer);
    clearInterval(ping);
    res.end();
  }
}

/** Handles every /api/* request. Works with Node's http server and Vercel functions. */
export async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  let route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  if (!route || route === 'index') route = url.searchParams.get('route') || route;

  try {
    if (route === 'health') return json(res, 200, { ok: true });
    if (route === 'config' && req.method === 'GET') return await getConfig(req, res);

    if (!isAuthorized(req)) return json(res, 401, { error: 'Password required.', code: 'auth' });

    if (route === 'models' && req.method === 'GET') return await getModels(req, res, url);
    if (route === 'chat' && req.method === 'POST') return await postChat(req, res);

    return json(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
    else res.end();
  }
}
