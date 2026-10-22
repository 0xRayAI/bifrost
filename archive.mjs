// Append-only daily archive. Live windows stay where they are; this store is never pruned.
// Day folders are America/Chicago. A 19:30 CT event belongs on that Chicago date, not the next UTC date.
import fs from 'node:fs';
import path from 'node:path';
import { chicagoDay, chicagoStamp } from './chicago-stamp.mjs';

export const KINDS = ['events', 'cards', 'inbox', 'nudges', 'acks', 'activity'];
const CAP = 300;
const DROP = /body|text|message|secret|token|password|authorization/i;
const FIELDS = {
  events: ['t_ct', 'from', 'to', 'kind', 'direction', 'label', 'source', 'src_file', 'repo', 'number', 'credit', 'status', 'sha', 'actor', 'author', 'merged_by'],
  cards: ['key', 'repo', 'number', 'title', 'url', 'owner', 'stage', 'state', 'kind', 'verb', 'merged_by', 'labels', 'agents', 'pinned', 'section', 'stall', 'nudge', 'last_beat_t', 'packet_ok', 'waiting', 'packet', 'hold', 'beats', 't_ct', 'updated_ct'],
  inbox: ['t_ct', 'seat', 'type', 'repo', 'number', 'sha', 'title', 'url', 'reason'],
  nudges: ['kind', 't', 't_ct', 'card', 'repo', 'number', 'title', 'url', 'stage', 'level', 'seat', 'via', 'beat_t', 'closed_at', 'about'],
  acks: ['seat', 'line', 't_ct', 'review'],
  activity: ['seq', 'seat', 't_ct', 'kind', 'action', 'from', 'to', 'agent', 'tag'],
};

const seen = new Set();
let root = '';
let cardCache = null;
const transitionIds = new Set();
let transitionLatest = new Map();
const TRANSITION_VERBS = new Set(['opened', 'stage', 'parked', 'held', 'released', 'merged', 'closed', 'reopened']);
const KIND_TRANSITION = {
  pr_open: ['opened', 'live', 'review'],
  issue_open: ['opened', 'live', 'open'],
  pr_ready: ['opened', 'live', 'review'],
  pr_draft: ['parked', 'parked', 'review'],
  merged: ['merged', 'closed', 'done'],
  pr_close: ['closed', 'closed', 'done'],
  issue_close: ['closed', 'closed', 'done'],
  pr_reopen: ['reopened', 'live', 'review'],
  issue_reopen: ['reopened', 'live', 'open'],
};

export function validArchiveDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function clip(v, depth = 0) {
  if (typeof v === 'string') return v.length > CAP ? v.slice(0, CAP) : v;
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => clip(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (DROP.test(k)) continue;
      o[k] = clip(v[k], depth + 1);
    }
    return o;
  }
  return null;
}

export function recordId(kind, row) {
  if (!row || typeof row !== 'object') return '';
  if (kind === 'cards') {
    const key = typeof row.key === 'string' ? row.key : '';
    if (!key) return '';
    const stage = row.stage == null ? '' : String(row.stage);
    const state = row.state == null ? '' : String(row.state);
    const updated = typeof row.updated_ct === 'string' ? row.updated_ct : '';
    return updated ? `${key}|${stage}|${state}|${updated}` : `${key}|${stage}|${state}`;
  }
  if (kind === 'inbox') return row.id == null ? '' : `${row.seat ?? ''}:${row.id}`;   // ids repeat across seats (builder-cloud copy, multi-seat route)
  if (kind === 'acks') return `${row.seat}:${row.line ?? row.lineId ?? ''}`;
  return row.id == null ? '' : String(row.id);
}

/** Fields the board already shows. Drops body, text, message, secret, token, password, authorization. */
export function project(kind, row) {
  const src = row && typeof row === 'object' ? row : {};
  const out = { id: kind === 'inbox' ? String(src.id ?? '') : recordId(kind, src) };   // inbox keeps the line id; seat is its own field
  for (const k of FIELDS[kind] || []) {
    if (!(k in src) || DROP.test(k)) continue;
    out[k] = clip(src[k]);
  }
  return out;
}

