import fs from 'node:fs';

/**
 * Minimal .env loader (no dependencies).
 * Values already present in process.env always win, so platform-provided
 * variables (Render, Railway, Docker, Vercel...) are never overwritten.
 */
export function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*?)\1\s*(?:#.*)?$/);
    if (quoted) {
      value = quoted[1] === '"' ? quoted[2].replace(/\\n/g, '\n') : quoted[2];
    } else if (value.startsWith('#')) {
      value = '';
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

export function env(name, fallback = '') {
  const value = process.env[name];
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}

export function envBool(name, fallback) {
  const value = env(name);
  if (!value) return fallback;
  return !/^(0|false|no|off)$/i.test(value);
}

export function envList(name, fallback) {
  const value = env(name);
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}
