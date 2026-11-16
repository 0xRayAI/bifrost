// Per-seat wake filter. The line still lands on the board. A skip is reason "filter".
// SEAT_WAKE_FILTER is "actionable" (default), "all", or JSON {mode, seats}.
// fleet-roster.json "wake_filter" is the same JSON when the env var is unset.
// A seat override of "all" keeps the old wake. "actionable" forces the filter.

const HOUR_MS = 60 * 60 * 1000;
const REVIEW = new Set(['review', 'critic_pass', 'critic_fail', 'verdict']);
const DIRECT = new Set(['dispatch', 'packet', 'handoff', 'start_after']);
const ROUTED = new Set(['near', 'mill']);

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

const SUCCESS = new Set(['success', 'passed', 'green']);
const SUITE = new Set(['check_suite', 'workflow_run', 'ci_pass', 'ci_success']);
const CLOSED = new Set(['merged', 'merge', 'pr_close', 'issue_close', 'pr_closed', 'issue_closed', 'closed']);
const GREEN_REASON = 'CI green on current head';

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

function successDone(row) {
  const conclusion = String(row && row.conclusion || '').toLowerCase();
  const status = String(row && row.status || '').toLowerCase();
  if (!SUCCESS.has(conclusion)) return false;
  return !status || status === 'completed';
}

// Every check_run is done and successful, and a completed suite agrees.
// A suite or a workflow by itself is not the head. A missing row is not success.
export function checksAllGreen(checks) {
  const list = (Array.isArray(checks) ? checks : []).filter(row => row && row.required !== false);
  const runs = list.filter(row => String(row.kind || '') === 'check_run');
  const suites = list.filter(row => SUITE.has(String(row.kind || '')));
  if (!runs.length || !suites.length) return false;
  return list.every(successDone);
}

function ghWord(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

// The collector's read token. A missing page, a short page, or a failed read is not a green head.
export async function githubHeadChecks(repo, sha, opts = {}) {
  const token = String(opts.token || '').trim();
  const fetchImpl = opts.fetch || globalThis.fetch;
  const api = String(opts.api || 'https://api.github.com').replace(/\/$/, '');
  const parts = String(repo || '').trim().split('/');
  const head = String(sha || '').trim().toLowerCase();
  if (!token || parts.length !== 2 || !parts[0] || !parts[1] || !/^[0-9a-f]{7,40}$/.test(head)) return null;
  if (typeof fetchImpl !== 'function') return null;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'live-board-feed',
  };
  const read = async (path) => {
    let res;
    try {
      res = await fetchImpl(api + path, { headers, signal: AbortSignal.timeout(15000) });
    } catch {
      return null;
    }
    if (!res || !res.ok) return null;
    try { return await res.json(); } catch { return null; }
  };
  const root = `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/commits/${head}`;
  const [runsBody, suitesBody] = await Promise.all([
    read(root + '/check-runs?per_page=100'),
    read(root + '/check-suites?per_page=100'),
  ]);
  if (!runsBody || !suitesBody) return null;
  const runs = Array.isArray(runsBody.check_runs) ? runsBody.check_runs : null;
  const suites = Array.isArray(suitesBody.check_suites) ? suitesBody.check_suites : null;
  if (!runs || !suites || !runs.length) return null;
  if (Number(runsBody.total_count) !== runs.length || Number(suitesBody.total_count) !== suites.length) return null;
  return [
    ...runs.map(row => ({
      kind: 'check_run',
      name: String(row && row.name || ''),
      status: ghWord(row && row.status),
      conclusion: ghWord(row && row.conclusion),
    })),
    ...suites.map(row => ({
      kind: 'check_suite',
      name: String(row && row.app && row.app.slug || 'suite'),
      status: ghWord(row && row.status),
      conclusion: ghWord(row && row.conclusion),
    })),
  ];
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
  if (!checksAllGreen(checks)) return null;
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

// Assignee, then owner. classifyBatch and allowWake both use this, so a review
// offered to one of them is not filtered for the other.
export function owedSeat(card, idOf) {
  const id = typeof idOf === 'function' ? idOf : (value => String(value || '').trim().toLowerCase());
  if (!card) return '';
  return id(card.assignee) || id(card.owner) || '';
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
  if (assignedR(line, who)) return { allow: true };
  return { allow: false, reason: 'filter' };
}
