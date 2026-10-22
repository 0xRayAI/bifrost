const TURN_OPEN_MS = (Number(process.env.LIVE_TURN_OPEN_MIN) || 20) * 60000;
const PROMPT_WORK_MS = 10 * 60000;   // a prompt pulse: the seat stays working this long, and Blaze is the sender
// Seat -> end time (ms), or 0 for an open turn past TURN_OPEN_MS (full clear).
// An ended turn clears older marks. A newer mark counts only while fresh. A running cloud agent stays.
let turnRelease = new Map();
// Bifrost live mesh: password-gated (or public) static page + in-memory feed (push-only ingest; full or delta, delta polls).
// Node 20, zero dependencies.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { seatPresence, presentSeat, foldSeatTouch, fleetConfigOf, configuredRoster, readWakeOk, writeWakeOk } from './presence.mjs';
import { parseAllowlist, mergeCards, sourceCardsFrom, projectAllowed, validateItem, workEventToItem, cardNoNudge, workItemNewer } from './source.mjs';
import { checkRoutesFromDir, readRoutingMap, createLoginResolver, auditLogins } from './routes.mjs';
import { fingerprint, tripwire, createClock, wakeTitle, mutedSeats, selectStallSeats } from './governor.mjs';
import { acceptWaveCards, applyBrief, attachPacketCards, burnQuiet, isPacketBorn, isPlanCard, liveWorkCount, postedCards, retainSeedCards, resolveWaveSeed, scheduleWaves } from './wave-schedule.mjs';
import { createArch1Launch, ARCH1_CANON, cardKeyOf } from './arch1-launch.mjs';
import { configureWorkTrack, acceptCursorWebhook, appendWake, applyCloudOwners, boardCloudAgents, canonSeatToken, cloudIdsAlias, cloudTurnId, deriveTrackFromDir, displaySeat, isPacket, loadSeatAgentMap, openCloudTurns, readJsonl, readWakeRows, safePrUrl, seatForAgentId, stampCriticCloud, toToken } from './worktrack.mjs';
import { wakeConfig, createWakeState, classifyBatch, gateLine, noteSent, releaseDue, publicStats, fullStats, restoreWakeBook, viewLine } from './wake-gate.mjs';
const COLLECTOR_DIR_EARLY = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'collector');
import { initArchive, appendArchive, backfillArchive, readArchive, validArchiveDate, KINDS as ARCHIVE_KINDS, cardHistory, archiveDays, archivedLineBytes, appendTransition, transitionFromEvent, queryTransitions, exportTransitions } from './archive.mjs';
import { pinnedOrigin } from './origin.mjs';
import { missingHandoffs, hotfixMergeLine, isHotfixTitle, isMergeHandoff, validMergeReview } from './handoff.mjs';
import { clockStamp, writeStartAfter } from './chicago-stamp.mjs';
import { createBatch } from './pr-batch.mjs';
const batch = createBatch();

const PORT = process.env.PORT === '0' ? 0 : (Number(process.env.PORT) || 8080);   // PORT=0: the OS picks a free port (tests); the log line names it
// Site mode. Default (no config): GATED = password login + private repos masked on the page, feed and logs.
// PUBLIC = no password, no masking: every repo name shows (build in public). Set by collector/site.json
// ({"public": true, "name": "Bifrost"}, committed for our deploy and copied by deploy.sh) or LIVE_PUBLIC=1|0 (env wins).
function siteConfig(env, dir) {
  let f = {};
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) f = j; } catch {}
  const ev = String(env.LIVE_PUBLIC ?? '').trim().toLowerCase();
  const pub = ['1', 'true', 'yes', 'on'].includes(ev) ? true : ['0', 'false', 'no', 'off'].includes(ev) ? false : f.public === true;
  const name = String(env.LIVE_SITE_NAME || (typeof f.name === 'string' && f.name) || 'Bifrost').replace(/[<>&"']/g, '').slice(0, 60) || 'Bifrost';
  const title = String(env.LIVE_SITE_TITLE || (typeof f.title === 'string' && f.title) || `${name} live mesh`).replace(/[<>&"']/g, '').slice(0, 80);
  return { public: pub, name, title };
}
const SITE = siteConfig(process.env, path.join(path.dirname(fileURLToPath(import.meta.url)), 'collector'));
const PUBLIC = SITE.public;
const MESH_PASSWORD = process.env.MESH_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const INGEST_SECRET = process.env.INGEST_SECRET || '';
for (const [k, v, min] of [...(PUBLIC ? [] : [['MESH_PASSWORD', MESH_PASSWORD, 1]]), ['SESSION_SECRET', SESSION_SECRET, 32], ['INGEST_SECRET', INGEST_SECRET, 32]]) {
  if (v.length < min) { console.error(`missing or too-short env ${k}; refusing to start`); process.exit(1); }
}
const ORIGIN = pinnedOrigin(process.env);
// Reported ages. They do not gate /healthz (feed_quiet and cards_behind do).
const CARD_STALE_S = Number(process.env.CARD_STALE_S) > 0 ? Number(process.env.CARD_STALE_S) : 600;
const DATA_STALE_S = Number(process.env.DATA_STALE_S) > 0 ? Number(process.env.DATA_STALE_S) : 21600;

// POST /activity auth. Primary: the seat's OWN GitHub App installation token (Builder = app builder-app on org example-org),
// verified against GitHub per token: GraphQL viewer must be the app's bot user (login + pinned id; a PAT or user
// token is a human user, no other app can be that bot) and every repo of the token's installation must belong to the
// org. Verdicts are cached in memory by sha256(token) only; the token itself is never stored or logged.
// Installation-token auth ONLY (the static ACTIVITY_KEY_<SEAT> fallback was removed Oct 9). The token can read nothing here.
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';   // overridable for tests only
const GH_SEATS_DEFAULT = [{ seat: 'Builder', bot: 'builder-app[bot]', botId: 100000002, org: 'example-org' }];
// LIVE_GH_SEATS: JSON [{seat, bot, botId, org}] naming each fleet's seat Apps. Unset or invalid keeps the kit example.
function ghSeatsFrom(raw) {
  try { const a = JSON.parse(raw || ''); if (Array.isArray(a) && a.length && a.every(x => x && typeof x.seat === 'string' && typeof x.bot === 'string' && Number.isInteger(x.botId) && typeof x.org === 'string')) return a; } catch {}
  return GH_SEATS_DEFAULT;
}
const GH_SEATS = ghSeatsFrom(process.env.LIVE_GH_SEATS);
const GH_OK_MS = 10 * 60000, GH_BAD_MS = 10 * 60000, GH_CACHE_MAX = 2000;
const ghCache = new Map();     // sha256(token) hex -> { seat | null, exp } or { pending: Promise }
async function ghVerify(tok) {   // -> seat, null (rejected), or throws (GitHub unreachable: caller answers 503)
  if (!/^ghs_[A-Za-z0-9._-]{20,1024}$/.test(tok)) return null;
  const key = crypto.createHash('sha256').update(tok).digest('hex'), now = Date.now();
  const c = ghCache.get(key);
  if (c && c.pending) return c.pending;
  if (c && c.exp > now) return c.seat;
  const pending = (async () => {
    const h = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'live-board',
      'X-GitHub-Api-Version': '2022-11-28' };
    const g = await fetch(GITHUB_API + '/graphql', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { login databaseId } }' }), signal: AbortSignal.timeout(6000) });
    if (g.status >= 500) throw new Error('github ' + g.status);
    const v = g.ok ? ((await g.json().catch(() => ({}))).data || {}).viewer : null;
    const m = v && GH_SEATS.find(x => x.bot === v.login && x.botId === v.databaseId);
    if (!m) return null;
    const r = await fetch(GITHUB_API + '/installation/repositories?per_page=100', { headers: h, signal: AbortSignal.timeout(6000) });
    if (r.status >= 500) throw new Error('github ' + r.status);
    if (!r.ok) return null;                       // only installation tokens can list their installation's repos
    const repos = ((await r.json().catch(() => ({}))).repositories) || [];
    return repos.length && repos.every(x => x && x.owner && x.owner.login === m.org) ? m.seat : null;
  })();
  ghCache.set(key, { pending });
  try {
    const seat = await pending;
    ghCache.set(key, { seat, exp: Date.now() + (seat ? GH_OK_MS : GH_BAD_MS) });
    if (ghCache.size > GH_CACHE_MAX) for (const [k, v] of ghCache) if (!v.pending && v.exp <= Date.now()) ghCache.delete(k);
    if (ghCache.size > GH_CACHE_MAX) ghCache.delete(ghCache.keys().next().value);
    return seat;
  } catch (e) { ghCache.delete(key); throw e; }
}
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'mesh_session';
const MAX_INGEST = 25 * 1024 * 1024;   // decoded JSON cap (the gzip body is capped at the same size)
const MAX_LOGIN_BODY = 4096;
const RL_MAX = 10, RL_WINDOW_MS = 15 * 60 * 1000;

// ---- static files: whitelist loaded into memory at startup ----
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const STATIC = new Map();
for (const f of fs.readdirSync(PUB)) {
  const ext = path.extname(f);
  if (!TYPES[ext]) continue;
  STATIC.set('/' + f, { type: TYPES[ext], body: fs.readFileSync(path.join(PUB, f)) });
}
// avatars: public/avatars/*.png, served same-origin behind the login (missing file -> 404 -> drawn fallback)
const AV = path.join(PUB, 'avatars');
if (fs.existsSync(AV)) for (const f of fs.readdirSync(AV)) {
  if (/^[a-z0-9._-]+\.png$/i.test(f)) STATIC.set('/avatars/' + f, { type: 'image/png', body: fs.readFileSync(path.join(AV, f)) });
}
if (STATIC.has('/index.html')) STATIC.set('/', STATIC.get('/index.html'));

// ---- feed (in memory, delta-capable, two sources merged by event id) ----
// cursor = "<epoch>.<seq>": epoch is random per process (a cold start invalidates every cursor), seq bumps on
// every change. Each event remembers the seq that last changed it, so ?since=<cursor> returns only those.
// Sources: "github" = the Railway collector child (read-only token, file on the volume), "box" = the box pusher
// (POST /ingest, /ingest/delta; box-only signals). Same id in both -> the github copy wins. Each source has its own
// ack cursor "<epoch>_<source>.<n>" so a collector write never invalidates the box pusher's delta base.
const EMPTY_FEED = { title: SITE.title, generated_at: null, event_count: 0, events: [] };
const EPOCH = crypto.randomBytes(6).toString('base64url');
const STARTED = Date.now();
const MAX_REMOVED = 20000;
const BOX_STALE_MS = (Number(process.env.BOX_STALE_S) || 180) * 1000;
let seq = 0, header = {}, floorSeq = 0;
const evs = new Map();          // id -> { e, h, s }  (merged view)
const removed = [];             // [{ id, s }] (ids dropped from the merged view)
let fullDirty = true, feedBody, feedGz, feedEtag;
let activityReady = false;   // activity.jsonl loads later; mergedHeader runs before that
const WINDOW_MIN = Math.max(1, Math.min(1440, Number(process.env.LIVE_WINDOW_MIN) || 15));   // seat 'active' window (minutes)
const SRC_PRIO = ['github', 'box'];
const SRCS = Object.fromEntries(SRC_PRIO.map(n => [n, { evs: new Map(), header: null, seq: 0, at: 0 }]));
let ghRetest = new Set();       // "repo#n" with a GitHub lab retest: the box's merge-queue.md copy is then hidden
const cursor = () => `${EPOCH}.${seq}`;
const srcCursor = n => `${EPOCH}_${n}.${SRCS[n].seq}`;
const evHash = e => crypto.createHash('sha1').update(JSON.stringify(e)).digest('base64url');
function headerOf(f) { const h = {}; for (const k of Object.keys(f)) if (k !== 'events' && k !== 'cursor') h[k] = f[k]; return h; }
function dropId(id) { evs.delete(id); removed.push({ id, s: seq }); if (removed.length > MAX_REMOVED) floorSeq = removed.splice(0, removed.length - MAX_REMOVED).pop().s; }
// Every served event carries a credit (never blank): the collector sets it from logins; anything else (box, Jira, health,
// emitter, older collectors) is credited by its sender node: a roster seat, a human alias (HUMAN_ALIASES), else the github node.
// HUMAN_ALIASES: comma list of alias=Label (e.g. "htafolla=Blaze,lead=Blaze"); default empty, so no human names live in code.
const HUMAN_ALIASES = Object.fromEntries(String(process.env.HUMAN_ALIASES || '').split(',').map(x => x.split('=').map(y => y.trim()))
  .filter(([a, l]) => a && l).map(([a, l]) => [a.toLowerCase(), l]));
let rosterSeats = null;
function creditOf(e) {
  if (typeof e.credit === 'string' && e.credit) return e.credit;
  if (!rosterSeats) { try { rosterSeats = new Set((JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'collector', 'fleet-roster.json'), 'utf8')).seats || []).map(x => String(x).toLowerCase())); } catch { rosterSeats = new Set(); } }
  const f = String(e.from || '').toLowerCase();
  if (f === 'coord') return cosSeat();
  if (HUMAN_ALIASES[f]) return HUMAN_ALIASES[f];
  return rosterSeats.has(f) ? f : 'github';
}
function upsert(e) { if (!e.credit) e = { ...e, credit: creditOf(e) }; noteGithubWork(e); const h = evHash(e), cur = evs.get(e.id); if (!cur || cur.h !== h) evs.set(e.id, { e, h, s: seq }); }
// Fleet-only (same rule as feed/live_collect.fleet_only): a GitHub-sourced event that shows a login outside the fleet
// map is never served, whichever source sent it (box /ingest included). LIVE_SHOW_UNMAPPED=1 keeps them.
const SHOW_UNMAPPED = process.env.LIVE_SHOW_UNMAPPED === '1';
function unmapped(e) {
  if (SHOW_UNMAPPED) return false;
  const gh = String(e.src_file || '').startsWith('github') || !!e.actor || !!e.author;
  if (!gh) return false;
  if (e.from === 'Others' || e.to === 'Others' || (Array.isArray(e.hops) && e.hops.includes('Others'))) return true;
  return e.external === 'upstream' && !!e.actor && e.from === 'Upstream';
}
// CI is not work: check runs, suites and workflow runs never draw as board traffic (cards still read them from the source).
const CI_KINDS = new Set(['check_run', 'check_suite', 'workflow_run', 'ci_pass', 'ci_fail']);
// Board traffic is packets only (Blaze 10/14): a handoff between parties. State-only kinds stay on cards, never as bursts.
// #337 packets: seat turns, merges, reviews, PRs opened, comments, issues, finished/failed deploys.
// Not packets: commits (including pr_commit, the push stream), edits, review requests, referenced
// activity, draft toggles, commit statuses, unfinished deploys. pr_force_push and pr_ready stay
// (a force-push and ready-for-review are handoffs). CI stays off the board.
const NOT_TRAFFIC = new Set(['commit', 'pr_commit', 'pr_edit', 'issue_edit', 'pr_review_requested', 'pr_review_request_removed', 'pr_activity', 'issue_activity', 'pr_draft', 'commit_status', 'deploy_pending']);
const isTraffic = e => !CI_KINDS.has(e.kind) && !NOT_TRAFFIC.has(e.kind) && !(e.kind === 'deploy' && e.state && !/^(success|failure|failed|error|crashed)$/i.test(e.state));
// GitHub deployment statuses (src github-api) duplicate the Railway poll. op_deploy is the deploy
// source. A github-api deploy/deploy_fail stays only when the poll has no row for that deploy
// (no matching sha or service), and an old unmatched status is history once any poll row exists.
function ghDeployCovered(e) {
  if (!e || (e.kind !== 'deploy' && e.kind !== 'deploy_fail')) return false;
  if (String(e.src_file || '') !== 'github-api') return false;
  const sha = String(e.sha || '').toLowerCase();
  const ctx = (String(e.context || '') + ' ' + String(e.label || '')).toLowerCase();
  let poll = false;
  for (const v of evs.values()) {
    const o = v.e;
    if (!o || o.kind !== 'op_deploy') continue;
    poll = true;
    const os = String(o.sha || '').toLowerCase();
    if (sha && os && (sha.startsWith(os) || os.startsWith(sha))) return true;
    const svc = String(o.service || '').toLowerCase();
    if (svc && ctx.includes(svc)) return true;
  }
  if (!poll) return false;
  const t = Date.parse(e.t_ct || '');
  return !(Number.isFinite(t) && Date.now() - t <= 6 * 3600000);
}
const shown = (n, e) => isTraffic(e) && !ghDeployCovered(e) && !unmapped(e) && !(n === 'box' && e.src_file === 'merge-queue.md' && ghRetest.has(`${e.repo}#${e.number}`));
function touch(id) {
  for (const n of SRC_PRIO) { const e = SRCS[n].evs.get(id); if (e && shown(n, e)) return upsert(e); }
  if (evs.has(id)) dropId(id);
}
function ingestSrc(n, events, hdr, remove = null) {   // remove === null -> full replace of that source
  const S = SRCS[n], changed = new Set();
  seq++; S.seq++; S.at = Date.now(); S.header = hdr;
  if (remove === null) { const ids = new Set(events.map(e => e.id)); for (const id of [...S.evs.keys()]) if (!ids.has(id)) { S.evs.delete(id); changed.add(id); } }
  else for (const id of remove) if (S.evs.delete(id)) changed.add(id);
  for (const e of events) { S.evs.set(e.id, e); changed.add(e.id); }
  if (n === 'github') {
    const rt = new Set(); for (const e of S.evs.values()) if (String(e.kind || '').startsWith('lab_retest_')) rt.add(`${e.repo}#${e.number}`);
    if (rt.size !== ghRetest.size || [...rt].some(k => !ghRetest.has(k))) {
      ghRetest = rt; for (const e of SRCS.box.evs.values()) if (e.src_file === 'merge-queue.md') changed.add(e.id);
    }
  }
  for (const id of changed) touch(id);
  if (events.some(e => e && e.kind === 'op_deploy')) {
    for (const n of SRC_PRIO) for (const [id, e] of SRCS[n].evs) if (e && (e.kind === 'deploy' || e.kind === 'deploy_fail') && e.src_file === 'github-api') touch(id);
  }
  for (const e of events) {
    appendArchive('events', e);
    const row = transitionFromEvent(e);
    if (row) appendTransition(row);
  }
  for (const e of events) if (e && CI_KINDS.has(e.kind)) noteCi(e);
  if (n === 'github') {
    recomputeGithubDataAt();
    const packetHeld = bfCards.some(c => c && (c.born === 'packet' || String(c.key || '').toLowerCase().startsWith('packet:')));
    if (packetHeld && !(S.header && S.header.board)) publishBoard();
    enqueueHotfixMerges(events);
  }
  header = mergedHeader(); fullDirty = true;
}
const ingestFull = f => ingestSrc('box', f.events, headerOf(f));
const ingestDelta = d => ingestSrc('box', d.upsert, headerOf(d.header), d.remove);
// pusher-auth readback (ingest responses only): which seats the merged board shows working, no event data
const fleetBrief = () => { refreshWorking(); const f = header.fleet || {}; return { box_stale: !!f.box_stale, cloud_working: !!f.cloud?.working, working: Object.keys(f.working || {}).sort() }; };
// ---- builder inbox mirror (port of example-org/xray PR #5 house/live/activity.mjs): lines persist on the volume
const INBOX_KEYS = new Set(['id', 't_ct', 'seat', 'type', 'repo', 'number', 'sha', 'title', 'url', 'reason', 'from', 'to', 'kind', 'flag', 'batch', 'labels']);
const INBOX_BANNED = /body|text|message/i;   // tested against field NAMES only; values (e.g. type "prompt_message") are fine
const INBOX_FILE = path.join(process.env.MESH_DATA_DIR || '/data', 'inbox', 'builder.jsonl');
let inboxLines = [];
try { inboxLines = fs.readFileSync(INBOX_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
function saveInbox() {
  for (const l of inboxLines) appendArchive('inbox', { ...l, seat: l.seat ?? 'builder' });
  const cut = Date.now() - 7 * 86400000;
  inboxLines = inboxLines.filter(l => !(Date.parse(l.t_ct) < cut)).slice(-5000);
  try { fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true }); fs.writeFileSync(INBOX_FILE + '.tmp', inboxLines.map(l => JSON.stringify(l)).join('\n') + '\n'); fs.renameSync(INBOX_FILE + '.tmp', INBOX_FILE); } catch (e) { console.log('inbox: save failed ' + e.code); }
}
function validInboxLine(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  for (const k of Object.keys(d)) if (!INBOX_KEYS.has(k) || INBOX_BANNED.test(k)) return false;
  for (const k of ['id', 't_ct', 'seat', 'type', 'repo', 'title', 'url', 'reason']) if (typeof d[k] !== 'string' || (!d[k] && !['repo', 'url', 'title'].includes(k))) return false;
  if (typeof d.number !== 'number' || !Number.isInteger(d.number)) return false;
  if (d.sha != null && typeof d.sha !== 'string') return false;
  if (d.from != null && !canonSeatTokenOk(d.from)) return false;
  if (d.to != null && !toToken(d.to)) return false;
  if (d.kind != null && !tokenOk(d.kind)) return false;
  if (d.flag != null && !tokenOk(d.flag)) return false;
  if (d.labels != null && !labelsOk(d.labels)) return false;
  if (d.batch != null && (typeof d.batch !== 'string' || d.batch.length > 2000)) return false;
  if (d.seat.toLowerCase() !== 'builder') return false;
  return true;
}
function tokenOk(v) { return typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v); }
function labelsOk(v) { return Array.isArray(v) && v.length <= 20 && v.every(item => typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(item)); }
function canonSeatTokenOk(v) { return typeof v === 'string' && !!canonSeatToken(v); }
function linesAfter(lines, sinceId) { if (!sinceId) return lines.slice(); const at = lines.findIndex(l => l.id === sinceId); return at < 0 ? lines.slice() : lines.slice(at + 1); }
function postInbox({ secret, headerSecret, body, lines }) {
  if (typeof headerSecret !== 'string' || !headerSecret || !safeEq(headerSecret, secret)) return { status: 401, error: 'unauthorized' };
  let parsed; try { parsed = JSON.parse(body); } catch { return { status: 400, error: 'not json' }; }
  const incoming = parsed && Array.isArray(parsed.lines) ? parsed.lines : null;
  if (!incoming) return { status: 400, error: 'lines required' };
  if (incoming.some(l => !l || String(l.seat || '').toLowerCase() !== 'builder')) return { status: 403, error: 'inbox is not exposed' };
  const good = incoming.filter(validInboxLine);
  if (!good.length && incoming.length) return { status: 400, error: 'no line stored', rejected: incoming.map((l, i) => (l && typeof l.id === 'string' && l.id) ? l.id.slice(0, 120) : '#' + i) };
  if (parsed.replace === true && good.length) lines.length = 0;   // resync only after a line validates
  const known = new Set(lines.map(l => l.id)); let added = 0;
  for (const l of good) { if (known.has(l.id)) continue; known.add(l.id); lines.push(l); added++; }
  return { status: 200, added };
}
// ---- Live board: the server is the source of truth for seat inboxes, cards and nudges ---------------------------------
// Seat auth: Builder = its builder-app installation token (ghVerify, unchanged); every other seat = its own key, checked
// against SEAT_KEYS (Railway variable, JSON seat -> sha256 hex of the key; the keys themselves live only on the box).
// Our 8 seats (feed/fleet-roster.json) plus the kit's builder / builder-cloud plumbing (installation-token auth, mirror);
// no route writes to builder. The kit's sample seats (reviewer, tester, qa, coord, operator, triager, ...) are gone: their
// jobs map to ours (coord -> the CoS role, operator / tester / qa -> the operator role, reviewer -> critic).
// canonSeat and seatIdOf read those roles. The worktrack alias stores the seat strings
// cosSeat() and operatorSeat() return. blinky and forge stay the defaults when routing is absent.
const COS = 'blinky', OPS = 'forge', REVIEW = 'critic';
const COORD_SEAT = (() => {   // the CoS role (routing seats.coord.seat): pulls the next work on an empty board
  try { const r = JSON.parse(fs.readFileSync(path.join(process.env.BIFROST_ROUTING_DIR || path.join(COLLECTOR_DIR_EARLY(), 'routing'), 'inbox-roles.json'), 'utf8'));
    const c = r?.seats?.coord; return c && !c.off && c.seat ? String(c.seat).toLowerCase() : null; } catch { return null; }
})();
const OPERATOR_SEAT = (() => {   // the operator role (routing seats.operator.seat): delivers nudges
  try { const r = JSON.parse(fs.readFileSync(path.join(process.env.BIFROST_ROUTING_DIR || path.join(COLLECTOR_DIR_EARLY(), 'routing'), 'inbox-roles.json'), 'utf8'));
    const c = r?.seats?.operator; return c && !c.off && c.seat ? String(c.seat).toLowerCase() : null; } catch { return null; }
})();
const cosSeat = () => COORD_SEAT || COS;   // the CoS role (routing seats.coord)
const operatorSeat = () => OPERATOR_SEAT || OPS;   // the operator role (routing seats.operator)
const SEAT_ALIAS = {
  coord: cosSeat(), coordinator: cosSeat(), cos: cosSeat(), triager: cosSeat(),
  operator: operatorSeat(), tester: operatorSeat(), qa: operatorSeat(), lab: operatorSeat(),
  reviewer: REVIEW,
};
const COORD_NAMES = new Set(['coord', 'coordinator', 'cos', 'triager']);
const OPERATOR_NAMES = new Set(['operator', 'tester', 'qa', 'lab']);
// LIVE_SEAT_IDS (comma list) replaces the fleet's seat ids; builder / builder-cloud are kit plumbing and always kept.
const SEAT_IDS = process.env.LIVE_SEAT_IDS
  ? [...new Set(['builder', 'builder-cloud', ...process.env.LIVE_SEAT_IDS.split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(x))])]
  : ['builder', 'builder-cloud', 'arch1', 'forge', 'critic', 'blinky', 'herald', 'nibbler', 'sound', 'magnet'];
