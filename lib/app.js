import fs from 'node:fs';
import path from 'node:path';
import { handleApi } from './handler.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(self)',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function statFile(file) {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

async function serveStatic(req, res, root, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return plain(res, 400, 'Bad request');
  }
  if (rel.includes('\0')) return plain(res, 400, 'Bad request');

  let file = path.join(root, path.normalize(rel));
  if (file !== root && !file.startsWith(root + path.sep)) return plain(res, 403, 'Forbidden');

  let stat = await statFile(file);
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await statFile(file);
  }
  if (!stat) {
    if (path.extname(rel)) return plain(res, 404, 'Not found');
    file = path.join(root, 'index.html'); // single-page app fallback
    stat = await statFile(file);
    if (!stat) return plain(res, 404, 'Not found');
  }

  const lastModified = stat.mtime.toUTCString();
  if (req.headers['if-modified-since'] === lastModified) {
    res.writeHead(304);
    return res.end();
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'last-modified': lastModified,
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/** Request handler serving the API and the web app. */
export function createApp({ publicDir }) {
  const root = path.resolve(publicDir);
  return async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res);

    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
    try {
      await serveStatic(req, res, root, pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) plain(res, 500, 'Server error');
    }
  };
}