/** Byte length of the daily archived line, including the trailing newline. */
export function archivedLineBytes(kind, row) {
  return Buffer.byteLength(JSON.stringify(project(kind, row)) + '\n');
}

function timeMs(row) {
  for (const c of [row.t_ct, row.closed_at, row.updated_ct]) {
    const t = typeof c === 'number' ? c : Date.parse(c || '');
    if (Number.isFinite(t) && t > 0) return t;
  }
  if (typeof row.t === 'number' && Number.isFinite(row.t) && row.t > 0) return row.t;
  return Date.now();
}

function logRead(e) {
  if (e && e.code !== 'ENOENT') console.log('archive: read failed ' + e.code);
}

// #290: startup reads only the newest WARM_DAYS day dirs; any other day's ids load lazily on its first append.
const WARM_DAYS = Math.max(1, Number(process.env.MESH_ARCHIVE_WARM_DAYS) || 2);
const loadedDays = new Set();

function loadDay(day) {
  if (loadedDays.has(day)) return;
  loadedDays.add(day);
  const dir = path.join(root, day);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { logRead(e); return; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const kind = name.slice(0, -6);
    if (!KINDS.includes(kind)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); }
    catch (e) { logRead(e); continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const id = kind === 'inbox' ? recordId(kind, row) : row && row.id;
        if (row && row.id && id) seen.add(kind + '\0' + id);
      } catch { /* truncated or corrupt line */ }
    }
  }
}

function loadSeen() {
  let days;
  try { days = fs.readdirSync(root); }
  catch (e) { logRead(e); return; }
  for (const day of days.filter(validArchiveDate).sort().slice(-WARM_DAYS)) loadDay(day);
}

export function loadedArchiveDays() { return [...loadedDays].sort(); }

export function initArchive(dataDir) {
  root = path.join(dataDir || process.env.MESH_DATA_DIR || '/data', 'archive');
  seen.clear();
  loadedDays.clear();
  cardCache = null;
  transitionIds.clear();
  transitionLatest = new Map();
  loadSeen();
  loadTransitionIndex();
  return root;
}

export function archiveDays() {
  let names;
  try { names = fs.readdirSync(root); }
  catch (e) { logRead(e); return []; }
  return names.filter(validArchiveDate).sort();
}

export function appendArchive(kind, row) {
  if (!root || !KINDS.includes(kind) || !row || typeof row !== 'object') return false;
  const id = recordId(kind, row);
  if (!id) return false;
  const key = kind + '\0' + id;
  const day = chicagoDay(timeMs(row));
  if (!validArchiveDate(day)) return false;
  loadDay(day);
  if (seen.has(key)) return false;
  const rec = project(kind, row);
  const file = path.join(root, day, kind + '.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (e) {
    console.log('archive: append failed ' + (e && e.code || 'write'));
    return false;
  }
  seen.add(key);
  if (kind === 'cards' && cardCache && typeof rec.key === 'string' && rec.key && rec.kind !== 'source') cardCache.push(rec);
  return true;
}

function loadCardCache() {
  if (cardCache) return cardCache;
  const rows = [];
  for (const day of archiveDays()) {
    for (const row of readArchive(day, 'cards').lines) {
      if (row && typeof row.key === 'string' && row.key && row.kind !== 'source') rows.push(row);
    }
  }
  cardCache = rows;
  return rows;
}

function textOf(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

function chicagoTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  const stamped = chicagoStamp(ms);
  if (!stamped) return '';
  if (typeof value === 'string' && value.slice(0, 19) === stamped.slice(0, 19) && value.slice(-6) === stamped.slice(-6)) return value;
  return stamped;
}

function indexFile() {
  return path.join(root, 'transition-index.json');
}

function transitionFile(day) {
  return path.join(root, day, 'transitions.jsonl');
}

