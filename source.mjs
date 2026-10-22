// Card sources. One normalized item becomes one card, whether a server adapter
// pulled it or a client posted it. No connector is required for the push path.
// Field names only; this module does not read credentials or log them.

const FIELDS = new Set(['source', 'key', 'title', 'url', 'status', 'status_category', 'priority', 'assignee', 'updated', 'project']);
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,119}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,79}$/;
const CATEGORIES = new Set(['new', 'indeterminate', 'done']);
const NOT_A_SEAT = new Set(['lead']);
const CLOSED_KEEP_MS = 24 * 3600 * 1000;

export function parseAllowlist(rawJson, jiraProjects) {
  const allow = {};
  let badJson = false;
  if (rawJson && String(rawJson).trim()) {
    try {
      const o = JSON.parse(rawJson);
      if (!o || typeof o !== 'object' || Array.isArray(o)) badJson = true;
      else {
        for (const [k, v] of Object.entries(o)) {
          const src = String(k).toLowerCase();
          if (!SOURCE_RE.test(src) || !Array.isArray(v)) continue;
          const projects = [];
          for (const item of v) {
            const p = String(item ?? '').trim();
            if (p && p.length <= 80) projects.push(p);
          }
          allow[src] = projects;
        }
      }
    } catch { badJson = true; }
  }
  if (jiraProjects && String(jiraProjects).trim()) {
    allow.jira = String(jiraProjects).split(/[\s,]+/).map(s => s.trim()).filter(s => s && s.length <= 80);
  }
  return { allow, badJson };
}

export function projectAllowed(allow, source, project) {
  const list = allow && allow[source];
  if (!Array.isArray(list) || !list.length) return false;
  const p = String(project || '').toLowerCase();
  return list.some(x => String(x).toLowerCase() === p);
}

export function jiraJql(projects) {
  const quoted = [];
  for (const p of projects || []) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(p)) continue;
    quoted.push(`"${p}"`);
  }
  if (!quoted.length) return null;
  return `project in (${quoted.join(',')}) AND statusCategory != Done ORDER BY updated DESC`;
}

export function statusCategory(raw) {
  const s = String(raw || '').toLowerCase();
  switch (s) {
    case 'done':
    case 'indeterminate':
    case 'new':
      return s;
    case '':
      return '';
    default:
      return '';
  }
}

