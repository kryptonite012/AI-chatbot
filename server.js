import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, env } from './lib/env.js';
import { createApp } from './lib/app.js';
import { appInfo } from './lib/handler.js';
import { getProviders, probeLocal, serverKey } from './lib/providers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const port = Number(env('PORT', '3000'));
const host = env('HOST', '0.0.0.0');

const server = http.createServer(createApp({ publicDir: path.join(ROOT, 'public') }));
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

server.listen(port, host, async () => {
  const { appName } = appInfo();
  console.log(`\n  ${appName} is running at http://localhost:${port}\n`);

  for (const p of getProviders()) {
    let status;
    if (p.local) status = (await probeLocal(p)).ok ? 'running' : 'not running';
    else status = serverKey(p) ? 'key set' : 'no key (can be added in the app)';
    const mark = status === 'key set' || status === 'running' ? '✓' : '·';
    console.log(`  ${mark} ${p.name.padEnd(11)} ${status}`);
  }
  if (!env('APP_PASSWORD')) {
    console.log('\n  Tip: set APP_PASSWORD before deploying publicly so strangers cannot use your API keys.');
  }
  console.log('');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
