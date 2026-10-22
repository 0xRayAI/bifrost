// ARCH1 cloud wake. The seat is arch1. Default off (ARCH1_LAUNCH_ENABLED=1 turns it on).
// A real packet (dispatch, Critic FAIL, ready) launches a Cursor cloud agent, or
// follows up the live agent that already holds that card. Nudges never launch.
// Webhooks are outgoing FINISHED/ERROR only, and the current Cloud Agents API
// still registers them on the legacy v0 create call (v1 webhooks are not out yet):
// https://cursor.com/docs/cloud-agent/api/endpoints
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ARCH1_CANON = 'arch1';
export const ARCH1_ALIAS = 'arch1';
const COOLDOWN_MS_DEFAULT = 30 * 60 * 1000;
const CAP_DEFAULT = 3;
const AGENT_ID = /^bc[_-][A-Za-z0-9-]{4,80}$/;

export function chicagoDay(when = new Date()) {
  const t = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}


export function isArch1Seat(seat) {
  const id = String(seat || '').toLowerCase();
  return id === ARCH1_CANON || id === ARCH1_ALIAS;
}

export function realPacketKind(line) {
  if (!line || typeof line !== 'object') return null;
  const type = String(line.type || '').toLowerCase().replace(/[\s-]+/g, '_');
  const reason = String(line.reason || '').toLowerCase();
  if (type === 'nudge' || reason.startsWith('nudge')) return null;
  if (type === 'dispatch') return 'dispatch';
  if (type === 'ready') return 'ready';
  if (type === 'critic_fail') return 'critic_fail';
  if (reason.includes('critic fail') || reason.includes('critic_fail')) return 'critic_fail';
  return null;
}

export function cardKeyOf(line) {
  const repo = String(line && line.repo || '').toLowerCase();
  const number = Number(line && line.number);
  if (repo && Number.isInteger(number) && number >= 1) return repo + '#' + number;
  return 'packet:' + String(line && line.id || '').slice(0, 120);
}

export function launchEnabled(env) {
  return String(env.ARCH1_LAUNCH_ENABLED || '0').trim() === '1';
}

export function dailyCap(env) {
  const n = Number(env.ARCH1_LAUNCH_DAILY_CAP);
  if (!Number.isFinite(n) || n < 0) return CAP_DEFAULT;
  return Math.floor(n);
}

export function cooldownMs(env) {
  const n = Number(env.ARCH1_LAUNCH_COOLDOWN_S);
  if (!Number.isFinite(n) || n < 0) return COOLDOWN_MS_DEFAULT;
  return n * 1000;
}