function preferLatest(prev, row) {
  if (!prev) return row;
  const prevT = Date.parse(prev.t_ct) || 0;
  const nextT = Date.parse(row.t_ct) || 0;
  if (prev.transition === 'merged' && row.transition === 'closed') return prev;
  if (row.transition === 'reopened' && nextT >= prevT) return row;
  if (prev.transition === 'merged' && row.transition !== 'merged' && row.transition !== 'reopened') return prev;
  if (nextT > prevT) return row;
  if (nextT < prevT) return prev;
  if (row.transition === 'merged' && prev.transition !== 'merged') return row;
  if (prev.transition === 'merged' && row.transition !== 'merged') return prev;
  return String(row.id) > String(prev.id) ? row : prev;
}

function rememberTransition(row) {
  if (!row || !row.id || !row.card) return;
  transitionIds.add(row.id);
  transitionLatest.set(row.card, preferLatest(transitionLatest.get(row.card), row));
}

function scanTransitionRows() {
  const rows = [];
  let days;
  try { days = fs.readdirSync(root); }
  catch (e) { logRead(e); return rows; }
  for (const day of days.filter(validArchiveDate).sort()) {
    let text;
    try { text = fs.readFileSync(transitionFile(day), 'utf8'); }
    catch (e) { logRead(e); continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.id && row.card) rows.push(row);
      } catch { /* truncated or corrupt line */ }
    }
  }
  return rows;
}

function writeTransitionIndex() {
  if (!root) return;
  const body = JSON.stringify({
    ids: [...transitionIds].sort(),
    latest: Object.fromEntries(transitionLatest),
  });
  const file = indexFile();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    console.log('archive: transition index failed ' + (e && e.code || 'write'));
  }
}

function rebuildTransitionIndex() {
  transitionIds.clear();
  transitionLatest = new Map();
  for (const row of scanTransitionRows()) rememberTransition(row);
  writeTransitionIndex();
}

function loadTransitionIndex() {
  transitionIds.clear();
  transitionLatest = new Map();
  let raw;
  try { raw = fs.readFileSync(indexFile(), 'utf8'); }
  catch (e) {
    logRead(e);
    rebuildTransitionIndex();
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed.ids) ? parsed.ids : null;
    const latest = parsed.latest && typeof parsed.latest === 'object' && !Array.isArray(parsed.latest) ? parsed.latest : null;
    if (!ids || !latest) {
      rebuildTransitionIndex();
      return;
    }
    for (const id of ids) if (typeof id === 'string' && id) transitionIds.add(id);
    for (const [card, row] of Object.entries(latest)) {
      if (row && typeof row === 'object' && row.id) transitionLatest.set(card, row);
    }
  } catch {
    rebuildTransitionIndex();
  }
}

function bcOf(e) {
  const bags = [e.bc, e.bcId, e.bc_id];
  if (e.actor && typeof e.actor === 'object') bags.push(e.actor.bc);
  for (const c of bags) {
    const s = typeof c === 'string' ? c.trim() : '';
    if (/^bc-[a-z0-9-]+$/i.test(s)) return s.slice(0, 80);
  }
  return '';
}

function loginOf(e) {
  const actor = e.actor;
  if (typeof actor === 'string' && actor) return actor.slice(0, 80);
  if (actor && typeof actor === 'object' && typeof actor.login === 'string' && actor.login) return actor.login.slice(0, 80);
  if (typeof e.author === 'string' && e.author) return e.author.slice(0, 80);
  if (typeof e.merged_by === 'string' && e.merged_by) return e.merged_by.slice(0, 80);
  return '';
}

function seatOfEvent(e) {
  if (typeof e.credit === 'string' && e.credit) return e.credit.slice(0, 80);
  if (e.actor && typeof e.actor === 'object' && typeof e.actor.seat === 'string' && e.actor.seat) return e.actor.seat.slice(0, 80);
  if (typeof e.from === 'string') return e.from.slice(0, 80);
  return '';
}