export function noNudgePatterns(raw = process.env.NO_NUDGE_REPOS) {
  if (raw == null || !String(raw).trim()) return [];
  return String(raw).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

export function repoNoNudge(repo, patterns = noNudgePatterns()) {
  const low = String(repo || '').trim().toLowerCase();
  if (!low) return false;
  return patterns.some(pattern => {
    const pat = String(pattern || '').trim();
    if (!pat) return false;
    if (pat.endsWith('/*')) {
      const owner = pat.slice(0, -2).toLowerCase();
      return Boolean(owner) && (low === owner || low.startsWith(owner + '/'));
    }
    return low === pat.toLowerCase();
  });
}

export function cardNoNudge(card, patterns = noNudgePatterns()) {
  if (!card || typeof card !== 'object') return false;
  if (repoNoNudge(card.repo, patterns)) return true;
  const key = String(card.key || '');
  const hash = key.lastIndexOf('#');
  return hash > 0 && repoNoNudge(key.slice(0, hash), patterns);
}

export function jiraHoldStatus(raw = process.env.JIRA_HOLD_STATUS) {
  const name = raw == null ? '' : String(raw).trim();
  return name || 'On Hold';
}

export function statusIsHold(status, name = jiraHoldStatus()) {
  const got = String(status || '').trim().toLowerCase();
  const want = String(name || '').trim().toLowerCase();
  return Boolean(got) && got === want;
}

function stateOf(category) {
  switch (category) {
    case 'done':
      return { state: 'closed', stage: 'done' };
    case 'indeterminate':
      return { state: 'live', stage: 'review' };
    case 'new':
    case '':
      return { state: 'live', stage: 'open' };
    default: {
      /** @type {never} */
      const _exhaustive = category;
      throw new Error('unhandled status_category ' + String(_exhaustive));
    }
  }
}

export function validateItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'object required';
  for (const k of Object.keys(raw)) if (!FIELDS.has(k)) return 'unknown field';
  if (typeof raw.source !== 'string' || !SOURCE_RE.test(raw.source)) return 'bad source';
  if (typeof raw.key !== 'string' || !KEY_RE.test(raw.key)) return 'bad key';
  if (typeof raw.title !== 'string' || !raw.title.trim()) return 'title required';
  if (raw.title.length > 2000) return 'field too long';
  if (typeof raw.project !== 'string' || !PROJECT_RE.test(raw.project)) return 'bad project';
  if (Object.prototype.hasOwnProperty.call(raw, 'url') && raw.url != null && raw.url !== '') {
    if (typeof raw.url !== 'string' || raw.url.length > 300) return 'bad url';
    try {
      const u = new URL(raw.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad url';
    } catch { return 'bad url'; }
  } else if (Object.prototype.hasOwnProperty.call(raw, 'url') && raw.url != null && typeof raw.url !== 'string') return 'bad url';
  for (const k of ['status', 'priority', 'assignee']) {
    if (!Object.prototype.hasOwnProperty.call(raw, k) || raw[k] == null || raw[k] === '') continue;
    if (typeof raw[k] !== 'string' || raw[k].length > 80) return 'bad ' + k;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'status_category') && raw.status_category != null && raw.status_category !== '') {
    if (typeof raw.status_category !== 'string' || !CATEGORIES.has(raw.status_category)) return 'bad status_category';
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'updated') && raw.updated != null && raw.updated !== '') {
    if (typeof raw.updated !== 'string' || raw.updated.length > 40 || !Number.isFinite(Date.parse(raw.updated))) return 'bad updated';
  }
  return null;
}

export function normalizeItem(raw) {
  return {
    source: raw.source,
    key: raw.key,
    title: raw.title.trim().slice(0, 120),
    url: typeof raw.url === 'string' ? raw.url : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    status_category: raw.status_category ? statusCategory(raw.status_category) : '',
    priority: typeof raw.priority === 'string' ? raw.priority : '',
    assignee: typeof raw.assignee === 'string' ? raw.assignee : '',
    updated: typeof raw.updated === 'string' ? raw.updated : '',
    project: raw.project,
  };
}

export function unpackSourceBody(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'object required' };
  if (Object.prototype.hasOwnProperty.call(parsed, 'items')) {
    if (Object.keys(parsed).some(k => k !== 'items')) return { error: 'unknown field' };
    if (!Array.isArray(parsed.items)) return { error: 'items must be an array' };
    if (parsed.items.length > 200) return { error: 'too many items' };
    return { items: parsed.items };
  }
  return { items: [parsed] };
}

export function acceptItems(rawItems, allow) {
  const accepted = [];
  const rejected = [];
  for (const raw of rawItems || []) {
    const key = raw && typeof raw === 'object' && typeof raw.key === 'string' ? raw.key.slice(0, 120) : '';
    const err = validateItem(raw);
    if (err) { rejected.push({ key, error: err }); continue; }
    const item = normalizeItem(raw);
    if (!projectAllowed(allow, item.source, item.project)) {
      rejected.push({ key: item.key, error: 'project not allowlisted' });
      continue;
    }
    accepted.push(item);
  }
  return { accepted, rejected };
}

