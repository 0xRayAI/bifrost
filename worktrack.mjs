// Work the server already heard about: Cursor agent webhooks, inbox packets, wakes, blockers.
// Live state is rebuilt from append-only files on the volume. Nothing here is deleted.
import fs from 'node:fs';
import path from 'node:path';
import { clockStamp } from './chicago-stamp.mjs';

// Seats, display names, aliases and the human lane come from the server's config (configureWorkTrack); nothing here
// names a seat. HUMAN_TO is the `to` value that parks a packet with a person; HUMAN_LANE is that lane's label.
export const SEAT_IDS = [];
export const UNASSIGNED = 'unassigned';
let DISPLAY = {};
let ALIAS = {};
let MIRROR = {};   // seat <-> its mirror seat (an inbox line copied to both counts once; an ack on either counts)
let MIRROR_COPY = new Set();   // the copy side of each pair (kept when both sides hold a line)
let HUMAN_TO = 'human';
let LAUNCH_SEAT = '';
export let HUMAN_LANE = 'Waiting on a human';

export function configureWorkTrack({ seatIds = [], display = {}, alias = {}, mirror = {}, humanTo, humanLane, launchSeat } = {}) {
  SEAT_IDS.length = 0;
  for (const id of seatIds) { const k = String(id || '').toLowerCase(); if (k && !SEAT_IDS.includes(k)) SEAT_IDS.push(k); }
  DISPLAY = {}; ALIAS = {}; MIRROR = {}; MIRROR_COPY = new Set();
  for (const id of SEAT_IDS) DISPLAY[id] = typeof display[id] === 'string' && display[id] ? display[id] : id;
  for (const [k, v] of Object.entries(alias || {})) { const id = String(v || '').toLowerCase(); if (SEAT_IDS.includes(id)) ALIAS[String(k).toLowerCase()] = id; }
  for (const [id, name] of Object.entries(DISPLAY)) { ALIAS[id] = id; ALIAS[name.toLowerCase()] = id; }
  for (const [a, b] of Object.entries(mirror || {})) { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); if (SEAT_IDS.includes(x) && SEAT_IDS.includes(y)) { MIRROR[x] = y; MIRROR[y] = x; MIRROR_COPY.add(y); } }
  if (typeof humanTo === 'string' && /^[a-z0-9_-]{1,40}$/i.test(humanTo)) HUMAN_TO = humanTo.toLowerCase();
  if (typeof humanLane === 'string' && humanLane.trim()) HUMAN_LANE = humanLane.trim().slice(0, 60);
  LAUNCH_SEAT = SEAT_IDS.includes(String(launchSeat || '').toLowerCase()) ? String(launchSeat).toLowerCase() : '';
}

const PACKET_TYPES = new Set(['dispatch', 'ready', 'packet', 'critic_fail', 'needs_human']);

export function displaySeat(id) {
  const key = String(id || '').toLowerCase();
  return DISPLAY[key] || '';
}

export function canonSeatToken(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key || key.length > 40) return '';
  const id = ALIAS[key] || (SEAT_IDS.includes(key) ? key : '');
  return SEAT_IDS.includes(id) ? id : '';
}

export function toToken(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === HUMAN_TO) return HUMAN_TO;
  return canonSeatToken(key);
}

function textOf(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/ghs_|github_pat_|BEGIN |api[_-]?key|bearer |\bsecret\b|cursor[-_]?key/i.test(text)) return '';
  return text.slice(0, max);
}

function httpsUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url.startsWith('https://') || /[\s]/.test(url) || url.includes('@')) return '';
  return url.slice(0, 300);
}

function prOf(parsed) {
  const target = parsed && parsed.target && typeof parsed.target === 'object' ? parsed.target : {};
  const pull = parsed && (parsed.pull_request || parsed.pullRequest);
  const pr = pull && typeof pull === 'object' ? pull : {};
  return httpsUrl(target.prUrl) || httpsUrl(target.pr_url) || httpsUrl(parsed && parsed.prUrl) || httpsUrl(parsed && parsed.pr_url)
    || httpsUrl(pr.html_url) || httpsUrl(pr.url)
    || (typeof target.url === 'string' && target.url.includes('/pull/') ? httpsUrl(target.url) : '');
}

function statusOf(raw) {
  switch (raw) {
    case 'CREATED':
    case 'CREATING':
    case 'CREATE':
    case 'AGENT_CREATED':
      return 'created';
    case 'RUNNING':
    case 'IN_PROGRESS':
    case 'WORKING':
    case 'ACTIVE':
      return 'running';
    case 'PR_OPENED':
    case 'PR_OPEN':
    case 'PULL_REQUEST_OPENED':
    case 'PULL_REQUEST':
      return 'pr_opened';
    case 'FINISHED':
    case 'FINISH':
    case 'COMPLETE':
    case 'COMPLETED':
    case 'DONE':
      return 'finished';
    case 'ERROR':
    case 'TIMED_OUT':
    case 'TIMEOUT':
    case 'EXPIRED':
    case 'CANCELLED':
    case 'CANCELED':
    case 'FAILED':
      return 'failed';
    case '':
      return '';
    default:
      return raw.includes('PR_OPEN') ? 'pr_opened' : '';
  }
}

export function rankOf(status) {
  switch (status) {
    case 'created': return 1;
    case 'running': return 2;
    case 'pr_opened': return 3;
    case 'finished':
    case 'failed': return 4;
    default: {
      /** @type {never} */
      const unexpected = status;
      throw new Error('unknown agent status ' + String(unexpected));
    }
  }
}

export function classifyCursor(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = String(parsed.status || parsed.event || parsed.type || '').toUpperCase().replace(/[\s.-]+/g, '_');
  const pr = safePrUrl(prOf(parsed));
  let status = statusOf(raw);
  if (!status && pr) status = 'pr_opened';
  if (!status) return null;
  return { status, rank: rankOf(status), pr, closed: status === 'finished' || status === 'failed' };
}

function agentOf(parsed) {
  const id = typeof parsed.id === 'string' ? parsed.id
    : parsed.agent && typeof parsed.agent === 'object' && typeof parsed.agent.id === 'string' ? parsed.agent.id
    : typeof parsed.agentId === 'string' ? parsed.agentId : '';
  const clean = id.trim();
  return /^[A-Za-z0-9._:-]{4,80}$/.test(clean) ? clean : '';
}

function payloadSeat(parsed) {
  const meta = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
  const source = parsed.source && typeof parsed.source === 'object' ? parsed.source : {};
  const agent = parsed.agent && typeof parsed.agent === 'object' ? parsed.agent : {};
  const agentMeta = agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {};
  const spots = [parsed.seat, parsed.launching_seat, meta.seat, meta.launching_seat, source.seat, agent.seat, agentMeta.seat, agentMeta.launching_seat];
  for (const spot of spots) {
    const id = canonSeatToken(spot);
    if (id) return id;
  }
  return '';
}

function mapSeat(agent, map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return '';
  if (Object.prototype.hasOwnProperty.call(map, agent)) {
    const id = canonSeatToken(map[agent]);
    if (id) return id;
  }
  for (const [key, value] of Object.entries(map)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (prefix && agent.startsWith(prefix)) {
      const id = canonSeatToken(value);
      if (id) return id;
    }
  }
  return '';
}

