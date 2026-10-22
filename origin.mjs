// Pinned public origin. The page never trusts Host or X-Forwarded-Host.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function refuse(msg) {
  console.error(msg + '; refusing to start');
  process.exit(1);
}

/** https, or http only for localhost / 127.0.0.1. Invalid values exit in every NODE_ENV. */
export function pinnedOrigin(env = process.env) {
  const fromApp = String(env.APP_PUBLIC_ORIGIN ?? '').trim();
  const raw = fromApp || String(env.LIVE_URL ?? '').trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') refuse('missing APP_PUBLIC_ORIGIN');
    return '';
  }
  let url;
  try { url = new URL(raw); }
  catch { refuse('invalid APP_PUBLIC_ORIGIN'); }
  if (url.username || url.password) refuse('invalid APP_PUBLIC_ORIGIN');
  const https = url.protocol === 'https:';
  const httpLocal = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!https && !httpLocal) refuse('invalid APP_PUBLIC_ORIGIN');
  if (!url.hostname) refuse('invalid APP_PUBLIC_ORIGIN');
  return url.origin;
}
