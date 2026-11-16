// Per-seat wake filter. The line still lands on the board. A skip is reason "filter".
// SEAT_WAKE_FILTER is "actionable" (default), "all", or JSON {mode, seats}.
// fleet-roster.json "wake_filter" is the same JSON when the env var is unset.
// A seat override of "all" keeps the old wake. "actionable" forces the filter.

const HOUR_MS = 60 * 60 * 1000;
const REVIEW = new Set(['review', 'critic_pass', 'critic_fail', 'verdict']);
const DIRECT = new Set(['dispatch', 'packet', 'handoff', 'start_after']);
const ROUTED = new Set(['near', 'mill']);
const CLOUD_OWNERS = new Set(['builder', 'builder-cloud', 'cloud']);
const RACI_SEATS = new Set(['mill', 'near', 'critic', 'forge', 'herald', 'nibbler', 'magnet', 'blinky']);

function kindOf(line) {
  return String(line && (line.kind || line.type) || '').trim().toLowerCase();
}

export function readWakeFilter(env = {}, roster = null) {
  const raw = env.SEAT_WAKE_FILTER == null ? '' : String(env.SEAT_WAKE_FILTER).trim();
  if (raw === 'all' || raw === 'off') return { mode: 'all', seats: {} };
  let parsed = null;
  if (raw.startsWith('{')) {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (!parsed && roster && typeof roster.wake_filter === 'object') parsed = roster.wake_filter;
  const seats = parsed && parsed.seats && typeof parsed.seats === 'object' ? parsed.seats : {};
  const mode = parsed && parsed.mode === 'all' ? 'all' : 'actionable';
  return { mode, seats };
}

export function filterMode(config, seat) {
  const over = config && config.seats ? config.seats[seat] : '';
  if (over === 'all' || over === 'off') return 'all';
  if (over === 'actionable') return 'actionable';
  return config && config.mode === 'all' ? 'all' : 'actionable';
}

function mentioned(line, seat) {
  const list = Array.isArray(line && line.mentions) ? line.mentions : [];
  if (list.some(item => String(item).replace(/^@/, '').toLowerCase() === seat)) return true;
  const hay = `${line && line.title || ''}\n${line && line.reason || ''}`;
  return new RegExp(`(^|[^A-Za-z0-9])@${seat}([^A-Za-z0-9]|$)`, 'i').test(hay);
}

function ownerPrompt(line) {
  const kind = kindOf(line);
  return kind === 'prompt' || kind === 'seat_prompt';
}

function stationLine(line) {
  const kind = kindOf(line);
  return kind === 'station' || String(line && line.id || '').startsWith('nudge:station:');
}

function cancelled(line) {
  const text = `${line && line.conclusion || ''} ${line && line.status || ''} ${line && line.reason || ''}`.toLowerCase();
  return /\bcancell?ed\b/.test(text) || /\bskipped\b/.test(text);
}

function currentHead(line, head) {
  if (cancelled(line)) return false;
  const sha = String(line && line.sha || '').trim().toLowerCase();
  // An empty sha is not a superseded head. That ci_fail wakes.
  if (!sha) return true;
  const cur = String(head || '').trim().toLowerCase();
  if (!cur) return true;
  return sha === cur || cur.startsWith(sha) || sha.startsWith(cur);
}

function assignedR(line, seat) {
  if (!ROUTED.has(seat)) return false;
  if (/packet\s*R/i.test(String(line && line.reason || ''))) return true;
  const raci = String(line && (line.raci || (line.packet && line.packet.raci)) || '');
  return new RegExp(`\\bR\\s*=\\s*${seat}\\b`, 'i').test(raci);
}

const PASS = new Set(['success', 'skipped', 'neutral']);
const CLOSED = new Set(['merged', 'merge', 'pr_close', 'issue_close', 'pr_closed', 'issue_closed', 'closed']);
const GREEN_REASON = 'CI green on current head';
const RUN_PAGES = 20;
const RERUN_MS = 60 * 1000;

function slots(state) {
  if (!state.stationAt) state.stationAt = new Map();
  if (!Array.isArray(state.greenHeads)) state.greenHeads = [];
  return state;
}

export function fullHeadSha(line) {
  const found = [];
  for (const key of ['head_sha', 'sha', 'head']) {
    const sha = String(line && line[key] || '').trim().toLowerCase();
    if (/^[0-9a-f]{7,40}$/.test(sha)) found.push(sha);
  }
  found.sort((a, b) => b.length - a.length);
  return found[0] || '';
}

function sameSha(a, b) {
  if (!a || !b || a.length < 7 || b.length < 7) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function ghWord(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

function mapRun(row) {
  const attempt = Number(row && row.run_attempt);
  return {
    name: String(row && row.name || ''),
    status: ghWord(row && row.status),
    conclusion: ghWord(row && row.conclusion),
    workflow_id: row && row.workflow_id != null ? row.workflow_id : '',
    event: ghWord(row && row.event),
    run_attempt: Number.isFinite(attempt) ? attempt : 0,
  };
}

// One row per workflow and event: the highest run_attempt.
export function latestRuns(runs) {
  const best = new Map();
  for (const row of Array.isArray(runs) ? runs : []) {
    if (!row) continue;
    const id = row.workflow_id != null && row.workflow_id !== '' ? String(row.workflow_id) : String(row.name || '');
    const key = id + '\n' + ghWord(row.event);
    const attempt = Number(row.run_attempt);
    const n = Number.isFinite(attempt) ? attempt : 0;
    const prev = best.get(key);
    if (!prev || n >= prev.n) best.set(key, { n, row });
  }
  return [...best.values()].map(item => mapRun(item.row));
}

// Actions runs for one head. total_count must be covered, and every latest attempt completed.
export function runsAllGreen(runs) {
  const list = latestRuns(runs);
  if (!list.length) return false;
  return list.every((row) => row.status === 'completed' && PASS.has(row.conclusion));
}

// GITHUB_READ_TOKEN only. A missing token, a short page, a 403, or a 429 is not a green head.
// Only a green list is cached. A pending head, a 500, or a timeout is fetched again on a later
// event, at least 60s apart, until that head is green. A new sha is a new key.
// 403 and 429 share one in-memory backoff. A 403 is logged once.
export async function githubHeadRuns(repo, sha, opts = {}) {
  const token = String(opts.token || '').trim();
  if (!token) return null;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const api = String(opts.api || 'https://api.github.com').replace(/\/$/, '');
  const parts = String(repo || '').trim().split('/');
  const head = String(sha || '').trim().toLowerCase();
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[0-9a-f]{7,40}$/.test(head)) return null;
  const state = opts.state;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 15 * 60 * 1000;
  const gap = Number.isFinite(opts.gapMs) ? opts.gapMs : RERUN_MS;
  const key = `${parts[0]}/${parts[1]}@${head}`.toLowerCase();
  if (state && now < state.quietUntil) return null;
  if (state && state.fetched && state.fetched.has(key)) return state.fetched.get(key);
  if (state && state.retryAt && state.retryAt.has(key) && now < state.retryAt.get(key)) return null;
  if (state && state.inflight && state.inflight.has(key)) return state.inflight.get(key);

  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'live-board-feed',
  };
  const root = `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/actions/runs`;

  const job = (async () => {
    const rows = [];
    let total = null;
    let blocked = '';
    for (let page = 1; page <= RUN_PAGES; page++) {
      const path = `${root}?head_sha=${encodeURIComponent(head)}&per_page=100&page=${page}`;
      let res;
      try {
        res = await fetchImpl(api + path, { headers, signal: AbortSignal.timeout(15000) });
      } catch {
        blocked = 'miss';
        break;
      }
      if (!res) { blocked = 'miss'; break; }
      if (res.status === 403 || res.status === 429) { blocked = res.status === 403 ? 'denied' : 'rate'; break; }
      if (!res.ok) { blocked = 'miss'; break; }
      let body;
      try { body = await res.json(); } catch { blocked = 'miss'; break; }
      const chunk = body && body.workflow_runs;
      if (!Array.isArray(chunk)) { blocked = 'miss'; break; }
      if (total == null) {
        total = Number(body.total_count);
        if (!Number.isFinite(total) || total < 0) { blocked = 'miss'; break; }
      }
      rows.push(...chunk);
      if (rows.length >= total) {
        if (rows.length !== total) blocked = 'miss';
        break;
      }
      if (chunk.length === 0) { blocked = 'miss'; break; }
    }
    if (!blocked && rows.length !== total) blocked = 'miss';
    if (blocked === 'denied' || blocked === 'rate') {
      if (state) {
        state.quietUntil = now + backoffMs;
        if (blocked === 'denied' && !state.deniedLogged) {
          state.deniedLogged = true;
          if (typeof opts.log === 'function') opts.log('wake: actions runs 403, green wake off');
        }
      }
      return null;
    }
    const runs = blocked ? null : latestRuns(rows);
    if (runs && runsAllGreen(runs)) {
      if (state) state.fetched.set(key, runs);
      return runs;
    }
    if (state) {
      if (!state.retryAt) state.retryAt = new Map();
      state.retryAt.set(key, now + gap);
    }
    return runs;
  })();
  if (state) {
    if (!state.inflight) state.inflight = new Map();
    state.inflight.set(key, job);
    job.finally(() => { if (state.inflight.get(key) === job) state.inflight.delete(key); });
  }
  return job;
}

const RETRY_CAP = 30;
const RETRY_WINDOW_MS = 30 * 60 * 1000;

function headKey(repo, sha) {
  const parts = String(repo || '').trim().split('/');
  return `${parts[0]}/${parts[1]}@${String(sha || '').trim().toLowerCase()}`.toLowerCase();
}

// noteCi only runs when the feed changes. A pending sha retries on its own timer.
export function createCriticHeads(opts) {
  const state = opts.state;
  const timers = new Map();
  const book = new Map();
  const dropped = new Set();
  const setTimer = opts.setTimeout || globalThis.setTimeout;
  const clearTimer = opts.clearTimeout || globalThis.clearTimeout;

  function drop(key) {
    const timer = timers.get(key);
    if (timer) clearTimer(timer);
    timers.delete(key);
    book.delete(key);
    if (state.retryAt) state.retryAt.delete(key);
  }

  function clearOtherHeads(repo, number, sha) {
    const repoName = String(repo || '').toLowerCase();
    for (const [key, row] of book) {
      if (row.number === number && row.sha !== sha && String(row.repo || '').toLowerCase() === repoName) drop(key);
    }
  }

  function arm(key, ev, n, now) {
    let row = book.get(key);
    if (!row) row = { tries: 0, started: now, ev, n, repo: ev.repo, sha: fullHeadSha(ev), logged: false };
    row.tries += 1;
    row.ev = ev;
    if (row.tries > RETRY_CAP || now - row.started >= RETRY_WINDOW_MS) {
      if (!row.logged && typeof opts.log === 'function') opts.log('wake: actions runs retry dropped');
      dropped.add(key);
      drop(key);
      return;
    }
    book.set(key, row);
    if (timers.has(key)) return;
    const when = state.retryAt && state.retryAt.get(key);
    const delay = Math.max(0, (when || now + RERUN_MS) - now);
    const timer = setTimer(() => {
      timers.delete(key);
      void noteCi(row.ev, row.n);
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers.set(key, timer);
  }

  function rSeatLine(ev, repo, number, sha) {
    if (typeof opts.card !== 'function') return null;
    const card = opts.card(repo, number);
    if (!card) return null;
    const filled = assignCloudRaci(card);
    const owner = String(filled.owner || '').trim().toLowerCase();
    if (!CLOUD_OWNERS.has(owner)) return null;
    const seat = raciRole(filled.packet, 'R');
    if (!seat) return null;
    return {
      id: `wake:${seat}:${repo.toLowerCase()}#${number}:${sha}`,
      t_ct: String(ev.t_ct || ''),
      seat,
      type: 'ci_pass',
      kind: 'ci_pass',
      repo,
      number,
      sha,
      title: 'CI green',
      url: String(ev.url || ev.source || `https://github.com/${repo}/pull/${number}`),
      reason: 'CI green for R',
    };
  }

  async function noteCi(ev, n) {
    const token = String(opts.token ? opts.token() : '').trim();
    if (!token) return null;
    const repo = String(ev && ev.repo || '').trim();
    const sha = fullHeadSha(ev);
    const number = Number(n);
    if (!repo || !sha || !Number.isInteger(number)) return null;
    const key = headKey(repo, sha);
    if (dropped.has(key)) return null;
    clearOtherHeads(repo, number, sha);
    if (typeof opts.closed === 'function' && opts.closed(repo, number, ev)) { drop(key); return null; }
    if (typeof opts.seen === 'function' && opts.seen(repo, number, sha)) { drop(key); return null; }
    const prior = state.retryAt && state.retryAt.get(key);
    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    const runs = await githubHeadRuns(repo, sha, {
      token, api: opts.api ? opts.api() : undefined, state, log: opts.log, fetch: opts.fetch, now,
    });
    if (runs && runsAllGreen(runs)) {
      drop(key);
      const ping = criticGreenLine(ev, runs, {});
      const ownerWake = rSeatLine(ev, repo, number, sha);
      const batch = [ping, ownerWake].filter(Boolean);
      if (batch.length && typeof opts.deliver === 'function') opts.deliver(batch);
      return ping;
    }
    const gapSkip = prior != null && state.retryAt && state.retryAt.get(key) === prior && now < prior && runs == null;
    if (gapSkip || (state.quietUntil && now < state.quietUntil)) return null;
    arm(key, ev, number, now);
    return null;
  }

  return { noteCi };
}

export function lineClosed(line) {
  if (!line) return false;
  if (line.merged === true || line.closed === true) return true;
  if (CLOSED.has(kindOf(line))) return true;
  const state = String(line.state || line.pr_state || '').toLowerCase();
  return state === 'closed' || state === 'merged';
}

function greenRow(line) {
  const sha = fullHeadSha(line);
  const repo = String(line && line.repo || '').trim().toLowerCase();
  const n = Number(line && line.number);
  if (!sha || !repo || !Number.isInteger(n) || n < 1) return null;
  return { repo, number: n, sha };
}

export function greenSeen(state, line) {
  const row = greenRow(line);
  if (!row) return false;
  return slots(state).greenHeads.some(item => item.repo === row.repo && item.number === row.number && sameSha(item.sha, row.sha));
}

export function rememberGreen(state, line) {
  const row = greenRow(line);
  if (!row) return false;
  const rows = slots(state).greenHeads;
  const hit = rows.find(item => item.repo === row.repo && item.number === row.number && sameSha(item.sha, row.sha));
  if (!hit) {
    rows.push(row);
    return true;
  }
  if (row.sha.length > hit.sha.length) {
    hit.sha = row.sha;
    return true;
  }
  return false;
}

export function dumpGreenHeads(state) {
  return slots(state).greenHeads.map(row => ({ repo: row.repo, number: row.number, sha: row.sha }));
}

export function restoreGreenHeads(state, dump) {
  const rows = dump && Array.isArray(dump.greenHeads) ? dump.greenHeads : Array.isArray(dump) ? dump : [];
  state.greenHeads = [];
  for (const row of rows) rememberGreen(state, row);
}

export function criticGreenLine(ev, checks, opts = {}) {
  if (!ev || opts.closed || lineClosed(ev)) return null;
  if (!runsAllGreen(checks)) return null;
  const row = greenRow(ev);
  if (!row) return null;
  return {
    id: `wake:critic:${row.repo}#${row.number}:${row.sha}`,
    t_ct: String(ev.t_ct || ''),
    seat: 'critic',
    type: 'ci_pass',
    kind: 'ci_pass',
    repo: String(ev.repo || '').trim(),
    number: row.number,
    sha: row.sha,
    title: 'CI green',
    url: String(ev.url || ev.source || `https://github.com/${row.repo}/pull/${row.number}`),
    reason: GREEN_REASON,
  };
}

function stationOpen(state, seat, now) {
  const prev = slots(state).stationAt.get(seat) || 0;
  return !(prev && now - prev < HOUR_MS);
}

// The station hour lives on the wake state. Seen green heads are written with the breaker file.
// Call this only after the gate sends or queues. A skip must leave the slot open.
export function commitWake(state, seat, line, now) {
  const book = slots(state);
  const who = String(seat || '').toLowerCase();
  if (stationLine(line)) book.stationAt.set(who, now);
  if (who === 'critic' && String(line && line.reason || '') === GREEN_REASON) rememberGreen(state, line);
}

export function packetSeat(value) {
  const word = String(value || '').trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9_-]/g, '');
  if (!word) return '';
  if (word === 'arch1') return 'forge';
  return RACI_SEATS.has(word) ? word : '';
}

function raciRole(packet, letter) {
  const text = String(packet && packet.raci || '');
  const match = text.match(new RegExp(`\\b${letter}\\s*[=:]\\s*([A-Za-z][A-Za-z0-9_-]*)`, 'i'));
  return match ? packetSeat(match[1]) : '';
}

export function assignCloudRaci(card) {
  if (!card || typeof card !== 'object') return card;
  const owner = String(card.owner || '').trim().toLowerCase();
  if (!CLOUD_OWNERS.has(owner)) return card;
  const packet = card.packet && typeof card.packet === 'object' ? { ...card.packet } : {};
  const seat = packetSeat(packet['next owner'] || packet.next_owner);
  if (!seat) return card;
  const roles = {};
  for (const match of String(packet.raci || '').matchAll(/\b([RACI])\s*[=:]\s*([A-Za-z][A-Za-z0-9_-]*)/gi)) {
    roles[match[1].toUpperCase()] = match[2];
  }
  if (!roles.R) roles.R = seat;
  if (!roles.A) roles.A = 'forge';
  packet.raci = ['R', 'A', 'C', 'I'].filter(key => roles[key]).map(key => `${key}=${roles[key]}`).join(' ');
  return { ...card, packet };
}

// Assignee, then owner. A cloud card owes the packet R. arch1 cards owe forge.
// offered to one of them is not filtered for the other.
export function owedSeat(card, idOf) {
  const id = typeof idOf === 'function' ? idOf : (value => String(value || '').trim().toLowerCase());
  if (!card) return '';
  const filled = assignCloudRaci(card);
  const owner = id(filled.owner);
  if (CLOUD_OWNERS.has(owner)) {
    const seat = raciRole(filled.packet, 'R') || packetSeat((filled.packet || {})['next owner'] || (filled.packet || {}).next_owner);
    if (seat) return seat;
  }
  const seat = id(filled.assignee) || owner || '';
  return seat === 'arch1' ? 'forge' : seat;
}

export function allowWake(config, seat, line, ctx) {
  const who = String(seat || '').toLowerCase();
  if (filterMode(config, who) === 'all') return { allow: true };
  const state = ctx.state;
  const now = ctx.now;
  if (stationLine(line)) return stationOpen(state, who, now) ? { allow: true } : { allow: false, reason: 'filter' };
  const kind = kindOf(line);
  // The ladder and the stall clock are already the act-now signal. The filter cuts the GitHub noise.
  if (kind === 'nudge' || kind === 'timed_run' || kind === 'clock' || String(line.type || '').toLowerCase() === 'nudge') return { allow: true };
  if (DIRECT.has(kind)) return { allow: true };
  if (/^nudge L\d/i.test(String(line.reason || ''))) return { allow: true };
  if (ownerPrompt(line) || mentioned(line, who)) return { allow: true };
  if (REVIEW.has(kind) && ctx.owner === who) return { allow: true };
  if (kind === 'ci_fail' && ctx.owner === who && currentHead(line, ctx.head)) return { allow: true };
  if (who === 'critic' && String(line && line.reason || '') === GREEN_REASON) {
    if (ctx.closed || lineClosed(line) || !fullHeadSha(line) || greenSeen(state, line)) return { allow: false, reason: 'filter' };
    return { allow: true };
  }
  if (String(line && line.reason || '') === 'CI green for R' && ctx.owner === who) return { allow: true };
  if (assignedR(line, who)) return { allow: true };
  return { allow: false, reason: 'filter' };
}
