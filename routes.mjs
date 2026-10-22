// Route validation, same rules as tools/bifrost-init --check (#294): every fleet seat needs a route, and no rule may
// route to a seat outside the fleet. The server runs it at startup and flags problems on the board and in the log.
import fs from 'node:fs';
import path from 'node:path';

export function roleTargets(roles) {
  const out = new Map(), add = (s, why) => { const k = String(s).toLowerCase(); if (!out.has(k)) out.set(k, new Set()); out.get(k).add(why); };
  for (const [role, r] of Object.entries(roles?.seats || {})) if (r && typeof r === 'object' && !r.off && r.seat) add(r.seat, `seats.${role}`);
  for (const [seat, r] of Object.entries(roles?.extra_seats || {})) if (r && typeof r === 'object' && ['kinds', 'needles', 'merge_bases'].some(k => Array.isArray(r[k]) && r[k].length)) add(seat, 'extra_seats');
  for (const key of ['pr_heads', 'comment_watch']) for (const seat of Object.keys(roles?.[key]?.seats || {})) add(seat, key);
  const fb = roles?.fallback || {};
  for (const seat of [fb.seat, ...(Array.isArray(fb.from) ? fb.from : [])]) if (seat) add(seat, 'fallback');
  return out;
}

/** -> { ok, unrouted: [seat], unknown: [seat], error? } */
export function checkRoutes(roles, seats) {
  const t = roleTargets(roles), fleet = new Set(seats.map(s => String(s).toLowerCase()));
  const unrouted = [...fleet].filter(s => !t.has(s)).sort();
  const unknown = [...t.keys()].filter(s => !fleet.has(s)).sort();
  return { ok: !unrouted.length && !unknown.length, unrouted, unknown };
}

export function checkRoutesFromDir(dir, rosterFile) {
  try {
    const roles = JSON.parse(fs.readFileSync(path.join(dir, 'inbox-roles.json'), 'utf8'));
    const seats = JSON.parse(fs.readFileSync(rosterFile, 'utf8')).seats || [];
    if (!seats.length) return { ok: false, unrouted: [], unknown: [], error: 'no seats in the roster' };
    return checkRoutes(roles, seats);
  } catch (e) {
    return { ok: false, unrouted: [], unknown: [], error: 'routing not readable (' + (e.code || 'json') + ')' };
  }
}

// Routing map (inbox-roles.json "routing"): each seat once, its real GitHub login (App seats as name[bot], people by
// handle, null = no GitHub login) and its nicknames as aliases. Served read-only at GET /routing.
/** -> [{ seat, login, aliases }] */
export function routingMap(roles) {
  return Object.entries(roles?.routing || {}).filter(([, e]) => e && typeof e === 'object')
    .map(([seat, e]) => ({ seat: seat.toLowerCase(), login: typeof e.login === 'string' && e.login ? e.login : null,
      aliases: (Array.isArray(e.aliases) ? e.aliases : []).filter(a => typeof a === 'string') }));
}
export function readRoutingMap(dir) {
  try { return routingMap(JSON.parse(fs.readFileSync(path.join(dir, 'inbox-roles.json'), 'utf8'))); } catch { return []; }
}

// Login resolver: GET <api>/users/<login> with the existing read token. Cached (ttlMs), rate-limit safe: a 403/429 with
// no remaining quota pauses every lookup until the reset time and answers from cache ('unverified' when there is none).
// -> 'ok' (exists) | 'missing' (404: refuse the entry) | 'unverified' (no token, network, rate limit).
export function createLoginResolver({ api = 'https://api.github.com', token = '', ttlMs = 6 * 3600e3, fetchImpl = globalThis.fetch,
  now = () => Date.now() } = {}) {
  const cache = new Map(); let pausedUntil = 0; let calls = 0;
  async function resolve(login) {
    const key = String(login).toLowerCase(), hit = cache.get(key), t = now();
    if (hit && t - hit.t < ttlMs) return hit.status;
    if (!token || t < pausedUntil) return hit ? hit.status : 'unverified';
    let status;
    try {
      calls++;
      const r = await fetchImpl(`${api.replace(/\/$/, '')}/users/${encodeURIComponent(login)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'bifrost-routing' } });
      if (r.status === 200) status = 'ok';
      else if (r.status === 404) status = 'missing';
      else {
        const left = Number(r.headers.get('x-ratelimit-remaining')), reset = Number(r.headers.get('x-ratelimit-reset'));
        if ((r.status === 403 || r.status === 429) && (left === 0 || r.headers.get('retry-after'))) {
          const ra = Number(r.headers.get('retry-after'));
          pausedUntil = ra > 0 ? t + ra * 1000 : reset > 0 ? reset * 1000 : t + 3600e3;
        }
        return hit ? hit.status : 'unverified';
      }
    } catch { return hit ? hit.status : 'unverified'; }
    cache.set(key, { status, t });
    return status;
  }
  return { resolve, get calls() { return calls; } };
}

/** Resolve every map login. -> { entries: [{seat, login, aliases, status}], refused: [seat], unverified: [seat], no_login: [seat] } */
export async function auditLogins(entries, resolve) {
  const out = [];
  for (const e of entries) out.push({ ...e, status: e.login ? await resolve(e.login) : 'no_login' });
  const pick = st => out.filter(e => e.status === st).map(e => e.seat).sort();
  return { entries: out, refused: pick('missing'), unverified: pick('unverified'), no_login: pick('no_login') };
}