function canonSeat(name) {
  const id = String(name || '').toLowerCase();
  if (SEAT_IDS.includes(id)) return id;
  if (COORD_NAMES.has(id)) return cosSeat();
  if (OPERATOR_NAMES.has(id)) return operatorSeat();
  return SEAT_ALIAS[id] || id;
}
// Builder-cloud: the cloud Builder seat (own key). It reads Builder's work: every builder inbox line is mirrored into its inbox,
// nudges to builder land in its inbox as type 'nudge', and /cards?seat=builder-cloud shows Builder's cards.
const SEAT_DISPLAY = { 'builder-cloud': 'Builder-cloud' };
const CARD_SEAT = { 'builder-cloud': 'builder' };
// Work tracking (worktrack.mjs) reads seats from here. SEAT_DISPLAY_NAMES (JSON seat -> label) renames lanes;
// WORK_HUMAN_TO is the inbox `to` that parks a packet with a person, WORK_HUMAN_LANE that lane's label.
const jsonEnvObj = name => { try { const o = JSON.parse(process.env[name] || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
configureWorkTrack({
  seatIds: SEAT_IDS, display: { ...SEAT_DISPLAY, ...jsonEnvObj('SEAT_DISPLAY_NAMES') }, alias: SEAT_ALIAS,
  mirror: { builder: 'builder-cloud' }, launchSeat: ARCH1_CANON,
  humanTo: process.env.WORK_HUMAN_TO, humanLane: process.env.WORK_HUMAN_LANE,
});
const SEAT_KEY_HASH = (() => { try { const o = JSON.parse(process.env.SEAT_KEYS || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } })();
// Inbox wake. SEAT_WEBHOOKS is JSON {seat: {url, key_env?, header?}}. The key is process.env[key_env], else
// process.env.WAKE_KEY_<SEAT> (seat upper-cased, '-' -> '_'; key_env may be omitted), sent as
// Authorization: Bearer <key> unless header names a different header (then the raw key). A quiet seat sends after
// WAKE_COALESCE_MS (default 50) so a short burst is one POST. Further lines within WAKE_DEBOUNCE_S (default 60)
// wait and share the next POST's ids. Three attempts with backoff. The inbox write never waits on this.
const envNonNeg = (name, fallback) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const WAKE_DEBOUNCE_MS = envNonNeg('WAKE_DEBOUNCE_S', 60) * 1000;
const WAKE_COALESCE_MS = envNonNeg('WAKE_COALESCE_MS', 50);
const WAKE_RETRY_MS = envNonNeg('WAKE_RETRY_MS', 400);
const WAKE_ATTEMPTS = 3;
// Seats due at the same moment (a deploy, one event routed to 4 seats) send WAKE_STAGGER_MS apart, not all at once:
// the seats' automations share one Cursor account.
const WAKE_STAGGER_MS = envNonNeg('WAKE_STAGGER_MS', 1500);
let wakeNextSlot = 0;
function wakeSlot() { const now = Date.now(), at = Math.max(now, wakeNextSlot); wakeNextSlot = at + WAKE_STAGGER_MS; return at - now; }
function loadSeatWebhooks() {
  const raw = process.env.SEAT_WEBHOOKS;
  if (!raw) return {};
  let parsed; try { parsed = JSON.parse(raw); } catch { console.log('wake: SEAT_WEBHOOKS is not json'); return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [seat, cfg] of Object.entries(parsed)) {
    const id = canonSeat(seat);
    if (!SEAT_IDS.includes(id) || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const seatKeyEnv = 'WAKE_KEY_' + id.toUpperCase().replace(/-/g, '_');
    const url = typeof cfg.url === 'string' ? cfg.url : '', keyEnv = typeof cfg.key_env === 'string' ? cfg.key_env : seatKeyEnv;
    const header = typeof cfg.header === 'string' && cfg.header.trim() ? cfg.header.trim() : 'Authorization';
    let okUrl = false; try { const u = new URL(url); okUrl = u.protocol === 'http:' || u.protocol === 'https:'; } catch { okUrl = false; }
    if (!okUrl || !/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(keyEnv) || !/^[A-Za-z0-9-]{1,64}$/.test(header)) { console.log('wake: skip bad config for ' + id); continue; }
    out[id] = { url, keyEnv, seatKeyEnv, header, bearer: header.toLowerCase() === 'authorization' };
  }
  return out;
}
const SEAT_WEBHOOKS = loadSeatWebhooks();
const wakeQ = new Map();
const wakeState = createWakeState();
const turnTimers = new Map();
let holdTimer = null;
let holdAt = Infinity;
const wakeOkAt = {};   // seat -> ISO of the last successful wake POST. Restored at boot from wake-ok.json, and from wakes.jsonl when that seat is missing (loadPersistedWakes). Not memory-only.
// Wake health on the board: each configured seat's last good wake; quiet = none within BIFROST_WAKE_QUIET_MINUTES
// (default 240) of now (or of server start), even with no unacked line.
const WAKE_QUIET_MS = (Number(process.env.BIFROST_WAKE_QUIET_MINUTES) > 0 ? Number(process.env.BIFROST_WAKE_QUIET_MINUTES) : 240) * 60000;
const BOOT_AT = Date.now();
function wakeBoard(now = Date.now()) {
  const out = {};
  for (const seat of Object.keys(SEAT_WEBHOOKS)) {
    const last = wakeOkAt[seat] || null, t = last ? Date.parse(last) : BOOT_AT;
    const st = wakeQ.get(seat)?.status;
    out[seat] = { last_ok: last, last_err: st && !st.ok ? (st.error || 'fail') : null, quiet: now - t > WAKE_QUIET_MS };
  }
  return out;
}
function recordSkip(seat, line, reason) {
  const row = {
    t: Date.now(), seat: seat || '', reason,
    id: String(line && line.id || '').slice(0, 300),
    kind: String(line && (line.type || line.kind) || '').slice(0, 64),
  };
  wakeState.skips.push(row);
  if (wakeState.skips.length > 4000) wakeState.skips.splice(0, wakeState.skips.length - 4000);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'wake-skips.jsonl'), JSON.stringify(row) + '\n');
  } catch (e) { console.log('wake: skip append failed ' + ((e && e.code) || 'write')); }
  console.log(`wake: skip ${row.seat || '-'} ${reason} ${row.id}`);
}
function ownerOfLine(line) {
  const repo = String(line && line.repo || '').toLowerCase();
  const n = Number(line && line.number);
  if (!repo || !Number.isInteger(n)) return '';
  const card = bfCards.find(c => c && String(c.repo || '').toLowerCase() === repo && Number(c.number) === n);
  if (!card) return '';
  return seatIdOf(card.assignee) || seatIdOf(card.owner) || '';
}
function enqueuePending(seat, line) {
  const id = canonSeat(seat);
  if (!id || !SEAT_WEBHOOKS[id] || !line) return;
  let st = wakeQ.get(id);
  if (!st) { st = { lastSent: 0, pending: [], timer: null, inflight: false, status: null }; wakeQ.set(id, st); }
  st.pending.push(viewLine(line));
  armWake(id);
}
// Same handled cursor live-inbox reads: $HOME/.burst/cursors/<seat>.txt, keys repo#number|sha|kind.
// A legacy LIVE_CURSORS value is not that folder. Unset LIVE_CURSORS is the fixed folder.
function cursorDir() {
  const home = String(process.env.HOME || '').trim() || os.homedir();
  const fixed = path.resolve(home, '.burst', 'cursors');
  const raw = String(process.env.LIVE_CURSORS || '').trim();
  if (!raw) return fixed;
  const chosen = path.resolve(raw);
  if (chosen === fixed) return fixed;
  const root = String(process.env.LIVE_CURSOR_ROOT || '').trim();
  const legacy = root
    ? [path.resolve(root, 'home/box/burst-run/cursors'), path.resolve(root, 'workspace/.cursors')]
    : [path.resolve('/home/box/burst-run/cursors'), path.resolve('/workspace/.cursors')];
  if (legacy.includes(chosen)) return fixed;
  return chosen;
}
const handledCache = new Map();
function handledKeySet(seat) {
  const name = String(seat || '').toLowerCase();
  const file = path.join(cursorDir(), name + '.txt');
  let st;
  try { st = fs.statSync(file); }
  catch { handledCache.delete(name); return { raw: new Set(), lower: new Set() }; }
  const prev = handledCache.get(name);
  if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.file === file) return prev.keys;
  const raw = new Set();
  const lower = new Set();
  for (const row of fs.readFileSync(file, 'utf8').split('\n')) {
    const key = row.trim();
    if (!key) continue;
    raw.add(key);
    lower.add(key.toLowerCase());
  }
  const keys = { raw, lower };
  handledCache.set(name, { mtime: st.mtimeMs, size: st.size, file, keys });
  return keys;
}
function lineHandled(seat, line) {
  if (!line) return false;
  const keys = handledKeySet(seat);
  if (!keys.lower.size) return false;
  const repo = String(line.repo || '').trim().toLowerCase();
  const number = Number(line.number);
  const sha = String(line.sha || line.head || '').trim().toLowerCase();
  const kind = String(line.kind || line.type || '').trim().toLowerCase();
  if (repo && Number.isInteger(number) && sha && kind && keys.lower.has(`${repo}#${number}|${sha}|${kind}`)) return true;
  const id = String(line.id || '').trim();
  if (!id) return false;
  return keys.raw.has(`id:${id}`) || keys.lower.has(`id:${id.toLowerCase()}`);
}
function wakeLineKept(line) {
  if (!line) return false;
  const seat = String(line.seat || line.to || '').trim().toLowerCase();
  if (!seat) return true;
  if (ackedSet(seat).has(String(line.id || ''))) return false;
  if (lineHandled(seat, line)) return false;
  return true;
}
function offerLines(lines) {
  const cfg = wakeConfig(process.env);
  const { wakes, skips } = classifyBatch((Array.isArray(lines) ? lines : []).filter(wakeLineKept), { owner: ownerOfLine });
  for (const s of skips) recordSkip(s.seat, s.line, s.reason);
  const now = Date.now();
  for (const w of wakes) {
    const seat = canonSeat(w.seat);
    if (!seat || !SEAT_WEBHOOKS[seat]) continue;
    if (cfg.paused) { recordSkip(seat, w.line, 'paused'); continue; }
    const d = gateLine({ seat, line: w.line }, wakeState, now, cfg);
    if (d.op === 'skip') { recordSkip(seat, d.line, d.reason); continue; }
    if (d.op === 'queue') {
      wakeState.hold.push({ seat, line: d.line, until: d.until });
      armHold(d.until);
      continue;
    }
    enqueuePending(seat, d.line);
  }
}
function noteWake(seat, line) {
  try {
    if (!line) return;
    offerLines([{ ...line, seat: line.seat || seat }]);
  } catch { /* keep the inbox write */ }
}
function armWake(seat) {
  const st = wakeQ.get(seat);
  if (!st || st.timer || st.inflight || !st.pending.length) return;
  const cfg = wakeConfig(process.env);
  const now = Date.now();
  let wait;
  if (!st.lastSent) wait = cfg.batchMs > 0 ? cfg.batchMs : WAKE_COALESCE_MS;
  else {
    const remain = cfg.batchMs - (now - st.lastSent);
    wait = remain > 0 ? remain : (cfg.batchMs === 0 ? WAKE_COALESCE_MS : 0);
  }
  const t = setTimeout(() => { st.timer = null; void flushWake(seat); }, wait + wakeSlot());
  if (t.unref) t.unref();
  st.timer = t;
}
function pumpHold(now = Date.now()) {
  const cfg = wakeConfig(process.env);
  const { due, skips } = releaseDue(wakeState, now, cfg);
  for (const s of skips) recordSkip(s.seat, s.line, s.reason);
  for (const d of due) enqueuePending(d.seat, d.line);
  let next = 0;
  for (const item of wakeState.hold) if (!next || item.until < next) next = item.until;
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; holdAt = Infinity; }
  if (next) armHold(next);
}
function armHold(until) {
  if (!until) return;
  if (until <= Date.now()) { pumpHold(Date.now()); return; }
  if (holdTimer && holdAt <= until) return;
  if (holdTimer) clearTimeout(holdTimer);
  holdAt = until;
  holdTimer = setTimeout(() => { holdTimer = null; holdAt = Infinity; pumpHold(Date.now()); }, Math.max(0, until - Date.now()) + 15);
  if (holdTimer.unref) holdTimer.unref();
}
function observeTurn(seat, kind, action) {
  if (kind !== 'turn') return;
  const id = canonSeat(seat);
  if (!id) return;
  if (action === 'start') {
    const now = Date.now();
    wakeState.turnOpen.set(id, now);
    const prev = turnTimers.get(id);
    if (prev) clearTimeout(prev);
    const wait = wakeConfig(process.env).turnOpenMs;
    const t = setTimeout(() => {
      turnTimers.delete(id);
      if (wakeState.turnOpen.get(id) !== now) return;
      wakeState.turnOpen.delete(id);
      pumpHold();
    }, wait);
    if (t.unref) t.unref();
    turnTimers.set(id, t);
    return;
  }
  if (action === 'end') {
    const prev = turnTimers.get(id);
    if (prev) clearTimeout(prev);
    turnTimers.delete(id);
    wakeState.turnOpen.delete(id);
    pumpHold();
  }
}
function wakePayload(seat, batch) {
  const real = batch.filter(l => !l.clock);
  const shown = real.length ? real : batch;
  const last = shown[shown.length - 1];
  const lines = real.map(l => { const out = { ...l }; delete out.clock; return out; });
  return { seat, inbox_id: last.id, ids: shown.map(l => l.id), type: last.type, repo: last.repo, number: last.number, title: last.title, url: last.url, reason: last.reason, lines };
}
function wakeErr(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  const code = e && e.cause && e.cause.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : 'network';
}
async function deliverWake(cfg, body) {
  const key = process.env[cfg.keyEnv] || process.env[cfg.seatKeyEnv];
  if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) return { ok: false, attempts: 0, error: 'no_key' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'bifrost-live' };
  if (cfg.bearer) headers.Authorization = 'Bearer ' + key; else headers[cfg.header] = key;
  let error = 'network', detail = '';
  for (let i = 1; i <= WAKE_ATTEMPTS; i++) {
    try {
      const res = await fetch(cfg.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(8000) });
      const text = await res.text().catch(() => '');
      if (res.ok) return { ok: true, attempts: i };
      error = 'http_' + res.status;
      detail = wakeDetail(text, key, cfg.url);
    } catch (e) { error = wakeErr(e); }
    if (i < WAKE_ATTEMPTS) await new Promise(r => { const t = setTimeout(r, WAKE_RETRY_MS * (2 ** (i - 1))); if (t.unref) t.unref(); });
  }
  return { ok: false, attempts: WAKE_ATTEMPTS, error, detail };
}
// non-2xx response body for the log: one line, 160 chars, the key and the webhook url (with its automation id) removed
function wakeDetail(text, key, url) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  for (const x of [key, url, url.split('/').pop()]) if (x && x.length >= 6) t = t.split(x).join('[redacted]');
  return t.replace(/(crsr|key|sk)[_-][A-Za-z0-9_-]{8,}/gi, '[redacted]').slice(0, 160);
}
async function flushWake(seat) {
  const st = wakeQ.get(seat), cfg = SEAT_WEBHOOKS[seat];
  if (!st || st.inflight || !st.pending.length || !cfg) return;
  const batch = st.pending.splice(0, st.pending.length);
  st.inflight = true; st.lastSent = Date.now();
  let result; try { result = await deliverWake(cfg, JSON.stringify(wakePayload(seat, batch))); }
  catch { result = { ok: false, attempts: WAKE_ATTEMPTS, error: 'network' }; }
  st.status = { ok: !!result.ok, attempts: result.attempts, at: new Date().toISOString() };
  if (!result.ok) st.status.error = result.error || 'network';
  console.log(`wake: ${seat} ${result.ok ? 'ok' : 'fail'} attempts=${result.attempts}${result.ok ? '' : ' ' + st.status.error}${result.detail ? ' body=' + JSON.stringify(result.detail) : ''}`);
  if (result.ok) {
    noteSent(wakeState, seat, batch, Date.now());
    touchSeat(seat); wakeOkAt[seat] = st.status.at; persistWakeOk();
    serverActivity(seat, 'turn', 'start', 'wake', { moves: false });
  }
  st.inflight = false;
  const last = batch[batch.length - 1] || {};
  try {
    appendWake(STATE_DIR, {
      seat, id: last.id, ids: batch.map(l => l.id).filter(id => typeof id === 'string' && id),
      t_ct: st.status.at, ok: !!result.ok, attempts: result.attempts,
      title: String(last.title || '').slice(0, 120),
      repo: String(last.repo || '').slice(0, 200), number: Number.isInteger(last.number) ? last.number : 0,
      kind: String(last.type || last.kind || '').slice(0, 64),
      ...(typeof last.sha === 'string' && last.sha ? { sha: last.sha.slice(0, 80) } : {}),
      ...(result.ok ? {} : { error: String(result.error || 'network').slice(0, 40) }),
    });
  } catch (e) { console.log('wake: append failed ' + ((e && e.code) || 'write')); }
  armWake(seat);
  try { publishHeader(); } catch { /* the inbox line is already durable */ }
}
// Last time this process saw each seat act through its inbox (wake 2xx, inbox read, ack); counts toward fleet "active".
// Acks survive a restart as append-only archive rows and are folded in at startup.
// The last good wake survives too: persistWakeOk writes wake-ok.json, and loadPersistedWakes restores wakes.jsonl.
const seatTouch = {};
const touchSeat = (seat, t = Date.now()) => { if (seat) seatTouch[seat] = Math.max(seatTouch[seat] || 0, t); };
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const bearerOf = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
async function seatOf(req) {   // -> seat id | null; throws when GitHub can't verify an installation token (caller: 503)
  const tok = bearerOf(req); if (!tok) return null;
  if (tok.startsWith('ghs_')) { const s = await ghVerify(tok); return s ? String(s).toLowerCase() : null; }
  const h = sha256hex(tok);
  for (const s of SEAT_IDS) { const v = SEAT_KEY_HASH[s]; if (s !== 'builder' && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) && safeEq(h, v)) return s; }
  return null;
}
const seatIdOf = name => { const t = String(name || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ');
  for (const w of t.split(/\s+/)) {
    if (SEAT_IDS.includes(w) || w === 'lead') return w;
    if (COORD_NAMES.has(w)) return cosSeat();
    if (OPERATOR_NAMES.has(w)) return operatorSeat();
    if (SEAT_ALIAS[w]) return SEAT_ALIAS[w];
  } return null; };
const STATE_DIR = path.join(process.env.MESH_DATA_DIR || '/data', 'live');
function persistWakeOk() {
  try { writeWakeOk(path.join(STATE_DIR, 'wake-ok.json'), wakeOkAt); }
  catch (e) { console.log('wake: save failed ' + (e && e.code || 'write')); }
}
Object.assign(wakeOkAt, readWakeOk(path.join(STATE_DIR, 'wake-ok.json')));
const NUDGE_L1_MS = (Number(process.env.NUDGE_L1_S) || 3600) * 1000, NUDGE_L2_MS = (Number(process.env.NUDGE_L2_S) || 1800) * 1000;
const NUDGE_L3_MS = (Number(process.env.NUDGE_L3_S) > 0 ? Number(process.env.NUDGE_L3_S) : 7200) * 1000;
const HELD_MAX_MS = (Number(process.env.HELD_MAX_S) > 0 ? Number(process.env.HELD_MAX_S) : 72 * 3600) * 1000;
const seatInbox = {};   // seat -> [lines]
for (const s of SEAT_IDS) { try { seatInbox[s] = fs.readFileSync(path.join(STATE_DIR, 'inbox', s + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { seatInbox[s] = []; } }
if (!seatInbox.builder.length && inboxLines.length) seatInbox.builder = inboxLines.slice();   // carry the builder mirror over
if (!seatInbox['builder-cloud'].length && seatInbox.builder.length) seatInbox['builder-cloud'] = seatInbox.builder.map(l => ({ ...l, seat: 'builder-cloud' }));
function bfWrite(rel, text) { try { const f = path.join(STATE_DIR, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); } catch (e) { console.log('live: save failed ' + e.code); } }
const START_AFTER_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2}$/;
const START_AFTER_MAX_MS = 30 * 86400 * 1000;   // same horizon the board uses for a Start after: comment
function loadStartAfter() {
  const bag = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  try {
    const o = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'start-after.json'), 'utf8'));
    return { overrides: bag(o && o.overrides), woke: bag(o && o.woke), parked: bag(o && o.parked) };
  } catch { return { overrides: {}, woke: {}, parked: {} }; }
}
const startAfter = loadStartAfter();
function saveStartAfter() {
  bfWrite('start-after.json', JSON.stringify({ overrides: startAfter.overrides, woke: startAfter.woke, parked: startAfter.parked }));
}
function parseStartAfter(iso) {
  if (typeof iso !== 'string') return null;
  const s = iso.trim();
  if (!START_AFTER_RE.test(s) || s.length > 40) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? { iso: s, t } : null;
}
function startWithinCap(when, now = Date.now()) {
  return !!(when && when.t <= now + START_AFTER_MAX_MS);
}
function maySetStartAfter(who, card) {
  if (!who) return false;
  if (card) {
    const owner = seatIdOf(card.owner) || String(card.owner || '').trim().toLowerCase();
    if (owner && owner === who) return true;
  }
  return SEAT_IDS.includes(who);
}
function startKeyOf(c) {
  if (!c) return '';
  if (typeof c.key === 'string' && c.key) return c.key.toLowerCase();
  const repo = String(c.repo || '').toLowerCase();
  const n = Number(c.number);
  return repo && Number.isInteger(n) ? repo + '#' + n : '';
}
function cardStart(c, now = Date.now()) {
  const key = startKeyOf(c);
  const ov = key && startAfter.overrides[key];
  const when = ov && typeof ov.start_after === 'string' ? parseStartAfter(ov.start_after) : parseStartAfter(c && c.start_after);
  return startWithinCap(when, now) ? when : null;
}
function startIsFuture(c, now) {
  const when = cardStart(c, now);
  return !!(when && when.t > now);
}
function scheduledCards(now = Date.now()) {
  let n = 0;
  for (const c of bfCards) if (c && !c.pinned && c.state !== 'closed' && startIsFuture(c, now)) n++;
  return n;
}
// Inbox ack: each seat's acked line ids (persisted). GET /inbox/<seat> hides acked lines. A closed or merged card
// does not hide an unacked line. For reviewer, a Reviewer verdict at the card's current head newer than the line does.
const inboxAcks = (() => { try { const o = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'acks.json'), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } })();
const ackedSet = s => new Set(inboxAcks[s] || []);
function ackLines(seat, what, review) {
  const arr = seatInbox[seat] || [], have = new Set(inboxAcks[seat] || []); let n = 0;
  const at = typeof what === 'object' && what ? arr.findIndex(l => l.id === what.upto) : -1;
  const ids = what === 'all' ? arr.map(l => l.id)
    : what === 'stale' ? arr.filter(l => settledLine(l) && !have.has(l.id)).slice(0, 1000).map(l => l.id)
    : typeof what === 'object' && what ? (at < 0 ? null : arr.slice(0, at + 1).map(l => l.id))
    : arr.some(l => l.id === what) ? [what] : null;
  if (!ids) return -1;
  const lineOf = id => arr.find(l => l.id === id);
  const blocked = id => {
    const line = lineOf(id);
    return !!(line && isMergeHandoff(line) && !validMergeReview(review, line));
  };
  if (typeof what === 'string' && blocked(what)) return -2;
  for (const id of ids) {
    if (have.has(id) || blocked(id)) continue;
    have.add(id); n++;
    const line = lineOf(id);
    const row = { seat, line: id, t_ct: ctStamp(Date.now()) };
    if (line && isMergeHandoff(line)) row.review = review;
    appendArchive('acks', row);
  }
  const live = new Set(arr.map(l => l.id)); inboxAcks[seat] = [...have].filter(id => live.has(id)).slice(-6000);
  bfWrite('acks.json', JSON.stringify(inboxAcks)); return n;
}
// Closed items (nudge skips them): the latest close / merge vs reopen event per repo#number, from the merged feed. A line
// or card on a closed or merged PR / issue is done even when the board no longer carries its card.
const CLOSE_KINDS = new Set(['merged', 'pr_close', 'issue_close', 'pr_closed', 'issue_closed', 'closed']);
const REOPEN_KINDS = new Set(['reopen', 'pr_reopen', 'issue_reopen', 'reopened']);
let closedSeq = -1, closedMap = new Map();
function closedItems() {
  if (closedSeq === seq) return closedMap;
  const m = new Map();
  for (const { e } of evs.values()) {
    if (!e || e.number == null || !(CLOSE_KINDS.has(e.kind) || REOPEN_KINDS.has(e.kind))) continue;
    const k = `${String(e.repo || '').toLowerCase()}#${Number(e.number)}`, t = Date.parse(e.t_ct) || 0, prev = m.get(k);
    if (!prev || t >= prev.t) m.set(k, { t, closed: CLOSE_KINDS.has(e.kind) });
  }
  closedSeq = seq; closedMap = m; return m;
}
function itemClosed(repo, number) {
  if (number == null || !repo) return false;
  const v = closedItems().get(`${String(repo).toLowerCase()}#${Number(number)}`);
  return !!(v && v.closed);
}
function lineCard(l) {
  return bfCards.find(x => x.repo && String(x.repo).toLowerCase() === String(l.repo || '').toLowerCase() && Number(x.number) === Number(l.number));
}
function lineDone(seat, l) {
  if (itemClosed(l.repo, l.number)) return false;
  const c = lineCard(l);
  if (!c || c.state === 'closed') return false;
  const lt = Date.parse(l.t_ct) || 0;
  if (seat === REVIEW && c.reviewer && c.reviewer.at_head && Number(c.reviewer.t) >= lt) return true;   // verdict at head = Reviewer's step done
  return false;
}
// A settled line still shows on a plain read. --ack stale is the receipt: a close or merge event, or a card that is closed or done.
// A missing card is not settled. The board drops cards, and a handoff can arrive before the card does.
function settledLine(l) {
  const number = Number(l && l.number);
  if (!l || !l.repo || !Number.isInteger(number) || number < 1) return false;
  if (itemClosed(l.repo, number)) return true;
  const c = lineCard(l);
  if (!c) return false;
  return c.state === 'closed' || c.stage === 'done';
}
function seatOpenRows(seat, all) {
  const acked = ackedSet(seat);
  return all ? seatInbox[seat].slice() : seatInbox[seat].filter(l => !acked.has(l.id) && !lineDone(seat, l));
}
function openLines(seat, all) {
  const name = String(seat || '').toLowerCase();
  // Parked and dark seats stay in the inbox file and out of the open set, same as the queue.
  // A recent owner prompt unmutes that seat. The roster is read on this call, not cached at boot.
  if (loadMutedSeats().has(name) && !recentPromptSeats().has(name)) return [];
  return seatOpenRows(seat, all);
}
function saveSeatInbox(s) {
  for (const l of seatInbox[s]) appendArchive('inbox', { ...l, seat: l.seat ?? s });
  const cut = Date.now() - 7 * 86400000;
  seatInbox[s] = seatInbox[s].filter(l => !(Date.parse(l.t_ct) < cut)).slice(-5000);
  bfWrite('inbox/' + s + '.jsonl', seatInbox[s].map(l => JSON.stringify(l)).join('\n') + '\n');
}
// Startup route check (same rules as tools/bifrost-init --check): a seat with no route, or a rule routing to a seat
// outside the fleet, is logged loudly and shown on the board (header.routing, /healthz routing). Never a crash.
const ROUTING = checkRoutesFromDir(process.env.BIFROST_ROUTING_DIR || path.join(COLLECTOR_DIR_EARLY(), 'routing'),
  process.env.BIFROST_ROSTER || path.join(COLLECTOR_DIR_EARLY(), 'fleet-roster.json'));
