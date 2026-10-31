// One-shot rebuild of card history that the 24h display drop never archived.
// Dry-run is the default. --write appends through the archive, which refuses an id it already has.
import fs from 'node:fs';
import path from 'node:path';
import { appendArchive, initArchive, recordId, appendTransition, transitionFromEvent } from './archive.mjs';
import { chicagoDay } from './chicago-stamp.mjs';

const PARKED = /\b(parked|blocked|waiting|icebox)\b/i;
const BC_ID = /\b(bc-[a-z0-9]+(?:-[a-z0-9]+)*)\b/gi;

export function chooseRepos({ repos, collectorRepos, orgRepos } = {}) {
  const src = (repos && repos.length) ? repos : (collectorRepos && collectorRepos.length) ? collectorRepos : (orgRepos || []);
  const out = [];
  for (const raw of src) {
    const name = String(raw || '').trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

export function parseGhPages(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const one = JSON.parse(trimmed);
    return Array.isArray(one) ? one : [one];
  } catch { /* one JSON value per page */ }
  const out = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const chunk = JSON.parse(trimmed.slice(start, i + 1));
        if (Array.isArray(chunk)) out.push(...chunk);
        else out.push(chunk);
      }
    }
  }
  return out;
}

export function linkedAgents(...texts) {
  const out = [];
  for (const text of texts) {
    for (const match of String(text || '').matchAll(BC_ID)) {
      const id = match[1].toLowerCase();
      if (!out.includes(id)) out.push(id);
    }
  }
  return out.slice(0, 8);
}

export function loadSeats(file) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return new Map(); }
  const map = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [login, seat] of Object.entries(raw)) {
    if (typeof seat === 'string' && seat) map.set(login.toLowerCase(), seat);
  }
  return map;
}

export function seatOf(login, seats) {
  if (!login || !seats) return '';
  return seats.get(String(login).toLowerCase()) || '';
}

function labelsOf(item) {
  const raw = Array.isArray(item && item.labels) ? item.labels : [];
  const names = [];
  for (const label of raw) {
    const name = typeof label === 'string' ? label : (label && label.name);
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 8);
}

function parkedLabels(labels) {
  return labels.some(name => PARKED.test(name));
}

export function itemFromIssue(repo, issue) {
  if (!issue || typeof issue !== 'object' || issue.pull_request || !Number.isInteger(issue.number)) return null;
  return normalizeItem(repo, issue, 'issue');
}

export function itemFromPull(repo, pull) {
  if (!pull || typeof pull !== 'object' || !Number.isInteger(pull.number)) return null;
  const item = normalizeItem(repo, pull, 'pr');
  const mergedBy = pull.merged_by && typeof pull.merged_by === 'object' ? pull.merged_by.login : '';
  item.merged_at = typeof pull.merged_at === 'string' ? pull.merged_at : '';
  item.merged_by = typeof mergedBy === 'string' ? mergedBy : '';
  item.head_ref = pull.head && typeof pull.head.ref === 'string' ? pull.head.ref : '';
  item.draft = pull.draft === true;
  item.agents = linkedAgents(item.title, item.head_ref, pull.body);
  return item;
}

function normalizeItem(repo, row, kind) {
  const user = row.user && typeof row.user === 'object' ? row.user.login : '';
  return {
    repo, number: row.number, kind,
    title: typeof row.title === 'string' ? row.title : '',
    url: typeof row.html_url === 'string' ? row.html_url : '',
    user: typeof user === 'string' ? user : '',
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    closed_at: typeof row.closed_at === 'string' ? row.closed_at : '',
    merged_at: '', merged_by: '', head_ref: '', draft: false,
    labels: labelsOf(row),
    agents: linkedAgents(row.title, row.body),
    state: typeof row.state === 'string' ? row.state : '',
  };
}

function itemKey(repo, number) {
  return `${String(repo || '').toLowerCase()}#${Number(number)}`;
}

function kindKey(repo, number, kind) {
  return `${itemKey(repo, number)}:${kind}`;
}

