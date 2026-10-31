// The default seat read is a queue head. Stored lines stay until close, merge, or an ack.
// Ready handoffs, a hotfix, and P0/P1 are the head. While that head is open, nudges and
// station lines stay in the backlog. A read does not pop.

const P_MARK = /\bP[01]\b/;
const HEAD_KINDS = new Set(['ready', 'merge', 'critic_fail', 'ci_fail', 'live_pass']);
const REAL_TYPES = new Set(['issue_open', 'issue_comment', 'pr_comment', 'review', 'review_comment', 'comment']);
const WAKE_WIP = 8;

function lineText(line, cardTitle) {
  const title = String(line && line.title || '');
  const reason = String(line && line.reason || '');
  const labels = Array.isArray(line && line.labels) ? line.labels.join(' ') : '';
  return `${title}\n${reason}\n${labels}\n${cardTitle || ''}`;
}

export function lineRank(line, cardTitle = '') {
  const type = String(line && line.type || '').toLowerCase();
  const kind = String(line && line.kind || '').toLowerCase();
  const title = String(line && line.title || '');
  const text = lineText(line, cardTitle);
  if (type === 'packet' && HEAD_KINDS.has(kind)) return 0;
  if (/^hotfix:/i.test(title) || P_MARK.test(text)) return 1;
  if (kind === 'station') return 4;
  if (type === 'nudge') return 3;
  if (REAL_TYPES.has(type)) return 1;
  return 2;
}

function isPriority(line, cardTitle) {
  const title = String(line && line.title || '');
  return /^hotfix:/i.test(title) || P_MARK.test(lineText(line, cardTitle));
}

function byAge(a, b) {
  const ta = String(a.line.t_ct || '');
  const tb = String(b.line.t_ct || '');
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return a.index - b.index;
}

function ranked(lines, titleOf) {
  const name = typeof titleOf === 'function' ? titleOf : () => '';
  return (Array.isArray(lines) ? lines : []).filter(Boolean).map((line, index) => {
    const cardTitle = name(line) || '';
    return { line, index, rank: lineRank(line, cardTitle), priority: isPriority(line, cardTitle) };
  });
}

function newestFirst(a, b) {
  return byAge(b, a);
}

function pick(rows, rank) {
  return rows.filter((row) => row.rank === rank).sort(byAge).map((row) => row.line);
}

export function queueView(lines, opts = {}) {
  const wip = Number.isInteger(opts.wip) ? opts.wip : WAKE_WIP;
  const rows = ranked(lines, opts.titleOf);
  const ready = pick(rows, 0);
  const priority = rows.filter((row) => row.rank === 1 && row.priority).sort(byAge).map((row) => row.line);
  const rest = rows.filter((row) => row.rank === 1 && !row.priority && !row.line.shed).sort(newestFirst).slice(0, opts.nudge ? 0 : wip).map((row) => row.line);
  const head = [...ready, ...priority, ...rest];
  if (head.length) return head;
  const real = pick(rows, 2);
  if (real.length) return real;
  const nudge = pick(rows, 3);
  if (nudge.length) return [nudge[0]];
  const station = pick(rows, 4);
  if (station.length) return [station[station.length - 1]];
  return [];
}

export function backlogOf(lines, opts = {}) {
  const head = new Set(queueView(lines, opts).map((line) => line && line.id));
  return (Array.isArray(lines) ? lines : []).filter((line) => line && !head.has(line.id));
}

export function keepStation(lines) {
  return !(Array.isArray(lines) ? lines : []).some(Boolean);
}

export function overWip(lines, opts = {}) {
  return backlogOf(lines, opts).length > 0;
}

export function nudgeTargets(lines, opts = {}) {
  const head = queueView(lines, opts);
  if (!overWip(lines, opts)) return head;
  const titleOf = typeof opts.titleOf === 'function' ? opts.titleOf : () => '';
  return head.filter((line) => {
    const type = String(line && line.type || '').toLowerCase();
    const kind = String(line && line.kind || '').toLowerCase();
    if (type === 'packet' && HEAD_KINDS.has(kind)) return true;
    return isPriority(line, titleOf(line) || '');
  });
}

export function markShed(line, openLines, opts = {}) {
  if (!line || line.shed) return line;
  if (!overWip(openLines, opts)) return line;
  const titleOf = typeof opts.titleOf === 'function' ? opts.titleOf : () => '';
  const cardTitle = titleOf(line) || '';
  const type = String(line.type || '').toLowerCase();
  const kind = String(line.kind || '').toLowerCase();
  if (type === 'packet' && HEAD_KINDS.has(kind)) return line;
  if (isPriority(line, cardTitle)) return line;
  if (type === 'nudge' || kind === 'station') return line;
  return { ...line, shed: true };
}