if (!ROUTING.ok) console.log('ROUTING: FAIL ' + (ROUTING.error || '') + (ROUTING.unrouted.length ? ' no route for ' + ROUTING.unrouted.join(',') : '') + (ROUTING.unknown.length ? ' rules to seats outside the fleet: ' + ROUTING.unknown.join(',') : ''));
// Routing map login audit (at startup and every BIFROST_ROUTING_AUDIT_S, default 3600): every login in the map is resolved
// against GitHub with the existing read token (cached, rate-limit safe). A login GitHub does not know is refused: the
// entry is served as refused at /routing, ROUTING.ok goes false, and the CoS gets a board nudge. Unverified (no token,
// rate limit, network) is flagged, never refused.
const ROUTING_DIR = process.env.BIFROST_ROUTING_DIR || path.join(COLLECTOR_DIR_EARLY(), 'routing');
const ROUTING_BASE_OK = ROUTING.ok;
let ROUTING_MAP = readRoutingMap(ROUTING_DIR).map(e => ({ ...e, status: e.login ? 'unverified' : 'no_login' }));
const loginResolver = createLoginResolver({ api: GITHUB_API, token: process.env.GITHUB_READ_TOKEN || '',
  ttlMs: (Number(process.env.BIFROST_LOGIN_TTL_S) || 21600) * 1000 });