function launchSeat(dir, agent) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'arch1-launch.json'), 'utf8'));
    const cards = parsed && parsed.cards && typeof parsed.cards === 'object' ? parsed.cards : {};
    for (const row of Object.values(cards)) {
      if (LAUNCH_SEAT && row && row.agentId === agent) return LAUNCH_SEAT;
    }
  } catch { /* no launch file */ }
  return '';
}

export function resolveAgentSeat(parsed, agent, dir, map) {
  return payloadSeat(parsed) || launchSeat(dir, agent) || mapSeat(agent, map) || '';
}

export function seatForAgentId(agent, map) {
  return mapSeat(String(agent || ''), map);
}

export function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      const row = JSON.parse(raw);
      if (row && typeof row === 'object') rows.push(row);
    } catch { /* keep the rest of the log */ }
  }
  return rows;
}

function appendJsonl(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

export function decideAgent(existing, next) {
  if (!next || typeof next.agent !== 'string' || !next.agent || typeof next.status !== 'string') return 'ignore';
  const rows = existing.filter(row => row && row.agent === next.agent);
  if (next.event_id && existing.some(row => row && row.event_id === next.event_id)) return 'duplicate';
  const rank = rows.reduce((max, row) => Math.max(max, Number(row.rank) || 0), 0);
  if (Number(next.rank) < rank) return 'stale';
  const same = rows.some(row => row.status === next.status && Number(row.rank) === Number(next.rank));
  if (same) {
    const hadPr = rows.some(row => row.pr);
    if (next.pr && !hadPr) return 'append';
    return 'duplicate';
  }
  return 'append';
}

export function acceptCursorWebhook({ dir, raw, headers, map, now = Date.now() }) {
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
  catch { return { appended: false, action: 'ignore' }; }
  const classified = classifyCursor(parsed);
  const agent = parsed && typeof parsed === 'object' ? agentOf(parsed) : '';
  if (!classified || !agent) return { appended: false, action: 'ignore' };
  const headerId = headers && (headers['x-webhook-id'] || headers['X-Webhook-ID']) || '';
  const bodyId = typeof parsed.event_id === 'string' ? parsed.event_id : typeof parsed.eventId === 'string' ? parsed.eventId : '';
  const eventId = String(headerId || bodyId || (agent + ':' + classified.status)).slice(0, 200);
  const file = path.join(dir, 'agents.jsonl');
  const existing = readJsonl(file);
  const priorSeat = existing.reduce((seat, row) => (row && row.agent === agent && row.seat && row.seat !== UNASSIGNED ? row.seat : seat), '');
  const seat = resolveAgentSeat(parsed, agent, dir, map) || priorSeat || UNASSIGNED;
  const rec = {
    event_id: eventId,
    agent,
    status: classified.status,
    rank: classified.rank,
    seat,
    t_ct: clockStamp(now),
    title: textOf(parsed.summary || parsed.name || agent, 120) || agent,
    pr: classified.pr || '',
  };
  const action = decideAgent(existing, rec);
  if (action !== 'append') return { appended: false, action };
  appendJsonl(file, rec);
  return { appended: true, action, record: rec };
}

export function appendWake(dir, rec) {
  appendJsonl(path.join(dir, 'wakes.jsonl'), rec);
}

export function readWakeRows(dir) {
  return readJsonl(path.join(dir, 'wakes.jsonl'));
}

function readInboxLines(dir) {
  const inbox = path.join(dir, 'inbox');
  let names = [];
  try { names = fs.readdirSync(inbox); } catch { return []; }
  const byId = new Map();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of readJsonl(path.join(inbox, name))) {
      if (!line || typeof line.id !== 'string' || !line.id) continue;
      const prev = byId.get(line.id);
      if (!prev || (MIRROR[prev.seat] === line.seat && MIRROR_COPY.has(line.seat))) byId.set(line.id, line);
    }
  }
  return [...byId.values()];
}

function readAcks(dir) {
  const out = {};
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(path.join(dir, 'acks.json'), 'utf8')); } catch { return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [seat, ids] of Object.entries(parsed)) {
    out[String(seat).toLowerCase()] = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  }
  return out;
}

function lineAcked(acks, seat, id) {
  if (acks[seat] && acks[seat].has(id)) return true;
  const twin = MIRROR[seat];
  if (twin && acks[twin] && acks[twin].has(id)) return true;
  return false;
}

export function isBlocker(line) {
  if (!line || typeof line !== 'object') return false;
  const type = String(line.type || '').toLowerCase();
  const kind = String(line.kind || '').toLowerCase();
  const flag = String(line.flag || '').toLowerCase();
  const to = String(line.to || '').toLowerCase();
  return type === 'needs_human' || kind === 'needs_human' || flag === 'needs_human' || to === HUMAN_TO;
}

export function isPacket(line) {
  if (!line || typeof line !== 'object') return false;
  const type = String(line.type || '').toLowerCase();
  const kind = String(line.kind || '').toLowerCase();
  if (PACKET_TYPES.has(type) || PACKET_TYPES.has(kind)) return true;
  if (isBlocker(line)) return true;
  return false;
}