export function parseCloudRepo(raw) {
  let text = String(raw || '').trim() || 'https://github.com/0xRayAI/xray';
  let ref = 'main';
  const marked = text.match(/^(.*?)(?:#|@)([A-Za-z0-9._/-]{1,120})$/);
  if (marked && !/^https?:\/\//i.test(text)) { text = marked[1]; ref = marked[2]; }
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = 'https://github.com/' + text;
  try {
    const url = new URL(text);
    if (url.username || url.password) return { repository: 'https://github.com/0xRayAI/xray', ref: 'main' };
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      let name = parts[1].replace(/\.git$/, '');
      const atRef = name.match(/^(.*?)@([A-Za-z0-9._/-]{1,120})$/);
      if (atRef) { name = atRef[1]; ref = atRef[2]; }
      const repository = url.protocol + '//' + url.host + '/' + parts[0] + '/' + name;
      if (parts[2] === 'tree' && parts[3]) ref = decodeURIComponent(parts.slice(3).join('/')).slice(0, 120);
      return { repository, ref };
    }
  } catch { /* default below */ }
  return { repository: 'https://github.com/0xRayAI/xray', ref: 'main' };
}

function plain(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (/ghs_|github_pat_|BEGIN |cursor[-_]|api[_-]?key|bearer |\bsecret\b|:\/\/[^/\s]*:[^/\s]*@/i.test(text)) return '';
  return text.slice(0, max);
}

export function launchPrompt(line, env = {}) {
  const kind = realPacketKind(line) || 'packet';
  const host = String(env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const mesh = /^[a-z0-9.-]+$/i.test(host) ? 'Mesh: https://' + host : 'Mesh: the live mesh.';
  return [
    'You are ARCH1, the cloud seat.',
    'A real packet landed in your inbox.',
    'Read the inbox, do this card\'s work, and ack the line when the work is done.',
    'Card: ' + (Number.isInteger(line.number) && line.number >= 1 ? plain(line.repo, 200) + '#' + line.number : cardKeyOf(line)),
    'Type: ' + kind,
    'Title: ' + plain(line.title, 120),
    'Reason: ' + plain(line.reason, 160),
    'URL: ' + plain(line.url, 300),
    'Line id: ' + plain(line.id, 200),
    mesh,
    'Inbox: GET /inbox/arch1.',
    'Ack: POST /inbox/arch1/ack with this line id.',
    'TUI bar: when the card asks for the local ARCH1 retirement proof, run house/live/tools/arch1-tui-harness.sh.',
    'That script installs OpenCode, OpenClaw, Hermes, Grok CLI, and the Cursor agent CLI, then runs the 0xRay .cjs and .mjs harnesses.',
    'Post the log it writes. The log names the xray commit. Do not put credentials in the log.',
    'Push the branch only. Never open a pull request or an issue.',
  ].join('\n');
}

export function verifyCursorWebhook(secret, raw, signature) {
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function emptyState() {
  return { day: '', count: 0, cards: {}, beats: [], webhookIds: [] };
}

function cleanPending(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = plain(raw.id, 200);
  if (!id) return null;
  const number = Number(raw.number);
  const sha = String(raw.sha || '').toLowerCase();
  return {
    id,
    seat: isArch1Seat(raw.seat) ? String(raw.seat).toLowerCase() : ARCH1_CANON,
    type: plain(raw.type, 40),
    repo: plain(raw.repo, 200),
    number: Number.isInteger(number) ? number : 0,
    sha: /^[0-9a-f]{7,64}$/.test(sha) ? sha : '',
    title: plain(raw.title, 120),
    url: plain(raw.url, 300),
    reason: plain(raw.reason, 160),
  };
}

function pendingLine(pending) {
  const line = {
    id: pending.id, seat: pending.seat, type: pending.type, repo: pending.repo,
    number: pending.number, title: pending.title, url: pending.url, reason: pending.reason,
  };
  if (pending.sha) line.sha = pending.sha;
  return line;
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    return {
      day: typeof parsed.day === 'string' ? parsed.day : '',
      count: Number.isInteger(parsed.count) && parsed.count >= 0 ? parsed.count : 0,
      cards: sanitizeCards(parsed.cards),
      beats: Array.isArray(parsed.beats) ? parsed.beats.slice(-200) : [],
      webhookIds: Array.isArray(parsed.webhookIds) ? parsed.webhookIds.filter(id => typeof id === 'string').slice(-500) : [],
    };
  } catch { return emptyState(); }
}

function sanitizeCards(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cards = {};
  for (const [key, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const card = { ...row };
    const pending = cleanPending(row.pending);
    if (pending) card.pending = pending;
    else delete card.pending;
    cards[key] = card;
  }
  return cards;
}

function usedOn(state, day) {
  return state.day === day ? state.count : 0;
}

const DEAD_STATUS = new Set(['ERROR', 'TIMED_OUT', 'TIMEOUT', 'EXPIRED', 'CANCELLED']);

export function createArch1Launch({ env, dataDir, now = () => Date.now(), onBeat = () => {}, fetchImpl = globalThis.fetch, ownsCard, cardOnBoard, runningId }) {
  const file = path.join(dataDir, 'arch1-launch.json');
  const state = loadState(file);
  const enabled = launchEnabled(env);
  const cap = dailyCap(env);
  const waitMs = cooldownMs(env);
  const repo = parseCloudRepo(env.ARCH1_CLOUD_REPO);
  const api = String(env.CURSOR_API_URL || 'https://api.cursor.com').replace(/\/$/, '');
  const key = typeof env.CURSOR_API_KEY === 'string' ? env.CURSOR_API_KEY : '';
  const secret = typeof env.CURSOR_WEBHOOK_SECRET === 'string' ? env.CURSOR_WEBHOOK_SECRET : '';
  let tail = Promise.resolve();
  const timers = new Map();

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const text = JSON.stringify({
        day: state.day, count: state.count, cards: state.cards,
        beats: state.beats.slice(-200), webhookIds: state.webhookIds.slice(-500),
      });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch { console.log('arch1 launch: state save failed'); }
  }

  function roll(day) {
    if (state.day !== day) { state.day = day; state.count = 0; }
  }

  function health() {
    const day = chicagoDay(now()) || '';
    return { enabled, cap, used: usedOn(state, day), day, seat: ARCH1_CANON };
  }

  function cardBeats() { return state.beats.slice(); }

  function webhookUrl() {
    const base = String(env.CURSOR_WEBHOOK_BASE || '').trim()
      || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + String(env.RAILWAY_PUBLIC_DOMAIN).trim() : '')
      || String(env.RAILWAY_STATIC_URL || '').trim();
    if (!base || !/^https?:\/\//i.test(base)) return '';
    return base.replace(/\/$/, '') + '/cursor/webhook';
  }

  function authHeader() {
    return 'Basic ' + Buffer.from(key + ':', 'utf8').toString('base64');
  }

  async function postApi(pathname, body) {
    if (!key) return { ok: false, status: 0 };
    let res;
    try {
      res = await fetchImpl(api + pathname, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json', 'User-Agent': 'bifrost-live' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch { return { ok: false, status: 0 }; }
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { ok: res.ok, status: res.status, body: parsed };
  }

  function agentIdOf(body) {
    const id = body && (typeof body.id === 'string' ? body.id : body.agent && typeof body.agent.id === 'string' ? body.agent.id : '');
    return AGENT_ID.test(id) ? id : '';
  }

  function touch(card, at, extra) {
    const prev = state.cards[card] && typeof state.cards[card] === 'object' ? state.cards[card] : {};
    const next = {
      agentId: typeof prev.agentId === 'string' ? prev.agentId : '',
      at, status: typeof prev.status === 'string' ? prev.status : 'idle', ...extra,
    };
    if (Object.prototype.hasOwnProperty.call(extra, 'pending')) {
      if (extra.pending) next.pending = extra.pending;
      else delete next.pending;
    } else if (prev.pending) next.pending = prev.pending;
    state.cards[card] = next;
  }

  function rowOf(card) {
    return state.cards[card] && typeof state.cards[card] === 'object' ? state.cards[card] : null;
  }

  function cooling(row, at) {
    return !!(row && Number(row.at) > 0 && at - Number(row.at) < waitMs);
  }

  function queuePending(card, line) {
    const pending = cleanPending(line);
    if (!pending) return;
    const prev = rowOf(card) || { agentId: '', at: 0, status: 'idle' };
    state.cards[card] = { ...prev, pending };
    persist();
    arm(card);
  }

  function arm(card) {
    const row = rowOf(card);
    if (!row || !row.pending) return;
    const delay = Math.max(0, Number(row.at) + waitMs - now());
    const prev = timers.get(card);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => { timers.delete(card); void release(card); }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(card, timer);
  }

  function considerQueued(line) {
    const job = tail.then(() => run(line, { queued: true }), () => run(line, { queued: true }));
    tail = job.then(() => {}, () => {});
    return job;
  }

  function release(card) {
    const row = rowOf(card);
    if (!row || !row.pending) return Promise.resolve();
    if (cooling(row, now())) { arm(card); return Promise.resolve(); }
    const pending = row.pending;
    delete row.pending;
    persist();
    const prev = timers.get(card);
    if (prev) { clearTimeout(prev); timers.delete(card); }
    return considerQueued(pendingLine(pending));
  }

  function pump() {
    return Promise.all(Object.keys(state.cards).map(card => release(card)));
  }

  function rememberBeat(line, what, id) {
    const beat = {
      t: now(), what, repo: String(line.repo || '').slice(0, 200),
      number: Number.isInteger(line.number) ? line.number : 0, url: plain(line.url, 300),
      card: cardKeyOf(line),
    };
    state.beats.push(beat);
    if (state.beats.length > 200) state.beats.splice(0, state.beats.length - 200);
    const inbox = {
      id: String(id || ('arch1-beat:' + cardKeyOf(line) + ':' + what)).slice(0, 200),
      t_ct: new Date(beat.t).toISOString(), seat: ARCH1_CANON, type: 'beat',
      repo: beat.repo, number: beat.number, title: plain(line.title, 120), url: beat.url, reason: what.slice(0, 200),
    };
    persist();
    try { onBeat(beat, inbox); } catch { console.log('arch1 launch: beat failed'); }
  }

  function arch1Owns(line) {
    if (typeof ownsCard !== 'function') return true;
    try { return ownsCard(line) === true; }
    catch { return false; }
  }

  async function run(line, opts = {}) {
    const kind = realPacketKind(line);
    if (!kind || !isArch1Seat(line.seat)) return;
    if (!enabled) return;
    const at = now();
    const day = chicagoDay(at) || 'unknown';
    roll(day);
    const card = cardKeyOf(line);
    if (typeof cardOnBoard === 'function' && cardOnBoard(card) !== true) {
      const seen = state.beats.some(b => b.what === 'card missing' && b.card === card);
      if (!seen) rememberBeat(line, 'card missing', 'arch1-miss:' + card.slice(0, 120));
      return;
    }
    if (kind === 'critic_fail' && !arch1Owns(line)) return;
    const row = rowOf(card);
    if (!opts.queued && cooling(row, at)) { queuePending(card, line); return; }
    if (state.count >= cap) {
      const already = state.beats.some(b => b.what === 'ARCH1 launch cap reached' && b.card === card && chicagoDay(b.t) === day);
      if (!already) rememberBeat(line, 'ARCH1 launch cap reached', 'arch1-cap:' + day + ':' + card);
      console.log('arch1 launch: cap');
      return;
    }
    if (!key) { console.log('arch1 launch: not configured'); return; }
    const prompt = launchPrompt(line, env);
    const held = rowOf(card);
    const liveId = held && held.status === 'live' && AGENT_ID.test(String(held.agentId || '')) ? held.agentId : '';
    let resumeId = liveId;
    if (!resumeId && typeof runningId === 'function') {
      try {
        const found = String(runningId(line) || '');
        if (AGENT_ID.test(found)) resumeId = found;
      } catch { /* board unread: a new agent is still allowed */ }
    }
    if (resumeId) {
      const followed = await postApi('/v0/agents/' + encodeURIComponent(resumeId) + '/followup', { prompt: { text: prompt } });
      if (!followed.ok) {
        touch(card, at, { agentId: '', status: 'error' });
        persist();
        console.log('arch1 launch: follow-up http ' + (followed.status || 0));
      } else {
        touch(card, at, { agentId: resumeId, status: 'live', pending: null });
        state.count += 1;
        persist();
        console.log('arch1 launch: follow-up');
        return;
      }
    }
    const body = { prompt: { text: prompt }, source: { repository: repo.repository, ref: repo.ref }, name: ('ARCH1 ' + card).slice(0, 100) };
    const hook = webhookUrl();
    if (hook && secret.length >= 32) body.webhook = { url: hook, secret };
    else console.log('arch1 launch: webhook not registered');
    const result = await postApi('/v0/agents', body);
    touch(card, at, {});
    if (!result.ok) { persist(); console.log('arch1 launch: http ' + (result.status || 0)); return; }
    const agentId = agentIdOf(result.body);
    if (!agentId) { persist(); console.log('arch1 launch: no agent id'); return; }
    touch(card, at, { agentId, status: 'live', pending: null });
    state.count += 1;
    persist();
    console.log('arch1 launch: started');
  }

  function consider(line) {
    const job = tail.then(() => run(line), () => run(line));
    tail = job.then(() => {}, () => {});
    return job;
  }

  function handleWebhook(raw, headers) {
    const signature = headers['x-webhook-signature'] || headers['X-Webhook-Signature'] || '';
    if (!secret || !verifyCursorWebhook(secret, raw, signature)) return { status: 401, body: { error: 'unauthorized' } };
    let parsed;
    try { parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
    catch { return { status: 400, body: { error: 'not json' } }; }
    const delivery = String(headers['x-webhook-id'] || headers['X-Webhook-ID'] || '').slice(0, 200);
    if (delivery && state.webhookIds.includes(delivery)) return { status: 200, body: { ok: true, duplicate: true } };
    const status = String(parsed && parsed.status || '').toUpperCase();
    const dead = DEAD_STATUS.has(status);
    if (status !== 'FINISHED' && !dead) return { status: 200, body: { ok: true } };
    roll(chicagoDay(now()) || 'unknown');
    const agentId = parsed && typeof parsed.id === 'string' ? parsed.id : '';
    let card = '';
    let row = null;
    if (AGENT_ID.test(agentId)) {
      for (const [keyName, held] of Object.entries(state.cards)) {
        if (held && held.agentId === agentId) { card = keyName; row = held; break; }
      }
    }
    if (row && status === 'FINISHED') row.status = 'finished';
    if (row && dead) { row.status = 'error'; row.agentId = ''; }
    const what = status === 'FINISHED' ? 'ARCH1 cloud agent FINISHED' : status === 'ERROR' ? 'ARCH1 cloud agent ERROR' : 'ARCH1 cloud agent TIMEOUT';
    if (delivery) state.webhookIds.push(delivery);
    const split = card.includes('#') ? card.split('#') : ['', '0'];
    const repoName = split.slice(0, -1).join('#') || '';
    const number = Number(split[split.length - 1]);
    const target = parsed && parsed.target && typeof parsed.target === 'object' ? parsed.target : {};
    const url = typeof target.url === 'string' && target.url.startsWith('https://') ? target.url.slice(0, 300) : '';
    const summary = plain(parsed && parsed.summary, 160);
    const line = {
      repo: repoName, number: Number.isInteger(number) ? number : 0, title: summary, url, id: delivery || agentId || what,
      seat: ARCH1_CANON, type: 'beat', reason: what,
    };
    rememberBeat(line, what);
    console.log('arch1 launch: webhook ' + status.toLowerCase());
    return { status: 200, body: { ok: true } };
  }

  for (const card of Object.keys(state.cards)) if (rowOf(card) && rowOf(card).pending) arm(card);

  return { consider, handleWebhook, health, cardBeats, pump };
}