ROUTING.logins = { refused: [], unverified: ROUTING_MAP.filter(e => e.login).map(e => e.seat), no_login: ROUTING_MAP.filter(e => !e.login).map(e => e.seat) };
async function auditRouting() {
  const a = await auditLogins(readRoutingMap(ROUTING_DIR), loginResolver.resolve);
  ROUTING_MAP = a.entries;
  ROUTING.logins = { refused: a.refused, unverified: a.unverified, no_login: a.no_login };
  ROUTING.ok = ROUTING_BASE_OK && !a.refused.length;
  if (a.refused.length) console.log('ROUTING: FAIL login not on GitHub for ' + a.refused.join(','));
  console.log(`routing: logins ok ${a.entries.filter(e => e.status === 'ok').length} refused ${a.refused.length} unverified ${a.unverified.length}`);
}
setTimeout(() => auditRouting().catch(() => {}), 0).unref?.();
setInterval(() => auditRouting().catch(() => {}), (Number(process.env.BIFROST_ROUTING_AUDIT_S) || 3600) * 1000).unref();
// Line nudges (part of evalNudges, the one nudge path): an open inbox line older than NUDGE_LINE_S
// (default 900) gets nudge L1 and a re-wake of its seat; L2 and L3 follow one window apart, then it stops (never loops).
// An ack, a handled cursor key, or the card moving on closes them. A handled or acked line gets no L1, L2, or L3.
const NUDGE_LINE_MS = Math.max(1, Number(process.env.NUDGE_LINE_S) > 0 ? Number(process.env.NUDGE_LINE_S) : 900) * 1000;
function nudgeLines(now) {
  let changed = false;
  const open = new Set();
  for (const seat of SEAT_IDS) for (const l of openLines(seat)) {
    if (itemClosed(l.repo, l.number)) continue;
    const closedCard = lineCard(l);
    if (closedCard && closedCard.state === 'closed') continue;
    if (lineHandled(seat, l)) continue;
    const t = Date.parse(l.t_ct);
    if (!Number.isFinite(t) || now - t < NUDGE_LINE_MS) continue;
    const base = `nudge:line:${seat}:${l.id}`; open.add(base);
    const mine = nudges.filter(n => n.kind === 'line' && n.line_key === base);
    const last = mine[mine.length - 1];
    if (mine.length >= 3 || (last && now - last.t < NUDGE_LINE_MS)) continue;
    const lvl = mine.length + 1;
    nudges.push({ id: `${base}:L${lvl}`, kind: 'line', line_key: base, t: now, t_ct: ctStamp(now), card: '', repo: l.repo || '',
      number: Number.isInteger(l.number) ? l.number : 0, title: String(l.title || '').slice(0, 120), url: String(l.url || '').slice(0, 300),
      stage: '', level: lvl, seat, via: 'unacked line', line: String(l.id).slice(0, 300), since: new Date(t).toISOString() });
    noteWake(seat, { ...l, reason: (`nudge L${lvl}: ` + (l.reason || '')).slice(0, 300) });
    changed = true;
  }
  for (const n of nudges) if ((n.kind === 'line' || (n.kind === 'reassign' && n.line_key)) && !n.closed_at && !open.has(n.line_key)) { n.closed_at = new Date(now).toISOString(); changed = true; }
  return changed;
}
// Seat nudges (same path): a seat with no route (startup route check) and a configured seat whose wake went quiet
// (no good wake within BIFROST_WAKE_QUIET_MINUTES) each hold one open nudge on that seat until fixed. Not a CoS wake.
function nudgeSeats(now) {
  let changed = false;
  const want = new Map();
  for (const seat of ROUTING.unrouted) want.set(`nudge:unrouted:${seat}`, { seat, kind: 'unrouted', via: 'no route' });
  for (const seat of ROUTING.logins?.refused || []) want.set(`nudge:login:${seat}`, { seat, kind: 'unrouted', via: 'login not on GitHub' });
  const w = wakeBoard(now);
  for (const [seat, v] of Object.entries(w)) if (v.quiet) want.set(`nudge:quiet:${seat}:${v.last_ok || 'boot'}`, { seat, kind: 'quiet', via: 'wake quiet' });
  for (const [id, x] of want) if (!nudges.some(n => n.id === id)) {
    nudges.push({ id, kind: x.kind, t: now, t_ct: ctStamp(now), card: '', repo: '', number: 0, title: `${x.seat}: ${x.via}`, url: '',
      stage: '', level: 1, seat: x.seat, about: x.seat, via: x.via });
    changed = true;
  }
  for (const n of nudges) if ((n.kind === 'unrouted' || n.kind === 'quiet') && !n.closed_at && !want.has(n.id)) { n.closed_at = new Date(now).toISOString(); changed = true; }
  return changed;
}
function validSeatLine(d) { if (!d || typeof d.seat !== 'string' || !SEAT_IDS.includes(canonSeat(d.seat))) return false; return validInboxLine({ ...d, seat: 'builder' }); }
function inboxLineError(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'line must be an object';
  const keys = Object.keys(d);
  const banned = keys.filter(k => INBOX_BANNED.test(k)).sort();
  const unknown = keys.filter(k => !INBOX_KEYS.has(k) && !INBOX_BANNED.test(k)).sort();
  const parts = [];
  if (banned.length) parts.push('field names must not include body, text, or message: ' + banned.join(', '));
  if (unknown.length) parts.push('unknown fields: ' + unknown.join(', '));
  const seat = typeof d.seat === 'string' ? canonSeat(d.seat) : '';
  if (!SEAT_IDS.includes(seat)) parts.push('seat must be a seat id');
  if (typeof d.id !== 'string' || !d.id) parts.push('id required');
  if (typeof d.t_ct !== 'string' || !d.t_ct) parts.push('t_ct required');
  if (typeof d.type !== 'string' || !d.type) parts.push('type required');
  if (typeof d.reason !== 'string' || !d.reason) parts.push('reason required');
  for (const k of ['repo', 'title', 'url']) if (typeof d[k] !== 'string') parts.push(k + ' must be a string');
  if (typeof d.number !== 'number' || !Number.isInteger(d.number)) parts.push('number must be an integer');
  if (d.sha != null && typeof d.sha !== 'string') parts.push('sha must be a string');
  if (d.from != null && !canonSeatTokenOk(d.from)) parts.push('from must be a seat id');
  if (d.to != null && !toToken(d.to)) parts.push('to must be a seat id');
  if (d.kind != null && !tokenOk(d.kind)) parts.push('kind must be a string');
  if (d.flag != null && !tokenOk(d.flag)) parts.push('flag must be a string');
  if (d.labels != null && !labelsOk(d.labels)) parts.push('labels must be a list of short names');
  if (d.batch != null && typeof d.batch !== 'string') parts.push('batch must be a string');
  else if (typeof d.batch === 'string' && d.batch.length > 2000) parts.push('batch is too long');
  return parts.length ? parts.join('; ') : null;
}
function rejectedRef(l, i) {
  if (l && typeof l.id === 'string' && l.id) return l.id.slice(0, 120);
  return '#' + i;
}
function attentionNow() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [process.env.ATTENTION_STATE_FILE, path.join(here, '..', '..', '..', 'house', 'ATTENTION_STATE.md')].filter(Boolean);
  for (const file of files) {
    try { return fs.readFileSync(file, 'utf8'); } catch { /* the next path */ }
  }
  return '';
}
function prBusy(line) {
  const repo = String(line && line.repo || '').toLowerCase();
  const n = Number(line && line.number);
  if (!repo || !Number.isInteger(n)) return false;
  const key = repo + '#' + n;
  if (batch.busy(key)) return true;
  return cloudAgentBoard().some((row) => row && row.state === 'running' && String(row.card || '').toLowerCase() === key);
}
function storeFlush(src, out) {
  if (!out || !out.line) return null;
  const line = { ...out.line, t_ct: ctStamp(Date.now()) };
  if (src && src.flag === 'hotfix') line.flag = 'hotfix';
  return line;
}
function noteCi(ev) {
  const repo = String(ev && ev.repo || '').toLowerCase();
  const n = Number(ev && ev.number);
  const key = repo && Number.isInteger(n) ? repo + '#' + n : '';
  const out = batch.observeCi(ev, { attention: attentionNow(), busy: key ? batch.busy(key) || prBusy({ repo, number: n }) : false });
  const line = storeFlush(ev, out);
  if (!line) return;
  postSeatLines({ lines: [line] }, null);
}
function takeBatch(lines) {
  const kept = [];
  for (const line of lines) {
    if (line && String(line.kind || '').toLowerCase() === 'run_end') {
      const out = batch.runEnd(line, { attention: attentionNow(), hotfix: line.flag === 'hotfix' });
      const flush = storeFlush(line, out);
      if (flush) kept.push(flush);
      continue;
    }
    if (line && batch.absorb(line, prBusy(line))) continue;
    kept.push(line);
  }
  return kept;
}
function postSeatLines(parsed, onlySeat) {
  const incoming = parsed && Array.isArray(parsed.lines) ? parsed.lines : null;
  if (!incoming || incoming.length > 5000) return { status: 400, error: 'lines required' };
  if (onlySeat && incoming.some(l => !l || canonSeat(l.seat) !== onlySeat)) return { status: 403, error: 'inbox is not exposed' };
  const rejected = []; const good = [];
  for (let i = 0; i < incoming.length; i++) {
    const l = incoming[i];
    const err = inboxLineError(l);
    if (err || !validSeatLine(l)) { rejected.push({ ref: rejectedRef(l, i), error: err || 'line refused' }); continue; }
    good.push(l);
  }
  const refs = rejected.map(r => r.ref);
  if (rejected.length) console.log(`inbox: rejected ${rejected.length} bad line(s)`);
  if (!good.length && rejected.length) {
    const why = rejected.slice(0, 8).map(r => r.ref + ': ' + r.error).join('; ');
    return { status: 400, error: ('no line stored: ' + why).slice(0, 800), rejected: refs };
  }
  const outgoing = takeBatch(good);
  const touched = new Set(); let added = 0; const fresh = [];
  if (parsed.replace === true && onlySeat && good.length && seatInbox[onlySeat]) {
    seatInbox[onlySeat].length = 0;
    touched.add(onlySeat);
  }
  for (const l of outgoing) {
    const s = canonSeat(l.seat), arr = seatInbox[s]; if (!arr || arr.some(x => x.id === l.id)) continue;
    const stored = { ...l, seat: s };
    for (const k of ['from', 'to', 'kind', 'flag']) if (typeof stored[k] === 'string') stored[k] = stored[k].toLowerCase();
    arr.push(stored); touched.add(s); added++; fresh.push(stored);
    if (s === 'builder') { const c = seatInbox['builder-cloud']; if (!c.some(x => x.id === l.id)) { const copy = { ...stored, seat: 'builder-cloud' }; c.push(copy); touched.add('builder-cloud'); fresh.push(copy); } } }
  for (const s of touched) saveSeatInbox(s);
  if (fresh.length) { try { offerLines(fresh); } catch { /* keep the inbox write */ } }
  for (const l of fresh) ensurePacketCard(l);
  for (const l of fresh) void arch1Launch.consider(l);
  return { status: 200, added, rejected: refs };
}
// ---- Assistant / emitter: the sample MCP server posts one event per tool call / OAuth sign-in (POST /emit, Bearer = the
// 'assistant' seat key, checked against SEAT_KEYS.assistant). Write-only and strict: tool name, time, ok, client class,
// latency, kind; any other field (addresses, content, emails, user ids) is refused. Not a reading seat (no inbox/cards).
const EMITTER_WORK_MS = (Number(process.env.EMITTER_WORKING_S) || 120) * 1000;   // a run of calls = working until 2 min after the last
const DOT_FIELDS = new Set(['tool', 't', 'ok', 'client', 'latency_ms', 'kind']);
const emitter = { last: 0, recent: [] };   // in memory: last event time + the last 50 events (no customer data by construction)
function validDot(d, now = Date.now()) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'object required';
  for (const k of Object.keys(d)) if (!DOT_FIELDS.has(k)) return 'unknown field ' + String(k).slice(0, 32);
  if (!['tool', 'oauth'].includes(d.kind)) return 'kind must be tool|oauth';
  if (typeof d.tool !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(d.tool)) return 'bad tool';
  if (typeof d.ok !== 'boolean') return 'ok must be boolean';
  if (!['assistant', 'other'].includes(d.client)) return 'client must be assistant|other';
  if (d.latency_ms != null && !(Number.isInteger(d.latency_ms) && d.latency_ms >= 0 && d.latency_ms <= 600000)) return 'bad latency_ms';
  const t = Date.parse(d.t); if (typeof d.t !== 'string' || d.t.length > 40 || !Number.isFinite(t) || Math.abs(now - t) > 3600000) return 'bad t';
  return null;
}
function dotsFleet(fleet, now = Date.now()) {   // Assistant node state, merged into the fleet view
  if (!emitter.last) return fleet;
  const f = fleet || { as_of: iso(now), window_min: WINDOW_MIN, seats: {}, working: {}, active: 0, total: 0 };
  const win = (f.window_min || WINDOW_MIN) * 60000, last = emitter.recent[emitter.recent.length - 1] || {};
  const working = now - emitter.last <= EMITTER_WORK_MS;
  f.seats = { ...(f.seats || {}), Assistant: { active: now - emitter.last <= win, last_ct: iso(emitter.last), via: 'emitter', working, ...(working ? { working_via: 'emitter' } : {}) } };
  f.working = { ...(f.working || {}) }; delete f.working.Assistant;
  if (working) f.working.Assistant = { via: 'emitter', since_ct: iso(emitter.last), tool: last.tool, client: last.client, ok: last.ok };
  return f;
}
// cards: the collector waveboard, plus one card per accepted source item. A collector pass replaces only the wave cards.
let waveCards = []; let bfCards = []; let seedHold = []; let nudges = []; let waveSig = ''; let boardSig = '';
let WAVE_SEED = { waves: [] };
try {
  const seedPath = resolveWaveSeed(path.dirname(fileURLToPath(import.meta.url)), process.env, (file) => fs.existsSync(file));
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (seed && Array.isArray(seed.waves)) WAVE_SEED = seed;
} catch { /* a fleet with no seed file does not schedule waves */ }
try {
  const held = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'wave-seed.json'), 'utf8'));
  seedHold = Array.isArray(held.cards) ? held.cards : [];
} catch { /* nothing loaded */ }
let cardsAt = 0;
let githubDataAt = 0;
let githubCardAt = 0;
try {
  const cardsPath = path.join(STATE_DIR, 'cards.json');
  const parsed = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
  bfCards = (Array.isArray(parsed.cards) ? parsed.cards : []).map(applyBrief);
  waveCards = bfCards.slice();
  const u = parsed.updated_ct;
  const t = typeof u === 'number' ? u : Date.parse(String(u ?? ''));
  if (Number.isFinite(t) && t > 0) cardsAt = t;
  else if (bfCards.length) cardsAt = fs.statSync(cardsPath).mtimeMs;
} catch { /* missing file stays cardsAt 0 */ }
function recordArch1Beat(_beat, line) {
  if (line && line.id && seatInbox.arch1 && !seatInbox.arch1.some(x => x.id === line.id)) {
    seatInbox.arch1.push(line);
    saveSeatInbox('arch1');
    appendArchive('inbox', line);
    noteWake('arch1', line);
  }
  seq++; header = mergedHeader(); fullDirty = true;
}
const arch1Launch = createArch1Launch({
  env: process.env, dataDir: STATE_DIR, onBeat: recordArch1Beat,
  runningId: line => {
    const repo = String(line && line.repo || '').toLowerCase();
    const num = Number(line && line.number);
    const card = repo && Number.isInteger(num) ? repo + '#' + num : '';
    if (card) {
      const row = cloudAgentBoard().find(item => item && item.state === 'running' && String(item.card || '').toLowerCase() === card);
      if (row && row.bcId) return row.bcId;
    }
    const sha = String(line && line.sha || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) return '';
    return runningCloudForHead(sha);
  },
  ownsCard: line => {
    const repo = String(line && line.repo || '').toLowerCase();
    const num = Number(line && line.number);
    if (!repo || !Number.isInteger(num)) return false;
    const card = bfCards.find(c => c && String(c.repo || '').toLowerCase() === repo && Number(c.number) === num);
    if (!card) return false;
    const id = seatIdOf(card.owner);
    return id === 'arch1' || id === 'lead';
  },
  cardOnBoard: key => bfCards.some(c => c && String(c.key || '').toLowerCase() === String(key || '').toLowerCase()),
});
try { nudges = fs.readFileSync(path.join(STATE_DIR, 'nudges.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
initArchive(process.env.MESH_DATA_DIR || '/data');
function seedTouchFromAcks() {
  for (const day of archiveDays()) {
    for (const row of readArchive(day, 'acks').lines) {
      const seat = String(row && row.seat || '').toLowerCase();
      const t = Date.parse(row && row.t_ct || '');
      if (!seat || !Number.isFinite(t) || t <= 0) continue;
      seatTouch[seat] = Math.max(seatTouch[seat] || 0, t);
    }
  }
}
seedTouchFromAcks();
const saveNudges = () => {
  for (const n of nudges) {
    appendArchive('nudges', n);
    if (n && n.closed_at) appendArchive('nudges', { ...n, id: `${n.id}#closed`, t_ct: n.closed_at });
  }
  nudges = nudges.slice(-3000);
  bfWrite('nudges.jsonl', nudges.map(n => JSON.stringify(n)).join('\n') + '\n');
};
const parsedAllow = parseAllowlist(process.env.SOURCE_ALLOWLIST, '');
if (parsedAllow.badJson) console.log('source: SOURCE_ALLOWLIST is not json');
const SOURCE_ALLOW = parsedAllow.allow;
const work = new Map();
const WORK_MAX = 5000;
function nudgeToCloud(n) {   // a nudge to Builder is also an inbox line for Builder-cloud (either seat can pick it up)
  const l = { id: n.id, t_ct: n.t_ct, seat: 'builder-cloud', type: 'nudge', repo: n.repo, number: n.number, title: n.title, url: n.url, reason: `nudge L${n.level} (${n.via})` };
  if (!validInboxLine({ ...l, seat: 'builder' })) l.title = '';
  if (!validInboxLine({ ...l, seat: 'builder' }) || seatInbox['builder-cloud'].some(x => x.id === l.id)) return;
  seatInbox['builder-cloud'].push(l); saveSeatInbox('builder-cloud'); noteWake('builder-cloud', l);
}
function itemsFromWork() {
  const latest = new Map();
  for (const e of work.values()) {
    if (e.source !== 'jira' && !projectAllowed(SOURCE_ALLOW, e.source, e.project)) continue;
    const item = workEventToItem(e);
    if (!item || validateItem(item)) continue;
    const id = item.source + '\0' + item.key;
    const prev = latest.get(id);
    if (!prev || workItemNewer(prev, item)) latest.set(id, item);
  }
  return [...latest.values()];
}
function weeklyBurnFraction() {
  const raw = process.env.BIFROST_WEEKLY_BURN;
  if (raw == null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;
}
function cardIsClosed(card) {
  if (!card || card.pinned) return false;
  if (card.state === 'closed' || card.stage === 'done') return true;
  const number = Number(card.number);
  if (!card.repo || !Number.isInteger(number)) return false;
  return itemClosed(card.repo, number);
}
function waveBoard(cards, now = Date.now()) {
  const coord = cosSeat();
  return scheduleWaves(retainSeedCards(cards, bfCards, seedHold, cardIsClosed), WAVE_SEED, {
    coord, now, prior: bfCards, weeklyBurn: weeklyBurnFraction(), window: WAVE_SEED.window,
    closed: cardIsClosed,
  });
}
function notePonder(card) {
  const key = startKeyOf(card) || (card && card.key);
  const row = batch.ponder(key, 'closed');
  if (!row) return;
  try {
    const file = path.join(STATE_DIR, 'ponder.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...row, t_ct: new Date().toISOString() }) + '\n');
  } catch (e) { console.log('ponder: ' + ((e && e.code) || 'write')); }
}
function ensurePacketCard(line) {
  if (!isPacket(line)) return;
  const key = cardKeyOf(line);
  if (!key || key === 'packet:') return;
  if (bfCards.some(c => c && String(c.key || '').toLowerCase() === key.toLowerCase())) return;
  const number = Number(line.number);
  const owner = typeof line.to === 'string' && line.to ? line.to : line.seat;
  bfCards = bfCards.concat([{
    key, born: 'packet', kind: 'packet', repo: String(line.repo || ''),
    number: Number.isInteger(number) ? number : 0,
    title: String(line.title || '').slice(0, 120), url: String(line.url || '').slice(0, 300),
    owner: String(owner || '').slice(0, 24), stage: 'open', state: 'live',
    packet: {}, packet_ok: true, missing: [],
    beats: [], last_beat_t: Date.now(), stall: false,
  }]);
  publishBoard();
}
function githubEvents() {
  try { return [...SRCS.github.evs.values()]; } catch { return []; }
}
function archiveCard(c, stamp) {
  if (!c || c.kind === 'source' || !c.key) return;
  const beat = Number(c.last_beat_t);
  const fromBeat = Number.isFinite(beat) && beat > 0 ? new Date(beat).toISOString() : '';
  const updated = typeof c.updated_ct === 'string' && c.updated_ct ? c.updated_ct : (fromBeat || stamp);
  appendArchive('cards', { ...c, t_ct: c.t_ct || updated || stamp, updated_ct: updated });
}
function mergedEventFor(card, events) {
  const repo = String(card && card.repo || '').toLowerCase();
  const number = Number(card && card.number);
  if (!repo || !Number.isInteger(number)) return null;
  return (events || []).find(e => e && e.kind === 'merged' && String(e.repo || '').toLowerCase() === repo && Number(e.number) === number) || null;
}
/** Final merged or closed rows the display cap or the 24h window left off the board. The archive stamp is this write, so a newer live snapshot does not stay last. */
function archiveFinals(settled, stamp) {
  const events = githubEvents();
  const rows = [];
  for (const c of Array.isArray(settled) ? settled : []) if (c && c.key) rows.push(c);
  for (const c of bfCards) {
    if (!isPacketBorn(c) || !cardIsClosed(c) || c.state === 'closed') continue;
    const hit = mergedEventFor(c, events);
    rows.push({
      ...c, state: 'closed', stage: 'done', verb: hit ? 'merged' : 'closed',
      merged_by: hit ? (hit.merged_by || hit.from) : c.merged_by, updated_ct: stamp,
    });
  }
  for (const c of rows) {
    const hit = mergedEventFor(c, events);
    const verb = hit ? 'merged' : (c.verb === 'merged' || c.verb === 'closed' ? c.verb : 'closed');
    archiveCard({
      ...c, state: 'closed', stage: 'done', verb,
      merged_by: (hit && (hit.merged_by || hit.from)) || c.merged_by,
      updated_ct: stamp,
    }, stamp);
  }
}
function publishBoard(updatedCt, settled) {
  const stamp = updatedCt || new Date().toISOString();
  archiveFinals(settled, stamp);
  const merged = mergeCards(waveCards, sourceCardsFrom(itemsFromWork(), { seats: SEAT_IDS }));
  const scheduled = waveBoard(merged);
  scheduled.cards = attachPacketCards(scheduled.cards, githubEvents()).map(applyBrief);
  const sig = JSON.stringify(scheduled.cards);
  if (sig === boardSig) return;
  boardSig = sig;
  bfCards = scheduled.cards; cardsAt = Date.now();
  bfWrite('cards.json', JSON.stringify({ updated_ct: stamp, cards: bfCards }));
  for (const c of bfCards) {
    if (c && String(c.state || '').toLowerCase() === 'closed') notePonder(c);
    if (!c || c.kind === 'source') continue;
    archiveCard(c, stamp);
  }
  recomputeGithubDataAt();
}
function takeTransitions(rows) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) appendTransition(row);
}
function setCards(wb) {
  if (!wb || typeof wb !== 'object') return;
  takeTransitions(wb.transitions);
  if (!Array.isArray(wb.cards)) return;
  const stamp = wb.updated_ct || new Date().toISOString();
  const sliced = wb.cards.slice(0, 200);
  const kept = acceptWaveCards(sliced, waveCards, {
    stalled: feedStalled(),
    feedAgeMs: feedFileAgeMs(),
    stallWindowMs: watchLimitMs(),
  });
  if (kept === waveCards) { archiveFinals(wb.settled, stamp); return; }
  const sig = JSON.stringify(kept);
  if (sig === waveSig) { archiveFinals(wb.settled, stamp); return; }
  waveSig = sig;
  waveCards = kept;
  publishBoard(stamp, wb.settled);
}
function holdOwner(c) {
  const owner = seatIdOf(c.owner);
  if (owner && SEAT_IDS.includes(owner)) return owner;
  const by = seatIdOf(c.hold && c.hold.by);
  if (by && SEAT_IDS.includes(by)) return by;
  return cosSeat();
}
// A future start_after parks the card (no nudge, and it is not an open card for the tripwire). At that time one
// inbox line wakes the owning seat. The command override wins over the collector field. Both the date and the
// woke mark live in start-after.json, so a restart does not lose the date or send the wake twice.
function owningSeat(c) {
  return seatIdOf(c.nudge_to) || seatIdOf((c.packet || {})['next owner']) || seatIdOf(c.owner);
}
function applyStartAfter(now = Date.now()) {
  let changed = false;
  for (const c of bfCards) {
    if (!c || c.pinned) continue;
    const key = startKeyOf(c);
    if (!key) continue;
    const ov = startAfter.overrides[key];
    if (ov && typeof ov.start_after === 'string' && c.start_after !== ov.start_after) {
      c.start_after = ov.start_after;
      changed = true;
    }
    const when = parseStartAfter(c.start_after);
    if (!when || !startWithinCap(when, now) || c.state === 'closed') {
      if (c.state === 'closed' && startAfter.parked[key]) { delete startAfter.parked[key]; changed = true; }
      continue;
    }
    if (when.t > now) {
      if (c.state !== 'parked' || c.stall) { c.state = 'parked'; c.stall = false; changed = true; }
      if (startAfter.parked[key] !== when.iso) { startAfter.parked[key] = when.iso; changed = true; }
      continue;
    }
    if (startAfter.parked[key]) {
      delete startAfter.parked[key];
      changed = true;
      if (c.state === 'parked') { c.state = 'live'; c.stall = false; }
    }
    const wokeKey = key + '@' + when.iso;
    if (startAfter.woke[wokeKey]) continue;
    const seat = owningSeat(c);
    if (!seat || !SEAT_IDS.includes(seat)) continue;
    const line = {
      id: `start-after:${key}:${when.iso}`, t_ct: ctStamp(now), seat, type: 'start_after',
      repo: String(c.repo || ''), number: Number.isInteger(c.number) ? c.number : Number(c.number) || 0,
      title: String(c.title || '').slice(0, 120), url: String(c.url || '').slice(0, 300), reason: `start after ${when.iso}`,
    };
    const r = postSeatLines({ lines: [line] }, null);
    if (r.status !== 200) continue;
    startAfter.woke[wokeKey] = now;
    changed = true;
  }
  if (changed) saveStartAfter();
  return changed;
}
// NUDGE: a live card with no beat for 60 min -> level 1 to the packet's next owner (else the card owner); still no
// beat 30 min after that -> level 2 to Coord. Level 3 then repeats to that same owner every 2h until a beat lands.
// Repos in NO_NUDGE_REPOS (unset means none) are shown and never nudged. A held card raises no L1/L2/L3. It nudges
// the owner once if it stays held with no beat past HELD_MAX_S (default 72h), unless the repo is in that list.
function evalNudges(now = Date.now()) {
  let changed = applyStartAfter(now); const byKey = new Map(bfCards.map(c => [c.key, c]));
  for (const n of nudges) {
    if (n.closed_at || ['silent', 'line', 'unrouted', 'quiet', 'handoff'].includes(n.kind) || (n.kind === 'reassign' && (n.line_key || String(n.id || '').includes(':handoff:')))) continue;
    const c = byKey.get(n.card);
    if (cardNoNudge(c) || cardNoNudge({ repo: n.repo, key: n.card }) || itemClosed(n.repo, n.number)) {
      n.closed_at = new Date(now).toISOString(); changed = true; continue;
    }
    if (n.kind === 'held') {
      if (!c || c.state !== 'held' || c.last_beat_t !== n.beat_t) { n.closed_at = new Date(now).toISOString(); changed = true; }
      continue;
    }
    if (!c || c.state !== 'live' || c.waiting || c.last_beat_t !== n.beat_t) { n.closed_at = new Date(now).toISOString(); changed = true; }
  }
  for (const c of bfCards) {
    if (isPlanCard(c)) continue;   // the plan card is the tripwire's, and its beat is refreshed by the scheduler
    if (cardNoNudge(c) || itemClosed(c.repo, c.number)) continue;   // closed / merged PRs and issues are never nudged
    if (c.state === 'held' && !c.pinned && c.last_beat_t && now - c.last_beat_t >= HELD_MAX_MS) {
      const nid = `nudge:${c.key}:held:${c.last_beat_t}`;
      if (!nudges.some(n => n.id === nid)) {
        const seat = holdOwner(c);
        nudges.push({ id: nid, kind: 'held', t: now, t_ct: ctStamp(now), card: c.key, repo: c.repo || '', number: c.number || 0,
          title: String(c.title || '').slice(0, 120), url: String(c.url || '').slice(0, 300), stage: c.stage || '', level: 0, seat, via: 'held past max', beat_t: c.last_beat_t });
        changed = true;
        if (seat === 'builder') nudgeToCloud(nudges[nudges.length - 1]);
      }
    }
    if (batch.inBeat(startKeyOf(c))) {
      for (const n of nudges) {
        if (n.closed_at || n.card !== c.key) continue;
        if (n.kind === 'handoff' || n.kind === 'line' || n.kind === 'silent' || n.kind === 'unrouted' || n.kind === 'quiet') continue;
        n.closed_at = new Date(now).toISOString();
        changed = true;
      }
      continue;
    }
    if (c.pinned || c.state !== 'live' || c.waiting || !c.last_beat_t || now - c.last_beat_t < NUDGE_L1_MS) continue;
    const id = lvl => `nudge:${c.key}:L${lvl}:${c.last_beat_t}`, has = lvl => nudges.find(n => n.id === id(lvl));
    const mk = (lvl, seat, via, nid = id(lvl)) => { nudges.push({ id: nid, t: now, t_ct: ctStamp(now), card: c.key, repo: c.repo || '', number: c.number || 0,
      title: String(c.title || '').slice(0, 120), url: String(c.url || '').slice(0, 300), stage: c.stage || '', level: lvl, seat, via, beat_t: c.last_beat_t }); changed = true;
      if (seat === 'builder') nudgeToCloud(nudges[nudges.length - 1]); };
    const to = seatIdOf(c.nudge_to), nx = to || seatIdOf((c.packet || {})['next owner']);
    const tgt = nx || seatIdOf(c.owner) || cosSeat(), via = to ? (c.nudge_via || 'retest owner') : nx ? 'next owner' : 'card owner';
    const l1s = nudges.filter(n => n.id === id(1) || n.id.startsWith(id(1) + ':'));
    let l1 = l1s[l1s.length - 1];
    if (!l1) { mk(1, tgt, via); l1 = has(1); }
    else if (!l1.closed_at && l1.seat !== tgt) {
      l1.closed_at = new Date(now).toISOString(); changed = true;
      if (!l1s.some(n => n.seat === tgt)) { mk(1, tgt, via, id(1) + ':' + tgt); l1 = nudges[nudges.length - 1]; } }
    if (l1 && !l1.closed_at && now - l1.t >= NUDGE_L2_MS + NUDGE_L3_MS) {
      const reps = nudges.filter(n => n.card === c.key && n.level === 3 && n.beat_t === c.last_beat_t && !n.closed_at);
      const prev = reps.length ? reps[reps.length - 1].t : l1.t + NUDGE_L2_MS;
      if (now - prev >= NUDGE_L3_MS) mk(3, tgt, 'repeat', `nudge:${c.key}:L3:${c.last_beat_t}:${reps.length + 1}`);
    }
  }
  if (nudgeLines(now)) changed = true;
  if (nudgeSeats(now)) changed = true;
  if (evalHandoffs(now)) changed = true;
  if (changed) saveNudges();
  return changed;
}
// A handoff event with no /inbox packet to the routed next seat within NUDGE_L1_S is `handoff missing`.
// The owing seat is nudged L1, then L2 after NUDGE_L2_S, then L3 after NUDGE_L3_S. Room posts are not
// lines here, so they never clear the miss. This does not post a packet.
let handoffRolesCache = null;
function handoffConfig() {
  if (handoffRolesCache) return handoffRolesCache;
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const dir = process.env.BIFROST_ROUTING_DIR || path.join(appDir, 'collector', 'routing');
  for (const file of [path.join(dir, 'inbox-roles.json'), path.join(appDir, '..', 'feed', 'routing', 'inbox-roles.json')]) {
    const parsed = readJson(file);
    if (parsed && parsed.handoffs) { handoffRolesCache = parsed; return parsed; }
  }
  handoffRolesCache = {};
  return handoffRolesCache;
}
function feedEvents() {
  const out = [];
  for (const row of evs.values()) if (row && row.e) out.push(row.e);
  return out;
}
function inboxPackets() {
  const out = [];
  for (const lines of Object.values(seatInbox)) if (Array.isArray(lines)) out.push(...lines);
  return out;
}
function latestPrTitle(repo, number) {
  const key = String(repo || '').toLowerCase() + '#' + Number(number);
  let best = '';
  let when = -1;
  const src = SRCS.github && SRCS.github.evs;
  if (!src) return '';
  for (const e of src.values()) {
    if (!e || typeof e.title !== 'string' || !e.title.trim()) continue;
    if ((String(e.repo || '').toLowerCase() + '#' + Number(e.number)) !== key) continue;
    const t = Date.parse(e.t_ct || '') || 0;
    if (t >= when) { when = t; best = e.title; }
  }
  return best;
}
function enqueueHotfixMerges(batch) {
  if (!Array.isArray(batch) || !batch.length) return;
  const roles = handoffConfig();
  const block = roles && roles.handoffs;
  const reviewer = block && block.reviewer;
  const from = block && block.merger;
  const lines = [];
  for (const e of batch) {
    if (!e || String(e.kind || '').toLowerCase() !== 'merged') continue;
    if (!isHotfixTitle(latestPrTitle(e.repo, e.number))) continue;
    const line = hotfixMergeLine({ repo: e.repo, number: e.number, sha: e.merge_sha || e.sha || '', reviewer, from });
    if (line) lines.push(line);
  }
  if (lines.length) postSeatLines({ lines }, null);
}
function evalHandoffs(now) {
  let changed = false;
  const due = missingHandoffs({ events: feedEvents(), lines: inboxPackets(), roles: handoffConfig(), loginToSeat: loginMap(), now, l1ms: NUDGE_L1_MS });
  const open = new Set();
  for (const ob of due) {
    if (!SEAT_IDS.includes(ob.owes)) continue;
    if (lineHandled(ob.owes, { repo: ob.repo, number: ob.number, sha: ob.sha, kind: ob.kind })) continue;
    const held = bfCards.find(c => c && (c.key === ob.key || (String(c.repo || '').toLowerCase() === String(ob.repo || '').toLowerCase() && Number(c.number) === Number(ob.number))));
    if (held && startIsFuture(held, now)) continue;
    const base = `nudge:handoff:${ob.key}:${ob.kind}:${ob.sha}`;
    open.add(base);
    if (!nudges.some(n => n.id === base)) {
      nudges.push({ id: base, kind: 'handoff', t: now, t_ct: ctStamp(now), card: ob.key, repo: ob.repo, number: ob.number,
        title: `handoff missing ${ob.kind}`.slice(0, 120), url: '', stage: '', level: 1, seat: ob.owes, via: 'handoff missing', beat_t: ob.since, sha: ob.sha, flag: 'handoff missing' });
      changed = true;
      noteWake(ob.owes, { id: base, type: 'nudge', kind: ob.kind, repo: ob.repo, number: ob.number, title: 'handoff missing', reason: `handoff missing ${ob.kind}`, sha: ob.sha });
    }
    const l1 = nudges.find(n => n.id === base && !n.closed_at);
    const l2id = `${base}:L2`;
    if (l1 && !nudges.some(n => n.id === l2id) && now - l1.t >= NUDGE_L2_MS) {
      nudges.push({ ...l1, id: l2id, t: now, t_ct: ctStamp(now), level: 2, seat: ob.owes, via: 'escalation' });
      changed = true;
      noteWake(ob.owes, { id: l2id, type: 'nudge', kind: ob.kind, repo: ob.repo, number: ob.number, title: 'handoff missing', reason: `nudge L2: handoff missing ${ob.kind}`, sha: ob.sha });
    }
    const l2 = nudges.find(n => n.id === l2id && !n.closed_at);
    if (l2 && now - l2.t >= NUDGE_L3_MS) {
      const reps = nudges.filter(n => n.kind === 'handoff' && n.level === 3 && n.card === ob.key && n.sha === ob.sha && !n.closed_at);
      const prev = reps.length ? reps[reps.length - 1].t : l2.t;
      if (now - prev >= NUDGE_L3_MS) {
        const id = `${base}:L3:${reps.length + 1}`;
        if (!nudges.some(n => n.id === id)) {
          nudges.push({ ...l2, id, t: now, t_ct: ctStamp(now), level: 3, seat: ob.owes, via: 'repeat' });
          changed = true;
        }
      }
    }
  }
  for (const n of nudges) {
    if (n.closed_at) continue;
    const handoff = n.kind === 'handoff' || (n.kind === 'reassign' && String(n.id || '').includes(':handoff:'));
    if (!handoff) continue;
    const base = String(n.id).replace(/:L3cos$/, '').replace(/:L3:\d+$/, '').replace(/:L2$/, '');
    if (!open.has(base)) { n.closed_at = new Date(now).toISOString(); changed = true; }
  }
  return changed;
}
// SILENT SEAT: no activity / prompt / beat line for > 2 h (merged fleet last_ct) while the seat owns live work (a live
// card where it is owner, next owner or retest owner, or an open nudge to it) -> fleet.seats[name].silent and
// one nudge on that seat per quiet stretch (keyed by the seat's last_ct; closes when the seat acts or owns nothing). Not a CoS wake.
const SILENT_MS = (Number(process.env.SILENT_S) || 7200) * 1000;
function evalSilent(fleet, now = Date.now()) {
  if (!fleet || !fleet.seats) return false;
  let changed = false; const silentIds = new Map();
  const presence = seatPresence();
  for (const [name, o] of Object.entries(fleet.seats)) {
    const id = seatIdOf(name); if (!id || !SEAT_IDS.includes(id)) continue;   // bot seats only (not Lead)
    const owns = bfCards.some(c => !c.pinned && c.state === 'live' && cardSeats(c).includes(id)) ||
      nudges.some(n => !n.closed_at && n.kind !== 'silent' && n.seat === id);
    const folded = presentSeat(fleet.seats, name, presence);
    let last = folded.last;
    if (last > tsOf(o.last_ct)) { o.last_ct = iso(last); o.via = 'presence'; o.active = now - last <= (fleet.window_min || WINDOW_MIN) * 60000; }
    if (folded.working && !o.working) { o.working = true; o.working_via = 'presence'; }
    if (folded.working) continue;
    if (owns && (!last || now - last > SILENT_MS)) { o.silent = true; o.silent_since = iso(last || null); silentIds.set(id, { name, last }); }
  }
  for (const n of nudges) if (n.kind === 'silent' && !n.closed_at) {
    const cur = silentIds.get(n.about);
    if (!cur || cur.last !== n.beat_t) { n.closed_at = new Date(now).toISOString(); changed = true; }
  }
  for (const [id, { name, last }] of silentIds) {
    const nid = `silent:${id}:${last}`;
    if (nudges.some(n => n.id === nid)) continue;
    nudges.push({ id: nid, kind: 'silent', t: now, t_ct: ctStamp(now), card: '', repo: '', number: 0,
      title: `${name} silent 2h while owning live work`, url: '', stage: '', level: 2, seat: id, via: 'silent seat', about: id, beat_t: last });
    changed = true;
  }
  if (changed) saveNudges();
  return changed;
}
function keepPush(beats, limit) {
  if (beats.length <= limit) return beats;
  const window = beats.slice(-limit);
  const latest = [...beats].reverse().find(b => b.what === 'pushed');
  if (!latest || window.some(b => b.id && b.id === latest.id)) return window;
  const next = [latest, ...window.slice(1)];
  next.sort((a, b) => a.t - b.t);
  return next;
}
function cardsView(list = bfCards) {   // cards with their nudges as distinct nudge beats
  applyStartAfter();
  const by = new Map(); for (const n of nudges) { if (!by.has(n.card)) by.set(n.card, []); by.get(n.card).push(n); }
  const missing = new Set(nudges.filter(n => n.kind === 'handoff' && !n.closed_at).map(n => n.card));
  return list.map(c => {
    const ns = (by.get(c.key) || []).filter(n => n.kind === 'handoff' || n.beat_t === c.last_beat_t);
    let card = c;
    if (ns.length) {
      const beats = keepPush([...(c.beats || []), ...ns.map(n => ({ t: n.t, what: n.kind === 'handoff' ? 'handoff missing' : `nudge L${n.level} → ${n.seat}`, nudge: true, level: n.level, seat: n.seat, id: n.id }))].sort((a, b) => a.t - b.t), 6);
      card = { ...c, beats, nudge: Math.max(...ns.map(n => n.level)), nudge_open: ns.some(n => !n.closed_at) };
    }
    if (!missing.has(c.key)) return card;
    const flags = Array.isArray(card.flags) ? card.flags.filter(f => f !== 'handoff missing') : [];
    flags.push('handoff missing');
    return { ...card, flags, handoff: 'missing' };
  });
}
const cardSeats = c => [seatIdOf(c.owner), seatIdOf((c.packet || {})['next owner']), seatIdOf(c.nudge_to)].filter(Boolean);
const boxStale = (now = Date.now()) => now - (SRCS.box.at || STARTED) > BOX_STALE_MS;
const tsOf = s => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : 0; };
const iso = t => (t ? new Date(t).toISOString() : null);
// Fleet = GitHub-derived (Railway) + box-derived seat state. "active" is recomputed against the server clock, so a
// silent box ages out on its own. Box-only working drops. That silence is not a board error.
function mergeFleet(g, b, stale, now) {
  if (!g && !b) return undefined;
  const win = ((g || b).window_min || WINDOW_MIN) * 60000;
  const names = [...new Set([...Object.keys(g?.seats || {}), ...Object.keys(b?.seats || {})])];
  const seats = {}, working = {};
  for (const s of names) {
    const gs = g?.seats?.[s], bs = b?.seats?.[s], gl = tsOf(gs?.last_ct), bl = tsOf(bs?.last_ct);
    const src = bl > gl ? bs : gs, last = Math.max(gl, bl);
    const o = { active: !!last && now - last <= win, last_ct: src?.last_ct ?? null, via: src?.via ?? null, working: false };
    let w = g?.working?.[s] || null;
    const bw = b?.working?.[s];
    if (!w && bw && !stale && !(bw.via === 'prompt' && gl > tsOf(bw.since_ct))) w = bw;   // a prompt is answered once the seat acts on GitHub
    if (w) { o.working = true; o.working_via = w.via; working[s] = w; }
    seats[s] = o;
  }
  const gc = g?.cloud || {}, bc = b?.cloud || {};
  const ghl = Math.max(tsOf(gc.github_last_ct), tsOf(bc.github_last_ct));
  const boxOpen = stale ? [] : (bc.open_agents || []);
  const open = [...new Set([...boxOpen, ...(gc.open_agents || [])])];
  const cloud = { active: open.length > 0, open_agents: open, github_last_ct: iso(ghl),
                  last_ct: iso(Math.max(tsOf(gc.last_ct), tsOf(bc.last_ct))) , working: !!gc.working || (!stale && !!bc.working) };
  if (cloud.working) working.CloudAgents = g?.working?.CloudAgents || b?.working?.CloudAgents || { via: 'cloud' };
  return { as_of: iso(now), window_min: win / 60000, seats, active: Object.values(seats).filter(v => v.active).length,
           total: Math.max(names.length, g?.total || 0, b?.total || 0), cloud, working, box_stale: false,
           missing_activity: [...new Set([...(b?.missing_activity || []), ...(g?.missing_activity || [])])].sort() };   // feed only
}
function mergedHeader(now = Date.now()) {
  const g = SRCS.github.header, b = SRCS.box.header, stale = boxStale(now);
  const h = { ...(b || {}), ...(g || {}) };
  if (!g && !b) Object.assign(h, headerOf(EMPTY_FEED));
  delete h.source; delete h.fleet;
  if (Array.isArray(h.product_nodes)) h.product_nodes = h.product_nodes.filter(n => n !== 'burst-live');
  if (Array.isArray(h.services)) h.services = h.services.filter(n => n !== 'burst-live');
  h.title = SITE.title;   // the server's site.json wins: a box pusher or an older collector still sends the template title
  h.generated_at = g?.generated_at || b?.generated_at || null;   // LIVE pill: the Railway collector once it runs
  h.event_count = evs.size;
  h.wakes = wakeBoard(now);   // last successful wake per seat; quiet past BIFROST_WAKE_QUIET_MINUTES
  h.wake_stats = publicStats(wakeState, now, wakeConfig(process.env).statMs);
  h.routing = ROUTING;   // startup route check (bifrost-init rules)
  h.clock = typeof clock === 'undefined' ? null : clock.run;   // timed run: deadlines per seat, cleared by a seat move
  h.kinds = [...new Set([...(g?.kinds || []), ...(b?.kinds || [])])].sort();
  h.notes = [...new Set([...(g?.notes || []), ...(b?.notes || [])])];
  h.sources = {
    github: g ? { generated_at: g.generated_at ?? null, received_at: iso(SRCS.github.at) } : null,
    box: b ? { generated_at: b.generated_at ?? null, received_at: iso(SRCS.box.at), stale } : null,
  };
  // board: the Railway collector's board. An empty box board never overrides real cards.
  const bd = g?.board || b?.board;
  if (bd) {
    try {
      setCards(bd);
      evalNudges(now);
      h.board = { ...bd, cards: cardsView(), source: 'server' };
    } catch (e) { console.log('cards: step failed ' + ((e && e.message) || 'error')); }
  }
  const fleet = mergeFleet(g?.fleet, b?.fleet, stale, now);
  if (fleet) { if (b && !stale) evalSilent(fleet, now); h.fleet = fleet; }   // only with a fresh box view (no restart flaps)
  const df = dotsFleet(h.fleet, now); if (df) h.fleet = df;
  const tf = foldSeatTouch(h.fleet, seatTouch, now); if (tf) h.fleet = tf;   // wake / read / ack activity
  const af = applyStoredActivity(h.fleet, now); if (af) h.fleet = af;   // open turns and tasks (activity.jsonl)
  h.track = trackView(now);   // Cursor agents, packets, wakes and blockers rebuilt from the volume
  h.cloud_agents = foldOpenCloudTurns(cloudAgentBoard(), now);   // first-class board rows: bcId, seat, card, state, last update
    if (h.board) {
    if (ownerName()) h.board.stats = { ...(h.board.stats || {}), ...ownerPromptStats(now) };
    h.board.cloud_agents = h.cloud_agents;
    if (Array.isArray(h.board.cards)) h.board.cards = stampCriticCloud(h.board.cards, h.cloud_agents);
  }
  const wf = applyTrackWorking(h.fleet, h.track, now); if (wf) h.fleet = wf;   // a woken packet, not a running cloud agent
  const gf = applyGithubWorking(h.fleet, now); if (gf) h.fleet = gf;   // GitHub actor on a PR or issue
  if (h.fleet) h.fleet = clearClosedWork(h.fleet);
  if (h.fleet) h.fleet = applyTurnRelease(h.fleet, now);   // an ended turn clears older marks; a fresh later mark stays. a cloud via is not a seat turn
  const cf = applyCloudOwners(h.fleet, h.cloud_agents, now); if (cf) h.fleet = cf;   // a running agent stays on its own id; the seat stays idle
  if (h.fleet) h.fleet = stampClockTree(h.fleet);
  if (h.fleet) h.fleet.seat_display = { ...SEAT_DISPLAY, ...jsonEnvObj('SEAT_DISPLAY_NAMES') };
  h.freshness = stampClockTree({
    github_latest_ct: githubDataAt ? new Date(githubDataAt).toISOString() : null,
    github_card_latest_ct: githubCardAt ? new Date(githubCardAt).toISOString() : null,
    cards_at: cardsAt ? new Date(cardsAt).toISOString() : null,
  });
  h.queue = openQueue();
  // Chips read this list. It is the seat config union, not the board subset and not a fixed strip.
  const roster = configuredRoster(process.env, [
    COLLECTOR_DIR_EARLY(),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed'),
  ]);
  if (roster.names.length) {
    h.roster = roster.names;
    h.roster_roles = roster.roles;
  }
  return h;
}
function closedCardKeys() {
  const keys = new Set();
  for (const c of bfCards) {
    if (!c || String(c.state || '').toLowerCase() !== 'closed') continue;
    keys.add(String(c.repo || '').toLowerCase() + '#' + Number(c.number));
  }
  return keys;
}
function trackView(now) {
  try { return deriveTrackFromDir(STATE_DIR, now, NUDGE_L1_MS, closedCardKeys()); }
  catch (e) { console.log('track: ' + ((e && e.message) || 'read failed')); return { items: [], overdue: [], lanes: [] }; }
}
function activityCloudRows() {
  try {
    if (Array.isArray(activity)) return activity;
  } catch { /* the activity tail is declared later; the file is the same log */ }
  return readJsonl(path.join(STATE_DIR, 'activity.jsonl'));
}
function arch1CloudLinks() {
  const links = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'arch1-launch.json'), 'utf8'));
    const cards = parsed && parsed.cards && typeof parsed.cards === 'object' ? parsed.cards : {};
    for (const [card, row] of Object.entries(cards)) {
      if (!row || typeof row.agentId !== 'string' || !row.agentId) continue;
      const state = row.status === 'finished' ? 'finished' : row.status === 'error' ? 'failed' : 'running';
      links.push({
        bcId: row.agentId,
        card,
        seat: ARCH1_CANON,
        state,
        updated_ct: Number(row.at) ? ctStamp(Number(row.at)) : '',
      });
    }
  } catch { /* no launch file */ }
  return links;
}
function foldOpenCloudTurns(rows, now) {
  const out = Array.isArray(rows) ? rows.slice() : [];
  for (const turn of openCloudTurns(activityCloudRows(), now)) {
    if (out.some(row => row && cloudIdsAlias(row.bcId, turn.bcId))) continue;
    out.push({ bcId: turn.bcId, seat: '', card: '', pr: '', state: 'running', updated_ct: turn.updated_ct });
  }
  return out;
}
function readTracks() {
  const files = [];
  const named = String(process.env.LIVE_TRACKS || '').trim();
  if (named) files.push(named);
  const house = String(process.env.LIVE_HOUSE || '').trim();
  if (house) files.push(path.join(house, 'fleet', 'TRACKS.md'));
  const houseFile = String(process.env.HOUSE || '').trim();
  if (houseFile) files.push(path.join(path.dirname(houseFile), 'fleet', 'TRACKS.md'));
  files.push(path.join(process.cwd(), 'house', 'fleet', 'TRACKS.md'));
  for (const file of files) {
    try {
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8');
    } catch { /* the next path */ }
  }
  return '';
}
function cloudAgentBoard() {
  try {
    return boardCloudAgents({
      agents: readJsonl(path.join(STATE_DIR, 'agents.jsonl')),
      activity: activityCloudRows(),
      links: arch1CloudLinks(),
      board: bfCards,
      events: githubEvents(),
      tracks: readTracks(),
    });
  } catch (e) { console.log('cloud agents: ' + ((e && e.message) || 'read failed')); return []; }
}
function applyTrackWorking(fleet, track, now) {
  const workingItems = (track && track.items || []).filter(item => item.working && item.seat_name && item.kind !== 'agent');
  if (!workingItems.length) return fleet;
  const f = fleet ? { ...fleet, seats: { ...(fleet.seats || {}) }, working: { ...(fleet.working || {}) } }
    : { as_of: iso(now), window_min: WINDOW_MIN, seats: {}, working: {}, active: 0, total: 0 };
  for (const item of workingItems) {
    const name = canonSeatToken(item.seat_name) || item.seat_name;   // fleet seats are keyed by seat id
    const via = item.kind === 'agent' ? 'cloud' : 'wake';
    if (!f.working[name]) f.working[name] = { via, since_ct: item.t_ct, on: item.title };
    const src = f.seats[name] || { active: true, last_ct: item.t_ct, via };
    const on = item.kind === 'packet' ? ('working on ' + item.title) : 'working';
    f.seats[name] = { ...src, working: true, working_via: src.working_via || via, working_on: on };
  }
  if (!fleet) f.total = Object.keys(f.seats).length;
  f.active = Object.values(f.seats).filter(v => v.active && !v.external).length;
  return f;
}
const PARKED_QUEUE = new Set(['herald', 'magnet', 'nibbler', 'sound']);
const OPEN_ASKS = new Set(['packet', 'dispatch', 'ready', 'critic_fail', 'needs_human', 'issue_comment', 'pr_comment', 'pr_open', 'issue_open', 'comment', 'pr', 'issue']);
function chicagoDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Parked seats stay in the inbox file and off the open queue. arch10x lines from a previous Chicago day do too.
function queueStale(line, now) {
  const blob = `${line && line.title || ''} ${line && line.id || ''}`;
  if (!/arch10x/i.test(blob)) return false;
  const t = Date.parse(line && line.t_ct || '');
  if (!Number.isFinite(t)) return true;
  return chicagoDay(t) < chicagoDay(now);
}
function openQueue(now = Date.now()) {
  const lines = [];
  for (const seat of SEAT_IDS) {
    for (const l of openLines(seat)) {
      if (!l || l.id == null || queueStale(l, now) || !OPEN_ASKS.has(String(l.type || ''))) continue;
      lines.push({
        id: String(l.id).slice(0, 120), seat,
        title: String(l.title || '').slice(0, 120),
        t_ct: typeof l.t_ct === 'string' ? l.t_ct : '',
        type: typeof l.type === 'string' ? l.type : '',
      });
    }
  }
  lines.sort((a, b) => (Date.parse(a.t_ct) || 0) - (Date.parse(b.t_ct) || 0));
  return lines.slice(0, 200);
}
// active windows and box staleness move with the clock: re-merge every 15 s, publish only on a real change
const fleetSig = h => JSON.stringify([h.fleet && { ...h.fleet, as_of: 0 }, h.sources?.box?.stale, nudges.length, nudges.filter(n => n.closed_at).length,
  (h.track?.items || []).map(i => i.id + ':' + i.label + ':' + i.lane + ':' + (i.overdue ? 1 : 0)),
  (h.cloud_agents || []).map(a => a.bcId + ':' + a.state + ':' + a.updated_ct + ':' + a.card)]);