function wokenIds(wakes) {
  const ids = new Set();
  for (const row of wakes || []) {
    if (!row || row.ok !== true || row.outcome === 'skipped') continue;
    if (typeof row.id === 'string' && row.id) ids.add(row.id);
    if (Array.isArray(row.ids)) for (const id of row.ids) if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

function packetItem(line, { acked, woken, closed, now, windowMs }) {
  const seat = String(line.seat || '').toLowerCase();
  const from = canonSeatToken(line.from);
  const title = textOf(line.title, 120) || String(line.id);
  const steps = ['sent', 'delivered'];
  let phase = 'delivered';
  if (woken) { steps.push('woken'); phase = 'woken'; }
  if (acked) { steps.push('acked'); phase = 'acked'; }
  const age = now - Date.parse(line.t_ct || '');
  const overdue = !acked && !closed && Number.isFinite(age) && age > windowMs;
  const working = woken && !acked && !closed;
  const labels = [phase];
  if (working) labels.push('working on ' + title);
  if (overdue) labels.push('overdue');
  const seats = [];
  if (from && !seats.includes(from)) seats.push(from);
  if (seat && SEAT_IDS.includes(seat) && !seats.includes(seat)) seats.push(seat);
  const blocked = isBlocker(line) && !acked && !closed;
  const lanes = blocked ? [HUMAN_LANE] : seats.map(id => displaySeat(id)).filter(Boolean);
  return {
    id: String(line.id),
    kind: 'packet',
    phase,
    steps,
    label: labels.join(' · '),
    labels,
    title,
    url: typeof line.url === 'string' ? line.url.slice(0, 300) : '',
    pr: '',
    seats,
    lane: lanes[0] || displaySeat(seat) || seat,
    lanes,
    overdue,
    flagged: overdue,
    working,
    closed: !!closed,
    seat_name: working ? displaySeat(seat) : '',
    t_ct: typeof line.t_ct === 'string' ? line.t_ct : '',
    agent: '',
    status: phase,
  };
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
// Same owner/repo rules as house/burst/activity.mjs. A dotted repo name stays.
// "." and ".." are not names, so github.com/../../pull/1 is not a card.
// The {0,38} group counts "-b" as one repeat. The lookahead counts characters: owner 39, repo 100.
const GH_OWNER = '(?![A-Za-z0-9-]{40})[A-Za-z0-9](?:-[A-Za-z0-9]|[A-Za-z0-9]){0,38}';
const GH_REPO = '(?![A-Za-z0-9._-]{101})[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?';
const CARD_REF = new RegExp('^' + GH_OWNER + '/' + GH_REPO + '#\\d{1,8}$');
const PR_URL = new RegExp('^https://github\\.com/(' + GH_OWNER + ')/(' + GH_REPO + ')/pull/(\\d{1,8})(?:/|\\?|#|$)');
const SAFE_PR_URL = new RegExp('^https://github\\.com/' + GH_OWNER + '/' + GH_REPO + '/pull/\\d{1,8}$');

export function cardRefOf(value) {
  const raw = String(value || '').trim();
  if (CARD_REF.test(raw)) return raw;
  const match = PR_URL.exec(raw);
  return match ? `${match[1]}/${match[2]}#${Number(match[3])}` : '';
}

function boardStateOfStatus(status) {
  if (status === 'failed') return 'failed';
  if (status === 'finished') return 'finished';
  if (status === 'running' || status === 'created' || status === 'pr_opened') return 'running';
  return '';
}

function boardStateOfAction(action) {
  switch (String(action || '').toLowerCase()) {
    case 'cancel': return 'failed';
    case 'finished':
    case 'finish': return 'finished';
    case 'launch':
    case 'reply': return 'running';
    default: return '';
  }
}

function safePr(value) {
  const raw = String(value || '').trim();
  if (CARD_REF.test(raw)) return raw;
  if (PR_URL.test(raw)) return raw.slice(0, 300);
  return '';
}

/** https GitHub pull URL only. A card ref stays on tag. javascript:, data:, and http: are empty. Longer than 300 is refused. */
export function safePrUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return '';
  const raw = value.trim();
  if (!raw || raw.length > 300 || !SAFE_PR_URL.test(raw)) return '';
  return raw;
}

/** The critic cloud id for one PR. A running agent wins, then the newest. A failed id is used only when it is the only one. */
export function criticCloudId(cardKey, agents) {
  const key = String(cardKey || '').trim().toLowerCase();
  if (!key) return '';
  const rows = (Array.isArray(agents) ? agents : []).filter((row) => {
    if (!row || String(row.seat || '').toLowerCase() !== 'critic') return false;
    return String(row.card || '').trim().toLowerCase() === key && typeof row.bcId === 'string' && row.bcId;
  });
  if (!rows.length) return '';
  const usable = rows.filter((row) => row.state !== 'failed');
  const pool = usable.length ? usable : rows;
  pool.sort((a, b) => {
    const run = (b.state === 'running' ? 1 : 0) - (a.state === 'running' ? 1 : 0);
    if (run) return run;
    return (Date.parse(b.updated_ct) || 0) - (Date.parse(a.updated_ct) || 0) || String(b.bcId).localeCompare(String(a.bcId));
  });
  return pool[0].bcId;
}

/** Copy critic_bc onto each card from the critic cloud row for that PR. A card with no critic row keeps a stored id. */
export function stampCriticCloud(cards, agents) {
  return (Array.isArray(cards) ? cards : []).map((card) => {
    if (!card || typeof card !== 'object') return card;
    const id = criticCloudId(card.key, agents);
    if (!id || card.critic_bc === id) return card;
    return { ...card, critic_bc: id };
  });
}

export const CLOUD_STALE_MS = 6 * 60 * 60 * 1000;

function markStaleCloud(rows, now) {
  return rows.map(row => {
    if (!row || row.state !== 'running') return row;
    const t = Date.parse(row.updated_ct);
    if (!Number.isFinite(t) || now - t <= CLOUD_STALE_MS) return row;
    return { ...row, state: 'stale' };
  });
}

function boardIds(board) {
  const ids = new Set();
  for (const card of board || []) {
    const key = typeof card === 'string' ? card : (card && card.key);
    if (typeof key === 'string' && key) ids.add(key.toLowerCase());
  }
  return ids;
}

function linkedCard(value, onBoard) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (CARD_REF.test(raw)) return raw;
  const fromUrl = cardRefOf(raw);
  if (fromUrl) return fromUrl;
  if (onBoard.has(raw.toLowerCase())) return raw;
  return '';
}

const BC_MENTION = /\b(bc-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/;

/** bc id anywhere in a turn tag or a branch name, plus the text after it. */
function cloudMention(text) {
  const raw = String(text || '');
  const match = BC_MENTION.exec(raw);
  if (!match) return null;
  const id = match[1];
  const track = raw.slice(match.index + id.length).trim().replace(/^[·:\-]+\s*/, '');
  return { id, track };
}

function boardCardKey(repo, number, board) {
  const num = Number(number);
  if (!repo || !Number.isInteger(num) || num < 1) return '';
  const hit = (board || []).find(card => card && String(card.repo || '').toLowerCase() === String(repo).toLowerCase() && Number(card.number) === num && card.key);
  if (hit) return String(hit.key);
  const key = `${repo}#${num}`;
  return CARD_REF.test(key) ? key : '';
}

/** A turn track is `owner/repo#n`, `#n`, or a bare number that matches one board card. */
function trackCard(track, board) {
  const raw = String(track || '').trim();
  if (!raw) return '';
  const direct = cardRefOf(raw);
  if (direct) return direct;
  const marked = raw.match(/#(\d{1,8})\b/) || raw.match(/^(\d{1,8})(?:\b|[-#])/);
  if (!marked) return '';
  const num = Number(marked[1]);
  const hits = (board || []).filter(card => card && Number(card.number) === num && card.key);
  if (!hits.length) return '';
  if (hits.length === 1) return String(hits[0].key);
  const pr = hits.find(card => card.kind === 'pr' || card.kind === 'packet');
  return String((pr || hits[0]).key);
}

function prOfCard(key, board) {
  const hit = (board || []).find(card => card && String(card.key || '') === key);
  return hit ? safePrUrl(hit.url) : '';
}

const PACKET_KEY = /^packet:[A-Za-z0-9._:-]{1,80}$/i;

function trackCardCell(cell) {
  const raw = String(cell || '').trim();
  if (CARD_REF.test(raw) || PACKET_KEY.test(raw)) return raw;
  return cardRefOf(raw);
}

/** TRACKS.md rows: Cloud id, seat, card (`owner/repo#n` or `packet:…`), state. */

const BC_ID = /\bbc-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,12})\b/gi;

/** Cloud agent ids in a PR body or a turn line. The body is not kept. */
export function cloudIdsIn(text) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(BC_ID.source, 'gi');
  for (const match of String(text || '').matchAll(re)) {
    const id = match[0].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length === 8) break;
  }
  return out;
}

export function trackRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
    if (cells.length < 3 || !/^bc-/i.test(cells[0])) continue;
    const card = trackCardCell(cells[2]);
    if (!card) continue;
    rows.push({ bcId: cells[0], card, seat: cells[1] || '' });
  }
  return rows;
}

function hrefFor(card, board) {
  const key = String(card || '');
  const hit = (board || []).find(item => item && String(item.key || '').toLowerCase() === key.toLowerCase());
  const url = hit && typeof hit.url === 'string' ? hit.url.trim() : '';
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+\/?$/.test(url)) return url;
  const match = new RegExp('^(' + GH_OWNER + ')/(' + GH_REPO + ')#(\\d{1,8})$', 'i').exec(key);
  if (!match) return '';
  const kind = hit && hit.kind === 'issue' ? 'issues' : 'pull';
  return `https://github.com/${match[1]}/${match[2]}/${kind}/${Number(match[3])}`;
}