export function readArchiveIndex(dataDir) {
  const index = { eventIds: new Set(), eventKinds: new Set(), cardIds: new Set(), cardsByKey: new Map() };
  const root = path.join(dataDir || '', 'archive');
  const rememberCard = (row) => {
    if (!row || !row.key) return;
    if (row.id) index.cardIds.add(String(row.id));
    const key = String(row.key).toLowerCase();
    const arr = index.cardsByKey.get(key) || [];
    arr.push(row);
    index.cardsByKey.set(key, arr);
  };
  try {
    const book = path.join(root, 'cards.jsonl');
    const bookStat = fs.statSync(book);
    if (bookStat.size > 0 && bookStat.size <= 8 * 1024 * 1024) {
      for (const line of fs.readFileSync(book, 'utf8').split('\n')) {
        if (!line) continue;
        try { rememberCard(JSON.parse(line)); } catch { /* truncated line */ }
      }
    }
  } catch { /* no card book yet */ }
  let days = [];
  try { days = fs.readdirSync(root); } catch { return index; }
  for (const day of days) {
    for (const kind of ['events', 'cards']) {
      const file = path.join(root, day, kind + '.jsonl');
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== 'object') continue;
        if (kind === 'events') {
          if (row.id) index.eventIds.add(String(row.id));
          if (row.repo && row.number != null && row.kind) index.eventKinds.add(kindKey(row.repo, row.number, row.kind));
          continue;
        }
        rememberCard(row);
      }
    }
  }
  return index;
}

function eventRow(id, item, kind, when, login, label) {
  return {
    id, t_ct: when, from: 'GitHub', to: 'GitHub', kind, direction: 'internal',
    label: label.slice(0, 54), source: item.url, src_file: 'github-api',
    repo: item.repo, number: item.number, actor: login || '', author: item.user || '',
    credit: 'github',
  };
}

function withSeat(row, login, seats) {
  const seat = seatOf(login, seats);
  if (!seat) return row;
  return { ...row, from: seat, credit: seat.toLowerCase() };
}

function cardBase(item, seats) {
  const key = itemKey(item.repo, item.number);
  return {
    key, repo: item.repo, number: item.number, title: item.title.slice(0, 120), url: item.url,
    owner: seatOf(item.user, seats), kind: item.kind, labels: item.labels, agents: item.agents,
    packet_ok: true,
  };
}

function openCard(item, seats) {
  const parked = !item.closed_at && !item.merged_at && (item.draft || parkedLabels(item.labels));
  return {
    ...cardBase(item, seats),
    stage: item.kind === 'pr' ? 'review' : 'open',
    state: parked ? 'parked' : 'live',
    t_ct: item.created_at, updated_ct: item.created_at,
  };
}

function finalStamp(when, rows) {
  const close = Date.parse(when) || 0;
  let latest = 0;
  for (const row of rows || []) {
    const stamp = Date.parse(row.updated_ct || row.t_ct || '') || 0;
    if (stamp > latest) latest = stamp;
  }
  if (!latest || close > latest) return when;
  return new Date(latest + 1000).toISOString();
}

function finalCard(item, seats, prior) {
  const merged = !!item.merged_at;
  const when = merged ? item.merged_at : item.closed_at;
  const stamp = finalStamp(when, prior);
  return {
    ...cardBase(item, seats),
    stage: 'done', state: 'closed', verb: merged ? 'merged' : 'closed',
    merged_by: merged ? (item.merged_by || item.user || '') : '',
    t_ct: when, updated_ct: stamp,
  };
}

function hasClosed(rows) {
  return (rows || []).some(row => row && (row.state === 'closed' || row.verb === 'merged' || row.verb === 'closed'));
}

function rememberEvent(index, row) {
  index.eventIds.add(row.id);
  index.eventKinds.add(kindKey(row.repo, row.number, row.kind));
}

