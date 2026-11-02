// The default seat read is a queue head. Stored lines stay until close, merge, or an ack.
// Ready handoffs come first. With a seat, the rest of the head is every card whose
// packet names that seat as R. Hotfix, then P0, then P1 sort ahead of the other cards.
// While that head is open, nudges and station lines stay in the backlog. A read does not pop.

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

export function rSeat(raci) {
  const match = String(raci || '').match(/\bR=([A-Za-z][A-Za-z0-9_-]*)/);
  return match ? match[1].toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
}

function cardPacketText(card) {
  if (!card) return '';
  const packet = card.packet || {};
  return [card.title, packet.goal, packet.acceptance, packet.raci, packet.path].filter(Boolean).join('\n');
}

function packetLevel(card) {
  const text = cardPacketText(card);
  if (/^hotfix:/im.test(text)) return 0;
  if (/\bP0\b/.test(text)) return 1;
  if (/\bP1\b/.test(text)) return 2;
  return 3;
}

function isPriority(line, cardTitle, card, seat) {
  if (seat) {
    const who = String(seat || '').toLowerCase();
    return who !== '' && rSeat((card && card.packet || {}).raci) === who;
  }
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

function byLevel(a, b) {
  const d = (a.level ?? 3) - (b.level ?? 3);
  if (d) return d;
  return byAge(a, b);
}

function zombieHandoff(line, card) {
  const type = String(line && line.type || '').toLowerCase();
  const kind = String(line && line.kind || '').toLowerCase();
  if (type !== 'packet' || (kind !== 'ready' && kind !== 'merge')) return false;
  if (!card || card.kind == null) return false;
  return String(card.kind) !== 'pr';
}

function ranked(lines, opts) {
  const titleOf = typeof opts.titleOf === 'function' ? opts.titleOf : () => '';
  const cardOf = typeof opts.cardOf === 'function' ? opts.cardOf : () => null;
  const seat = String(opts.seat || '');
  return (Array.isArray(lines) ? lines : []).filter(Boolean).map((line, index) => {
    const card = cardOf(line);
    const cardTitle = (card && card.title) || titleOf(line) || '';
    let rank = lineRank(line, cardTitle);
    if (zombieHandoff(line, card)) rank = 2;
    const priority = isPriority(line, cardTitle, card, seat);
    const named = rSeat((card && card.packet || {}).raci);
    if (seat && rank !== 0 && rank !== 3 && rank !== 4 && named !== seat.toLowerCase()) rank = 2;
    if (priority && rank !== 0 && rank !== 3 && rank !== 4) rank = 1;
    return { line, index, rank, priority, level: packetLevel(card) };
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
  const seat = String(opts.seat || '');
  const rows = ranked(lines, opts);
  const ready = pick(rows, 0);
  const priority = rows.filter((row) => row.rank === 1 && row.priority).sort(seat ? byLevel : byAge).map((row) => row.line);
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

export function liveLine(lines, opts = {}) {
  const head = queueView(lines, opts);
  return head.length ? [head[0]] : [];
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
  const cardOf = typeof opts.cardOf === 'function' ? opts.cardOf : () => null;
  return head.filter((line) => {
    const type = String(line && line.type || '').toLowerCase();
    const kind = String(line && line.kind || '').toLowerCase();
    if (type === 'packet' && HEAD_KINDS.has(kind)) return true;
    const card = cardOf(line);
    const cardTitle = (card && card.title) || titleOf(line) || '';
    return isPriority(line, cardTitle, card, opts.seat || '');
  });
}

export function markShed(line, openLines, opts = {}) {
  if (!line || line.shed) return line;
  if (!overWip(openLines, opts)) return line;
  const titleOf = typeof opts.titleOf === 'function' ? opts.titleOf : () => '';
  const cardOf = typeof opts.cardOf === 'function' ? opts.cardOf : () => null;
  const card = cardOf(line);
  const cardTitle = (card && card.title) || titleOf(line) || '';
  const type = String(line.type || '').toLowerCase();
  const kind = String(line.kind || '').toLowerCase();
  if (type === 'packet' && HEAD_KINDS.has(kind)) return line;
  if (isPriority(line, cardTitle, card, opts.seat || '')) return line;
  if (type === 'nudge' || kind === 'station') return line;
  return { ...line, shed: true };
}
