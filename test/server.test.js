import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// A fake upstream that speaks the OpenAI-compatible and Anthropic streaming formats.
let upstream;
let upstreamUrl;
let lastRequest;
let server;
let baseUrl;

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
  res.end();
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    lastRequest = { url: req.url, method: req.method, headers: req.headers, body };

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'llama3.2:latest' }, { id: 'text-embedding-3-small' }] }));
    }

    if (req.url === '/v1/chat/completions') {
      if (body.model === 'bad-model') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      }
      return sse(res, [
        { model: body.model, choices: [{ delta: { reasoning_content: 'Let me think.' } }] },
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world [1]' } }], citations: ['https://example.com/a'] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        '[DONE]',
      ]);
    }

    if (req.url === '/v1/messages') {
      return sse(res, [
        { type: 'message_start', message: { model: body.model, usage: { input_tokens: 11 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering…' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi from Claude' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]);
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  for (const name of Object.keys(process.env)) {
    if (/_(API_KEY|BASE_URL|MODELS|ENABLED)$/.test(name) || name === 'APP_PASSWORD') delete process.env[name];
  }
  Object.assign(process.env, {
    RATE_LIMIT_PER_MINUTE: '0',
    OLLAMA_BASE_URL: upstreamUrl,
    ANTHROPIC_BASE_URL: upstreamUrl,
    ANTHROPIC_API_KEY: 'server-anthropic-key',
    OPENAI_BASE_URL: `${upstreamUrl}/v1`,
    PERPLEXITY_BASE_URL: `${upstreamUrl}/v1`,
    PERPLEXITY_API_KEY: 'server-pplx-key',
  });

  const { resetProviders } = await import('../lib/providers.js');
  const { createApp } = await import('../lib/app.js');
  resetProviders();
  server = http.createServer(createApp({ publicDir: fileURLToPath(new URL('../public', import.meta.url)) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  upstream?.close();
});

async function chat(body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5)));
  return { res, text, events };
}

const joined = (events, type) => events.filter((e) => e.type === type).map((e) => e.text).join('');

test('health check responds', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('config lists providers without leaking keys', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  const raw = await res.text();
  const config = JSON.parse(raw);
  assert.equal(config.authorized, true);
  assert.equal(config.allowClientKeys, true);
  assert.ok(config.appName);
  assert.ok(!raw.includes('server-anthropic-key'));
  assert.ok(!raw.includes('server-pplx-key'));

  const byId = Object.fromEntries(config.providers.map((p) => [p.id, p]));
  assert.equal(byId.anthropic.serverKey, true);
  assert.equal(byId.openai.serverKey, false);
  assert.equal(byId.ollama.online, true);
  assert.ok(byId.ollama.models.includes('llama3.2:latest'));
});

test('streams an OpenAI-compatible answer (local Ollama, no key needed)', async () => {
  const { res, events } = await chat({
    provider: 'ollama',
    model: 'llama3.2:latest',
    system: 'Be brief.',
    messages: [
      { role: 'assistant', content: 'leading assistant turns are dropped' },
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'there' },
    ],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(joined(events, 'text'), 'Hello world [1]');
  assert.equal(joined(events, 'reasoning'), 'Let me think.');
  assert.deepEqual(events.find((e) => e.type === 'sources').items, [{ url: 'https://example.com/a' }]);
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 5, output: 2 });
  assert.equal(events.at(-1).type, 'done');

  assert.equal(lastRequest.body.stream, true);
  assert.deepEqual(lastRequest.body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hi\n\nthere' },
  ]);
  assert.equal(lastRequest.headers.authorization, undefined);
});

test('requires a key for cloud providers and accepts one from the browser', async () => {
  const missing = await chat({ provider: 'openai', model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(missing.res.status, 400);
  assert.equal(JSON.parse(missing.text).code, 'no_key');

  const withKey = await chat({ provider: 'openai', model: 'gpt-5-mini', apiKey: 'browser-key', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(withKey.res.status, 200);
  assert.equal(lastRequest.headers.authorization, 'Bearer browser-key');
  assert.deepEqual(lastRequest.body.stream_options, { include_usage: true });
});

test('turns upstream errors into a readable error event', async () => {
  const { events } = await chat({ provider: 'perplexity', model: 'bad-model', messages: [{ role: 'user', content: 'Hi' }] });
  const error = events.find((e) => e.type === 'error');
  assert.ok(error, 'expected an error event');
  assert.match(error.message, /401/);
  assert.match(error.message, /Incorrect API key/);
});

test('streams Claude with adaptive thinking and default fallbacks', async () => {
  const { events } = await chat({ provider: 'anthropic', model: 'claude-opus-5-5', system: 'Be kind.', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(joined(events, 'text'), 'Hi from Claude');
  assert.equal(joined(events, 'reasoning'), 'Considering…');
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 11, output: 4 });

  assert.equal(lastRequest.headers['x-api-key'], 'server-anthropic-key');
  assert.equal(lastRequest.headers['anthropic-version'], '2026-10-21');
  assert.equal(lastRequest.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(lastRequest.body.system, 'Be kind.');
  assert.equal(lastRequest.body.fallbacks, 'default');
  assert.deepEqual(lastRequest.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(lastRequest.body.temperature, undefined);
});

test('older Claude models are called without newer-only parameters', async () => {
  await chat({ provider: 'anthropic', model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(lastRequest.body.thinking, undefined);
  assert.equal(lastRequest.body.fallbacks, undefined);
  assert.equal(lastRequest.headers['anthropic-beta'], undefined);
});

test('rejects bad requests', async () => {
  assert.equal((await chat({ provider: 'nope', model: 'x', messages: [{ role: 'user', content: 'Hi' }] })).res.status, 400);
  assert.equal((await chat({ provider: 'ollama', model: 'bad model id', messages: [{ role: 'user', content: 'Hi' }] })).res.status, 400);
  assert.equal((await chat({ provider: 'ollama', model: 'llama3.2', messages: [] })).res.status, 400);
  const res = await fetch(`${baseUrl}/api/chat`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('lists live models from a provider', async () => {
  const res = await fetch(`${baseUrl}/api/models?provider=ollama`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.models.includes('qwen3:8b'));

  const verify = await fetch(`${baseUrl}/api/models?provider=perplexity&verify=1`);
  assert.equal(verify.status, 200);
  assert.equal(lastRequest.body.max_tokens, 1);
});

test('APP_PASSWORD locks the API', async () => {
  process.env.APP_PASSWORD = 'open-sesame';
  try {
    const locked = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.equal(locked.authRequired, true);
    assert.equal(locked.authorized, false);
    assert.equal(locked.providers, undefined);

    const denied = await chat({ provider: 'ollama', model: 'llama3.2', messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(denied.res.status, 401);

    const allowed = await chat({ provider: 'ollama', model: 'llama3.2', messages: [{ role: 'user', content: 'Hi' }] }, { 'x-app-password': 'open-sesame' });
    assert.equal(allowed.res.status, 200);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});

test('serves the web app and blocks path traversal', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await home.text(), /id="composer"/);

  const js = await fetch(`${baseUrl}/js/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);

  const spa = await fetch(`${baseUrl}/some/deep/link`);
  assert.equal(spa.status, 200);

  const traversal = await fetch(`${baseUrl}/..%2fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));
  assert.ok(!(await traversal.text()).includes('"name"'));

  const missing = await fetch(`${baseUrl}/nope.js`);
  assert.equal(missing.status, 404);
});