export function planBackfill(items, index, seats) {
  const events = [];
  const cards = [];
  let skippedEvents = 0;
  let skippedCards = 0;
  const byRepo = {};
  const seen = index || { eventIds: new Set(), eventKinds: new Set(), cardIds: new Set(), cardsByKey: new Map() };
  for (const item of items || []) {
    if (!item || !item.repo || !Number.isInteger(item.number) || !item.created_at) continue;
    const bucket = byRepo[item.repo] || (byRepo[item.repo] = { cards: 0, events: 0 });
    const short = item.repo.split('/')[1] || item.repo;
    const mark = item.kind === 'pr' ? '#' : ' issue #';
    const candidates = [];
    candidates.push(withSeat(eventRow(
      item.kind === 'pr' ? `${item.repo}#${item.number}:open` : `${item.repo}!${item.number}:open`,
      item, item.kind === 'pr' ? 'pr_open' : 'issue_open', item.created_at, item.user,
      `${short}${mark}${item.number} opened`,
    ), item.user, seats));
    if (item.kind === 'pr' && item.merged_at) {
      const merged = withSeat(eventRow(
        `${item.repo}#${item.number}:merged`, item, 'merged', item.merged_at, item.merged_by || item.user,
        `merged ${short} #${item.number}`,
      ), item.merged_by || item.user, seats);
      merged.merged_by = item.merged_by || '';
      candidates.push(merged);
    } else if (item.closed_at) {
      candidates.push(withSeat(eventRow(
        item.kind === 'pr' ? `${item.repo}#${item.number}:close` : `${item.repo}!${item.number}:close`,
        item, item.kind === 'pr' ? 'pr_close' : 'issue_close', item.closed_at, item.user,
        `closed ${short}${mark}${item.number}`,
      ), item.user, seats));
    }
    for (const row of candidates) {
      if (seen.eventIds.has(row.id) || seen.eventKinds.has(kindKey(row.repo, row.number, row.kind))) {
        skippedEvents++;
        continue;
      }
      events.push(row);
      rememberEvent(seen, row);
      bucket.events++;
    }
    const key = itemKey(item.repo, item.number);
    const prior = seen.cardsByKey.get(key) || [];
    const want = [];
    if (!prior.length) want.push(openCard(item, seats));
    else skippedCards++;
    if ((item.merged_at || item.closed_at) && !hasClosed(prior)) want.push(finalCard(item, seats, prior));
    else if (item.merged_at || item.closed_at) skippedCards++;
    for (const card of want) {
      const id = recordId('cards', card);
      if (!id || seen.cardIds.has(id)) { skippedCards++; continue; }
      cards.push(card);
      seen.cardIds.add(id);
      const arr = seen.cardsByKey.get(key) || [];
      arr.push({ ...card, id });
      seen.cardsByKey.set(key, arr);
      bucket.cards++;
    }
  }
  return { events, cards, skippedEvents, skippedCards, byRepo, closedCards: cards.filter(card => card.state === 'closed').length };
}

export function applyPlan(dataDir, plan, opts = {}) {
  const cards = plan && Array.isArray(plan.cards) ? plan.cards : [];
  const events = plan && Array.isArray(plan.events) ? plan.events : [];
  if (!opts.write) return { wrote: false, cards: 0, events: 0 };
  initArchive(dataDir);
  let wroteCards = 0;
  let wroteEvents = 0;
  for (const row of events) if (appendArchive('events', row)) wroteEvents++;
  for (const row of cards) if (appendArchive('cards', row)) wroteCards++;
  return { wrote: true, cards: wroteCards, events: wroteEvents };
}

export async function runBackfill(opts = {}) {
  const repos = chooseRepos(opts);
  const index = readArchiveIndex(opts.dataDir);
  const items = [];
  const errors = [];
  for (const repo of repos) {
    try {
      const page = await opts.fetchItems(repo);
      for (const item of page || []) if (item) items.push(item);
    } catch (err) {
      errors.push({ repo, error: String(err && err.message || err).slice(0, 200) });
    }
  }
  const plan = planBackfill(items, index, opts.seats);
  for (const repo of repos) if (!plan.byRepo[repo]) plan.byRepo[repo] = { cards: 0, events: 0 };
  const applied = applyPlan(opts.dataDir, plan, { write: opts.write === true });
  return {
    dry_run: opts.write !== true,
    repos, errors,
    ...(opts.keepItems ? { items } : {}),
    cards: plan.cards.length,
    closed_cards: plan.closedCards,
    events: plan.events.length,
    skipped_cards: plan.skippedCards,
    skipped_events: plan.skippedEvents,
    wrote_cards: applied.cards,
    wrote_events: applied.events,
    by_repo: plan.byRepo,
  };
}

export function tally(report) {
  return { cards: report.cards, events: report.events, skipped_cards: report.skipped_cards, skipped_events: report.skipped_events };
}

// Days the collector store never wrote. Listed until a transition lands on that Chicago date.
export const MISSING_DAYS = Object.freeze([
  '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-25',
  '2026-08-27', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01',
]);
const TRANSITION_SINCE = Date.parse('2026-06-05T00:00:00-05:00');

export function readArchiveEvents(dataDir) {
  const events = [];
  const days = [];
  const root = path.join(dataDir || '', 'archive');
  let names = [];
  try { names = fs.readdirSync(root); } catch { return { events, days }; }
  for (const day of names) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    days.push(day);
    let text = '';
    try { text = fs.readFileSync(path.join(root, day, 'events.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* truncated line */ }
    }
  }
  return { events, days };
}

export function knownTransitionIds(dataDir) {
  const root = path.join(dataDir || '', 'archive');
  const index = path.join(root, 'transition-index.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(index, 'utf8'));
    if (Array.isArray(parsed.ids)) return new Set(parsed.ids.filter(id => typeof id === 'string'));
  } catch { /* rebuild from the log */ }
  const ids = new Set();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return ids; }
  for (const day of names) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(root, day, 'transitions.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.id) ids.add(String(row.id));
      } catch { /* truncated line */ }
    }
  }
  return ids;
}