/** A run with no pull URL takes the card named on its TRACKS row. */
function linkTrackRows(rows, tracks, board) {
  for (const hit of trackRows(tracks)) {
    for (const row of rows || []) {
      if (!row || row.pr || !cloudIdsAlias(row.bcId, hit.bcId)) continue;
      if (!row.card) row.card = hit.card;
      if (!row.url) row.url = hrefFor(hit.card, board);
    }
  }
}

/** Fill an empty card or PR from a turn tag (`bc-<id> <track>`) or a head_ref that carries the id. */
function linkCloudCards(rows, { activity = [], events = [], board = [] } = {}) {
  const list = rows || [];
  function touch(id, card, pr) {
    if (!id) return;
    for (const row of list) {
      if (!row || !cloudIdsAlias(row.bcId, id)) continue;
      if (card && !row.card) row.card = card;
      if (pr && !row.pr) row.pr = pr;
      if (row.card && !row.pr) {
        const url = prOfCard(row.card, board);
        if (url) row.pr = url;
      }
    }
  }
  const texts = [];
  for (const row of activity || []) {
    if (!row || typeof row !== 'object') continue;
    const tag = typeof row.tag === 'string' ? row.tag : '';
    const label = typeof row.label === 'string' ? row.label : '';
    texts.push({ text: tag || label, event: row });
  }
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const blob = [event.head_ref, event.branch, event.ref, event.label, event.title].filter(value => typeof value === 'string').join(' ');
    if (blob) texts.push({ text: blob, event });
  }
  for (const item of texts) {
    const mention = cloudMention(item.text);
    if (!mention) continue;
    const fromEvent = boardCardKey(item.event && item.event.repo, item.event && item.event.number, board);
    const card = fromEvent || trackCard(mention.track, board);
    const pr = safePrUrl(item.event && (item.event.source || item.event.url || item.event.pr)) || safePr(item.event && item.event.pr);
    touch(mention.id, card, pr);
  }
  return list;
}

function pullUrlFromCard(card) {
  const match = new RegExp('^(' + GH_OWNER + ')/(' + GH_REPO + ')#(\\d{1,8})$').exec(String(card || ''));
  if (!match) return '';
  return `https://github.com/${match[1]}/${match[2]}/pull/${Number(match[3])}`;
}

function branchScore(bcId, branch) {
  const id = String(bcId || '').trim().toLowerCase();
  const ref = String(branch || '').trim().toLowerCase();
  if (!id || !ref) return 0;
  if (ref.includes(id)) return 100 + id.length;
  const hex = id.slice(3);
  if (hex.length >= 8 && ref.includes(hex)) return 80 + hex.length;
  const tail = (ref.match(/-([0-9a-f]{4,12})$/) || [])[1] || '';
  if (tail && (hex.endsWith(tail) || id.endsWith(tail))) return tail.length;
  return 0;
}

function pullOf(record) {
  if (!record || typeof record !== 'object') return null;
  const repo = typeof record.repo === 'string' ? record.repo : '';
  const number = Number(record.number);
  const card = CARD_REF.test(String(record.card || ''))
    ? String(record.card)
    : (repo && Number.isInteger(number) && number > 0 ? `${repo}#${number}` : cardRefOf(record.key || record.url || record.source || ''));
  const pr = safePrUrl(record.pr || record.url || record.source || '') || (card ? pullUrlFromCard(card) : '');
  const ids = []
    .concat(Array.isArray(record.bc_ids) ? record.bc_ids : [])
    .concat(cloudIdsIn(record.body))
    .concat(cloudIdsIn(record.label));
  const branch = record.head_ref || record.branch || '';
  if (!card && !pr) return null;
  if (!ids.length && !branch) return null;
  return {
    card: card || cardRefOf(pr),
    pr: pr || (card ? pullUrlFromCard(card) : ''),
    ids: ids.map(id => String(id).toLowerCase()),
    branch: String(branch),
  };
}

/** Map a cloud id to a card. TRACKS wins. Then a PR body that names the id, then the head branch. */
export function cloudCardFor(bcId, { tracks = '', events = [], board = [] } = {}) {
  const id = String(bcId || '').trim();
  if (!AGENT_ID.test(id)) return null;
  for (const row of trackRows(tracks)) {
    if (cloudIdsAlias(row.bcId, id)) return { card: row.card, pr: pullUrlFromCard(row.card) };
  }
  const pulls = [];
  for (const record of events || []) {
    const pull = pullOf(record);
    if (pull) pulls.push(pull);
  }
  for (const card of board || []) {
    const pull = pullOf(card);
    if (pull) pulls.push(pull);
  }
  const ranked = [];
  for (const pull of pulls) {
    let score = 0;
    for (const cid of pull.ids) {
      if (cid === id.toLowerCase() || cloudIdsAlias(cid, id)) score = Math.max(score, 100 + cid.length);
    }
    score = Math.max(score, branchScore(id, pull.branch));
    if (score) ranked.push({ pull, score });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.pull.card).localeCompare(String(b.pull.card)));
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].score < 8) return null;
  return { card: ranked[0].pull.card, pr: ranked[0].pull.pr };
}

function linkCloudRows(rows, sources) {
  return rows.map(row => {
    if (!row || row.card || row.pr) return row;
    const hit = cloudCardFor(row.bcId, sources);
    if (!hit || (!hit.card && !hit.pr)) return row;
    const next = { ...row, card: hit.card || row.card || '', pr: hit.pr || row.pr || '' };
    delete next.flag;
    return next;
  });
}

