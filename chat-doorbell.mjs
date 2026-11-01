// Chat doorbell. A critic ready or green head rings the owner's persistent chat.
// The inbox webhook still wakes the short routine. This POST is the seat message.
// A cloud-agent resume URL is refused and never fetched. The chat resumes critic_bc.

import fs from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{7,64}$/i;
const HEAD_KINDS = new Set(['ready', 'ci_pass']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function kindOf(line) {
  return text(line && (line.kind || line.type)).toLowerCase();
}

export function cloudResumeUrl(url) {
  let pathname = '';
  try { pathname = new URL(String(url || '')).pathname.toLowerCase(); }
  catch { return true; }
  if (pathname.includes('/agents/') || pathname.endsWith('/agents')) return true;
  if (pathname.includes('followup')) return true;
  return false;
}

export function isCriticHead(line, seat) {
  if (!line || typeof line !== 'object') return false;
  const owner = text(line.seat || seat).toLowerCase();
  if (owner !== 'critic') return false;
  if (line.seat && text(line.seat).toLowerCase() !== 'critic') return false;
  if (!HEAD_KINDS.has(kindOf(line))) return false;
  const repo = text(line.repo);
  const number = Number(line.number);
  const sha = text(line.sha).toLowerCase();
  if (!repo || !Number.isInteger(number) || number < 1 || !SHA.test(sha)) return false;
  return true;
}

export function criticHeads(lines, seat) {
  const out = [];
  const seen = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!isCriticHead(line, seat)) continue;
    const key = `${text(line.repo).toLowerCase()}#${Number(line.number)}|${text(line.sha).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function seatMessage(line) {
  const repo = text(line.repo);
  const number = Number(line.number);
  const sha = text(line.sha).toLowerCase();
  const url = text(line.url) || `https://github.com/${repo}/pull/${number}`;
  const kind = kindOf(line) || 'ready';
  const card = `${repo}#${number}`;
  const note = `SendToAgent critic: handoff ${kind} ${card} @${sha.slice(0, 7)} ${url} resume critic_bc`;
  return {
    seat: 'critic',
    kind: 'seat_message',
    action: 'wake',
    card,
    repo,
    number,
    sha,
    url,
    note: note.slice(0, 500),
  };
}

function covers(bell, head) {
  if (!bell || bell.kind !== 'seat_message' || text(bell.seat).toLowerCase() !== 'critic') return false;
  if (!text(bell.note)) return false;
  const repo = text(head.repo).toLowerCase();
  const number = Number(head.number);
  const sha = text(head.sha).toLowerCase();
  const bellRepo = text(bell.repo).toLowerCase();
  const bellSha = text(bell.sha).toLowerCase();
  if (bellRepo !== repo || Number(bell.number) !== number) return false;
  if (!bellSha || !sha) return false;
  return bellSha === sha || sha.startsWith(bellSha) || bellSha.startsWith(sha);
}

// NOTES that only say "Next for critic chat" are not a wake.
// A seat_message doorbell for that head is the wake. A cloud resume is not this function.
export function criticHandoffAcceptance({ notes = '', lines = [], doorbells = [], seat = 'critic' } = {}) {
  const heads = criticHeads(lines, seat);
  const asked = /next for critic chat/i.test(String(notes || ''));
  if (!heads.length && !asked) return { ok: true, reason: 'quiet' };
  if (!heads.length) {
    const hit = (doorbells || []).some((bell) => bell && bell.kind === 'seat_message' && text(bell.seat).toLowerCase() === 'critic' && text(bell.note));
    return hit ? { ok: true, reason: 'doorbell' } : { ok: false, reason: 'notes-only' };
  }
  const missing = heads.filter((head) => !(doorbells || []).some((bell) => covers(bell, head)));
  if (missing.length) return { ok: false, reason: 'notes-only' };
  return { ok: true, reason: 'doorbell' };
}

export function loadChatDoorbells(env = {}, seats = []) {
  const raw = env.SEAT_CHAT_DOORBELL;
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const known = new Set((seats || []).map((seat) => String(seat).toLowerCase()));
  const out = {};
  for (const [seat, cfg] of Object.entries(parsed)) {
    const id = String(seat || '').trim().toLowerCase();
    if (!known.has(id) || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const seatKeyEnv = 'CHAT_KEY_' + id.toUpperCase().replace(/-/g, '_');
    const url = typeof cfg.url === 'string' ? cfg.url : '';
    const keyEnv = typeof cfg.key_env === 'string' ? cfg.key_env : seatKeyEnv;
    const header = typeof cfg.header === 'string' && cfg.header.trim() ? cfg.header.trim() : 'Authorization';
    let okUrl = false;
    try {
      const u = new URL(url);
      okUrl = (u.protocol === 'http:' || u.protocol === 'https:') && !cloudResumeUrl(url);
    } catch { okUrl = false; }
    if (!okUrl || !/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(keyEnv) || !/^[A-Za-z0-9-]{1,64}$/.test(header)) continue;
    out[id] = { url, keyEnv, seatKeyEnv, header, bearer: header.toLowerCase() === 'authorization' };
  }
  return out;
}

export async function postSeatMessage(cfg, message, env = {}, fetchImpl = globalThis.fetch) {
  if (!cfg || !cfg.url) return { ok: false, error: 'no_chat', attempts: 0 };
  if (cloudResumeUrl(cfg.url)) return { ok: false, error: 'cloud_resume_refused', attempts: 0 };
  const body = JSON.stringify(message);
  if (/\/v0\/agents|followup/i.test(body)) return { ok: false, error: 'cloud_resume_refused', attempts: 0 };
  const key = env[cfg.keyEnv] || env[cfg.seatKeyEnv];
  if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) return { ok: false, error: 'no_key', attempts: 0 };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'bifrost-live' };
  if (cfg.bearer) headers.Authorization = 'Bearer ' + key;
  else headers[cfg.header] = key;
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (res && res.ok) return { ok: true, attempts: 1 };
    return { ok: false, error: 'http_' + (res && res.status), attempts: 1 };
  } catch {
    return { ok: false, error: 'network', attempts: 1 };
  }
}

export function appendDoorbell(dir, row) {
  if (!dir || !row) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'chat-doorbell.jsonl'), JSON.stringify(row) + '\n');
}
