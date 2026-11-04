// Vercel serverless entry point. Static files are served from /public by Vercel,
// and every /api/* request is rewritten here (see vercel.json).
import { handleApi } from '../lib/handler.js';
import { SECURITY_HEADERS } from '../lib/app.js';

export default async function handler(req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  return handleApi(req, res);
}