/** One board row per cloud agent. Latest line wins the state; an earlier seat, card, or PR stays. */
export function boardCloudAgents({ agents = [], activity = [], links = [], board = [], events = [], tracks = '', now = Date.now() } = {}) {
  const onBoard = boardIds(board);
  const lines = [];
  for (const row of agents || []) {
    if (!row || typeof row !== 'object') continue;
    const state = boardStateOfStatus(row.status);
    if (!state) continue;
    lines.push({
      bcId: row.agent,
      seat: row.seat && row.seat !== UNASSIGNED ? row.seat : '',
      pr: typeof row.pr === 'string' ? row.pr : '',
      card: '',
      state,
      updated_ct: typeof row.t_ct === 'string' ? row.t_ct : '',
    });
  }
  for (const row of activity || []) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind !== 'cloud_agent' && row.kind !== 'agent') continue;
    const state = boardStateOfAction(row.action);
    if (!state) continue;
    const tag = typeof row.tag === 'string' ? row.tag : '';
    lines.push({
      bcId: row.agent,
      seat: row.seat || row.by || '',
      pr: safePrUrl(row.pr),
      card: CARD_REF.test(tag) ? tag : '',
      state,
      updated_ct: typeof row.t_ct === 'string' ? row.t_ct : '',
    });
  }
  lines.sort((a, b) => (Date.parse(a.updated_ct) || 0) - (Date.parse(b.updated_ct) || 0));
  const by = new Map();
  for (const ev of lines) {
    const id = String(ev.bcId || '').trim();
    if (!AGENT_ID.test(id)) continue;
    const prev = by.get(id);
    const pr = safePr(ev.pr) || (prev && prev.pr) || '';
    const card = (CARD_REF.test(ev.card) ? ev.card : '') || cardRefOf(pr) || (prev && prev.card) || '';
    const seat = canonSeatToken(ev.seat) || (prev && prev.seat) || '';
    by.set(id, { bcId: id, seat, card, pr, state: ev.state, updated_ct: ev.updated_ct || (prev && prev.updated_ct) || '' });
  }
  for (const link of links || []) {
    if (!link || typeof link !== 'object') continue;
    const id = String(link.bcId || link.agent || '').trim();
    if (!AGENT_ID.test(id)) continue;
    const seat = canonSeatToken(link.seat) || '';
    const card = linkedCard(link.card, onBoard) || linkedCard(link.pr, onBoard);
    const pr = safePr(link.pr);
    const prev = by.get(id);
    if (!prev) {
      const state = link.state === 'failed' || link.state === 'finished' || link.state === 'running' ? link.state : 'running';
      by.set(id, { bcId: id, seat, card, pr, state, updated_ct: typeof link.updated_ct === 'string' ? link.updated_ct : '' });
      continue;
    }
    if (!prev.seat && seat) prev.seat = seat;
    if (!prev.card && card) prev.card = card;
    if (!prev.pr && pr) prev.pr = pr;
  }
  const rows = [...by.values()].sort((a, b) => (Date.parse(b.updated_ct) || 0) - (Date.parse(a.updated_ct) || 0) || a.bcId.localeCompare(b.bcId));
  linkCloudCards(rows, { activity, events, board });
  linkTrackRows(rows, tracks, board);
  const linked = linkCloudRows(foldCloudIds(rows), { tracks, events, board });
  const folded = linked.map(row => {
    if (!row) return row;
    const next = { ...row };
    delete next.flag;
    if (next.card && !next.url) next.url = hrefFor(next.card, board);
    if (next.card || next.pr) delete next.label;
    else next.label = 'no card';
    return next;
  });
  return markStaleCloud(folded, now);
}

/** True when one id is the other, or one is a bc- prefix of the other (`bc-531f2033` and the full uuid). */
export function cloudIdsAlias(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!AGENT_ID.test(left) || !AGENT_ID.test(right)) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= 11 && long.startsWith(short + '-');
}

/** One row per agent. A short id and its full id fold together. Newest line wins state; a known seat, card, or PR stays. */
const WORK_HANDOFF = new Set(['ready', 'critic_fail', 'live_pass', 'merge', 'ci_fail']);
const NOT_CARD_OWNER = new Set(['builder-cloud', 'cloud', 'cloudagents', 'unassigned', 'others', 'github', 'ci', '']);

function workSeatSet(seats) {
  const source = seats && seats.length ? seats : SEAT_IDS;
  return new Set(source.map((seat) => String(seat || '').toLowerCase()).filter((seat) => seat && !NOT_CARD_OWNER.has(seat)));
}

function workSeat(value, seats) {
  const key = String(value || '').trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9_-]/g, '');
  if (!key || NOT_CARD_OWNER.has(key)) return '';
  return seats.has(key) ? key : '';
}