export function ownerFromAssignee(assignee, seatIds) {
  const seats = new Set(seatIds || []);
  const t = String(assignee || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ');
  for (const w of t.split(/\s+/)) {
    if (!w || NOT_A_SEAT.has(w)) continue;
    if (w === 'lab' && seats.has('qa')) return 'qa';
    if (seats.has(w)) return w;
  }
  return 'builder-cloud';
}

function ownerLabel(id) {
  switch (id) {
    case 'builder': return 'Builder';
    case 'builder-cloud': return 'Builder-cloud';
    case 'reviewer': return 'Reviewer';
    case 'tester': return 'Tester';
    case 'qa': return 'QA';
    case 'coord': return 'Coord';
    case 'operator': return 'Operator';
    default: return id;
  }
}

function packetOf(item, owner) {
  const where = `${item.source} ${item.project} ${item.key}`.slice(0, 200);
  const done = item.status_category === 'done';
  return {
    goal: item.title.slice(0, 200),
    constraints: `stay on ${where}`.slice(0, 200),
    path: (item.url || where).slice(0, 300),
    acceptance: done ? `done in ${item.source}` : `done when ${item.source} status category is done`,
    evidence: item.updated ? `updated ${item.updated}`.slice(0, 200) : `seen in ${item.source}`,
    'next owner': owner,
    escalate: 'Coord',
  };
}

function githubParts(item) {
  if (item.source !== 'github') return { repo: '', number: 0 };
  const i = item.key.lastIndexOf('#');
  const repo = (i > 0 ? item.key.slice(0, i) : item.project).toLowerCase();
  const n = Number(i > 0 ? item.key.slice(i + 1) : '');
  return { repo, number: Number.isInteger(n) && n >= 0 ? n : 0 };
}

export function itemToCard(item, { seats, now = Date.now() } = {}) {
  const ownerId = ownerFromAssignee(item.assignee, seats);
  const owner = ownerLabel(ownerId);
  const beat = Number.isFinite(Date.parse(item.updated || '')) ? Date.parse(item.updated) : now;
  const mapped = stateOf(item.status_category || '');
  let state = mapped.state;
  const stage = mapped.stage;
  const held = state !== 'closed' && statusIsHold(item.status);
  if (held) state = 'held';
  const gh = githubParts(item);
  const packet = packetOf(item, owner);
  const card = {
    key: `${item.source}:${item.key}`,
    kind: 'source',
    source: item.source,
    project: item.project,
    alias: item.source === 'github' ? `${gh.repo}#${gh.number}` : '',
    repo: gh.repo,
    number: gh.number,
    title: item.title,
    url: item.url,
    owner,
    labels: item.priority ? [item.priority.slice(0, 30)] : [],
    stage,
    state,
    packet,
    packet_ok: true,
    missing: [],
    beats: [{ t: beat, what: `source ${item.source}`, url: item.url.slice(0, 160), id: `${item.source}:${item.key}` }],
    last_beat_t: beat,
    stall: state === 'live' && now - beat > 3600000,
    closed_t: state === 'closed' ? beat : 0,
    pinned: false,
    status: item.status,
    status_category: item.status_category,
  };
  if (held) card.hold = { reason: item.status.slice(0, 80), until: '', by: item.source, at: beat };
  return card;
}

export function sourceCardsFrom(items, opts = {}) {
  const now = opts.now || Date.now();
  const cards = [];
  for (const item of items || []) {
    if (validateItem(item)) continue;
    const card = itemToCard(normalizeItem(item), { seats: opts.seats, now });
    if (card.state === 'closed' && card.closed_t && now - card.closed_t > CLOSED_KEEP_MS) continue;
    cards.push(card);
  }
  cards.sort((a, b) => b.last_beat_t - a.last_beat_t);
  return cards.slice(0, 200);
}

export function mergeCards(waveCards, sourceCards) {
  const wave = Array.isArray(waveCards) ? waveCards : [];
  const keys = new Set(wave.map(c => c && c.key).filter(k => typeof k === 'string'));
  const extra = [];
  for (const c of sourceCards || []) {
    if (!c || typeof c.key !== 'string') continue;
    if (keys.has(c.key)) continue;
    if (c.alias && keys.has(c.alias)) continue;
    extra.push(c);
  }
  return [...wave, ...extra];
}

export function jiraOriginFromSite(site) {
  const host = String(site || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host || /[\s@]/.test(host) || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return null;
  if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return 'http://' + host;
  return 'https://' + host;
}

export function jiraIssueToItem(issue, origin) {
  if (!issue || typeof issue !== 'object' || typeof issue.key !== 'string' || !KEY_RE.test(issue.key)) return null;
  const f = issue.fields && typeof issue.fields === 'object' ? issue.fields : {};
  const status = f.status && typeof f.status === 'object' ? f.status : {};
  const cat = status.statusCategory && typeof status.statusCategory === 'object' ? status.statusCategory.key : '';
  const project = f.project && typeof f.project === 'object' && typeof f.project.key === 'string' ? f.project.key : '';
  const who = f.assignee && typeof f.assignee === 'object' ? f.assignee : null;
  const assignee = who ? String(who.displayName || who.emailAddress || '') : '';
  const priority = f.priority && typeof f.priority === 'object' ? String(f.priority.name || '') : '';
  let url = '';
  try { url = new URL('/browse/' + encodeURIComponent(issue.key), origin).toString(); } catch { url = ''; }
  return {
    source: 'jira',
    key: issue.key,
    title: typeof f.summary === 'string' ? f.summary : '',
    url,
    status: typeof status.name === 'string' ? status.name : '',
    status_category: statusCategory(cat),
    priority,
    assignee,
    updated: typeof f.updated === 'string' ? f.updated : '',
    project,
  };
}

function itemClosed(item) {
  return !!item && (item.status_category === 'done' || item.status === 'closed');
}

export function workItemNewer(prev, next) {
  const prevMs = Date.parse(prev && prev.updated);
  const nextMs = Date.parse(next && next.updated);
  const prevT = Number.isFinite(prevMs) ? prevMs : Number.NEGATIVE_INFINITY;
  const nextT = Number.isFinite(nextMs) ? nextMs : Number.NEGATIVE_INFINITY;
  if (nextT !== prevT) return nextT > prevT;
  return itemClosed(next) && !itemClosed(prev);
}

export function workEventToItem(event) {
  if (!event || typeof event !== 'object') return null;
  const closed = event.state === 'closed' || event.kind === 'closed';
  const category = closed ? 'done' : event.kind === 'opened' ? 'new' : 'indeterminate';
  const title = typeof event.title === 'string' && event.title.trim() ? event.title : String(event.key || '');
  return {
    source: event.source,
    key: event.key,
    title,
    url: typeof event.url === 'string' ? event.url : '',
    status: typeof event.status === 'string' && event.status ? event.status : (typeof event.state === 'string' ? event.state : ''),
    status_category: category,
    priority: '',
    assignee: typeof event.actor === 'string' ? event.actor : '',
    updated: typeof event.t === 'string' ? event.t : '',
    project: typeof event.project === 'string' ? event.project : '',
  };
}

export function githubEventToItem(event) {
  if (!event || typeof event !== 'object') return null;
  const repo = String(event.repo || '').trim();
  if (!repo || !Number.isInteger(event.number)) return null;
  const closed = ['closed', 'done'].includes(String(event.state || event.pr_state || '').toLowerCase());
  const url = typeof event.url === 'string' ? event.url : (typeof event.html_url === 'string' ? event.html_url : '');
  return {
    source: 'github',
    key: `${repo}#${event.number}`,
    title: typeof event.title === 'string' ? event.title : '',
    url,
    status: closed ? 'closed' : 'open',
    status_category: closed ? 'done' : 'new',
    priority: typeof event.priority === 'string' ? event.priority : '',
    assignee: typeof event.assignee === 'string' ? event.assignee : '',
    updated: typeof event.updated === 'string' ? event.updated : (typeof event.t_ct === 'string' ? event.t_ct : ''),
    project: repo,
  };
}