function publishHeader(now = Date.now()) {   // re-merge after a wake or a webhook; publish only on a real change
  const h = mergedHeader(now);
  if (fleetSig(h) !== fleetSig(header)) { seq++; header = h; fullDirty = true; }
}
setInterval(() => {
  const h = mergedHeader();
  if (fleetSig(h) !== fleetSig(header)) { seq++; header = h; fullDirty = true; }
}, 15000).unref();
const GOV_MS = Math.max(200, (Number(process.env.BIFROST_TICK_S) > 0 ? Number(process.env.BIFROST_TICK_S) : 60) * 1000);
// Governor: one tick. Nudges first (evalNudges: cards, unacked lines, unrouted and quiet seats); then the tripwire: when no
// seat has moved anything (events, acks) for BIFROST_TRIPWIRE_MINUTES (default 30) and some seat has open work, the
// clock starts a timed run (the same run the CoS starts by hand with POST /clock). A seat's move clears it.
const TRIP_MS = (Number(process.env.BIFROST_TRIPWIRE_MINUTES) > 0 ? Number(process.env.BIFROST_TRIPWIRE_MINUTES) : 30) * 60000;
const PER_SEAT_MS = (Number(process.env.BIFROST_RUN_SEAT_MINUTES) > 0 ? Number(process.env.BIFROST_RUN_SEAT_MINUTES) : 2) * 60000;
const CLOCK_SEATS = (() => {   // who may start a run by hand: BIFROST_CLOCK_SEATS, else the coord (CoS) seat
  const env = String(process.env.BIFROST_CLOCK_SEATS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return env.length ? env : COORD_SEAT ? [COORD_SEAT] : [];
})();
function readClockState() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'clock.json'), 'utf8'));
    if (saved && typeof saved === 'object') return saved;
  } catch { /* first boot has no clock file */ }
  return null;
}
const clock = createClock({ tripMs: TRIP_MS, perSeatMs: PER_SEAT_MS, state: readClockState() });
const trip = tripwire();
let governorChanges = 0;
function loadMutedSeats() {
  const files = [
    process.env.BIFROST_ROSTER,
    path.join(COLLECTOR_DIR_EARLY(), 'fleet-roster.json'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed', 'fleet-roster.json'),
  ].filter(Boolean);
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && (Array.isArray(data.parked) || Array.isArray(data.dark))) return mutedSeats(data);
    } catch { /* try the next roster */ }
  }
  return mutedSeats({}, [...PARKED_QUEUE]);
}
function recentPromptSeats(now = Date.now()) {
  const out = new Set();
  if (!activityReady || !Array.isArray(activity)) return out;
  for (const line of activity) {
    if (!line || line.kind !== 'prompt' || (line.action !== 'sent' && line.action !== 'received')) continue;
    const t = Date.parse(line.t_ct);
    if (!Number.isFinite(t) || now - t > PROMPT_WORK_MS || t > now + 300000) continue;
    const seat = String(line.seat || '').toLowerCase();
    if (seat) out.add(seat);
  }
  return out;
}
function stallOpenSeats(now = Date.now()) {
  const counts = {};
  for (const seat of SEAT_IDS) counts[seat] = openLines(seat).length;
  return selectStallSeats(SEAT_IDS, loadMutedSeats(), counts, recentPromptSeats(now));
}
function wakeRun(run) {
  for (const [seat, by] of Object.entries(run.deadlines)) {
    const n = openLines(seat).length;
    const planning = run.reason === 'plan' || (run.planSeat && seat === run.planSeat);
    const reason = run.reason === 'empty' ? `board empty, pull next work by ${by}`
      : planning ? `plan next wave: nothing carded, card the ranked backlog by ${by}`
      : `timed run (${run.reason}): move your open work or post your blocker in one line by ${by}`;
    noteWake(seat, { id: `clock:${run.started_at}:${seat}`, type: 'timed_run', title: wakeTitle(run, seat, n), reason });
  }
  console.log(`clock: ${run.reason} run started, ${Object.keys(run.deadlines).length} seat(s), ends ${run.ends_at}`);
}
function moveFp() { return fingerprint([...evs.values()].map(v => v.e).filter(e => e && e.moves !== false), { acks: Object.values(inboxAcks).reduce((n, a) => n + (a ? a.length : 0), 0) }); }
function flushHeld() {
  const ready = batch.drain({ attention: attentionNow() });
  if (!ready.length) return false;
  postSeatLines({ lines: ready.map((out) => storeFlush(null, out)).filter(Boolean) }, null);
  return true;
}
function governorRun(now = Date.now()) {
  if (flushHeld()) { seq++; fullDirty = true; }
  if (evalNudges(now)) { seq++; fullDirty = true; }
  const scheduled = waveBoard(bfCards, now);
  if (scheduled.changed) {
    bfCards = scheduled.cards; cardsAt = now; boardSig = JSON.stringify(bfCards);
    bfWrite('cards.json', JSON.stringify({ updated_ct: new Date(now).toISOString(), cards: bfCards }));
    seq++; fullDirty = true;
  }
  const w = wakeBoard(now);
  const r = clock.observe(moveFp(), now, { openCards: liveWorkCount(bfCards), scheduled: scheduledCards(now), openSeats: stallOpenSeats(now), coord: COORD_SEAT, planDue: scheduled.planDue, burnQuiet: burnQuiet(weeklyBurnFraction()) });
  bfWrite('clock.json', JSON.stringify(clock.snapshot()));
  if (r === 'stall' || r === 'empty' || r === 'plan') wakeRun(clock.run);
  if (r === 'quiet') console.log('clock: weekly burn quiet, empty board not woken');
  if (r === 'cleared') console.log('clock: cleared by a seat move');
  const fp = fingerprint([...evs.values()].map(v => v.e), { nudges: nudges.filter(n => !n.closed_at).map(n => n.id), routing: ROUTING.ok,
    quiet: Object.keys(w).filter(k => w[k].quiet).sort(), clock: clock.run && clock.run.started_at });
  if (trip(fp)) { governorChanges++; seq++; header = mergedHeader(); fullDirty = true; }
}
// GitHub comments, reviews, PR open/push and issue events name an actor, not a seat. Map that login
// (inbox-roles.json, fleet-nodes.json / LIVE_NODE_MAP, LIVE_GH_SEATS, git:<seat> from SEAT_GIT_NAMES)
// and a cloud agent's bc- id (SEAT_AGENT_MAP, or the id in the branch or comment) onto the seat.
// The mark expires on the same clock as an open turn (TURN_OPEN_MS / LIVE_TURN_OPEN_MIN).
const GH_WORK_KINDS = new Set(['pr_comment', 'issue_comment', 'review_comment', 'pr_review', 'review', 'pr_open', 'pr_commit', 'pr_force_push', 'push']);
const SEAT_GIT_NAMES = ['blinky', 'critic', 'forge', 'arch1', 'herald', 'magnet', 'nibbler', 'sound'];
const BC_ID = /\b(bc-[a-z0-9]+(?:-[a-z0-9]+)*)\b/i;
const ghWork = new Map();   // seat -> { at, on, t_ct }
let loginToSeat = null;
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function addLogin(map, login, seat) {
  const l = String(login || '').trim().toLowerCase();
  const id = String(seat || '').trim().toLowerCase();
  if (!l || !SEAT_IDS.includes(id) || map.has(l)) return;
  map.set(l, id);
}
function buildLoginMap() {
  const map = new Map();
  const appDir = path.dirname(fileURLToPath(import.meta.url));
  const routeDir = process.env.BIFROST_ROUTING_DIR || path.join(appDir, 'collector', 'routing');
  for (const file of [path.join(routeDir, 'inbox-roles.json'), path.join(appDir, '..', 'feed', 'routing', 'inbox-roles.json')]) {
    const routing = readJson(file)?.routing;
    if (!routing || typeof routing !== 'object') continue;
    for (const [seat, entry] of Object.entries(routing)) if (entry && typeof entry.login === 'string') addLogin(map, entry.login, seat);
  }
  for (const file of [path.join(appDir, 'collector', 'fleet-nodes.json'), path.join(appDir, '..', 'feed', 'fleet-nodes.json')]) {
    const nodes = readJson(file);
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) continue;
    for (const [login, seat] of Object.entries(nodes)) addLogin(map, login, seat);
  }
  for (const [login, seat] of Object.entries(jsonEnvObj('LIVE_NODE_MAP'))) addLogin(map, login, seat);
  for (const row of GH_SEATS) addLogin(map, row.bot, row.seat);
  for (const name of SEAT_GIT_NAMES) addLogin(map, 'git:' + name, name);
  return map;
}
function loginMap() { if (!loginToSeat) loginToSeat = buildLoginMap(); return loginToSeat; }
function githubWorkKind(kind) {
  if (CLOSE_KINDS.has(kind)) return false;
  return GH_WORK_KINDS.has(kind) || kind.startsWith('issue_');
}
function workOnOf(e) {
  const repo = typeof e.repo === 'string' ? e.repo : '';
  const n = Number(e.number);
  if (repo && Number.isInteger(n) && n > 0) return (repo + '#' + n).slice(0, 160);
  const label = typeof e.label === 'string' ? e.label : typeof e.title === 'string' ? e.title : '';
  return label.slice(0, 160);
}
function seatOfGithub(e) {
  const map = loginMap();
  for (const key of ['actor', 'author', 'sender', 'user', 'merged_by', 'triggering_actor']) {
    const login = e[key];
    if (typeof login !== 'string' || !login) continue;
    const hit = map.get(login.toLowerCase());
    if (hit) return hit;
  }
  const blob = ['actor', 'label', 'branch', 'ref', 'head', 'head_ref', 'title', 'source'].map(k => typeof e[k] === 'string' ? e[k] : '').join(' ');
  const bc = BC_ID.exec(blob);
  if (!bc) return '';
  return seatForAgentId(bc[1], loadSeatAgentMap(process.env.SEAT_AGENT_MAP));
}
function noteGithubWork(e) {
  if (!e || typeof e.kind !== 'string' || !githubWorkKind(e.kind)) return;
  const seat = seatOfGithub(e);
  if (!seat) return;
  const t = Date.parse(e.t_ct || '');
  if (!Number.isFinite(t)) return;
  const prev = ghWork.get(seat);
  if (prev && prev.at > t) return;
  const on = workOnOf(e);
  if (!on) return;
  ghWork.set(seat, { at: t, on, t_ct: e.t_ct });
}
function applyGithubWorking(fleet, now) {
  if (!ghWork.size) return fleet;
  let touched = false;
  const f = fleet ? { ...fleet, seats: { ...(fleet.seats || {}) }, working: { ...(fleet.working || {}) } }
    : { as_of: iso(now), window_min: WINDOW_MIN, seats: {}, working: {}, active: 0, total: 0 };
  for (const [seat, w] of ghWork) {
    if (now - w.at > TURN_OPEN_MS || !SEAT_IDS.includes(seat)) continue;
    touched = true;
    const cur = f.working[seat];
    if (!cur) f.working[seat] = { via: 'github', since_ct: w.t_ct, working_on: w.on };
    else if (!cur.working_on) f.working[seat] = { ...cur, working_on: w.on };
    const src = f.seats[seat] || { active: true, last_ct: w.t_ct, via: 'github' };
    f.seats[seat] = { ...src, working: true, working_via: src.working_via || 'github', working_on: src.working_on || w.on };
  }
  if (!touched) return fleet;
  if (!fleet) f.total = Object.keys(f.seats).length;
  f.active = Object.values(f.seats).filter(v => v.active && !v.external).length;
  return f;
}
// #336: fleet.as_of and every *_ct on the fleet and freshness are America/Chicago, never a bare Z.
function ctStamp(t) {
  return clockStamp(t);
}
function stampClockTree(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stampClockTree);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'as_of' || k.endsWith('_ct') || k === 'cards_at') && (typeof v === 'string' || typeof v === 'number')) out[k] = v ? ctStamp(v) : v;
    else if (v && typeof v === 'object') out[k] = stampClockTree(v);
    else out[k] = v;
  }
  return out;
}
function workTarget(on) {
  const m = /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#([1-9]\d*)$/.exec(String(on || '').trim());
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}
function closedKeyNumber(k, n) {
  const i = String(k).lastIndexOf('#');
  return i >= 0 && Number(String(k).slice(i + 1)) === n;
}
function workOnClosed(on) {
  const text = String(on || '').trim();
  const key = workTarget(text);
  const bare = /#([1-9]\d*)$/.exec(text);
  const number = key ? key.number : bare ? Number(bare[1]) : 0;
  if (!number) return false;
  const repo = key ? key.repo.toLowerCase() : '';
  if (repo && itemClosed(repo, number)) return true;
  for (const [k, v] of closedItems()) {
    if (!v || !v.closed || !closedKeyNumber(k, number)) continue;
    if (!repo) return true;
    const kr = k.slice(0, k.lastIndexOf('#'));
    if (kr === repo || kr.endsWith('/' + repo) || repo.endsWith('/' + kr)) return true;
  }
  for (const c of bfCards) {
    if (!c || String(c.state || '').toLowerCase() !== 'closed' || Number(c.number) !== number) continue;
    if (!repo) return true;
    const cr = String(c.repo || '').toLowerCase();
    if (cr === repo || cr.endsWith('/' + repo) || repo.endsWith('/' + cr)) return true;
  }
  return false;
}
function clearClosedWork(fleet) {
  if (!fleet) return fleet;
  let changed = false;
  const seats = { ...(fleet.seats || {}) };
  const working = { ...(fleet.working || {}) };
  for (const [name, seat] of Object.entries(seats)) {
    if (!seat || !workOnClosed(seat.working_on)) continue;
    const next = { ...seat };
    delete next.working_on;
    seats[name] = next;
    changed = true;
  }
  for (const [name, row] of Object.entries(working)) {
    if (!row || !workOnClosed(row.working_on)) continue;
    const next = { ...row };
    delete next.working_on;
    working[name] = next;
    changed = true;
  }
  return changed ? { ...fleet, seats, working } : fleet;
}
setInterval(() => governorRun(), GOV_MS).unref();
header = mergedHeader();
function full() {   // built lazily: only the first full GET after a change pays for stringify + gzip
  refreshWorking();
  if (fullDirty) {
    feedBody = Buffer.from(JSON.stringify({ ...maskHeader(header), cursor: cursor(), events: [...evs.values()].map(v => mask(v.e)) }));
    feedGz = zlib.gzipSync(feedBody, { level: 6 }); feedEtag = `"${cursor()}"`; fullDirty = false;
  }
  return { body: feedBody, gz: feedGz, etag: feedEtag };
}
// Private repos (D18): on the login-page feed an event or header object of a private repo keeps only its id, times, kind and
// mesh hops (plus number / sha so replay can link packets); repo becomes 'private repo' and title / label / url / branch
// text are dropped. header.fleet and header.board are seat state, never masked (the live page needs seats' active).
const PUBLIC_KEEP = new Set(['id', 't_ct', 'kind', 'from', 'to', 'hops', 'src_file', 'seat', 'credit', 'state', 'status', 'number', 'sha', 'active']);
const HEADER_RAW = ['fleet', 'board'];
// fleet / board stay whole, but every string naming a private repo (repo field, full name, URL) is rewritten.
// One compiled pattern, rebuilt only when the private set grows (not per string per GET).
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let privRe = null, privReN = -1;
function privPattern() {
  if (privReN !== privateRepos.size) { privReN = privateRepos.size; privRe = privReN ? new RegExp([...privateRepos].sort((a, b) => b.length - a.length).map(reEsc).join('|'), 'gi') : null; }
  return privRe;
}
function scrub(v) {
  if (!privateRepos.size || v === null) return v;
  if (typeof v === 'string') return v.replace(privPattern(), 'private repo');
  if (Array.isArray(v)) return v.map(scrub);
  if (typeof v !== 'object') return v;
  const o = {}; for (const k of Object.keys(v)) o[k] = scrub(v[k]); return o;
}
// A header repo name is shown only when confirmed public (read OK and private:false); anything else is a placeholder.
// The header is never collapsed like a private event: every field is kept, repo / repos are mapped, the rest masked + scrubbed.
function maskHeader(h) {
  if (!privateRepos.size || !h || typeof h !== 'object') return h;
  const pub = new Set([...readable].map(x => x.toLowerCase()).filter(x => !privateRepos.has(x)));
  const publicRepo = r => typeof r === 'string' && pub.has(r.toLowerCase());
  const o = {};
  for (const k of Object.keys(h)) {
    if (HEADER_RAW.includes(k)) o[k] = scrub(h[k]);
    else if (k === 'repo') o[k] = publicRepo(h[k]) ? h[k] : 'private repo';
    else if (k === 'repos' && Array.isArray(h[k])) o[k] = h[k].map(r => publicRepo(r) ? r : 'private repo');
    else o[k] = scrub(mask(h[k]));
  }
  return o;
}
// Short names are for matching only (an event whose repo is a bare name); scrub never rewrites bare short names.
const privateShort = new Set();
function isPrivate(o) {
  if (!o || typeof o.repo !== 'string') return false;
  const r = o.repo.toLowerCase();
  return privateRepos.has(r) || (!r.includes('/') && privateShort.has(r));
}
function mask(v) {
  if (!privateRepos.size || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(mask);
  if (isPrivate(v)) { const o = { repo: 'private repo', label: 'private repo' }; for (const k of PUBLIC_KEEP) if (k in v) o[k] = v[k]; return o; }
  const o = {}; for (const k of Object.keys(v)) o[k] = mask(v[k]); return o;
}
function since(c, raw = false) {   // raw: unmasked (ingest-secret inbox routing only)
  const mk = raw ? x => x : mask;  // null -> client must refetch the full feed
  const m = /^([A-Za-z0-9_-]+)\.(\d+)$/.exec(String(c || ''));
  if (!m || m[1] !== EPOCH) return null;
  const s = Number(m[2]);
  if (s > seq || s < floorSeq) return null;
  if (s === seq) return 'same';
  const events = []; for (const v of evs.values()) if (v.s > s) events.push(mk(v.e));
  return { ...(raw ? header : maskHeader(header)), delta: true, cursor: cursor(), events, removed: removed.filter(r => r.s > s).map(r => r.id) };
}

// ---- GitHub collector (Railway): python child with ONLY the read-only token; writes a feed file on the volume ----
// GITHUB_READ_TOKEN = fine-grained, read-only (no Checks permission: suites/runs come from Actions instead). The child
// env is built from scratch: no ingest secret, session secret or mesh password, and the token is never logged.
const DATA_DIR = process.env.MESH_DATA_DIR || '/data';
const GH_FEED = path.join(DATA_DIR, 'feed', 'github-events.json');
const JIRA_FEED = path.join(DATA_DIR, 'feed', 'jira-events.json');
const jira = { pid: null, restarts: 0, lastWrite: 0, sig: '' };
const COLLECTOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'collector');
const COLLECTOR_REPOS = (process.env.COLLECTOR_REPOS || 'example-org/app example-org/mcp').split(/\s+/).filter(Boolean);
const collector = { pid: null, restarts: 0, lastExit: null, lastWrite: 0, sig: '', repos: COLLECTOR_REPOS, child: null };
// COLLECTOR_ORG=org (D18): watch every repo the token can see in that org, unioned with COLLECTOR_REPOS; re-listed every
// COLLECTOR_ORG_REFRESH_S (3600). A changed list restarts the collector child with the new repos. A failed listing keeps the last list.
async function orgRepos(org, tok) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos?per_page=100&type=all&page=${page}`,
      { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('org list ' + r.status);
    const rows = await r.json();
    for (const x of rows) if (x && typeof x.full_name === 'string' && !x.archived) out.push(x.full_name);
    if (rows.length < 100) break;
  }
  return out;
}
// Each repo is checked once with GET /repos/<full>: 403/404 is skipped (never handed to the collector); `private` is remembered
// so the session-login page and feed mask that repo (inboxes and /cards keep the real names).
async function readableRepos(list, tok) {
  const ok = [];
  for (const full of list) {
    if (!readable.has(full)) {
      const r = await fetch(`${GITHUB_API}/repos/${full}`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!r || !r.ok) { skipped.add(full); console.log(`collector: skip ${repoTag(full)} (${r ? r.status : 'error'})`); continue; }
      skipped.delete(full);
      const d = await r.json().catch(() => ({}));
      if (d.private !== false && !PUBLIC) {   // public mode: nothing is masked, so nothing is remembered as private
        privateRepos.add(full.toLowerCase()); privateShort.add(full.toLowerCase().split('/').pop()); seq++; floorSeq = seq; fullDirty = true; }
      readable.add(full);
    }
    ok.push(full);
  }
  return ok;
}
const readable = new Set(), privateRepos = new Set(), skipped = new Set();   // listed or pinned but unreadable (token scope)
// Logs never name a repo that is not confirmed public (private or unreadable): it shows as 'private repo #n' (n is stable
// for the process). Collector / route child output passes through redactRepos (full and short names).
const repoNo = new Map();
const hiddenRepo = full => !PUBLIC && (privateRepos.has(String(full).toLowerCase()) || [...skipped].some(x => x.toLowerCase() === String(full).toLowerCase()));
function repoTag(full) {
  if (!hiddenRepo(full)) return full;
  const k = String(full).toLowerCase(); if (!repoNo.has(k)) repoNo.set(k, repoNo.size + 1);
  return `private repo #${repoNo.get(k)}`;
}
function redactRepos(text) {
  let t = String(text);
  const hidden = [...new Set([...privateRepos, ...[...skipped].map(x => x.toLowerCase())])].sort((a, b) => b.length - a.length);
  for (const full of hidden) {
    const tag = repoTag(full), esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(esc(full), 'gi'), tag);
    const short = full.split('/').pop();
    if (short) t = t.replace(new RegExp(`(^|[^\\w./-])${esc(short)}(?![\\w-])`, 'gi'), (m, a) => a + tag);
  }
  return t;
}
async function collectorRepos(tok) {
  const org = (process.env.COLLECTOR_ORG || '').trim();
  if (!org) return COLLECTOR_REPOS;
  try { return (await readableRepos([...new Set([...COLLECTOR_REPOS, ...await orgRepos(org, tok)])], tok)).sort(); }
  catch (e) { console.log('collector: ' + redactRepos(String(e.message)).slice(0, 80) + '; keeping last repo list'); return collector.repos; }
}
async function refreshOrgRepos() {
  const next = await collectorRepos(process.env.GITHUB_READ_TOKEN || '');
  if (next.join(' ') === collector.repos.join(' ')) return;
  collector.repos = next;
  console.log(`collector: repos ${next.map(repoTag).join(' ')}`);
  if (collector.child) { collector.restarts = 0; collector.child.kill('SIGTERM'); }   // exit handler restarts with the new list
}
// fleetConfig (presence.mjs): committed fleet-roster.json / fleet-nodes.json shipped beside the collector.
const fleetConfig = (e, dir = COLLECTOR_DIR) => fleetConfigOf(e, dir);
function collectorScript() {
  const beside = path.join(COLLECTOR_DIR, 'live_mesh.py');
  if (fs.existsSync(beside)) return beside;
  const feed = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed', 'live_mesh.py');
  return fs.existsSync(feed) ? feed : '';
}
async function startCollector() {
  const tok = process.env.GITHUB_READ_TOKEN || '';
  if (!tok || process.env.COLLECTOR === 'off') { console.log('collector: off (no GITHUB_READ_TOKEN or COLLECTOR=off)'); return; }
  if (process.env.COLLECTOR_ORG && !collector.orgTimer) {
    collector.repos = await collectorRepos(tok);
    console.log(`collector: repos ${collector.repos.map(repoTag).join(' ')}`);
    collector.orgTimer = setInterval(() => refreshOrgRepos().catch(() => {}), Number(process.env.COLLECTOR_ORG_REFRESH_S || 3600) * 1000);
    collector.orgTimer.unref();
  }
  const script = collectorScript();
  if (!script) { console.log('collector: code missing; off'); return; }
  fs.mkdirSync(path.join(DATA_DIR, 'feed'), { recursive: true }); fs.mkdirSync(path.join(DATA_DIR, 'home'), { recursive: true });
  seedStore();
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: path.join(DATA_DIR, 'home'), LANG: 'C.UTF-8',
    TZ: 'America/Chicago', PYTHONDONTWRITEBYTECODE: '1', LIVE_MODE: 'github', LIVE_NO_CHECKS: '1', GH_TOKEN: tok,
    LIVE_MESH_SRC: path.join(COLLECTOR_DIR, 'upstream'),
    LIVE_HEALTH_URLS: (process.env.COLLECTOR_HEALTH_URLS || '').trim(),
    MESH_RUN: DATA_DIR,
    LIVE_ACTIVITY: path.join(STATE_DIR, 'activity.jsonl'),
    LIVE_RAILWAY_FILE: path.join(DATA_DIR, 'feed', 'railway-deploys.json') };
  const railTok = process.env.RAILWAY_TOKEN || '';
  if (railTok) env.RAILWAY_TOKEN = railTok;   // deploy poll. Never written into the image.
  if (process.env.RAILWAY_PROJECTS) env.RAILWAY_PROJECTS = process.env.RAILWAY_PROJECTS;
  if (process.env.RAILWAY_POLL_S) env.RAILWAY_POLL_S = process.env.RAILWAY_POLL_S;
  if (process.env.GITHUB_HOLD_LABEL) env.GITHUB_HOLD_LABEL = process.env.GITHUB_HOLD_LABEL;
  if (process.env.NO_NUDGE_REPOS != null) env.NO_NUDGE_REPOS = process.env.NO_NUDGE_REPOS;
  for (const k of ['UPSTREAM_REPO', 'UPSTREAM_PINNED', 'UPSTREAM_REPOS', 'XRAY_REPO', 'XRAY_OURS', 'SEAT_PRESENCE', 'LIVE_NODE_MAP', 'LIVE_BRAND', 'LIVE_BRAND_RE', 'LIVE_SHOW_UNMAPPED', 'LIVE_FLEET_SEATS', 'HUMAN_ALIASES']) if (process.env[k] != null) env[k] = process.env[k];
  Object.assign(env, fleetConfig(process.env));
  const healthArg = env.LIVE_HEALTH_URLS.split(/\s+/).filter(Boolean)[0] || '';
  const args = ['-B', '-u', script, '--out', GH_FEED, '--watch', process.env.COLLECTOR_WATCH_S || '45',
    '--repos', ...collector.repos, '--deploy-repo', '', '--health', healthArg];
  const child = spawn('python3', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  collector.pid = child.pid; collector.child = child; collector.startedAt = Date.now(); collector.loopAt = 0; collector.watchKilled = false;
  console.log(`collector: started pid ${child.pid}`);
  for (const st of [child.stdout, child.stderr]) {
    let buf = '';
    st.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { let line = buf.slice(0, i).replaceAll(tok, '[redacted]'); if (railTok) line = line.replaceAll(railTok, '[redacted]'); console.log('collector: ' + redactRepos(line).slice(0, 400)); buf = buf.slice(i + 1); } });
  }
  child.on('error', e => console.log('collector: spawn failed (' + e.code + ')'));
  child.on('exit', (code, sig) => {
    collector.pid = null; collector.child = null; collector.lastExit = code ?? sig; collector.restarts++;
    const wait = Math.min(300, 15 * 2 ** Math.min(collector.restarts - 1, 4)) * 1000;
    console.log(`collector: exited ${code ?? sig}; restart in ${wait / 1000}s`);
    if (!stopping) setTimeout(startCollector, wait).unref();
  });
  process.on('exit', () => { try { child.kill('SIGTERM'); } catch {} });
}
let stopping = false;
// One-time seed (deploy.sh MESH_SEED_STORE=1 ships collector/seed/): the box collector's store (GitHub metadata only,
// no bodies or secrets) so the Railway collector continues incrementally with full history instead of a cold backfill
// (a cold backfill cannot recover check suites/runs of other apps). Never overwrites an existing volume file.
function seedStore() {
  const src = path.join(COLLECTOR_DIR, 'seed');
  if (!fs.existsSync(src)) return;
  for (const rel of ['store/app.json', 'store/mcp.json', 'health-state.json']) {
    const from = path.join(src, rel), to = path.join(DATA_DIR, 'feed', rel);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to + '.seed'); fs.renameSync(to + '.seed', to);
    console.log('collector: seeded ' + rel);
  }
}
// Per-repo collect times (D18), summarized on /healthz as a count and two times.
const repoSeen = new Map();
function repoTimes(f) {
  const at = typeof f.generated_at === 'string' ? f.generated_at : new Date().toISOString();
  const newest = new Map();
  for (const e of f.events || []) {
    const r = String(e && e.repo || '').toLowerCase(), t = String(e && e.t_ct || '');
    if (r && t && Date.parse(t) > Date.parse(newest.get(r) || 0)) newest.set(r, t);
  }
  for (const full of collector.repos) {
    const k = full.toLowerCase(), t = newest.get(k) || newest.get(k.split('/').pop()) || repoSeen.get(full)?.newest_event || null;
    repoSeen.set(full, { last_collected: at, newest_event: t });
  }
}
const ageS = t => (t > 0 ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null);
function eventMovesCard(e) {
  if (!e || typeof e !== 'object') return false;
  const k = typeof e.kind === 'string' ? e.kind : '';
  if (/watcher|turn|subagent/.test(k)) return false;
  if (k === 'check_run' || k === 'check_suite' || k === 'workflow_run' || k === 'ci_pass' || k === 'ci_fail' || k === 'pr_commit') return false;
  if (k === 'pr_open' || k === 'issue_open' || k === 'pr_force_push' || k === 'pr_update' || k === 'merged') return true;
  if (k === 'pr_reopen' || k === 'issue_reopen') return true;
  if (k.startsWith('critic_')) return true;
  if (k.startsWith('lab_retest_')) return true;
  if (k.startsWith('prompt') && e.from === 'Lead') return true;
  if ((k === 'issue_labeled' || k === 'pr_labeled') && /block/i.test(String(e.detail || ''))) return true;
  if (k.includes('blocker')) return true;
  return false;
}
function openCardIndex() {
  const keys = new Set(), closed = new Set();
  for (const c of bfCards) {
    if (!c || typeof c !== 'object' || c.kind === 'source') continue;
    const isClosed = c.state === 'closed';
    let repo = typeof c.repo === 'string' ? c.repo.trim().toLowerCase() : '';
    let n = Number(c.number);
    if (!(repo && Number.isInteger(n) && n > 0) && typeof c.key === 'string') {
      const m = /^([^#]+)#([1-9]\d*)$/.exec(c.key.trim().toLowerCase());
      if (m) { repo = m[1]; n = Number(m[2]); }
    }
    if (!(repo && Number.isInteger(n) && n > 0)) continue;
    (isClosed ? closed : keys).add(repo + '#' + n);
  }
  return { keys, closed };
}
function eventOnOpenCard(e, open) {
  const repo = e && typeof e.repo === 'string' ? e.repo.trim().toLowerCase() : '';
  if (!repo) return false;
  const n = Number(e.number);
  return e.number != null && e.number !== '' && Number.isInteger(n) && n > 0 && open.keys.has(repo + '#' + n);
}
// A merge moves the card clock even after the card is closed. CI still does not.
function mergedMovesClock(e) {
  if (!e || e.kind !== 'merged') return false;
  const repo = typeof e.repo === 'string' ? e.repo.trim() : '';
  const n = Number(e.number);
  return !!repo && e.number != null && e.number !== '' && Number.isInteger(n) && n > 0;
}
function onCardClock(e, open) {
  return eventMovesCard(e) && (eventOnOpenCard(e, open) || mergedMovesClock(e));
}
function recomputeGithubDataAt() {
  const open = openCardIndex();
  let best = 0, card = 0;
  for (const e of SRCS.github.evs.values()) {
    const t = Date.parse(e && typeof e.t_ct === 'string' ? e.t_ct : '');
    if (!Number.isFinite(t) || t <= 0) continue;
    if (t > best) best = t;
    if (t > card && onCardClock(e, open)) card = t;
  }
  githubDataAt = best;
  githubCardAt = card;
}
function boardWord() {
  if (cardsAt === 0) return 'building';
  if (!bfCards.length) return 'empty';
  return 'live';
}
function wakeHealth() {   // seat -> ok | fail | no_key | idle (configured, nothing sent yet); never a url or key
  const out = {};
  for (const [seat, cfg] of Object.entries(SEAT_WEBHOOKS)) {
    const st = wakeQ.get(seat)?.status;
    out[seat] = st ? (st.ok ? 'ok' : st.error === 'no_key' ? 'no_key' : 'fail') : (process.env[cfg.keyEnv] || process.env[cfg.seatKeyEnv] ? 'idle' : 'no_key');
  }
  return out;
}
function collectorWatched() {
  if (process.env.COLLECTOR === 'off') return false;
  if (process.env.GITHUB_READ_TOKEN) return true;
  const limit = Number(process.env.COLLECTOR_STALE_S);
  return Number.isFinite(limit) && limit >= 0;
}
function collectorPassAt() {
  return collector.lastWrite || 0;
}
function feedQuiet(now = Date.now()) {
  if (!collectorWatched()) return false;
  const at = collectorPassAt();
  if (!at) return false;
  const limit = Number(process.env.COLLECTOR_STALE_S);
  const ms = (Number.isFinite(limit) && limit >= 0 ? limit : 180) * 1000;
  return now - at > ms;
}
function watchLimitMs() {
  const interval = (Number(process.env.COLLECTOR_WATCH_S) || 45) * 1000;
  const n = Number(process.env.COLLECTOR_WATCHDOG_N);
  const mult = Number.isFinite(n) && n > 0 ? n : 3;
  return interval * mult;
}
function stallTick() {
  // On-disk mtime from before this process is not a completed loop. Later of start and last loop.
  return Math.max(collector.startedAt || 0, collector.loopAt || 0);
}
function feedStalled(now = Date.now()) {
  if (process.env.COLLECTOR === 'off' || !process.env.GITHUB_READ_TOKEN) return false;
  if (!collector.child && !collector.watchKilled) return false;
  const tick = stallTick();
  if (!tick) return false;
  return now - tick > watchLimitMs();
}
function feedFileAgeMs(now = Date.now()) {
  try {
    const age = now - fs.statSync(GH_FEED).mtimeMs;
    return age > 0 ? age : 0;
  } catch {
    return 0;
  }
}
function feedHealthLine(why) {
  upsert({ id: 'health:feed-loop', t_ct: ctStamp(Date.now()), from: 'watchdog', to: 'GitHub', kind: 'health_fail',
    label: String(why).slice(0, 80), src_file: 'watchdog', direction: 'internal' });
  seq++; header = mergedHeader(); fullDirty = true;
  console.log('collector: ' + why);
}
function watchFeed() {
  if (!feedStalled() || collector.watchKilled || !collector.child) return;
  collector.watchKilled = true;
  const age = Math.round((Date.now() - stallTick()) / 1000);
  feedHealthLine(`feed loop stalled ${age}s; restarting`);
  try { collector.child.kill('SIGTERM'); } catch { /* exit handler restarts the loop */ }
}
const CARD_BEHIND_S = (() => {
  const n = Number(process.env.CARD_BEHIND_S);
  return Number.isFinite(n) && n >= 0 ? n : 180;
})();
// Same predicate as the card clock (open card or a merge). A pr_open the board has not carded yet still counts;
// a pr_open on a card that is already closed does not. CI and pr_commit never count.
function lagWorthy(e, open) {
  if (!eventMovesCard(e)) return false;
  if (e.kind === 'pr_open') {
    const repo = typeof e.repo === 'string' ? e.repo.trim().toLowerCase() : '';
    const key = repo + '#' + Number(e.number);
    return !(open.closed && open.closed.has(key)) && !(repo && itemClosed(repo, Number(e.number)));
  }
  return onCardClock(e, open);
}
function cardsBehindData(now) {
  const open = openCardIndex();
  let worthy = 0;
  for (const e of SRCS.github.evs.values()) {
    if (!lagWorthy(e, open)) continue;
    const t = Date.parse(e && typeof e.t_ct === 'string' ? e.t_ct : '');
    if (Number.isFinite(t) && t > worthy) worthy = t;
  }
  const boardLag = !!(cardsAt && worthy && (now - cardsAt) > (now - worthy) + CARD_BEHIND_S * 1000);
  // Card clock versus that same predicate. github_latest_ct still stores raw ingest.
  const cardClock = githubCardAt || 0;
  const clockLag = !!(worthy && cardClock && (worthy - cardClock) > CARD_BEHIND_S * 1000);
  return boardLag || clockLag;
}
function unreadableRepos() {
  const fromFeed = SRCS.github.header && SRCS.github.header.repos_unreadable;
  const names = new Set(skipped);
  if (Array.isArray(fromFeed)) for (const r of fromFeed) if (typeof r === 'string' && r) names.add(r);
  return [...names].map(repoTag).sort((a, b) => a.localeCompare(b));
}
function healthBody() {   // public: counts, times, ages (s) and wake states; no urls or keys. Unreadable repos are listed.
  const now = Date.now();
  const at = collector.repos.map(r => repoSeen.get(r)?.last_collected).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  const cardAge = ageS(cardsAt), dataAge = ageS(githubDataAt);
  const passAt = collectorPassAt();
  const warming = collectorWatched() && !passAt;
  const quiet = feedQuiet(now);
  const behind = !warming && cardsBehindData(now);
  const stalled = feedStalled(now);
  // feed_quiet (collector file mtime) and cards lagging open-card data are the gates.
  // data_age and box_age are reported and do not change ok.
  const ok = !quiet && !behind;
  const staleStatus = Number(SRCS.github.header && SRCS.github.header.stale_status) || 0;
  const unread = unreadableRepos();
  const body = { ok, mode: PUBLIC ? 'public' : 'gated', collector: collector.pid ? 'running' : 'stopped', repos: collector.repos.length, repos_unreadable: unread.length, unreadable_repos: unread,
    oldest_collected: at.length === collector.repos.length ? at[0] || null : null, newest_collected: at.at(-1) || null,
    feed_quiet: quiet, box_age: ageS(SRCS.box.at), box_informational: true, collector_age: ageS(passAt), card_age: cardAge, data_age: dataAge,
    card_stale_s: CARD_STALE_S, data_stale_s: DATA_STALE_S, board: boardWord(),
    cards_behind: behind, stale_status: staleStatus,
    last_tick: passAt ? new Date(passAt).toISOString() : null, stalled,
    origin: ORIGIN || null, wakes: wakeHealth(), wake_stats: publicStats(wakeState, now, wakeConfig(process.env).statMs), arch1_launch: arch1Launch.health(), nudged_lines: nudges.filter(n => n.kind === 'line' && !n.closed_at).length, routing: ROUTING.ok ? 'ok' : 'fail', governor_changes: governorChanges };
  if (warming) body.status = 'warming';
  return body;
}
function readCollectorFeed() {   // every 2 s: ingest the collector's file when it changed (atomic rename by the writer)
  let st; try { st = fs.statSync(GH_FEED); } catch { return; }
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (sig === collector.sig) return;
  let f; try { f = JSON.parse(fs.readFileSync(GH_FEED, 'utf8')); } catch { return; }   // mid-replace: next tick
  if (!validFeed(f)) { collector.sig = sig; console.log('collector: feed file invalid; ignored'); return; }
  collector.sig = sig; collector.lastWrite = st.mtimeMs;   // quiet file: age is the file's age, including across a redeploy
  if (collector.startedAt && st.mtimeMs >= collector.startedAt) collector.loopAt = st.mtimeMs;
  collector.watchKilled = false;
  if (evs.has('health:feed-loop')) { evs.delete('health:feed-loop'); fullDirty = true; }
  repoTimes(f);
  ingestSrc('github', f.events, headerOf(f));
  routeSoon();
}
// ---- Server inbox routing: after each collector pass, feed/inbox_pass.py (same rules as the box pusher:
// routing/inbox-roles.json) routes events not seen before into seat inboxes, then postSeatLines stores them and fires
// the SEAT_WEBHOOKS wake. State (seen / sent ids, spool) lives on the volume under $MESH_DATA_DIR/route, so an event is
// routed once across restarts; the very first pass seeds silently (history is never delivered). A line that was
// stored but not yet marked sent (crash in between) is re-posted and dropped by postSeatLines' per-seat id check.
// The python child gets no token or secret. SERVER_ROUTING=off turns this off.
const ROUTE_DIR = path.join(DATA_DIR, 'route');
const route = { busy: false, again: false, passes: 0, lines: 0, last: null };
const routeKids = new Set();
process.on('exit', () => { for (const k of routeKids) { try { k.kill('SIGTERM'); } catch { /* already gone */ } } });
function routeScript() {
  for (const f of [path.join(COLLECTOR_DIR, 'inbox_pass.py'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed', 'inbox_pass.py')])
    if (fs.existsSync(f)) return f;
  return '';
}
function routePy(script, args) {
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: path.join(DATA_DIR, 'home'), LANG: 'C.UTF-8',
    TZ: process.env.TZ || 'America/Chicago', MESH_RUN: ROUTE_DIR, FEED: GH_FEED, LIVE_INBOX: path.join(ROUTE_DIR, 'spool'),
    INBOX_STATE: path.join(ROUTE_DIR, 'inbox-state.json'), INBOX_CACHE: path.join(ROUTE_DIR, 'inbox-events.json'),
    LIVE_ACTIVITY: path.join(STATE_DIR, 'activity.jsonl'), LIVE_BOARD: 'off', PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of ['SEAT_BOTS', 'SEAT_WATCHERS']) if (process.env[k]) env[k] = process.env[k];   // routing config only, no secrets
  return new Promise(resolve => {
    let out = '', err = '';
    const c = spawn('python3', ['-B', script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    routeKids.add(c);
    const finish = (code, errText) => { routeKids.delete(c); resolve({ code, out: out.trim(), err: errText }); };
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('error', e => finish(-1, String(e.code)));
    c.on('close', code => finish(code, err.trim().split('\n').pop() || ''));
  });
}
async function routeOnce(script) {
  fs.mkdirSync(path.join(DATA_DIR, 'home'), { recursive: true }); fs.mkdirSync(ROUTE_DIR, { recursive: true });
  const p = await routePy(script, ['pass']);
  if (p.code !== 0) { console.log('route: pass failed (' + p.code + ') ' + redactRepos(p.err).slice(0, 120)); return; }
  const out = path.join(ROUTE_DIR, 'unsent.json');
  for (let round = 0; round < 50; round++) {   // unsent hands out 500 lines at a time
    const u = await routePy(script, ['unsent', out]);
    if (u.code !== 0) { console.log('route: unsent failed (' + u.code + ')'); return; }
    if (!(Number(u.out) > 0)) break;
    let parsed; try { parsed = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return; }
    const r = postSeatLines(parsed, null);   // stores, dedupes by id per seat, wakes; bad lines are logged and dropped
    if (r.status !== 200 && r.status !== 400) return;
    route.lines += r.added || 0;
    const s = await routePy(script, ['sent', out]);
    if (s.code !== 0) { console.log('route: sent failed (' + s.code + ')'); return; }
    if (Number(u.out) < 500) break;
  }
  route.passes++; route.last = new Date().toISOString();
  console.log(`route: pass ${p.out}`);
}
async function routePass() {
  if (route.busy) { route.again = true; return; }
  const script = routeScript();
  if (!script) { console.log('route: inbox_pass.py missing; off'); return; }
  route.busy = true;
  try { do { route.again = false; await routeOnce(script); } while (route.again); }
  catch (e) { console.log('route: ' + redactRepos(String(e.message)).slice(0, 80)); }
  finally { route.busy = false; }
}
function routeSoon() { if (process.env.SERVER_ROUTING !== 'off') routePass(); }
function jiraScript() {
  const beside = path.join(COLLECTOR_DIR, 'jira_source.py');
  if (fs.existsSync(beside)) return beside;
  const feed = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed', 'jira_source.py');
  return fs.existsSync(feed) ? feed : '';
}
function jiraAllowlist() {
  const raw = process.env.JIRA_PROJECTS;
  if (raw == null || !String(raw).trim()) return null;
  const skip = new Set(String(process.env.JIRA_EXCLUDE || '').split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean));
  const set = new Set();
  for (const part of String(raw).split(/[\s,]+/)) {
    const key = part.trim().toUpperCase();
    if (!key || skip.has(key) || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) continue;
    set.add(key);
  }
  return set;
}
function jiraOn() {
  const list = jiraAllowlist();
  return process.env.JIRA_SOURCE !== 'off' && !!process.env.JIRA_SITE && !!process.env.JIRA_EMAIL && !!process.env.JIRA_API_TOKEN && !!list && list.size > 0;
}
function jiraKeyProject(key) {
  const m = /^([A-Z][A-Z0-9]{1,9})-\d+$/.exec(String(key || '').toUpperCase());
  return m ? m[1] : '';
}
function jiraAllowed(e) {
  const fromKey = jiraKeyProject(e.key);
  if (!fromKey) return false;
  const skip = new Set(String(process.env.JIRA_EXCLUDE || '').split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean));
  if (skip.has(fromKey)) return false;
  if (e.project != null && String(e.project).toUpperCase() !== fromKey) return false;
  const list = jiraAllowlist();
  if (list && !list.has(fromKey)) return false;
  return true;
}
const WORK_KEYS = new Set(['id', 'source', 't', 'kind', 'key', 'title', 'url', 'state', 'status', 'project', 'actor']);
const WORK_KINDS = new Set(['opened', 'updated', 'closed', 'reopened']);
function validWork(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  for (const k of Object.keys(e)) if (!WORK_KEYS.has(k)) return null;
  if (typeof e.id !== 'string' || !/^[A-Za-z0-9:._#+/-]{1,200}$/.test(e.id)) return null;
  if (typeof e.source !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(e.source)) return null;
  if (typeof e.t !== 'string' || !Number.isFinite(Date.parse(e.t))) return null;
  if (!WORK_KINDS.has(e.kind)) return null;
  if (typeof e.key !== 'string' || e.key.length < 1 || e.key.length > 80 || e.key.includes('@')) return null;
  if (e.source === 'jira' && !jiraAllowed(e)) return null;
  const out = { id: e.id, source: e.source, t: e.t, kind: e.kind, key: e.source === 'jira' ? e.key.toUpperCase() : e.key };
  if (e.title != null) {
    if (typeof e.title !== 'string' || e.title.length > 200 || e.title.includes('@')) return null;
    out.title = e.title;
  }
  if (e.url != null) {
    if (typeof e.url !== 'string' || e.url.length > 300 || !/^https:\/\/\S+$/.test(e.url)) return null;
    out.url = e.url;
  }
  if (e.state != null) {
    if (e.state !== 'open' && e.state !== 'closed') return null;
    out.state = e.state;
  }
  if (e.status != null) {
    if (typeof e.status !== 'string' || e.status.length > 80 || e.status.includes('@')) return null;
    out.status = e.status;
  }
  if (e.source === 'jira') out.project = jiraKeyProject(e.key);
  else if (e.project != null) {
    if (typeof e.project !== 'string' || e.project.length > 80 || e.project.includes('@')) return null;
    out.project = e.project;
  }
  if (e.actor != null) {
    if (typeof e.actor !== 'string' || e.actor.length > 80 || e.actor.includes('@')) return null;
    out.actor = e.actor;
  }
  return out;
}
function loadFeedEvents() {
  try {
    const f = JSON.parse(fs.readFileSync(JIRA_FEED, 'utf8'));
    if (!f || !Array.isArray(f.events)) return [];
    return f.events.filter(e => e && typeof e === 'object' && typeof e.id === 'string');
  } catch { return []; }
}
function persistWork() {
  const disk = loadFeedEvents();
  const byId = new Map();
  for (const raw of disk) { const n = validWork(raw); if (n) byId.set(n.id, n); }
  for (const e of work.values()) byId.set(e.id, e);
  let events = [...byId.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (events.length > WORK_MAX) events = events.slice(events.length - WORK_MAX);
  work.clear();
  for (const e of events) work.set(e.id, e);
  const payload = JSON.stringify({ source: 'jira', generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), events });
  fs.mkdirSync(path.dirname(JIRA_FEED), { recursive: true });
  const tmp = `${JIRA_FEED}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, JIRA_FEED);
  try { const st = fs.statSync(JIRA_FEED); jira.sig = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch {}
}
function acceptWork(list) {
  let accepted = 0, rejected = 0, changed = false;
  for (const e of list || []) {
    const n = validWork(e);
    if (!n) { rejected++; continue; }
    const prev = work.get(n.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(n)) changed = true;
    work.set(n.id, n);
    accepted++;
  }
  if (work.size > WORK_MAX) {
    const drop = [...work.values()].sort((a, b) => (a.t < b.t ? -1 : 1)).slice(0, work.size - WORK_MAX);
    for (const e of drop) work.delete(e.id);
    changed = true;
  }
  if (changed) {
    try { persistWork(); } catch { console.log('source: save failed'); }
    publishBoard();
  }
  return { accepted, rejected };
}
function readJiraFeed() {
  let st; try { st = fs.statSync(JIRA_FEED); } catch { return; }
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (sig === jira.sig) return;
  let f; try { f = JSON.parse(fs.readFileSync(JIRA_FEED, 'utf8')); } catch { return; }
  if (!f || !Array.isArray(f.events)) { jira.sig = sig; console.log('jira: feed file invalid; ignored'); return; }
  jira.lastWrite = Date.now();
  const source = typeof f.source === 'string' ? f.source : '';
  const events = f.events.map(e => (e && typeof e === 'object' && e.source == null && source ? { ...e, source } : e));
  const before = jira.sig;
  const r = acceptWork(events);
  if (jira.sig === before) jira.sig = sig;
  if (r.accepted || r.rejected) console.log(`jira: file ${r.accepted} accepted, ${r.rejected} rejected`);
}
function startJira() {
  if (jira.pid) return;
  if (!jiraOn()) {
    const any = process.env.JIRA_SITE || process.env.JIRA_EMAIL || process.env.JIRA_API_TOKEN || String(process.env.JIRA_PROJECTS || '').trim();
    if (any && process.env.JIRA_SOURCE !== 'off') console.log('jira: off (set JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECTS)');
    return;
  }
  const script = jiraScript();
  if (!script) { console.log('jira: code missing; off'); return; }
  fs.mkdirSync(path.dirname(JIRA_FEED), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'home'), { recursive: true });
  const token = process.env.JIRA_API_TOKEN, email = process.env.JIRA_EMAIL;
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: path.join(DATA_DIR, 'home'), LANG: 'C.UTF-8',
    TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1', JIRA_SITE: process.env.JIRA_SITE, JIRA_PROJECTS: process.env.JIRA_PROJECTS || '',
    JIRA_EMAIL: email, JIRA_API_TOKEN: token,
  };
  if (process.env.JIRA_API_BASE) env.JIRA_API_BASE = process.env.JIRA_API_BASE;
  if (process.env.JIRA_EXCLUDE) env.JIRA_EXCLUDE = process.env.JIRA_EXCLUDE;
  if (process.env.JIRA_HOLD_STATUS) env.JIRA_HOLD_STATUS = process.env.JIRA_HOLD_STATUS;
  const redact = line => line.replaceAll(token, '[redacted]').replaceAll(email, '[redacted]').slice(0, 400);
  const child = spawn('python3', ['-B', '-u', script, 'pull', '--out', JIRA_FEED], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  jira.pid = child.pid;
  console.log(`jira: started pid ${child.pid}`);
  for (const st of [child.stdout, child.stderr]) {
    let buf = '';
    st.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { console.log('jira: ' + redact(buf.slice(0, i).replace(/^jira: /, ''))); buf = buf.slice(i + 1); } });
  }
  child.on('error', e => console.log('jira: spawn failed (' + e.code + ')'));
  child.on('exit', (code, sig) => {
    jira.pid = null; jira.restarts++;
    if (stopping || code === 0) return;
    const wait = Math.min(300, 15 * 2 ** Math.min(jira.restarts - 1, 4)) * 1000;
    console.log(`jira: exited ${code ?? sig}; restart in ${wait / 1000}s`);
    setTimeout(startJira, wait).unref();
  });
  process.on('exit', () => { try { child.kill('SIGTERM'); } catch {} });
}

const validEvent = e => e && typeof e === 'object' && !Array.isArray(e) &&
  typeof e.id === 'string' && typeof e.t_ct === 'string' && (e.kind == null || typeof e.kind === 'string');
function validDelta(d) {
  if (!d || typeof d !== 'object' || typeof d.base !== 'string') return false;
  if (!d.header || typeof d.header !== 'object' || Array.isArray(d.header) || 'events' in d.header) return false;
  if (d.header.generated_at != null && typeof d.header.generated_at !== 'string') return false;
  if (!Array.isArray(d.upsert) || !Array.isArray(d.remove) || d.upsert.length > 200000 || d.remove.length > 200000) return false;
  return d.remove.every(id => typeof id === 'string') && d.upsert.every(validEvent) && evs.size + d.upsert.length <= 400000;
}
function validFeed(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  if (!Array.isArray(f.events) || f.events.length > 200000) return false;
  if (f.generated_at != null && typeof f.generated_at !== 'string') return false;
  if (f.event_count != null && typeof f.event_count !== 'number') return false;
  return f.events.every(validEvent);
}

// ---- activity (write-only from off-box seats; the box pusher pulls it with the ingest secret) ----
// One JSON line: {t_ct, kind, action, to?, agent?, tag?}. The seat comes from the key, never from the body.
const ACT_KINDS = { prompt: ['received', 'sent'], turn: ['start', 'end', 'tick'], subagent: ['start', 'end', 'tick'],
  watcher: ['start', 'end', 'tick'], cloud_agent: ['launch', 'reply', 'finished', 'cancel'],
  agent: ['launch', 'reply', 'finish', 'cancel'] };
const ACT_FIELDS = new Set(['t_ct', 'kind', 'action', 'to', 'from', 'agent', 'tag', 'seat', 'room', 'pr', 'note']);   // seat: optional, must match the token; from: prompt sender (#281); room: optional short name; pr: optional https GitHub pull URL; note: prompt line only
const ACT_BANNED = /body|text|message/i;          // no free-text key, and no free text inside any value except note
const ACT_VALUE = /^[A-Za-z0-9 ._:@#+\/-]{1,80}$/;
const ACT_NOTE = /^[A-Za-z0-9 ._:@#+\/?',;!()\-]{1,240}$/;   // the one capped line a prompt may carry. Keys named body, text, or message stay refused.
const ACT_AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{2,40}$/;
const ACT_RATE = 60, ACT_RATE_MS = 60000, ACT_KEEP = 5000, ACT_MAX_BODY = 1024;
const ACT_EPOCH = crypto.randomBytes(6).toString('base64url');
const ACT_FILE = path.join(STATE_DIR, 'activity.jsonl');   // append-only on the volume. The memory window is the tail.
const activity = []; let actSeq = 0;
function loadActivity() {
  let rows = [];
  try {
    rows = fs.readFileSync(ACT_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  for (const line of rows.slice(-ACT_KEEP)) {
    if (!line || typeof line !== 'object') continue;
    activity.push(line);
    if (typeof line.seq === 'number' && line.seq > actSeq) actSeq = line.seq;
  }
}
function rememberActivity(line) {
  activity.push(line);
  if (activity.length > ACT_KEEP) activity.splice(0, activity.length - ACT_KEEP);
  try {
    fs.mkdirSync(path.dirname(ACT_FILE), { recursive: true });
    fs.appendFileSync(ACT_FILE, JSON.stringify(line) + '\n');
  } catch (e) { console.log('activity: append failed ' + ((e && e.code) || 'write')); }
}
// Server-recorded seat activity (hotfix): a delivered wake opens the seat's turn and an inbox ack closes it, so every
// seat shows working from wake until ack without needing its own GitHub App token. Same line shape as POST /activity.
// One t_ct form on the board: America/Chicago wall time with its offset (-05:00 / -06:00), never a bare Z.
function ctOffset(t) {
  const d = new Date(t); if (isNaN(d)) return t;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(p => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((wall - Math.floor(d / 1000) * 1000) / 60000), a = Math.abs(off);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off < 0 ? '-' : '+'}${String(a / 60 | 0).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// Seat activity becomes a live board event (seat to seat traffic), not just a fleet flag (hotfix: board was GitHub-only).
const OWNER_NAME = /^[A-Za-z0-9 ._:@#+\/-]{1,40}$/;
function ownerFromLine(text) {
  const line = String(text || '').split(/\r?\n/, 1)[0].trim();
  return OWNER_NAME.test(line) ? line : '';
}
function ownerName() {
  const env = ownerFromLine(process.env.LIVE_OWNER || '');
  if (env) return env;
  const named = String(process.env.LIVE_OWNER_FILE || '').trim();
  const ownerFile = named || path.join(process.cwd(), 'owner-name');
  try {
    if (fs.existsSync(ownerFile) && fs.statSync(ownerFile).isFile()) {
      const got = ownerFromLine(fs.readFileSync(ownerFile, 'utf8'));
      if (got) return got;
    }
  } catch { /* fall through to HOUSE.md */ }
  const raw = String(process.env.HOUSE || '').trim();
  let file = '';
  if (raw) {
    const p = path.resolve(raw);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) file = p; } catch { file = ''; }
  }
  if (!file) {
    const dir = process.env.LIVE_HOUSE || path.join(process.cwd(), 'house');
    const candidate = path.join(dir, 'HOUSE.md');
    if (fs.existsSync(candidate)) file = candidate;
  }
  if (!file) return '';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const section = /(?:^|\n)## Owner\n([\s\S]*?)(?:\n## |$)/.exec(text);
  const found = /^name:\s*(\S.*?)\s*$/m.exec(section ? section[1] : '');
  return found ? found[1].trim() : '';
}
function promptSender(line) {
  const raw = String(line.from || '').trim();
  const name = ownerName();
  if (name && (!raw || raw.toLowerCase() === 'owner' || raw.toLowerCase() === name.toLowerCase())) return name;   // --from owner is the generic alias
  return raw;
}
function ownerPromptStats(now = Date.now()) {
  const owner = ownerName().toLowerCase();
  const rows = [];
  if (owner) {
    for (const line of activity) {
      if (!line || line.kind !== 'prompt') continue;
      const fr = String(line.from || '').trim().toLowerCase();
      if (fr !== owner && fr !== 'owner' && fr !== '') continue;
      const t = Date.parse(line.t_ct || '');
      if (!Number.isFinite(t) || now - t > 86400000 || t > now + 300000) continue;
      rows.push(line);
    }
  }
  rows.sort((a, b) => Date.parse(a.t_ct || '') - Date.parse(b.t_ct || ''));
  let bytes = 0;
  for (const line of rows) bytes += archivedLineBytes('activity', line);
  return { owner_prompts_24h: rows.length, owner_prompts_24h_ids: rows.map(l => l.id), owner_prompts_24h_bytes: bytes };
}
function activityEvent(line, opts) {
  const prompt = line.kind === 'prompt';
  const from = prompt ? promptSender(line) : line.seat;
  const to = prompt ? (line.to || line.seat) : (line.to || (line.agent ? 'cloud' : 'Bifrost'));
  const note = prompt && typeof line.note === 'string' ? line.note : '';
  const extra = prompt ? '' : (line.tag ? ' · ' + line.tag : '');
  const label = prompt ? `${from} → ${to}${note ? ': ' + note : ''}` : `${line.seat} ${line.kind} ${line.action}${extra}`;
  const ev = { id: `act:${line.id}`, t_ct: ctOffset(line.t_ct), from, to, kind: `seat_${line.kind}`, direction: 'internal',
    label, src_file: 'activity', repo: null };
  if (note) ev.note = note;
  if (prompt && line.room) ev.room = line.room;
  if (opts && opts.moves === false) ev.moves = false;
  upsert(ev);
  // /history reads the events archive: every seat activity line (prompt, turn, ack, cloud) lands there as the
  // same seat_<kind> event the feed draws, so live history and the spectrum show it. Replay on boot skips it.
  if (!(opts && opts.replay)) appendArchive('events', ev);
}
function serverActivity(seat, kind, action, tag, opts) {
  if (!seat) return;
  actSeq++;
  const line = { id: `${ACT_EPOCH}.${actSeq}`, seq: actSeq, seat, t_ct: ctOffset(new Date().toISOString()), kind, action, tag, by: 'server' };
  rememberActivity(line); appendArchive('activity', line); activityEvent(line, opts);
  observeTurn(seat, kind, action);
  seq++; header = mergedHeader(); fullDirty = true;
}
loadActivity();
for (const l of activity.slice(-500)) if (Date.now() - Date.parse(l.t_ct || '') < 86400000) activityEvent(l, { replay: true });
loadPersistedWakes();
activityReady = true;
function loadPersistedWakes() {   // last wake per seat survives a restart (wakes.jsonl is append-only)
  const last = new Map();
  for (const row of readWakeRows(STATE_DIR)) if (row && row.seat) last.set(String(row.seat), row);
  for (const [seat, row] of last) {
    let st = wakeQ.get(seat);
    if (!st) { st = { lastSent: 0, pending: [], timer: null, inflight: false, status: null }; wakeQ.set(seat, st); }
    st.status = { ok: !!row.ok, attempts: Number(row.attempts) || 0, at: typeof row.t_ct === 'string' ? row.t_ct : new Date().toISOString() };
    if (row.error) st.status.error = String(row.error).slice(0, 40);
    const t = Date.parse(row.t_ct || '');
    if (Number.isFinite(t)) st.lastSent = t;
    if (row.ok && typeof row.t_ct === 'string' && !wakeOkAt[seat]) wakeOkAt[seat] = row.t_ct;
  }
  let skipRows = [];
  try {
    skipRows = fs.readFileSync(path.join(STATE_DIR, 'wake-skips.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no skip file yet */ }
  restoreWakeBook(wakeState, readWakeRows(STATE_DIR), skipRows, Date.now(), wakeConfig(process.env).statMs);
}
header = mergedHeader(); fullDirty = true;
function clearSeatWork(f, seat) {
  if (!f || !seat) return;
  if (f.working) delete f.working[seat];
  const row = f.seats && f.seats[seat];
  if (!row) return;
  const src = { ...row, working: false };
  delete src.working_via;
  delete src.working_on;
  f.seats[seat] = src;
}
function turnHeld(open, seat, now) {
  for (const [key, t] of open) {
    if (key.split(':')[0] !== seat) continue;
    const kind = key.split(':')[1];
    if (now - t <= (kind === 'turn' ? TURN_OPEN_MS : 60 * 60 * 1000)) return true;
  }
  return false;
}
function markTime(row) {
  return tsOf(row && (row.since_ct || row.t_ct));
}
// An end drops a mark at or before that end. A newer mark stays only while it is
// inside TURN_OPEN_MS. A cloud via stays through this pass. applyCloudOwners
// then drops every cloud via on a seat. The agent stays on its own id. A mark
// with no time stays.
// endAt 0 is an open turn past the window, not an end.
function spareTurnMark(row, endAt, now = Date.now()) {
  if (row && row.via === 'cloud') return true;
  if (row && row.via === 'prompt') { const at = markTime(row); return !!at && now - at <= PROMPT_WORK_MS; }
  if (!endAt || !row) return false;
  const at = markTime(row);
  if (!at) return true;
  if (!(at > endAt)) return false;
  return now - at <= TURN_OPEN_MS;
}
function spareEndedSeat(seat, row, endAt, now = Date.now()) {
  if (spareTurnMark(row, endAt, now)) return true;
  if (!endAt) return false;
  const gh = ghWork.get(seat);
  return !!(gh && gh.at > endAt && now - gh.at <= TURN_OPEN_MS);
}
function applyTurnRelease(fleet, now = Date.now()) {
  if (!fleet || !turnRelease.size) return fleet;
  const f = { ...fleet, seats: { ...(fleet.seats || {}) }, working: { ...(fleet.working || {}) } };
  for (const [seat, endAt] of turnRelease) {
    if (spareEndedSeat(seat, f.working[seat], endAt, now)) continue;
    clearSeatWork(f, seat);
  }
  return f;
}
function applyStoredActivity(fleet, now) {
  if (!activityReady || !activity.length) { turnRelease = new Map(); return fleet; }
  const f = fleet || { as_of: iso(now), window_min: WINDOW_MIN, seats: {}, working: {}, active: 0, total: 0 };
  const win = (f.window_min || WINDOW_MIN) * 60000;
  const open = new Map();
  const ended = new Map();
  const newest = new Map();
  const prompted = new Map();
  for (const line of activity) {
    if (!line || typeof line.seat !== 'string') continue;
    if (line.kind === 'turn' && cloudTurnId(line.tag)) continue;   // bc-… track is the agent, not the seat
    const seat = line.seat.toLowerCase();
    if (!SEAT_IDS.includes(seat)) continue;
    const t = Date.parse(line.t_ct);
    if (!Number.isFinite(t) || t > now + 300000) continue;
    newest.set(seat, Math.max(newest.get(seat) || 0, t));
    const ident = String(line.agent || (line.kind === 'turn' ? '-' : line.tag) || '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || '-';
    const key = seat + ':' + line.kind + ':' + ident;
    if (line.kind === 'prompt' && (line.action === 'sent' || line.action === 'received')) {
      if (now - t <= PROMPT_WORK_MS) prompted.set(seat, Math.max(prompted.get(seat) || 0, t));
    }
    if (line.kind === 'turn' || line.kind === 'subagent' || line.kind === 'watcher') {
      if (line.action === 'end') {
        if (t >= (open.get(key) || 0)) open.delete(key);
        if (line.kind === 'turn') ended.set(seat, Math.max(ended.get(seat) || 0, t));
      } else if (line.action === 'tick') {
        if (open.has(key)) open.set(key, Math.max(open.get(key), t));   // a tick does not reopen a turn an end already closed
      } else open.set(key, Math.max(open.get(key) || 0, t));
    }
  }
  f.seats = { ...(f.seats || {}) };
  f.working = { ...(f.working || {}) };
  for (const [seat, t] of newest) {
    const prev = tsOf(f.seats[seat]?.last_ct);
    const last = Math.max(prev, t);
    const src = f.seats[seat] || {};
    f.seats[seat] = { ...src, active: !!last && now - last <= win, last_ct: iso(last), via: t > prev ? 'activity' : (src.via ?? null), working: !!src.working };
  }
  const fresh = new Set();
  for (const [key, t] of open) {
    const kind = key.split(':')[1];
    if (now - t > (kind === 'turn' ? TURN_OPEN_MS : 60 * 60 * 1000)) continue;   // a missed ack can't pin a seat as working
    const seat = key.split(':')[0];
    fresh.add(seat);
    if (!f.working[seat]) f.working[seat] = { via: kind || 'activity', since_ct: iso(t) };
    const src = f.seats[seat] || { active: false, last_ct: iso(t), via: 'activity' };
    f.seats[seat] = { ...src, working: true, working_via: src.working_via || 'activity' };
  }
  // A via:turn mark with no open seat turn is a cloud-tagged turn filed under the seat.
  // The collector still counts that tag. It does not keep the chip, and it does not move to another seat.
  for (const seat of Object.keys(f.working)) {
    const row = f.working[seat];
    if (!row || row.via !== 'turn' || fresh.has(seat)) continue;
    delete f.working[seat];
    const src = f.seats[seat];
    if (!src || (src.working_via !== 'turn' && src.working_via !== 'activity')) continue;
    const next = { ...src, working: false };
    delete next.working_via;
    f.seats[seat] = next;
  }
  // An ended turn clears a mark at or before that end, including after TURN_OPEN_MS.
  // A newer mark stays only while it is fresh. A cloud via is cleared later, on the agent's own id.
  // GitHub re-applies after this and expires on the same clock.
  // An open turn older than the window clears the seat. A newer open subagent or watcher keeps it.
  const release = new Map();
  for (const [seat, t] of ended) {
    if (turnHeld(open, seat, now)) continue;
    release.set(seat, t);
  }
  for (const [key, t] of open) {
    if (key.split(':')[1] !== 'turn' || now - t <= TURN_OPEN_MS) continue;
    const seat = key.split(':')[0];
    if (fresh.has(seat) || turnHeld(open, seat, now)) continue;
    if (!release.has(seat)) release.set(seat, 0);
  }
  for (const [seat, endAt] of release) {
    if (spareTurnMark(f.working[seat], endAt, now)) continue;
    clearSeatWork(f, seat);
  }
  turnRelease = release;
  for (const seat of Object.keys(f.working)) {
    const row = f.working[seat];
    if (!row || row.via !== 'prompt') continue;
    const t = prompted.get(seat) || 0;
    if (t && now - t <= PROMPT_WORK_MS) continue;
    delete f.working[seat];
    if (f.seats[seat] && f.seats[seat].working_via === 'prompt') {
      const src = { ...f.seats[seat], working: false };
      delete src.working_via;
      f.seats[seat] = src;
    }
  }
  for (const [seat, t] of prompted) {
    if (now - t > PROMPT_WORK_MS) continue;
    f.working[seat] = { via: 'prompt', since_ct: iso(t) };
    const src = f.seats[seat] || { active: true, last_ct: iso(t), via: 'activity', working: false };
    f.seats[seat] = { ...src, working: true, working_via: 'prompt' };
  }
  const liveTurns = openCloudTurns(activity, now);
  const liveIds = liveTurns.map(row => row.bcId);
  const endedTurns = [];
  for (const line of activity) {
    if (!line || line.kind !== 'turn' || line.action !== 'end') continue;
    const id = cloudTurnId(line.tag);
    if (id) endedTurns.push(id);
  }
  const prevOpen = Array.isArray(f.cloud && f.cloud.open_agents) ? f.cloud.open_agents.map(String) : [];
  if (liveIds.length || endedTurns.length || prevOpen.length) {
    const aliases = (id, ids) => ids.some(other => cloudIdsAlias(id, other));
    const openIds = [...new Set([
      ...prevOpen.filter(id => !aliases(id, endedTurns) || aliases(id, liveIds)),
      ...liveIds,
    ])].filter(Boolean).sort();
    f.cloud = { ...(f.cloud || {}), active: openIds.length > 0, open_agents: openIds, working: openIds.length > 0 };
  }
  f.active = Object.values(f.seats).filter(v => v.active).length;
  return f;
}
function refreshWorking(now = Date.now()) {
  if (!header || !header.fleet) return;
  const before = JSON.stringify(header.fleet.working || {});
  let fleet = applyStoredActivity(header.fleet, now);
  if (fleet) fleet = clearClosedWork(fleet);
  const cleared = applyCloudOwners(fleet, header.cloud_agents || [], now);
  if (cleared) fleet = cleared;
  if (fleet) header.fleet = stampClockTree(fleet);
  if (JSON.stringify((header.fleet && header.fleet.working) || {}) !== before) { seq++; fullDirty = true; }
}
const actHits = new Map();   // seat -> [timestamps]
function runningCloudForHead(tag) {
  if (!/^[0-9a-f]{40}$/.test(String(tag || ''))) return '';
  let id = '';
  for (const line of activity) {
    if (!line || (line.kind !== 'cloud_agent' && line.kind !== 'agent')) continue;
    if (line.tag !== tag) continue;
    const agent = typeof line.agent === 'string' ? line.agent : '';
    if (!ACT_AGENT.test(agent)) continue;
    const action = String(line.action || '');
    if (action === 'launch' || action === 'reply') id = agent;
    else if ((action === 'finished' || action === 'finish' || action === 'cancel') && id === agent) id = '';
  }
  if (!id) return '';
  const row = cloudAgentBoard().find(item => item && cloudIdsAlias(item.bcId, id));
  if (!row || row.state !== 'running') return '';
  return row.bcId;
}
// A finished cloud line stays here. It is not copied onto the inbox as run_end.
function foldCloudHead(d) {
  if (!d || (d.kind !== 'cloud_agent' && d.kind !== 'agent') || !/^[0-9a-f]{40}$/.test(d.tag || '')) return { line: d, skip: false };
  const running = runningCloudForHead(d.tag);
  if (!running || running === d.agent) return { line: d, skip: false };
  if (d.action === 'launch') return { line: { ...d, agent: running, action: 'reply' }, skip: false };
  if (d.action === 'finished' || d.action === 'finish' || d.action === 'cancel') return { line: d, skip: true };
  return { line: d, skip: false };
}
function validActivity(d, now = Date.now()) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'not an object';
  for (const k of Object.keys(d)) {
    if (ACT_BANNED.test(k)) return 'free-text fields are not accepted';
    if (!ACT_FIELDS.has(k)) return 'unknown field';
  }
  for (const k of Object.keys(d)) {
    if (k === 'pr' || k === 'note') continue;
    const v = d[k];
    if (typeof v !== 'string' || !ACT_VALUE.test(v)) return 'fields must be short plain strings (<= 80 chars)';
    if (ACT_BANNED.test(v)) return 'free text is not accepted';
  }
  if (!ACT_KINDS[d.kind]) return 'bad kind';
  if (!ACT_KINDS[d.kind].includes(d.action)) return 'bad action for kind';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?([+-]\d\d:\d\d|Z)$/.test(d.t_ct || '')) return 'bad t_ct';
  const t = Date.parse(d.t_ct);
  if (isNaN(t) || t > now + 5 * 60000 || t < now - 24 * 3600000) return 't_ct out of range';
  if ((d.kind === 'cloud_agent' || d.kind === 'agent') && !ACT_AGENT.test(d.agent || '')) return 'agent id required';
  if (d.agent != null && !ACT_AGENT.test(d.agent)) return 'bad agent id';
  if (d.tag != null && d.tag.length > 40) return 'tag too long';
  if (d.room != null && (d.kind !== 'prompt' || d.room.length > 40)) return 'room is only for prompt (<= 40 chars)';
  if (d.to != null && d.to.length > 40) return 'to too long';
  if (d.from != null && (d.kind !== 'prompt' || d.from.length > 40)) return 'from is only for prompt (<= 40 chars)';
  if (d.note != null) {
    if (d.kind !== 'prompt') return 'note is only for prompt (<= 240 chars)';
    if (typeof d.note !== 'string' || !ACT_NOTE.test(d.note)) return 'note must be a short plain line (<= 240 chars)';
  }
  if (d.pr != null) {
    if (d.kind !== 'cloud_agent') return 'pr is only for a cloud agent';
    if (!safePrUrl(d.pr)) return 'bad pr';
  }
  return null;
}
function actRateOk(seat, now = Date.now()) {
  const arr = (actHits.get(seat) || []).filter(t => now - t < ACT_RATE_MS);
  if (arr.length >= ACT_RATE) { actHits.set(seat, arr); return false; }
  arr.push(now); actHits.set(seat, arr); return true;
}
const actFails = new Map();  // ip -> [timestamps] (bad activity keys)
function activitySeatOfKey(tok) {   // every seat but builder posts with its own SEAT_KEYS entry, only as itself
  const h = sha256hex(tok);
  for (const id of SEAT_IDS) {
    if (id === 'builder') continue;
    const want = SEAT_KEY_HASH[id];
    if (typeof want === 'string' && /^[0-9a-f]{64}$/.test(want) && safeEq(h, want)) return displaySeat(id) || id;
  }
  return '';
}
function activitySeatOk(claimed, stored) {
  const raw = String(claimed).trim();
  if (raw.toLowerCase() === stored.toLowerCase()) return true;
  const id = canonSeatToken(raw);
  return !!id && (displaySeat(id) || id).toLowerCase() === stored.toLowerCase();
}

// ---- crypto helpers ----
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // fixed-length digests => constant time
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update('mesh-session:' + v).digest('base64url');

function makeSession() { const exp = String(Date.now() + SESSION_TTL_MS); return exp + '.' + sign(exp); }
function validSession(req) {
  if (PUBLIC) return true;   // public mode: no login, the page and feed are open
  const m = /(?:^|;\s*)mesh_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  return safeEq(sig, sign(exp)) && Number(exp) > Date.now();
}

// ---- rate limit (failed logins per client IP) ----
const fails = new Map(); // ip -> [timestamps]
// Railway's edge overwrites X-Real-IP (and X-Forwarded-For) on every public request, so a
// client-sent copy never reaches us. Prefer X-Real-IP; else the RIGHTMOST XFF hop (the one the
// nearest proxy appended); else the socket peer. Never the leftmost (client-controllable) hop.
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (net.isIP(real)) return real;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const hops = xff.split(',').map(h => h.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last && net.isIP(last)) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}
function recentFails(ip) {
  const now = Date.now(), arr = (fails.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (arr.length) fails.set(ip, arr); else fails.delete(ip);
  return arr;
}
setInterval(() => { for (const ip of fails.keys()) recentFails(ip); }, 60000).unref();

// ---- responses ----
const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(req, res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, obj, extra) => send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);

function loginPage(msg = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${SITE.name} · live mesh</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f17;color:#dde3ee;font:15px system-ui,sans-serif}
form{background:#141b27;padding:28px 30px;border-radius:12px;min-width:260px;box-shadow:0 8px 30px #0006}
h1{font-size:17px;margin:0 0 18px;font-weight:600;letter-spacing:.02em}input{width:100%;box-sizing:border-box;padding:10px;border-radius:7px;border:1px solid #2c3850;background:#0b0f17;color:#dde3ee;font-size:15px}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:7px;background:#6e8cff;color:#fff;font-size:15px;cursor:pointer}.e{color:#ff8f8f;font-size:13px;margin:10px 0 0}</style></head>
<body><form method="post" action="/login"><h1>${SITE.name} · live mesh</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required aria-label="Password">
<button type="submit">Enter</button>${msg ? `<p class="e">${msg}</p>` : ''}</form></body></html>`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.resume(); return; }
    const chunks = []; let size = 0, done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(Object.assign(new Error('too large'), { code: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

const cookie = (val, maxAgeS) => `${COOKIE}=${val}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`;

// ---- routes ----
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (p === '/cursor/webhook' && m === 'POST') {
    let raw;
    try { raw = await readBody(req, 65536); }
    catch (e) { return json(req, res, e && e.code === 413 ? 413 : 400, { error: e && e.code === 413 ? 'too large' : 'bad request' }); }
    const result = arch1Launch.handleWebhook(raw, req.headers);
    if (result.status === 200) {   // signature already verified: note the agent's lifecycle for work tracking
      try {
        const noted = acceptCursorWebhook({ dir: STATE_DIR, raw, headers: req.headers, map: loadSeatAgentMap(process.env.SEAT_AGENT_MAP), now: Date.now() });
        if (noted.appended) publishHeader();
      } catch (e) { console.log('agent: append failed ' + ((e && e.code) || 'write')); }
    }
    return json(req, res, result.status, result.body);
  }
  if (p === '/healthz' && (m === 'GET' || m === 'HEAD')) {
    const body = healthBody();
    return send(req, res, body.ok ? 200 : 503, 'application/json; charset=utf-8', JSON.stringify(body));
  }
  if (p === '/archive' && m === 'GET') {
    const key = String(process.env.ARCHIVE_KEY || '');
    const tok = bearerOf(req);
    if (!key || !tok) return json(req, res, 401, { error: 'unauthorized' });
    if (!safeEq(tok, key)) return json(req, res, 401, { error: 'unauthorized' });
    const date = url.searchParams.get('date') || '';
    const kind = url.searchParams.get('kind') || '';
    if (!validArchiveDate(date) || !ARCHIVE_KINDS.includes(kind)) return json(req, res, 400, { error: 'bad date or kind' });
    return json(req, res, 200, { date, kind, lines: readArchive(date, kind).lines });
  }
  if ((p === '/history' || p === '/history/cards' || p === '/history/transitions' || p === '/history/export') && m === 'GET') {
    if (!validSession(req)) return json(req, res, 401, { error: 'unauthorized' });
    const q = {
      state: url.searchParams.get('state') || '',
      card: url.searchParams.get('card') || '',
      transition: url.searchParams.get('transition') || '',
      since: url.searchParams.get('since') || '',
      until: url.searchParams.get('until') || '',
      limit: url.searchParams.get('limit') || '',
      cursor: url.searchParams.get('cursor') || '',
    };
    if (p === '/history/export') {
      const date = url.searchParams.get('date') || '';
      if (!validArchiveDate(date)) return json(req, res, 400, { error: 'bad date' });
      return send(req, res, 200, 'application/x-ndjson; charset=utf-8', exportTransitions(date));
    }
    if (p === '/history/transitions') return json(req, res, 200, queryTransitions(q));
    if (p === '/history/cards') return json(req, res, 200, cardHistory(q));
    const date = url.searchParams.get('date') || '';
    if (!date) return json(req, res, 200, { days: archiveDays() });
    if (!validArchiveDate(date)) return json(req, res, 400, { error: 'bad date' });
    return json(req, res, 200, { date, events: readArchive(date, 'events').lines });
  }
  if (p === '/robots.txt' && (m === 'GET' || m === 'HEAD')) return send(req, res, 200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');

  if (p === '/ingest' || p === '/ingest/delta') {
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!tok || !safeEq(tok, INGEST_SECRET)) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    const enc = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
    if (enc !== 'identity' && enc !== 'gzip') { req.resume(); return json(req, res, 415, { error: 'unsupported content-encoding' }); }
    let body;
    try { body = await readBody(req, MAX_INGEST); } catch (e) { return json(req, res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'too large' : 'bad request' }); }
    if (enc === 'gzip') {
      // maxOutputLength bounds the decoded size (zip-bomb guard)
      try { body = zlib.gunzipSync(body, { maxOutputLength: MAX_INGEST }); }
      catch (e) { return json(req, res, e && e.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, { error: e && e.code === 'ERR_BUFFER_TOO_LARGE' ? 'too large' : 'bad gzip' }); }
    }
    let feed;
    try { feed = JSON.parse(body.toString('utf8')); } catch { return json(req, res, 400, { error: 'invalid json' }); }
    if (p === '/ingest/delta') {   // events changed since the pusher's last acknowledged push; base must be current
      if (!validDelta(feed)) return json(req, res, 422, { error: 'not a delta' });
      if (feed.base !== srcCursor('box')) return json(req, res, 409, { error: 'cursor mismatch', cursor: srcCursor('box') });
      ingestDelta(feed);
      return json(req, res, 200, { ok: true, cursor: srcCursor('box'), events: evs.size, upserts: feed.upsert.length, removes: feed.remove.length, fleet: fleetBrief() });
    }
    if (!validFeed(feed)) return json(req, res, 422, { error: 'not a feed' });
    ingestFull(feed);
    return json(req, res, 200, { ok: true, cursor: srcCursor('box'), events: evs.size, event_count: feed.event_count ?? null, fleet: fleetBrief() });
  }

  if (p === '/activity') {   // write-only; answers {ok} or an error, never any data
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    const ip = clientIp(req), now = Date.now();
    const bad = (actFails.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
    if (bad.length >= RL_MAX) { req.resume(); return json(req, res, 429, { error: 'too many bad keys' }, { 'Retry-After': String(RL_WINDOW_MS / 1000) }); }
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    let seat = null;
    if (tok.startsWith('ghs_')) {   // Builder installation token; every other seat uses its own SEAT_KEYS entry
      try { seat = await ghVerify(tok); } catch { req.resume(); return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    } else if (tok) seat = activitySeatOfKey(tok);
    if (!seat) { bad.push(now); actFails.set(ip, bad); req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let body;
    try { body = await readBody(req, ACT_MAX_BODY); } catch (e) { return json(req, res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'too large' : 'bad request' }); }
    const text = body.toString('utf8').replace(/\r?\n$/, '');
    if (text.includes('\n')) return json(req, res, 422, { error: 'one JSON line per request' });
    let d;
    try { d = JSON.parse(text); } catch { return json(req, res, 400, { error: 'invalid json' }); }
    const why = validActivity(d, now);
    if (why) return json(req, res, 422, { error: why });
    // optional seat (one line format everywhere): must name the token's own seat; the stored seat comes from the token
    if (d.seat != null && !activitySeatOk(d.seat, seat)) return json(req, res, 403, { error: 'seat mismatch' });
    if (!actRateOk(seat, now)) return json(req, res, 429, { error: 'rate limited (60/min)' }, { 'Retry-After': '60' });
    const folded = foldCloudHead(d);
    if (folded.skip) return json(req, res, 202, { ok: true });
    const src = folded.line;
    actSeq++;
    const line = { id: `${ACT_EPOCH}.${actSeq}`, seq: actSeq, seat, t_ct: src.t_ct, kind: src.kind, action: src.action };
    for (const k of ['to', 'from', 'agent', 'tag', 'room', 'note']) if (src[k] != null) line[k] = src[k];
    if (src.pr != null) line.pr = safePrUrl(src.pr);
    rememberActivity(line);
    appendArchive('activity', line);
    activityEvent(line);
    observeTurn(seat, d.kind, d.action);
    seq++; header = mergedHeader(); fullDirty = true;
    const receipt = { ok: true };
    if (d.kind === 'prompt') receipt.id = line.id;
    return json(req, res, 202, receipt);
  }

  if (p === '/activity/ingest') {   // box uploader (X-Live-Ingest = ingest secret): a JSONL batch of activity lines for any fleet seat
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    const hs = req.headers['x-live-ingest'];
    if (typeof hs !== 'string' || !hs || !safeEq(hs, INGEST_SECRET)) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let body;
    try { body = await readBody(req, 256 << 10); } catch (e) { return json(req, res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'too large' : 'bad request' }); }
    const now = Date.now(), rejected = []; let added = 0;
    body.toString('utf8').split('\n').forEach((raw, i) => {
      if (!raw.trim()) return;
      let d; try { d = JSON.parse(raw); } catch { rejected.push({ n: i + 1, error: 'invalid json' }); return; }
      const id = d && typeof d.seat === 'string' ? canonSeatToken(d.seat) : '';
      if (!id || !SEAT_IDS.includes(id)) { rejected.push({ n: i + 1, error: 'unknown seat' }); return; }
      const why = validActivity(d, now);
      if (why) { rejected.push({ n: i + 1, error: why }); return; }
      const seat = displaySeat(id) || id;
      if (!actRateOk(seat, now)) { rejected.push({ n: i + 1, error: 'rate limited' }); return; }
      const folded = foldCloudHead(d);
      if (folded.skip) return;
      const src = folded.line;
      actSeq++;
      const line = { id: `${ACT_EPOCH}.${actSeq}`, seq: actSeq, seat, t_ct: src.t_ct, kind: src.kind, action: src.action, via: 'ingest' };
      for (const k of ['to', 'from', 'agent', 'tag', 'room', 'note']) if (src[k] != null) line[k] = src[k];
      if (src.pr != null) line.pr = safePrUrl(src.pr);
      rememberActivity(line); appendArchive('activity', line); observeTurn(id, d.kind, d.action); added++;
    });
    if (added) { seq++; header = mergedHeader(); fullDirty = true; }
    return json(req, res, 200, { ok: true, added, rejected: rejected.slice(0, 50) });
  }

  if (p === '/emit') {   // write-only Assistant / emitter events from the sample MCP server; answers {ok} or an error, never data
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    const ip = clientIp(req), now = Date.now();
    const bad = (actFails.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
    if (bad.length >= RL_MAX) { req.resume(); return json(req, res, 429, { error: 'too many bad keys' }, { 'Retry-After': String(RL_WINDOW_MS / 1000) }); }
    const tok = bearerOf(req), want = SEAT_KEY_HASH.assistant;
    if (!tok || typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want) || !safeEq(sha256hex(tok), want)) { bad.push(now); actFails.set(ip, bad); req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let d; try { d = JSON.parse((await readBody(req, 1024)).toString('utf8')); } catch (e) { return json(req, res, e && e.code === 413 ? 413 : 400, { error: e && e.code === 413 ? 'too large' : 'invalid json' }); }
    const why = validDot(d, now); if (why) return json(req, res, 422, { error: why });
    emitter.last = now; emitter.recent.push({ tool: d.tool, t: d.t, ok: d.ok, client: d.client, latency_ms: d.latency_ms ?? null, kind: d.kind }); emitter.recent = emitter.recent.slice(-50);
    const h = mergedHeader(now); if (fleetSig(h) !== fleetSig(header)) { seq++; header = h; fullDirty = true; }
    return json(req, res, 202, { ok: true });
  }

  if (p === '/ingest/events') {   // the box pusher only (ingest secret): events changed since ?since=<cursor> (inbox routing)
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!tok || !safeEq(tok, INGEST_SECRET)) return json(req, res, 401, { error: 'unauthorized' });
    const d = since(url.searchParams.get('since'), true);
    if (d === 'same') return json(req, res, 200, { cursor: cursor(), events: [] });
    if (d) return json(req, res, 200, { cursor: d.cursor, events: d.events });
    const all = [...evs.values()].map(v => v.e).filter(e => e.kind === 'pr_open' || e.kind === 'issue_open' || Date.now() - Date.parse(e.t_ct || '') < 3 * 86400000);   // card events always
    return json(req, res, 200, { cursor: cursor(), reset: true, events: all });
  }

  if (p === '/inbox' && m === 'POST') {   // ingest secret posts lines. A seat key posts a small batch of its own handoff packets.
    const hs = req.headers['x-live-ingest'];
    let sender = null;
    if (typeof hs === 'string' && hs && safeEq(hs, INGEST_SECRET)) sender = 'ingest';
    else { try { sender = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); } }
    if (!sender) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let parsed; try { parsed = JSON.parse((await readBody(req, 4 << 20)).toString('utf8')); } catch { return json(req, res, 400, { error: 'not json' }); }
    if (sender !== 'ingest') {
      const lines = parsed && Array.isArray(parsed.lines) ? parsed.lines : [];
      const handoffId = /^handoff:([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9]\d{0,6}):(ready|critic_fail|live_pass|merge|ci_fail):([0-9a-f]{7,64})$/;
      const ownHandoff = (line) => {
        if (!line || typeof line !== 'object' || Array.isArray(line)) return false;
        if (canonSeat(line.from) !== sender || line.type !== 'packet') return false;
        const id = typeof line.id === 'string' ? line.id : '';
        const hit = handoffId.exec(id);
        if (!hit || hit[3] !== line.kind) return false;
        if (hit[1] !== String(line.repo || '').toLowerCase() || Number(hit[2]) !== Number(line.number)) return false;
        const idSha = hit[4] || '';
        const lineSha = typeof line.sha === 'string' ? line.sha.trim().toLowerCase() : '';
        return idSha === lineSha;
      };
      if (parsed && parsed.replace === true) return json(req, res, 403, { error: 'not your handoff' });
      if (!lines.length || lines.length > 8 || lines.some(line => !ownHandoff(line))) return json(req, res, 403, { error: 'not your handoff' });
    }
    const r = postSeatLines(parsed, null);
    if (r.status === 200) { seq++; header = mergedHeader(); fullDirty = true; }
    return json(req, res, r.status, r.status === 200 ? { ok: true, added: r.added, rejected: r.rejected } : { error: r.error, ...(r.rejected ? { rejected: r.rejected } : {}) });
  }
  if (p === '/ingest/source') {
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    const hs = req.headers['x-live-ingest'];
    if (typeof hs !== 'string' || !hs || !safeEq(hs, INGEST_SECRET)) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let parsed;
    try { parsed = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); }
    catch (e) { return json(req, res, e && e.code === 413 ? 413 : 400, { error: e && e.code === 413 ? 'too large' : 'not json' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.events) || parsed.events.length > 500) {
      return json(req, res, 422, { error: 'events must be a list of at most 500' });
    }
    const source = typeof parsed.source === 'string' ? parsed.source : '';
    const events = parsed.events.map(e => (e && typeof e === 'object' && e.source == null && source ? { ...e, source } : e));
    const r = acceptWork(events);
    return json(req, res, 200, { ok: true, accepted: r.accepted, rejected: r.rejected });
  }
  const inboxM = /^\/inbox\/([a-z0-9-]{2,16})$/.exec(p);
  if (inboxM && m === 'GET') {   // a seat reads its own inbox: GET /inbox/<seat>?since=<id>
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    if (!who) return json(req, res, 401, { error: 'unauthorized' });
    if (!SEAT_IDS.includes(inboxM[1]) || who !== inboxM[1]) return json(req, res, 403, { error: 'inbox is not exposed' });
    const since = url.searchParams.get('since'), all = url.searchParams.get('all') === '1', stale = url.searchParams.get('stale') === '1';
    const base = since && seatInbox[who].some(l => l.id === since) ? linesAfter(seatInbox[who], since) : seatInbox[who];
    const keep = new Set(seatOpenRows(who, stale ? false : all).map(l => l.id)); touchSeat(who);
    const lines = base.filter(l => keep.has(l.id) && (!stale || settledLine(l)));
    return json(req, res, 200, { seat: who, lines: lines.slice(0, 1000) });
  }
  if (p === '/clock') {   // POST /clock: the CoS starts the same timed run the tripwire starts (BIFROST_CLOCK_SEATS keys only)
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    req.resume();
    if (!who) return json(req, res, 401, { error: 'unauthorized' });
    if (!CLOCK_SEATS.includes(who)) return json(req, res, 403, { error: 'not a clock seat' });
    const seats = stallOpenSeats();
    if (!seats.length) return json(req, res, 200, { ok: true, started: false, reason: 'no open work' });
    const run = clock.startByHand(Date.now(), seats, who); wakeRun(run); touchSeat(who);
    seq++; header = mergedHeader(); fullDirty = true;
    return json(req, res, 200, { ok: true, started: true, clock: run });
  }
  const ackM = /^\/inbox\/([a-z0-9-]{2,16})\/ack$/.exec(p);
  if (ackM) {   // POST /inbox/<seat>/ack {"id"} | {"upto"} | {"stale": true} | {"all": true}: that seat's key only. stale acks up to 1000 open lines with a close or merge event, or a closed or done card. The same cap is on GET ?stale=1.
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    if (!who) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    if (!SEAT_IDS.includes(ackM[1]) || who !== ackM[1]) { req.resume(); return json(req, res, 403, { error: 'not your inbox' }); }
    let d; try { d = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch { return json(req, res, 400, { error: 'invalid json' }); }
    const what = d && d.all === true ? 'all' : d && d.stale === true ? 'stale' : d && typeof d.id === 'string' && d.id.length <= 300 ? d.id : d && typeof d.upto === 'string' && d.upto.length <= 300 ? { upto: d.upto } : null;
    if (!what) return json(req, res, 400, { error: 'id, upto, stale, or all required' });
    const review = d && typeof d.review === 'string' && d.review.length <= 300 ? d.review : '';
    const n = ackLines(who, what, review); touchSeat(who);
    if (n === -2) return json(req, res, 400, { error: 'merge handoff needs a review url' });
    if (n < 0) return json(req, res, 404, { error: 'no such line' });
    if (n) serverActivity(who, 'turn', 'end', 'ack');
    if (n > 0) publishHeader();   // work tracking moves the packet to acked
    return json(req, res, 200, { ok: true, acked: n, open: seatOpenRows(who, false).length });
  }
  if (p === '/routing') {   // GET /routing: the routing map, read-only (seat, login, aliases, status). No keys, no webhook URLs.
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    let who = null; try { who = await seatOf(req); } catch { /* fall through to session / public */ }
    if (!who && !PUBLIC && !validSession(req)) return json(req, res, 401, { error: 'unauthorized' });
    return json(req, res, 200, { ok: ROUTING.ok, seats: ROUTING_MAP.map(e => ({ seat: e.seat, login: e.login, aliases: e.aliases, status: e.status })) });
  }
  if (p === '/cards/start-after') {   // POST {repo, number, start_after}: owner or a fleet seat, inside 30 days. Wins over the collector field while stored.
    if (m !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    if (!who) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let d; try { d = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch { return json(req, res, 400, { error: 'invalid json' }); }
    const repo = d && typeof d.repo === 'string' ? d.repo : '';
    const number = d && d.number;
    const when = parseStartAfter(d && d.start_after);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(number) || number < 1 || number > 9999999 || !when) {
      return json(req, res, 400, { error: 'repo, number, and start_after (ISO with offset) required' });
    }
    if (!startWithinCap(when)) return json(req, res, 400, { error: 'start_after is more than 30 days out' });
    const key = repo.toLowerCase() + '#' + number;
    const held = bfCards.find(c => c && (startKeyOf(c) === key || (String(c.repo || '').toLowerCase() === repo.toLowerCase() && Number(c.number) === number)));
    if (!maySetStartAfter(who, held)) return json(req, res, 403, { error: 'start_after is owner or fleet only' });
    const stamped = writeStartAfter(when.iso);
    if (!stamped) return json(req, res, 400, { error: 'repo, number, and start_after (ISO with offset) required' });
    startAfter.overrides[key] = { start_after: stamped, by: who, set_at: new Date().toISOString() };
    saveStartAfter();
    const now = Date.now();
    applyStartAfter(now);
    evalNudges(now);
    seq++; header = mergedHeader(); fullDirty = true;
    return json(req, res, 200, { ok: true, repo, number, start_after: stamped });
  }
  if (p === '/cards/seed' && m === 'POST') {   // ingest secret only. Loads a fleet wave seed. Does not run unless called.
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!tok || !safeEq(tok, INGEST_SECRET)) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
    let d; try { d = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); } catch { return json(req, res, 400, { error: 'invalid json' }); }
    if (!d || !Array.isArray(d.waves)) return json(req, res, 400, { error: 'waves array required' });
    const now = Date.now();
    WAVE_SEED = d;
    seedHold = postedCards(d, { now, coord: COORD_SEAT || COS });
    bfWrite('wave-seed.json', JSON.stringify({ updated_ct: new Date(now).toISOString(), cards: seedHold }));
    publishBoard(new Date(now).toISOString());
    seq++; header = mergedHeader(); fullDirty = true;
    return json(req, res, 200, { ok: true, cards: seedHold.length });
  }
  if (p === '/cards') {   // GET /cards?seat=<seat>: that seat's key (routing coord and operator may read any seat); ?seat=all (or those seats) sees all.
    // Public mode: no key needed, any ?seat= (default all cards); a key that is sent still limits to its own seat.
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    if (!who && !PUBLIC) return json(req, res, 401, { error: 'unauthorized' });   // public mode: cards are readable without a key
    const want = String(url.searchParams.get('seat') || who || 'all').toLowerCase();
    if (who && want !== who && who !== cosSeat() && who !== operatorSeat()) return json(req, res, 403, { error: 'not your seat' });
    const all = want === 'all' || want === 'coord' || want === cosSeat() || want === operatorSeat();
    const cs = CARD_SEAT[want] || want;
    return json(req, res, 200, { seat: want, cards: stampCriticCloud(cardsView(bfCards.filter(c => all || cardSeats(c).includes(cs))), cloudAgentBoard()) });
  }
  if (p === '/wake-stats') {
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    if (!who && !PUBLIC) return json(req, res, 401, { error: 'unauthorized' });
    const want = String(url.searchParams.get('seat') || who || 'all').toLowerCase();
    if (who && want !== who && who !== cosSeat() && who !== operatorSeat()) return json(req, res, 403, { error: 'not your seat' });
    const body = fullStats(wakeState, Date.now(), wakeConfig(process.env).statMs);
    const all = !who || want === 'all' || want === 'coord' || want === cosSeat() || want === operatorSeat();
    if (!all) {
      const row = body.seats[want] || { sent: 0, skipped: 0, reasons: {}, skips: [], queued: 0 };
      body.seats = { [want]: row };
    }
    return json(req, res, 200, body);
  }
  if (p === '/nudges') {   // GET /nudges?since=<id>: the routing operator seat's key only (that seat delivers them)
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    let who; try { who = await seatOf(req); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); }
    if (!who) return json(req, res, 401, { error: 'unauthorized' });
    if (who !== operatorSeat()) return json(req, res, 403, { error: 'operator only' });
    evalNudges();
    return json(req, res, 200, { nudges: stampClockTree(linesAfter(nudges, url.searchParams.get('since')).slice(0, 500)) });
  }

  if (p === '/inbox/builder') {   // POST: box mirror (X-Live-Ingest = ingest secret); GET: Builder's installation token only
    if (m === 'POST') {
      const hs = req.headers['x-live-ingest'];
      if (typeof hs !== 'string' || !hs || !safeEq(hs, INGEST_SECRET)) { req.resume(); return json(req, res, 401, { error: 'unauthorized' }); }
      let parsed; try { parsed = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch { return json(req, res, 400, { error: 'not json' }); }
      const r = postSeatLines(parsed, 'builder');
      return json(req, res, r.status, r.status === 200 ? { ok: true, added: r.added, rejected: r.rejected } : { error: r.error, ...(r.rejected ? { rejected: r.rejected } : {}) });
    }
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    let seat = null;
    if (tok.startsWith('ghs_')) { try { seat = await ghVerify(tok); } catch { return json(req, res, 503, { error: 'could not verify token, retry' }, { 'Retry-After': '30' }); } }
    if (!seat) return json(req, res, 401, { error: 'unauthorized' });
    if (String(seat).toLowerCase() !== 'builder') return json(req, res, 403, { error: 'inbox is not exposed' });
    return json(req, res, 200, { lines: linesAfter(seatInbox.builder, url.searchParams.get('since')) });
  }

  if (p === '/activity/pull') {   // the box pusher only (ingest secret): lines after ?after=<seq> of this epoch
    if (m !== 'GET') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!tok || !safeEq(tok, INGEST_SECRET)) return json(req, res, 401, { error: 'unauthorized' });
    const after = /^\d{1,12}$/.test(url.searchParams.get('after') || '') && url.searchParams.get('epoch') === ACT_EPOCH ? Number(url.searchParams.get('after')) : 0;
    const lines = activity.filter(l => l.seq > after).slice(0, 1000);
    return json(req, res, 200, { epoch: ACT_EPOCH, last: lines.length ? lines[lines.length - 1].seq : Math.max(after, 0), lines });
  }

  if (p === '/login') {
    if (PUBLIC) { req.resume(); return send(req, res, 303, 'text/plain', '', { Location: '/' }); }   // nothing to log in to
    if (m !== 'POST') return send(req, res, 303, 'text/plain', '', { Location: '/' });
    const ip = clientIp(req);
    if (recentFails(ip).length >= RL_MAX) { req.resume(); return send(req, res, 429, 'text/html; charset=utf-8', loginPage('Too many attempts. Try again later.'), { 'Retry-After': String(RL_WINDOW_MS / 1000) }); }
    let pw = '';
    try { pw = new URLSearchParams((await readBody(req, MAX_LOGIN_BODY)).toString('utf8')).get('password') || ''; }
    catch { return send(req, res, 400, 'text/html; charset=utf-8', loginPage('Bad request.')); }
    if (pw && safeEq(pw, MESH_PASSWORD)) {
      fails.delete(ip);
      return send(req, res, 303, 'text/plain', '', { Location: '/', 'Set-Cookie': cookie(makeSession(), SESSION_TTL_MS / 1000) });
    }
    const arr = recentFails(ip); arr.push(Date.now()); fails.set(ip, arr);
    return send(req, res, 401, 'text/html; charset=utf-8', loginPage('Wrong password.'));
  }

  if (p === '/logout') {
    req.resume();
    return send(req, res, 303, 'text/plain', '', { Location: '/', 'Set-Cookie': cookie('', 0) });
  }

  if (m !== 'GET' && m !== 'HEAD') return send(req, res, 405, 'text/plain', 'method not allowed', { Allow: 'GET, HEAD' });

  if (p === '/favicon.ico' && (PUBLIC || validSession(req))) {   // public mode: open like the page (was a 401)
    const fi = STATIC.get('/favicon.png');
    return fi ? send(req, res, 200, fi.type, fi.body) : send(req, res, 204, 'image/png', Buffer.alloc(0));
  }
  if (!validSession(req)) {
    if (p === '/live-events.json') return json(req, res, 401, { error: 'login required' });
    return send(req, res, 401, 'text/html; charset=utf-8', loginPage());
  }

  if (p === '/live-events.json') {
    const gzOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (url.searchParams.has('since')) {   // delta poll: only events changed since the client's cursor
      const d = since(url.searchParams.get('since'));
      if (d === 'same') return send(req, res, 304, 'application/json; charset=utf-8', Buffer.alloc(0), { ETag: `"${cursor()}"` });
      const buf = Buffer.from(JSON.stringify(d || { reset: true, cursor: cursor() }));
      if (gzOk && buf.length > 1024) return send(req, res, 200, 'application/json; charset=utf-8', zlib.gzipSync(buf, { level: 6 }), { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return send(req, res, 200, 'application/json; charset=utf-8', buf, { Vary: 'Accept-Encoding' });
    }
    const f = full();
    if (String(req.headers['if-none-match'] || '') === f.etag) return send(req, res, 304, 'application/json; charset=utf-8', Buffer.alloc(0), { ETag: f.etag, Vary: 'Accept-Encoding' });
    if (gzOk) return send(req, res, 200, 'application/json; charset=utf-8', f.gz, { 'Content-Encoding': 'gzip', ETag: f.etag, Vary: 'Accept-Encoding' });
    return send(req, res, 200, 'application/json; charset=utf-8', f.body, { ETag: f.etag, Vary: 'Accept-Encoding' });
  }
  const f = STATIC.get(p);
  if (f) return send(req, res, 200, f.type, f.body);
  return send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
}

const server = http.createServer({ requireHostHeader: false }, (req, res) => {
  handle(req, res).catch(() => { if (!res.headersSent) send(req, res, 500, 'text/plain', 'error'); else res.destroy(); });
});
server.requireHostHeader = false;
server.requestTimeout = 30000;
server.headersTimeout = 15000;
function githubFeedEvents() {
  try {
    const f = JSON.parse(fs.readFileSync(GH_FEED, 'utf8'));
    return f && Array.isArray(f.events) ? f.events : [];
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.log('archive: github feed ' + (e.code || 'read'));
    return [];
  }
}
backfillArchive({ inboxes: seatInbox, extraInbox: inboxLines, nudges, acks: inboxAcks, cards: bfCards, events: githubFeedEvents() });
server.listen(PORT, () => {
  console.log(`live mesh listening on :${server.address().port} (${PUBLIC ? 'public: no password, no masking' : 'gated'})`);
  // The stall clock starts once the port is open, so a slow bind is not a stall.
  if (process.env.COLLECTOR !== 'off') {
    readCollectorFeed();
    setInterval(readCollectorFeed, 2000).unref();
    const watchEvery = Math.min(5000, Math.max(500, (Number(process.env.COLLECTOR_WATCH_S) || 45) * 1000));
    setInterval(watchFeed, watchEvery).unref();
    startCollector().catch(e => console.log("collector: start failed " + String(e.message).slice(0, 80)));
  }
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
readJiraFeed();
setInterval(readJiraFeed, 2000).unref();
startJira();