/** One transition from a feed event. Merged wins later, at read time. No message body. */
export function transitionFromEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const mapped = KIND_TRANSITION[String(e.kind || '')];
  const repo = String(e.repo || '').toLowerCase();
  const number = Number(e.number);
  const source = e.id == null ? '' : String(e.id);
  if (!mapped || !repo || !Number.isInteger(number) || !source) return null;
  const t = chicagoTime(e.t_ct);
  if (!t) return null;
  const packet = textOf(typeof e.title === 'string' ? e.title : (typeof e.label === 'string' ? e.label : ''), 200);
  return {
    card: `${repo}#${number}`,
    transition: mapped[0],
    from_state: '',
    to_state: mapped[1],
    from_stage: '',
    to_stage: mapped[2],
    actor: { seat: seatOfEvent(e), login: loginOf(e), bc: bcOf(e) },
    t_ct: t,
    source_id: source.slice(0, 200),
    packet,
  };
}

/** Append-only. Id is card|transition|source_id. The same source event appends once. */
export function appendTransition(row) {
  if (!root || !row || typeof row !== 'object') return false;
  const card = String(row.card || '').toLowerCase();
  const transition = String(row.transition || '');
  const source = row.source_id == null ? '' : String(row.source_id).slice(0, 200);
  if (!card || !TRANSITION_VERBS.has(transition) || !source) return false;
  const id = `${card}|${transition}|${source}`;
  if (transitionIds.has(id)) return false;
  const t = chicagoTime(row.t_ct);
  const day = t.slice(0, 10);
  if (!validArchiveDate(day)) return false;
  const actor = row.actor && typeof row.actor === 'object' ? row.actor : {};
  const rec = {
    id, card, transition,
    from_state: textOf(row.from_state, 40),
    to_state: textOf(row.to_state, 40),
    from_stage: textOf(row.from_stage, 40),
    to_stage: textOf(row.to_stage, 40),
    actor: { seat: textOf(actor.seat, 80), login: textOf(actor.login, 80), bc: textOf(actor.bc, 80) },
    t_ct: t,
    source_id: source,
    packet: textOf(typeof row.packet === 'string' ? row.packet : '', 200),
  };
  const file = transitionFile(day);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (e) {
    console.log('archive: transition append failed ' + (e && e.code || 'write'));
    return false;
  }
  rememberTransition(rec);
  writeTransitionIndex();
  return true;
}

function clampLimit(raw) {
  if (raw == null || raw === '') return 200;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 200;
  return Math.min(1000, n);
}

function inWindow(stamp, since, until) {
  const t = Date.parse(stamp || '');
  if (since) {
    const s = Date.parse(since);
    if (Number.isFinite(s) && (!Number.isFinite(t) || t < s)) return false;
  }
  if (until) {
    const u = Date.parse(until);
    if (Number.isFinite(u) && (!Number.isFinite(t) || t > u)) return false;
  }
  return true;
}

function pageKeep(list, query, idOf) {
  let rows = list;
  const cursor = query && query.cursor ? String(query.cursor) : '';
  if (cursor) {
    const at = rows.findIndex(row => idOf(row) === cursor);
    rows = at < 0 ? [] : rows.slice(at + 1);
  }
  const limit = clampLimit(query && query.limit);
  const page = rows.slice(0, limit);
  const next = rows.length > page.length ? idOf(page[page.length - 1] || {}) : '';
  return { rows: page, next: next || '' };
}

