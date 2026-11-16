// Per-seat wake filter. The line still lands on the board. A skip is reason "filter".
// SEAT_WAKE_FILTER is "actionable" (default), "all", or JSON {mode, seats}.
// fleet-roster.json "wake_filter" is the same JSON when the env var is unset.
// A seat override of "all" keeps the old wake. "actionable" forces the filter.

const HOUR_MS = 60 * 60 * 1000;
const REVIEW = new Set(['review', 'critic_pass', 'critic_fail', 'verdict']);
const GREEN = new Set(['ci_pass', 'ready', 'live_pass']);
const DIRECT = new Set(['dispatch', 'packet', 'handoff', 'start_after']);
const COMMENT = new Set(['pr_comment', 'issue_comment', 'review_comment', 'comment']);
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

function greenKey(line) {
  const sha = String(line && line.sha || '').trim().toLowerCase();
  return `${String(line && line.repo || '').toLowerCase()}#${Number(line && line.number) || 0}|${sha || String(line && line.id || '')}`;
}

function slots(state) {
  if (!state.stationAt) state.stationAt = new Map();
  if (!state.greenHeads) state.greenHeads = new Set();
  return state;
}

function stationOpen(state, seat, now) {
  const prev = slots(state).stationAt.get(seat) || 0;
  return !(prev && now - prev < HOUR_MS);
}

function greenOpen(state, line) {
  return !slots(state).greenHeads.has(greenKey(line));
}

// The hour and the green head live on the wake state. A restart clears both.
// Call this only after the gate sends or queues. A skip must leave the slot open.
export function commitWake(state, seat, line, now) {
  const book = slots(state);
  const who = String(seat || '').toLowerCase();
  if (stationLine(line)) book.stationAt.set(who, now);
  if (who === 'critic' && GREEN.has(kindOf(line))) book.greenHeads.add(greenKey(line));
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
  if (kind === 'ci_fail' && (!ctx.owner || ctx.owner === who) && currentHead(line, ctx.head)) return { allow: true };
  // Seat comments still reach the gate, so the breaker and the repeat rules stay as they are.
  if (COMMENT.has(kind) || kind === 'needs_human') return { allow: true };
  if (who === 'critic' && GREEN.has(kind) && greenOpen(state, line)) return { allow: true };
  if (who === 'critic' && GREEN.has(kind)) return { allow: false, reason: 'filter' };
  if (assignedR(line, who)) return { allow: true };
  return { allow: false, reason: 'filter' };
}