function workAt(row) {
  const raw = Number(row && row.t);
  if (Number.isFinite(raw) && raw > 0) return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse((row && (row.t_ct || row.updated_ct || row.created_at)) || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function workKey(card) {
  const key = String(card && card.key || '').trim();
  if (key) return key.toLowerCase();
  const repo = String(card && card.repo || '').trim();
  const number = Number(card && card.number);
  return repo && Number.isInteger(number) ? `${repo}#${number}`.toLowerCase() : '';
}

function sameWorkCard(card, ref) {
  const want = workKey(card);
  const got = String(cardRefOf(ref) || ref || '').trim().toLowerCase();
  if (!want || !got) return false;
  return want === got;
}

function seatForBc(bcId, agents, seats) {
  const id = String(bcId || '').trim();
  if (!id) return '';
  for (const row of agents || []) {
    if (!row || !cloudIdsAlias(row.bcId || row.agent, id)) continue;
    const seat = workSeat(row.seat, seats) || workSeat(row.by, seats);
    if (seat) return seat;
  }
  return '';
}

function seatForWorkCard(card, agents, seats) {
  const key = workKey(card);
  for (const row of agents || []) {
    if (!row) continue;
    const named = String(cardRefOf(row.card) || row.card || '').toLowerCase();
    if (named !== key) continue;
    const seat = workSeat(row.seat, seats) || workSeat(row.by, seats) || seatForBc(row.bcId || row.agent, agents, seats);
    if (seat) return seat;
  }
  return '';
}

const ACTIVITY_STALL_MS = 60 * 60 * 1000;
const GH_ISSUE_URL = new RegExp('https://github\\.com/(' + GH_OWNER + ')/(' + GH_REPO + ')/(?:pull|issues)/(\\d{1,8})\\b', 'gi');
const FULL_CARD_REF = new RegExp('\\b(' + GH_OWNER + '/' + GH_REPO + ')#(\\d{1,8})\\b', 'gi');
const SHORT_CARD_REF = new RegExp('(?:^|[^A-Za-z0-9_./])(' + GH_REPO + ')#(\\d{1,8})\\b', 'gi');
const BARE_CARD_NUM = /(?:^|[^A-Za-z0-9_])#(\d{1,8})\b/g;
const ACTIVITY_PACKET = /\bpacket:[A-Za-z0-9_.:/#-]{1,80}/gi;

function cardIsLive(card) {
  return !!(card && !card.pinned && String(card.state || '').toLowerCase() === 'live');
}

function cardIsClosed(card) {
  if (!card || card.pinned) return false;
  const state = String(card.state || '').toLowerCase();
  const stage = String(card.stage || '').toLowerCase();
  return state === 'closed' || stage === 'done';
}

function allMatches(re, text) {
  re.lastIndex = 0;
  return [...String(text || '').matchAll(re)];
}

function boardIndex(list) {
  const byKey = new Map();
  for (const card of list || []) {
    const key = workKey(card);
    if (key && !byKey.has(key)) byKey.set(key, card);
  }
  return byKey;
}

function knownRepos(list, repos) {
  const names = new Set();
  for (const repo of repos || []) {
    const name = String(repo || '').trim().toLowerCase();
    if (name.includes('/')) names.add(name);
  }
  for (const card of list || []) {
    const repo = String(card && card.repo || '').trim().toLowerCase();
    if (repo.includes('/')) names.add(repo);
  }
  return [...names];
}

function roleSeats(roles, seatSet) {
  const out = [];
  const add = value => {
    const seat = workSeat(value, seatSet);
    if (seat && !out.includes(seat)) out.push(seat);
  };
  add(roles && roles.handoffs && roles.handoffs.reviewer);
  const seats = roles && roles.seats;
  if (seats && typeof seats === 'object') {
    add(seats.operator && seats.operator.seat);
    add(seats.coord && seats.coord.seat);
  }
  return out;
}

function seatTiedToCard(card, seat, seatSet, roles) {
  if (!seat) return false;
  const packet = card && card.packet && typeof card.packet === 'object' ? card.packet : {};
  const names = [
    card && card.owner, card && card.nudge_to, card && card.assignee, card && card.assignee_seat,
    card && card.author, card && card.opener, card && card.from,
    packet['next owner'], packet.next_owner, packet.reviewer,
  ];
  for (const name of names) if (workSeat(name, seatSet) === seat) return true;
  return roleSeats(roles, seatSet).includes(seat);
}

function activityNote(line) {
  const raw = typeof line.note === 'string' && line.note ? line.note : (typeof line.tag === 'string' ? line.tag : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function activityLineId(line) {
  if (typeof line.id === 'string' && line.id.trim()) return line.id.trim();
  if (Number.isInteger(line.seq) && line.seq > 0) return String(line.seq);
  return '';
}

// A bare #n that is closed on one repo and live on another is not a match.
function bareCard(text, board) {
  const nums = new Set();
  for (const match of String(text || '').matchAll(BARE_CARD_NUM)) nums.add(Number(match[1]));
  const found = [];
  for (const number of nums) {
    const same = (board || []).filter(card => Number(card && card.number) === number);
    const live = same.filter(cardIsLive);
    const closed = same.filter(cardIsClosed);
    if (closed.length && live.length) return { ambiguous: true };
    if (live.length > 1) return { ambiguous: true };
    if (live.length === 1) found.push(live[0]);
  }
  return { cards: found };
}

function activityCard(line, board, repos, index) {
  const text = [line.tag, line.pr, line.note, line.card, line.key].filter(part => typeof part === 'string').join('\n');
  const keys = new Set();
  for (const field of [line.card, line.key, line.tag]) {
    const raw = String(field || '').trim();
    const lower = raw.toLowerCase();
    if (lower.startsWith('packet:') && lower.length > 7) keys.add(lower);
    else if (CARD_REF.test(raw)) keys.add(lower);
  }
  for (const match of allMatches(GH_ISSUE_URL, text)) keys.add(`${match[1]}/${match[2]}#${Number(match[3])}`.toLowerCase());
  for (const match of allMatches(FULL_CARD_REF, text)) keys.add(`${match[1]}#${Number(match[2])}`.toLowerCase());
  for (const match of allMatches(ACTIVITY_PACKET, text)) keys.add(match[0].toLowerCase());
  const named = [];
  for (const key of keys) {
    const card = index.get(key);
    if (card) named.push(card);
  }
  if (!named.length) {
    const reposNamed = knownRepos(board, repos);
    for (const match of allMatches(SHORT_CARD_REF, text)) {
      const tail = String(match[1] || '').toLowerCase();
      const number = Number(match[2]);
      const hits = reposNamed.filter(repo => repo.split('/').pop() === tail);
      if (hits.length !== 1) continue;
      const card = index.get(`${hits[0]}#${number}`);
      if (card) named.push(card);
    }
  }
  if (!named.length) {
    const bare = bareCard(text, board);
    if (bare.ambiguous) return null;
    named.push(...(bare.cards || []));
  }
  const live = [];
  const seen = new Set();
  for (const card of named) {
    if (!cardIsLive(card)) continue;
    const key = workKey(card);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    live.push(card);
  }
  return live.length === 1 ? live[0] : null;
}

// A GitHub beat still closes every nudge. An activity beat closes only the seat that posted it.
export function activityKeepsNudge(card, nudge) {
  if (!card || !nudge) return false;
  const act = Number(card.activity_at) || 0;
  const last = Number(card.last_beat_t) || 0;
  const beat = Number(nudge.beat_t) || 0;
  if (!act || act < last || last === beat) return false;
  const who = String(card.activity_seat || '').trim().toLowerCase();
  const seat = String(nudge.seat || '').trim().toLowerCase();
  return !!who && who !== seat;
}

function applyActivityBeats(cards, { activity = [], seats, now, board, repos, roles } = {}) {
  const seatSet = seats instanceof Set ? seats : workSeatSet(seats);
  const source = Array.isArray(board) ? board : cards;
  const index = boardIndex(source);
  const hits = new Map();
  for (const line of activity || []) {
    if (!line || typeof line !== 'object') continue;
    const kind = String(line.kind || '').toLowerCase();
    if (kind === 'cloud_agent' || kind === 'agent') continue;
    if (line.by === 'server' && line.tag === 'wake') continue;
    const id = activityLineId(line);
    const seat = workSeat(line.seat, seatSet) || workSeat(line.by, seatSet);
    const t = workAt(line);
    if (!id || !seat || !t) continue;
    const card = activityCard(line, source, repos, index);
    if (!card || !seatTiedToCard(card, seat, seatSet, roles)) continue;
    const key = workKey(card);
    if (!key) continue;
    const row = { id, seat, t, note: activityNote(line) };
    const mine = hits.get(key) || [];
    mine.push(row);
    hits.set(key, mine);
  }
  if (!hits.size) return cards;
  return (Array.isArray(cards) ? cards : []).map(card => {
    if (!cardIsLive(card)) return card;
    const mine = hits.get(workKey(card));
    if (!mine || !mine.length) return card;
    const beats = Array.isArray(card.beats) ? card.beats.slice() : [];
    let activityAt = Number(card.activity_at) || 0;
    let activitySeat = String(card.activity_seat || '');
    let changed = false;
    for (const hit of [...mine].sort((a, b) => a.t - b.t)) {
      const id = 'act:' + hit.id;
      if (hit.t >= activityAt) { activityAt = hit.t; activitySeat = hit.seat; }
      if (beats.some(beat => beat && beat.id === id)) continue;
      // /merge/ stays in note. what stays activity so the merged-beat check does not trip.
      beats.push({ t: hit.t, what: 'activity', via: 'activity', seat: hit.seat, id, note: hit.note });
      changed = true;
    }
    const prev = Number(card.last_beat_t) || 0;
    const last = Math.max(prev, activityAt);
    const stall = Number.isFinite(now) ? now - last >= ACTIVITY_STALL_MS : false;
    const same = !changed && card.activity_at === activityAt && card.activity_seat === activitySeat
      && card.last_beat_t === last && card.stall === stall;
    if (same) return card;
    beats.sort((a, b) => (Number(a && a.t) || 0) - (Number(b && b.t) || 0));
    return { ...card, beats, last_beat_t: last, stall, activity_at: activityAt, activity_seat: activitySeat };
  });
}

/**
 * A cloud launch or reply, or a handoff, moves an open card to in_progress.
 * The owner is the latest seat on a handoff, cloud line, or receipt.
 * builder-cloud is a label: the seat is the one that owns that bc-.
 * A seat activity line beats a live card only when that seat is tied to the card.
 */
export function stampWorkCards(cards, { activity = [], lines = [], comments = [], agents = [], seats = [], now, board, repos, roles } = {}) {
  const seatSet = workSeatSet(seats);
  const hits = [];
  const note = (ref, seat, t, kind) => {
    const key = String(cardRefOf(ref) || ref || '').trim().toLowerCase();
    if (!key || !seat) return;
    hits.push({ key, seat, t, kind });
  };
  for (const line of activity || []) {
    if (!line || typeof line !== 'object') continue;
    const kind = String(line.kind || '').toLowerCase();
    if (kind !== 'cloud_agent' && kind !== 'agent') continue;
    const action = String(line.action || '').toLowerCase();
    if (action !== 'launch' && action !== 'reply') continue;
    const seat = workSeat(line.seat, seatSet) || workSeat(line.by, seatSet) || seatForBc(line.agent, agents, seatSet);
    note(line.tag || line.card || line.pr, seat, workAt(line), 'cloud');
  }
  for (const line of lines || []) {
    if (!line || typeof line !== 'object') continue;
    const type = String(line.type || '').toLowerCase();
    const kind = String(line.kind || '').toLowerCase();
    if (!(type === 'packet' && WORK_HANDOFF.has(kind)) && kind !== 'handoff' && type !== 'handoff') continue;
    const seat = workSeat(line.to, seatSet) || workSeat(line.seat, seatSet) || workSeat(line.from, seatSet);
    const ref = line.repo && line.number != null ? `${line.repo}#${line.number}` : (line.card || line.key);
    note(ref, seat, workAt(line), 'handoff');
  }
  for (const row of comments || []) {
    if (!row || typeof row !== 'object') continue;
    const kind = String(row.kind || row.type || '').toLowerCase();
    const blob = [row.label, row.title, row.detail, row.body, row.message].filter((part) => typeof part === 'string').join('\n');
    const trailer = /(?:^|\n)\s*Seat:\s*([A-Za-z0-9-]{2,16})\s*(?:\n|$)/.exec(blob);
    const receipt = kind === 'receipt' || /receipt/i.test(blob);
    if (!receipt && !trailer) continue;
    const seat = workSeat(trailer && trailer[1], seatSet) || workSeat(row.credit, seatSet) || workSeat(row.seat, seatSet) || workSeat(row.from, seatSet) || workSeat(row.author, seatSet);
    const ref = row.repo && row.number != null ? `${row.repo}#${row.number}` : (row.card || row.key);
    note(ref, seat, workAt(row), 'receipt');
  }
  const stamped = (Array.isArray(cards) ? cards : []).map((card) => {
    if (!card || typeof card !== 'object') return card;
    const key = workKey(card);
    const mine = hits.filter((hit) => hit.key === key);
    const latest = mine.reduce((best, hit) => (!best || hit.t >= best.t ? hit : best), null);
    const mapped = seatForWorkCard(card, agents, seatSet);
    const assignee = workSeat(card.assignee, seatSet) || workSeat(card.assignee_seat, seatSet);
    const author = workSeat(card.author, seatSet) || workSeat(card.opener, seatSet) || workSeat(card.from, seatSet)
      || (Array.isArray(card.labels) ? card.labels.map((label) => workSeat(label, seatSet)).find(Boolean) : '');
    const current = workSeat(card.owner, seatSet);
    const owner = (latest && latest.seat) || assignee || author || current || mapped || '';
    const stage = String(card.stage || '').toLowerCase();
    const working = mine.some((hit) => hit.kind === 'cloud' || hit.kind === 'handoff');
    const nextStage = working && (stage === 'open' || stage === '') ? 'in_progress' : card.stage;
    const nextOwner = owner || (NOT_CARD_OWNER.has(String(card.owner || '').toLowerCase()) ? '' : card.owner);
    if (nextStage === card.stage && nextOwner === card.owner) return card;
    return { ...card, stage: nextStage, owner: nextOwner };
  });
  return applyActivityBeats(stamped, { activity, seats: seatSet, now, board: board || cards, repos, roles });
}

export function foldCloudIds(rows) {
  const ordered = [...(rows || [])].sort((a, b) => (Date.parse(b && b.updated_ct) || 0) - (Date.parse(a && a.updated_ct) || 0));
  const folded = [];
  for (const row of ordered) {
    if (!row || !AGENT_ID.test(String(row.bcId || ''))) continue;
    const hit = folded.find(prev => cloudIdsAlias(prev.bcId, row.bcId));
    if (!hit) { folded.push({ ...row }); continue; }
    if (!hit.seat && row.seat) hit.seat = row.seat;
    if (!hit.card && row.card) hit.card = row.card;
    if (!hit.pr && row.pr) hit.pr = row.pr;
    if (!hit.url && row.url) hit.url = row.url;
    if (!hit.label && row.label) hit.label = row.label;
    if (String(row.bcId).length > String(hit.bcId).length) hit.bcId = row.bcId;
  }
  return folded;
}

const CLOUD_TURN_ID = /^bc-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;

/** The bc id at the start of a cloud turn tag (`bc-<id>` or `bc-<id> <track>`). A seat turn has none. */
export function cloudTurnId(tag) {
  const match = CLOUD_TURN_ID.exec(String(tag || '').trim());
  return match ? match[0] : '';
}

function cloudAliasKey(open, id) {
  for (const key of open.keys()) if (cloudIdsAlias(key, id)) return key;
  return '';
}

/** Open cloud turns. A start opens the bc id. An end closes that id. The seat on the line is not the agent. */
export function openCloudTurns(lines, now = Date.now()) {
  const open = new Map();
  for (const line of lines || []) {
    if (!line || line.kind !== 'turn') continue;
    const id = cloudTurnId(line.tag);
    if (!id) continue;
    const t = Date.parse(line.t_ct || '');
    if (!Number.isFinite(t) || t > now + 300000) continue;
    const hit = cloudAliasKey(open, id);
    if (line.action === 'end') {
      if (hit && t >= open.get(hit)) open.delete(hit);
      continue;
    }
    if (line.action === 'tick') {
      if (hit) open.set(hit, Math.max(open.get(hit), t));
      continue;
    }
    const keep = hit && hit.length >= id.length ? hit : id;
    const at = Math.max(hit ? open.get(hit) : 0, t);
    if (hit && hit !== keep) open.delete(hit);
    open.set(keep, at);
  }
  return [...open.entries()]
    .filter(([, t]) => now - t <= CLOUD_STALE_MS)
    .map(([bcId, t]) => ({ bcId, updated_ct: new Date(t).toISOString() }))
    .sort((a, b) => a.bcId.localeCompare(b.bcId));
}

/** last_ct is at least the newest cloud_agents row. A finished row leaves open_agents. No rows keeps the previous open set. */
export function syncCloudClock(cloud, rows) {
  const prev = cloud && typeof cloud === 'object' && !Array.isArray(cloud) ? cloud : {};
  const list = (Array.isArray(rows) ? rows : []).filter(row => row && AGENT_ID.test(String(row.bcId || '')));
  let last = Date.parse(prev.last_ct || '');
  if (!Number.isFinite(last)) last = 0;
  const running = [];
  const finished = [];
  for (const row of list) {
    const id = String(row.bcId);
    if (row.state === 'running') running.push(id);
    else finished.push(id);
    for (const key of ['updated_ct', 'finished_ct', 't_ct']) {
      const t = Date.parse(row[key] || '');
      if (Number.isFinite(t) && t > last) last = t;
    }
  }
  const kept = (Array.isArray(prev.open_agents) ? prev.open_agents : []).map(id => String(id)).filter(Boolean);
  const open = list.length
    ? running.filter(id => !finished.some(gone => cloudIdsAlias(gone, id)))
    : kept;
  const prevMs = Date.parse(prev.last_ct || '');
  const last_ct = last
    ? (prevMs === last && prev.last_ct ? prev.last_ct : new Date(last).toISOString())
    : (prev.last_ct || prev.github_last_ct || null);
  return {
    ...prev,
    open_agents: [...new Set(open)].sort(),
    active: open.length > 0,
    working: open.length > 0,
    last_ct,
  };
}

/** CloudAgents stays on the mesh. A non-empty open_agents list lights it. An empty list keeps last_ct. */
export function stampCloudMesh(header, rows) {
  const h = header && typeof header === 'object' && !Array.isArray(header) ? header : {};
  const nodes = (Array.isArray(h.product_nodes) ? h.product_nodes : []).filter(n => n && n !== 'burst-live');
  if (!nodes.includes('CloudAgents')) nodes.push('CloudAgents');
  const had = h.fleet && typeof h.fleet === 'object' && !Array.isArray(h.fleet) ? h.fleet : null;
  const fleet = had ? { ...had } : {};
  const prev = fleet.cloud && typeof fleet.cloud === 'object' && !Array.isArray(fleet.cloud) ? fleet.cloud : {};
  const cloud = syncCloudClock(prev, rows);
  const working = { ...(fleet.working || {}) };
  if (cloud.working) working.CloudAgents = { ...(working.CloudAgents || {}), via: (working.CloudAgents && working.CloudAgents.via) || 'cloud' };
  else delete working.CloudAgents;
  const next = { ...fleet, cloud };
  if (had || cloud.open_agents.length) next.working = working;
  return { ...h, product_nodes: nodes, fleet: next };
}

/** A running cloud row is working on its own id. It does not mark the launching seat.
 * `reviewer` canonicalizes to critic, so a row seat of reviewer must not light critic either.
 * A finished or failed row leaves open_agents. A cloud via mark on a seat is dropped. */
export function applyCloudOwners(fleet, rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const known = list.filter(row => row && AGENT_ID.test(String(row.bcId || '')));
  if (!fleet && !known.length) return fleet;
  const f = fleet
    ? { ...fleet, seats: { ...(fleet.seats || {}) }, working: { ...(fleet.working || {}) }, cloud: { ...(fleet.cloud || {}) } }
    : { as_of: new Date(now).toISOString(), window_min: 15, seats: {}, working: {}, cloud: {}, active: 0, total: 0 };
  for (const seat of new Set([...Object.keys(f.working), ...Object.keys(f.seats)])) {
    const held = f.working[seat];
    const src = f.seats[seat];
    const cloudWork = !!(held && held.via === 'cloud');
    const cloudSeat = !!(src && src.working_via === 'cloud');
    if (!cloudWork && !cloudSeat) continue;
    if (cloudWork) delete f.working[seat];
    if (!src) continue;
    const still = f.working[seat];
    const next = { ...src, working: !!(still && still.via !== 'cloud') };
    if (next.working_via === 'cloud') {
      if (still && still.via && still.via !== 'cloud') next.working_via = still.via;
      else delete next.working_via;
    }
    f.seats[seat] = next;
  }
  f.cloud = syncCloudClock(f.cloud, list);
  f.active = Object.values(f.seats).filter(v => v.active && !v.external).length;
  if (!fleet) f.total = Object.keys(f.seats).length;
  return f;
}

function agentItems(agents) {
  const byAgent = new Map();
  for (const row of agents || []) {
    if (!row || typeof row.agent !== 'string' || !row.agent) continue;
    const cur = byAgent.get(row.agent);
    const rank = Number(row.rank) || 0;
    const atMs = Date.parse(row.t_ct || '') || 0;
    const curMs = Date.parse((cur && cur.t_ct) || '') || 0;
    const named = row.seat && row.seat !== UNASSIGNED ? row.seat : '';
    if (!cur || rank > Number(cur.rank) || (rank === Number(cur.rank) && atMs >= curMs)) {
      const keptSeat = named || (cur && cur.seat && cur.seat !== UNASSIGNED ? cur.seat : '') || UNASSIGNED;
      byAgent.set(row.agent, { ...row, pr: row.pr || (cur && cur.pr) || '', seat: keptSeat });
    } else if (cur) {
      if (!cur.pr && row.pr) cur.pr = row.pr;
      if ((!cur.seat || cur.seat === UNASSIGNED) && named) cur.seat = named;
    }
  }
  const items = [];
  for (const row of byAgent.values()) {
    const failed = row.status === 'failed';
    const closed = failed || Number(row.rank) >= 4 || row.status === 'finished';
    const seat = row.seat && row.seat !== UNASSIGNED ? canonSeatToken(row.seat) : '';
    const lane = seat ? displaySeat(seat) : UNASSIGNED;
    const title = textOf(row.title, 120) || row.agent;
    const pr = typeof row.pr === 'string' ? row.pr : '';
    const state = failed ? 'failed' : closed ? 'finished' : 'running';
    items.push({
      id: 'agent:' + row.agent,
      kind: 'agent',
      phase: failed ? 'failed' : closed ? 'closed' : row.status,
      steps: [state],
      label: failed ? 'failed' : closed ? 'closed' : 'working',
      labels: [failed ? 'failed' : closed ? 'closed' : 'working'],
      title,
      url: pr,
      pr,
      card: cardRefOf(pr),
      bcId: row.agent,
      state,
      seats: seat ? [seat] : [],
      lane,
      lanes: [lane],
      overdue: false,
      flagged: false,
      working: !closed,
      closed,
      seat_name: !closed && seat ? displaySeat(seat) : '',
      t_ct: typeof row.t_ct === 'string' ? row.t_ct : '',
      updated_ct: typeof row.t_ct === 'string' ? row.t_ct : '',
      agent: row.agent,
      status: state === 'running' ? row.status : state,
    });
  }
  return items;
}

export function deriveTrack({ lines, acks, wakes, agents, now, windowMs, closedKeys, openKeys }) {
  const woken = wokenIds(wakes);
  const closed = closedKeys instanceof Set ? closedKeys : new Set(closedKeys || []);
  const aged = openKeys != null;
  const open = openKeys instanceof Set ? openKeys : new Set(openKeys || []);
  const items = [];
  for (const line of lines || []) {
    if (!isPacket(line)) continue;
    const seat = String(line.seat || '').toLowerCase();
    const key = String(line.repo || '').toLowerCase() + '#' + Number(line.number);
    const acked = lineAcked(acks || {}, seat, line.id);
    const gone = aged && acked && !open.has(key) && !closed.has(key);
    items.push(packetItem(line, {
      acked,
      woken: woken.has(line.id),
      closed: closed.has(key) || gone,
      now,
      windowMs,
    }));
  }
  items.push(...agentItems(agents));
  items.sort((a, b) => (Date.parse(b.t_ct) || 0) - (Date.parse(a.t_ct) || 0));
  const lanes = [];
  const byLane = new Map();
  for (const item of items) {
    for (const name of item.lanes.length ? item.lanes : [item.lane]) {
      if (!byLane.has(name)) { const bucket = []; byLane.set(name, bucket); lanes.push({ name, items: bucket }); }
      byLane.get(name).push({ id: item.id, label: item.label, title: item.title, url: item.url });
    }
  }
  return { items, overdue: items.filter(item => item.overdue).map(item => item.id), lanes };
}

export function deriveTrackFromDir(dir, now, windowMs, closedKeys, openKeys) {
  return deriveTrack({
    lines: readInboxLines(dir),
    acks: readAcks(dir),
    wakes: readWakeRows(dir),
    agents: readJsonl(path.join(dir, 'agents.jsonl')),
    now,
    windowMs,
    closedKeys,
    openKeys,
  });
}

export function loadSeatAgentMap(raw) {
  const pins = {
    'bc-fba6bbae*': 'forge',
    'bc-098a437d*': 'mill',
    'bc-753d223e*': 'near',
    'bc-7034043e*': 'nibbler',
  };
  if (!raw || !String(raw).trim()) return { ...pins };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...pins, ...parsed };
  } catch { /* the pins stay */ }
  return { ...pins };
}