function eventsFromItem(item) {
  if (!item || typeof item !== 'object') return [];
  if (item.kind && item.id != null && item.t_ct && item.repo && item.number != null && !item.created_at) return [item];
  if (!item.repo || !Number.isInteger(Number(item.number))) return [];
  const number = Number(item.number);
  const base = {
    repo: item.repo, number, title: typeof item.title === 'string' ? item.title : '',
    from: item.user || '', actor: item.user || '', author: item.user || '', credit: item.credit || '',
  };
  const out = [];
  if (item.created_at) {
    out.push({ ...base, id: `${item.repo}#${number}:open`, kind: item.kind === 'issue' ? 'issue_open' : 'pr_open', t_ct: item.created_at });
  }
  if (item.merged_at) {
    out.push({ ...base, id: `${item.repo}#${number}:merged`, kind: 'merged', t_ct: item.merged_at, merged_by: item.merged_by || '' });
  } else if (item.closed_at) {
    out.push({ ...base, id: `${item.repo}#${number}:close`, kind: item.kind === 'issue' ? 'issue_close' : 'pr_close', t_ct: item.closed_at });
  }
  return out;
}

function pickLatest(prev, row) {
  if (!prev) return row;
  const prevT = Date.parse(prev.t_ct) || 0;
  const nextT = Date.parse(row.t_ct) || 0;
  if (prev.transition === 'merged' && row.transition === 'closed') return prev;
  if (row.transition === 'reopened' && nextT >= prevT) return row;
  if (prev.transition === 'merged' && row.transition !== 'merged' && row.transition !== 'reopened') return prev;
  if (nextT > prevT) return row;
  if (nextT < prevT) return prev;
  return row;
}

export function planTransitionBackfill({ events, days, items, collector, seenIds } = {}) {
  const seen = new Set(seenIds || []);
  const rows = [];
  const latest = new Map();
  function pushEvent(e) {
    const t = Date.parse(e && e.t_ct || '');
    if (!Number.isFinite(t) || t < TRANSITION_SINCE) return;
    const row = transitionFromEvent(e);
    if (!row) return;
    const id = `${row.card}|${row.transition}|${row.source_id}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push(row);
    latest.set(row.card, pickLatest(latest.get(row.card), row));
  }
  for (const e of events || []) pushEvent(e);
  const present = new Set(days || []);
  const missing = new Set(MISSING_DAYS.filter(day => !present.has(day)));
  function stillLive(card) {
    const row = latest.get(card);
    return !row || (row.transition !== 'merged' && row.transition !== 'closed');
  }
  for (const item of [...(items || []), ...(collector || [])]) {
    for (const e of eventsFromItem(item)) {
      const peek = transitionFromEvent(e);
      if (!peek) continue;
      const day = chicagoDay(e.t_ct);
      if (!stillLive(peek.card) && !missing.has(day)) continue;
      pushEvent(e);
    }
  }
  const filled = new Set(rows.map(row => chicagoDay(row.t_ct)).filter(Boolean));
  const unrestored = MISSING_DAYS.filter(day => !present.has(day) && !filled.has(day));
  return { rows, unrestored };
}

export function applyTransitionBackfill(dataDir, plan, opts = {}) {
  const rows = plan && Array.isArray(plan.rows) ? plan.rows : [];
  const unrestored = plan && Array.isArray(plan.unrestored) ? plan.unrestored : [];
  if (!opts.write) return { wrote: false, appended: 0, unrestored };
  initArchive(dataDir);
  let appended = 0;
  for (const row of rows) if (appendTransition(row)) appended++;
  const file = path.join(dataDir, 'archive', 'transitions-backfill.json');
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ unrestored, appended }) + '\n');
  fs.renameSync(tmp, file);
  return { wrote: true, appended, unrestored };
}

export function runTransitionBackfill({ dataDir, items, collector, write } = {}) {
  const sources = readArchiveEvents(dataDir);
  const plan = planTransitionBackfill({
    events: sources.events, days: sources.days, items, collector,
    seenIds: knownTransitionIds(dataDir),
  });
  const applied = applyTransitionBackfill(dataDir, plan, { write: write === true });
  return {
    rows: plan.rows.length, unrestored: plan.unrestored,
    wrote: applied.wrote, appended: applied.appended,
  };
}