export function queryTransitions(query = {}) {
  const card = String(query.card || '').toLowerCase();
  const verb = String(query.transition || '');
  let rows = scanTransitionRows();
  if (card) rows = rows.filter(row => String(row.card || '').toLowerCase() === card);
  if (verb) rows = rows.filter(row => row.transition === verb);
  rows = rows.filter(row => inWindow(row.t_ct, query.since, query.until));
  rows.sort((a, b) => (Date.parse(a.t_ct) || 0) - (Date.parse(b.t_ct) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const paged = pageKeep(rows, query, row => row.id);
  return { transitions: paged.rows, next: paged.next };
}

/** NDJSON for one Chicago day. Empty when that day has no transitions file. */
export function exportTransitions(date) {
  if (!validArchiveDate(date)) return '';
  try { return fs.readFileSync(transitionFile(date), 'utf8'); }
  catch (e) { logRead(e); return ''; }
}

function cardStamp(row) {
  const direct = row && (row.updated_ct || row.t_ct);
  if (typeof direct === 'string' && Number.isFinite(Date.parse(direct))) return direct;
  const beat = Number(row && row.last_beat_t);
  if (Number.isFinite(beat) && beat > 0) return new Date(beat).toISOString();
  const closed = Number(row && row.closed_t);
  if (Number.isFinite(closed) && closed > 0) return new Date(closed).toISOString();
  return '';
}

function splitCard(card) {
  const match = /^(.*)#(\d+)$/.exec(String(card || ''));
  if (!match) return { repo: '', number: 0 };
  return { repo: match[1], number: Number(match[2]) };
}

function cardFromRows(key, arr) {
  arr.sort((a, b) => (Date.parse(cardStamp(a)) || 0) - (Date.parse(cardStamp(b)) || 0));
  const last = arr[arr.length - 1];
  const opened = arr.map(row => row.t_ct).filter(s => Number.isFinite(Date.parse(s))).sort()[0] || '';
  const owner = [...arr].reverse().map(row => (typeof row.owner === 'string' ? row.owner : '')).find(Boolean) || '';
  const closed = last.state === 'closed';
  const stamp = cardStamp(last);
  const beats = arr.flatMap(row => Array.isArray(row.beats) ? row.beats : []);
  const lastVerb = last && (last.verb === 'merged' || last.verb === 'closed') ? last.verb : '';
  const verb = lastVerb || ((last && last.merged_by) || beats.some(b => /merge/i.test(String((b && (b.what || b.kind)) || '')))
    ? 'merged' : closed ? 'closed' : (typeof last.state === 'string' ? last.state : ''));
  const labels = Array.isArray(last.labels) ? last.labels.filter(s => typeof s === 'string') : [];
  const agents = Array.isArray(last.agents) ? last.agents.filter(s => typeof s === 'string') : [];
  const parts = splitCard(key);
  return {
    id: key, owner, state: typeof last.state === 'string' ? last.state : '', verb,
    opened_ct: opened, closed_ct: closed ? stamp : '',
    title: typeof last.title === 'string' ? last.title : '',
    url: typeof last.url === 'string' ? last.url : '',
    repo: typeof last.repo === 'string' && last.repo ? last.repo : parts.repo,
    number: Number.isInteger(last.number) ? last.number : parts.number,
    updated_ct: stamp, labels, agents,
    merged_by: typeof last.merged_by === 'string' ? last.merged_by : '',
  };
}

function cardFromTransition(row) {
  const parts = splitCard(row.card);
  const merged = row.transition === 'merged';
  const closed = merged || row.transition === 'closed';
  const state = closed ? 'closed' : (row.to_state || '');
  return {
    id: row.card, owner: row.actor && row.actor.seat || '', state,
    verb: merged ? 'merged' : closed ? 'closed' : (state || row.transition),
    opened_ct: row.transition === 'opened' ? row.t_ct : '',
    closed_ct: closed ? row.t_ct : '',
    title: typeof row.packet === 'string' ? row.packet : '',
    url: '', repo: parts.repo, number: parts.number,
    updated_ct: row.t_ct || '', labels: [], agents: [],
    merged_by: merged && row.actor ? (row.actor.login || '') : '',
  };
}

// A merged transition wins over a later live snapshot in cards.jsonl. A later reopen wins back.
function overlayTransition(card, latest) {
  if (!latest) return card;
  if (!card) return cardFromTransition(latest);
  if (latest.transition === 'merged') {
    card.state = 'closed';
    card.verb = 'merged';
    card.closed_ct = latest.t_ct || card.closed_ct;
    if (!card.merged_by && latest.actor && latest.actor.login) card.merged_by = latest.actor.login;
    return card;
  }
  const cardT = Date.parse(card.updated_ct || '') || 0;
  const tranT = Date.parse(latest.t_ct || '') || 0;
  if (latest.transition === 'reopened' && tranT >= cardT) {
    card.state = 'live';
    card.verb = 'live';
    card.closed_ct = '';
    return card;
  }
  if (latest.transition === 'closed' && card.verb !== 'merged') {
    card.state = 'closed';
    card.verb = 'closed';
    card.closed_ct = latest.t_ct || card.closed_ct;
    return card;
  }
  return card;
}

/** Latest version of each card. Rows with no key are ignored. Nothing is deleted. Pass a query to page. */
export function cardHistory(query) {
  const grouped = new Map();
  for (const row of loadCardCache()) {
    const key = String(row.key || '').toLowerCase();
    if (!key) continue;
    const arr = grouped.get(key);
    if (arr) arr.push(row); else grouped.set(key, [row]);
  }
  for (const card of transitionLatest.keys()) if (!grouped.has(card)) grouped.set(card, []);
  const cards = [];
  for (const [key, arr] of grouped) {
    const storedKey = arr.length ? arr[0].key : key;
    const base = arr.length ? cardFromRows(storedKey, arr) : null;
    const card = overlayTransition(base, transitionLatest.get(key));
    if (card && card.id) cards.push(card);
  }
  const owners = [...new Set(cards.map(c => c.owner).filter(Boolean))].sort();
  const days = [...new Set(cards.flatMap(c => [c.opened_ct, c.closed_ct, c.updated_ct].map(s => String(s || '').slice(0, 10)).filter(validArchiveDate)))].sort();
  cards.sort((a, b) => (Date.parse(b.updated_ct) || 0) - (Date.parse(a.updated_ct) || 0) || (a.id < b.id ? -1 : 1));
  if (!query) return { cards, owners, days };
  let shown = cards;
  if (query.state) {
    const s = String(query.state).toLowerCase();
    shown = shown.filter(c => String(c.verb || '').toLowerCase() === s || String(c.state || '').toLowerCase() === s);
  }
  if (query.since || query.until) shown = shown.filter(c => inWindow(c.closed_ct || c.updated_ct, query.since, query.until));
  const paged = pageKeep(shown, query, c => c.id);
  return { cards: paged.rows, owners, days, next: paged.next };
}

export function readArchive(date, kind) {
  if (!validArchiveDate(date) || !KINDS.includes(kind)) return { lines: [] };
  const file = path.join(root, date, kind + '.jsonl');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { logRead(e); return { lines: [] }; }
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { lines.push(JSON.parse(line)); }
    catch { /* truncated or corrupt line */ }
  }
  return { lines };
}

function nudgeClose(n) {
  return { ...n, id: `${n.id}#closed`, t_ct: n.closed_at || n.t_ct };
}

/** One backfill of inboxes, nudges, acks, cards, and github feed events. Marker is temp + rename. */
export function backfillArchive(parts = {}) {
  if (!root) initArchive(parts.dataDir);
  const mark = path.join(root, '.backfill-done');
  try { if (fs.existsSync(mark)) return false; }
  catch (e) { logRead(e); }
  for (const [seat, lines] of Object.entries(parts.inboxes || {})) {
    if (!Array.isArray(lines)) continue;
    for (const l of lines) if (l) appendArchive('inbox', { ...l, seat: l.seat ?? seat });
  }
  for (const l of parts.extraInbox || []) if (l) appendArchive('inbox', { ...l, seat: l.seat ?? 'builder' });
  for (const n of parts.nudges || []) {
    if (!n) continue;
    appendArchive('nudges', n);
    if (n.closed_at) appendArchive('nudges', nudgeClose(n));
  }
  for (const seat of Object.keys(parts.acks || {})) {
    const ids = parts.acks[seat];
    if (!Array.isArray(ids)) continue;
    for (const lineId of ids) appendArchive('acks', { seat, line: lineId, t_ct: new Date().toISOString() });
  }
  for (const c of parts.cards || []) appendArchive('cards', c);
  for (const e of parts.events || []) {
    appendArchive('events', e);
    const row = transitionFromEvent(e);
    if (row) appendTransition(row);
  }
  fs.mkdirSync(root, { recursive: true });
  const tmp = mark + '.tmp';
  fs.writeFileSync(tmp, '1\n');
  fs.renameSync(tmp, mark);
  return true;
}
