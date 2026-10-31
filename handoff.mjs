// Missed-handoff check. The server never posts the packet and never treats a room post as one.
// A handoff counts only when an /inbox line of that kind is stored for the routed next seat,
// for the same pull request and head. Roles come from inbox-roles.json (`handoffs`), not from names in this file.

const HEAD_KINDS = new Set(['pr_commit', 'pr_force_push', 'pr_update']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function lower(value) {
  return text(value).toLowerCase();
}

function seatOf(value) {
  if (typeof value === 'string') return lower(value);
  if (value && typeof value.seat === 'string') return lower(value.seat);
  return '';
}

function timeOf(event) {
  if (typeof event.t === 'number' && Number.isFinite(event.t)) return event.t;
  const parsed = Date.parse(text(event.t_ct));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shaOf(event) {
  return lower(event.sha || event.head_sha || event.head || '');
}

function repoOf(event) {
  return lower(event.repo);
}

function numberOf(event) {
  const n = Number(event.number);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function stateOf(event) {
  return text(event.state || event.conclusion || event.status).toUpperCase();
}

function isFail(event) {
  const kind = lower(event.kind);
  if (kind === 'critic_fail') return true;
  if (kind === 'review' && stateOf(event) === 'CHANGES_REQUESTED') return true;
  return kind.startsWith('critic_') && stateOf(event).includes('FAIL');
}

function isPass(event) {
  const kind = lower(event.kind);
  if (kind === 'critic_pass') return true;
  if (kind === 'review' && stateOf(event) === 'APPROVED') return true;
  return kind.startsWith('critic_') && stateOf(event).includes('PASS');
}

function isGreen(event) {
  const kind = lower(event.kind);
  if (kind === 'ci_pass') return true;
  return (kind === 'check_run' || kind === 'workflow_run') && stateOf(event) === 'SUCCESS';
}

function isRed(event) {
  const kind = lower(event.kind);
  if (kind === 'ci_fail') return true;
  const state = stateOf(event);
  return (kind === 'check_run' || kind === 'workflow_run') && (state === 'FAILURE' || state === 'FAILED' || state === 'CANCELLED');
}

function isShip(event) {
  const kind = lower(event.kind);
  if (kind === 'deploy') return stateOf(event) !== 'FAILURE' && stateOf(event) !== 'FAILED' && stateOf(event) !== 'ERROR' && stateOf(event) !== 'CRASHED';
  return kind === 'op_deploy' && stateOf(event) === 'SUCCESS';
}

const DEFAULT_KINDS = {
  ready: { to: 'reviewer', owes: 'author' },
  critic_fail: { to: 'author', owes: 'reviewer' },
  merge: { to: 'merger', owes: 'author' },
  live_pass: { to: 'reviewer', owes: 'merger' },
  ci_fail: { to: 'author', owes: 'merger' },
};

export function handoffTable(roles) {
  const block = roles && typeof roles.handoffs === 'object' && !Array.isArray(roles.handoffs) ? roles.handoffs : {};
  const kinds = { ...DEFAULT_KINDS };
  if (block.kinds && typeof block.kinds === 'object') {
    for (const [name, row] of Object.entries(block.kinds)) {
      if (!kinds[name] || !row || typeof row !== 'object') continue;
      kinds[name] = {
        to: lower(row.to) || kinds[name].to,
        owes: lower(row.owes) || kinds[name].owes,
      };
    }
  }
  const merger = seatOf(block.merger) || seatOf(roles && roles.seats && roles.seats.builder && roles.seats.builder.seat);
  return { reviewer: seatOf(block.reviewer), merger, kinds };
}

function mappedSeat(map, login) {
  const key = lower(login);
  if (!key || !map) return '';
  if (typeof map.get === 'function') return lower(map.get(key) || '');
  return lower(map[key] || '');
}

function authorSeat(event, map) {
  if (typeof event.author === 'string' && event.author) {
    const mapped = mappedSeat(map, event.author);
    if (mapped) return mapped;
  }
  const kind = lower(event.kind);
  if (kind === 'pr_open' || kind === 'pr_ready') return mappedSeat(map, event.actor || event.sender || '');
  return '';
}

function resolveRole(role, table, author) {
  if (role === 'author') return author;
  if (role === 'reviewer') return table.reviewer;
  if (role === 'merger') return table.merger;
  return '';
}

function make(kind, sha, since) {
  return { kind, sha, since };
}

function walk(events, map) {
  let head = '';
  let sawFail = false;
  let passAt = '';
  let ci = '';
  let merged = false;
  let current = null;
  let author = '';
  const sorted = [...events].sort((a, b) => timeOf(a) - timeOf(b));
  for (const event of sorted) {
    const kind = lower(event.kind);
    const sha = shaOf(event);
    const when = timeOf(event);
    author = author || authorSeat(event, map);
    if (kind === 'pr_open' || kind === 'pr_ready') {
      if (sha) head = sha;
      sawFail = false;
      passAt = '';
      ci = '';
      current = make('ready', head, when);
    } else if (kind === 'pr_close' || kind === 'pr_draft') {
      current = null;
      sawFail = false;
      passAt = '';
      ci = '';
    } else if (HEAD_KINDS.has(kind) && sha && sha !== head) {
      const afterFail = sawFail;
      const afterRed = ci === 'red' || (current && current.kind === 'ci_fail');
      head = sha;
      ci = '';
      passAt = '';
      if (afterFail || (current && current.kind === 'ready')) {
        sawFail = false;
        current = make('ready', head, when);
      } else if (afterRed) {
        sawFail = false;
        current = null;
      }
    } else if (isFail(event)) {
      if (sha) head = sha;
      sawFail = true;
      passAt = '';
      current = make('critic_fail', head, when);
    } else if (isPass(event)) {
      if (sha) head = sha;
      sawFail = false;
      passAt = head;
      current = ci === 'green' ? make('merge', head, when) : null;
    } else if (isGreen(event)) {
      ci = 'green';
      if (passAt && passAt === head) current = make('merge', head, when);
    } else if (isRed(event)) {
      ci = 'red';
      current = make('ci_fail', sha || head, when);
    } else if (kind === 'merged') {
      merged = true;
      if (sha) head = sha;
      current = null;
    } else if (merged && isShip(event)) {
      current = make('live_pass', sha || head, when);
    }
  }
  return { current, author };
}

function isPacket(line, kind) {
  const lineKind = lower(line.kind);
  const type = lower(line.type);
  if (lineKind !== kind) return false;
  return type === 'packet' || type === kind;
}

function shaCovers(lineSha, headSha) {
  const head = lower(headSha);
  const got = lower(lineSha);
  if (!head || !got) return false;
  if (got === head) return true;
  const short = got.length <= head.length ? got : head;
  const long = got.length <= head.length ? head : got;
  return short.length >= 7 && long.startsWith(short);
}

export function packetCovers(lines, obligation) {
  if (!obligation || !obligation.to || !obligation.sha) return false;
  for (const line of lines || []) {
    if (!line || typeof line !== 'object') continue;
    if (!isPacket(line, obligation.kind)) continue;
    const dest = lower(line.seat || line.to);
    if (dest !== obligation.to) continue;
    if (numberOf(line) !== obligation.number) continue;
    if (repoOf(line) !== obligation.repo) continue;
    if (!shaCovers(line.sha, obligation.sha)) continue;
    return true;
  }
  return false;
}

export function handoffObligations(events, roles, loginToSeat) {
  const table = handoffTable(roles);
  const groups = new Map();
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const repo = repoOf(event);
    const number = numberOf(event);
    if (!repo || !number) continue;
    const key = repo + '#' + number;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const out = [];
  for (const [key, group] of groups) {
    const { current, author } = walk(group, loginToSeat);
    if (!current || !current.since) continue;
    const row = table.kinds[current.kind];
    if (!row) continue;
    const repo = key.slice(0, key.lastIndexOf('#'));
    const number = Number(key.slice(key.lastIndexOf('#') + 1));
    out.push({
      key,
      repo,
      number,
      kind: current.kind,
      sha: current.sha,
      since: current.since,
      to: resolveRole(row.to, table, author),
      owes: resolveRole(row.owes, table, author),
    });
  }
  return out;
}

export function missingHandoffs({ events, lines, roles, loginToSeat, now, l1ms }) {
  const wait = Number(l1ms) || 0;
  return handoffObligations(events, roles, loginToSeat)
    .filter(item => item.sha && now - item.since >= wait && !packetCovers(lines, item))
    .map(item => ({ ...item, flag: 'handoff missing' }));
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVIEW_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,6})#(pullrequestreview-\d+|issuecomment-\d+|discussion_r\d+)$/;

export function isHotfixTitle(title) {
  return /^hotfix:/i.test(text(title));
}

export function isMergeHandoff(line) {
  if (!line || typeof line !== 'object') return false;
  if (lower(line.kind) !== 'merge') return false;
  return lower(line.type) === 'packet' || String(line.id || '').includes(':merge:');
}

export function validMergeReview(url, line) {
  if (typeof url !== 'string' || !line || typeof line !== 'object') return false;
  const hit = REVIEW_URL.exec(url);
  if (!hit) return false;
  const repo = (hit[1] + '/' + hit[2]).toLowerCase();
  if (repo !== lower(line.repo)) return false;
  return Number(hit[3]) === numberOf(line);
}

export function hotfixMergeLine({ repo, number, sha, reviewer, from, t_ct }) {
  const raw = text(repo);
  if (!REPO_RE.test(raw)) return null;
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || n > 9999999) return null;
  const head = lower(sha);
  if (!/^[0-9a-f]{7,64}$/.test(head)) return null;
  const to = lower(reviewer) || 'critic';
  const src = lower(from) || 'forge';
  if (!/^[a-z0-9-]{2,16}$/.test(to) || !/^[a-z0-9-]{2,16}$/.test(src)) return null;
  return {
    id: `handoff:${raw.toLowerCase()}#${n}:merge:${head}`,
    t_ct: text(t_ct) || new Date().toISOString(),
    seat: to,
    from: src,
    to,
    type: 'packet',
    kind: 'merge',
    repo: raw,
    number: n,
    sha: head,
    title: 'handoff merge',
    url: `https://github.com/${raw}/pull/${n}`,
    reason: 'handoff merge',
  };
}
