// Governor (tripwire), ported from house/live-mesh/tripwire_push.py (#227) into the server: one tick hashes what
// matters and acts only on a real change. The fingerprint is the real events (a feed_push record never trips it, so
// no self-loop; a generated_at bump never trips it) plus the open nudges (evalNudges) and routing state.
import crypto from 'node:crypto';

export function realEvents(events) {
  return (Array.isArray(events) ? events : []).filter(e => !(e && typeof e === 'object' && e.kind === 'feed_push'));
}

export function fingerprint(events, watch = {}) {
  const ev = realEvents(events).map(e => [e.id, e.kind, e.t_ct, e.state ?? null, e.sha ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify({ ev, watch })).digest('hex');
}

/** tripwire(): call once per tick with the current fingerprint; true only when it changed since the last call. */
export function tripwire() {
  let last = null;
  return fp => { if (fp === last) return false; last = fp; return true; };
}

// Timed run (the clock). The tripwire is the trigger once nothing has moved for tripMs:
//   stall: open cards on the board -> each seat with open work is woken with its own deadline (perSeatMs apart).
//          A due plan card does not hide this. The CoS seat is included so the plan still wakes.
//          A seat whose open lines are only nudges is not woken. The nudge is that wake.
//          Live cards and no inbox lines wake the CoS seat.
//   plan: the plan card is due and the board has no other open card -> the CoS seat is woken once;
//   empty: no open cards -> the CoS (coord role) seat is woken to pull the next work.
//          Weekly burn at or above 75% keeps that wake quiet (no seat is woken).
// The CoS can start the same run by hand (POST /clock), including the empty-board wake.
// A seat move clears the clock. A trigger fires once for a still board and waits for the next move.
/** Seats marked parked or dark. A roster without those arrays uses fallback. */
export function mutedSeats(roster, fallback = []) {
  const data = roster && typeof roster === 'object' ? roster : {};
  const parked = Array.isArray(data.parked) ? data.parked : fallback;
  const dark = Array.isArray(data.dark) ? data.dark : [];
  return new Set([...parked, ...dark].map((seat) => String(seat).toLowerCase()).filter(Boolean));
}

/** Seats the stall may wake. Muted seats are out unless an owner prompt just woke them. Line counts on muted seats do not cancel the stall. */
export function selectStallSeats(ids, muted, openCounts, prompted) {
  const mute = new Set([...(muted instanceof Set ? muted : (muted || []))].map((seat) => String(seat).toLowerCase()));
  const woke = new Set([...(prompted instanceof Set ? prompted : (prompted || []))].map((seat) => String(seat).toLowerCase()));
  const counts = openCounts && typeof openCounts === 'object' ? openCounts : {};
  return (Array.isArray(ids) ? ids : []).filter((seat) => {
    const name = String(seat || '').toLowerCase();
    if (!name || name === 'builder' || name === 'builder-cloud') return false;
    const lines = Number(counts[seat] ?? counts[name] ?? 0);
    const promptedSeat = woke.has(name);
    if (mute.has(name) && !promptedSeat) return false;
    return lines > 0 || promptedSeat;
  });
}

export function wakeTitle(run, seat, openCount) {
  if (!run) return '';
  if (run.reason === 'empty') return 'board empty';
  if (run.reason === 'plan' || (run.planSeat && seat === run.planSeat)) return 'plan next wave';
  return `timed run: ${openCount} open line(s)`;
}

const STALL_NOISE = new Set([
  'feed_push', 'check_run', 'check_suite', 'workflow_run', 'ci_pass', 'ci_fail', 'pr_commit', 'commit_status',
  'health_ok', 'health_fail', 'deploy', 'deploy_fail', 'deploy_pending', 'op_deploy', 'probe',
]);

/** A feed row that resets the stall clock. CI, deploys, health, X, and seat presence do not. */
export function stallMove(e) {
  if (!e || typeof e !== 'object' || e.moves === false) return false;
  const k = typeof e.kind === 'string' ? e.kind : '';
  if (!k || STALL_NOISE.has(k)) return false;
  if (/watcher|turn|subagent/.test(k)) return false;
  if (k.startsWith('x_') || k.startsWith('seat_')) return false;
  return true;
}

/** Who the clock wakes for this board, or quiet when weekly burn holds an empty board. */
export function runChoice(board) {
  const { openCards = 0, openSeats = [], coord = null, scheduled = 0, planDue = false, burnQuiet = false, nudgeCovered = false } = board || {};
  if (openCards > 0) {
    let seats = openSeats.length ? [...openSeats] : [];
    if (!seats.length) {
      if (nudgeCovered || !coord) return null;
      seats = [coord];
    }
    if (planDue && coord && !seats.includes(coord)) seats.push(coord);
    seats = seats.filter(Boolean);
    if (!seats.length) return null;
    return { seats, reason: 'stall', planSeat: planDue ? coord : null };
  }
  if (planDue && coord) return { seats: [coord], reason: 'plan', planSeat: coord };
  if (scheduled > 0 || !coord) return null;
  if (burnQuiet) return { seats: [], reason: 'quiet' };
  return { seats: [coord], reason: 'empty', planSeat: null };
}

export function createClock({ tripMs, perSeatMs, now = Date.now(), state = null }) {
  const saved = state && typeof state === 'object' ? state : null;
  let lastFp = saved && saved.lastFp != null ? saved.lastFp : null;
  let lastMove = saved && Number.isFinite(saved.lastMove) ? saved.lastMove : now;
  let lastTrip = saved && Number.isFinite(saved.lastTrip) ? saved.lastTrip : null;
  let run = saved && saved.run ? saved.run : null;
  const start = (t, seats, reason, by, extra = {}) => {
    const order = [...new Set(seats)].filter(Boolean);
    const deadlines = Object.fromEntries(order.map((s, i) => [s, new Date(t + (i + 1) * perSeatMs).toISOString()]));
    run = { started_at: new Date(t).toISOString(), reason, by: by || null, deadlines,
      ends_at: order.length ? deadlines[order.at(-1)] : new Date(t).toISOString(),
      planSeat: extra.planSeat || null };
    lastTrip = t;
    return run;
  };
  return {
    get run() { return run; },
    snapshot() { return { lastFp, lastMove, lastTrip, run }; },
    /** -> 'plan' | 'stall' | 'empty' | 'quiet' | 'cleared' | null.
     *  moveFp: fingerprint of board moves (events, acks); board: { openCards, openSeats, coord, planDue, burnQuiet, nudgeCovered }.
     *  A due plan does not hide a stall: seats with open work are still woken.
     *  burnQuiet skips the empty-board wake and does not start a run.
     *  A fire waits for the next fingerprint change. */
    observe(moveFp, t, board) {
      if (moveFp !== lastFp) {
        const first = lastFp === null; lastFp = moveFp; lastMove = t; lastTrip = null;
        if (!first && run) { run = null; return 'cleared'; }
        return null;
      }
      if (lastTrip !== null || t - lastMove < tripMs) return null;
      const choice = runChoice(board);
      if (!choice) return null;
      if (choice.reason === 'quiet') { lastTrip = t; return 'quiet'; }
      start(t, choice.seats, choice.reason, null, { planSeat: choice.planSeat || null });
      return choice.reason;
    },
    startFromBoard(t, board, by) {
      const choice = runChoice(board);
      if (!choice || choice.reason === 'quiet' || !choice.seats.length) return null;
      const reason = choice.reason === 'stall' ? 'cos' : choice.reason;
      return start(t, choice.seats, reason, by || null, { planSeat: choice.planSeat || null });
    },
  };
}

/** Inbox noise the stall should not count as open work: clock lines and ladder nudges. */
export function isClockNudge(line) {
  const type = String(line && (line.type || line.kind) || '').toLowerCase();
  if (type === 'nudge' || type === 'timed_run' || type === 'clock') return true;
  const id = String(line && line.id || '');
  return id.startsWith('nudge:') || id.startsWith('clock:');
}

/** Stable key for one stale work item. The same card stays one key even when a breaker id rolls the hour. */
export function stallWorkKey(line) {
  if (!line || isClockNudge(line)) return '';
  const repo = String(line.repo || '').trim().toLowerCase();
  const n = Number(line.number);
  if (repo && Number.isInteger(n) && n > 0) return repo + '#' + n;
  return String(line.id || '').trim();
}

export function unackedWorkCount(lines) {
  return (Array.isArray(lines) ? lines : []).filter(line => !isClockNudge(line)).length;
}

/** Line id and, when present, the card. A rolling breaker id and its card stay one stale item. */
export function stallLineKeys(line) {
  if (!line || isClockNudge(line)) return [];
  const keys = [];
  const id = String(line.id || '').trim();
  if (id) keys.push(id);
  const repo = String(line.repo || '').trim().toLowerCase();
  const n = Number(line.number);
  if (repo && Number.isInteger(n) && n > 0) {
    const card = repo + '#' + n;
    if (card !== id) keys.push(card);
  }
  return keys;
}

export function stallWorkKeys(lines) {
  const keys = [];
  const seen = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const key of stallLineKeys(line)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function lineAlreadyFired(line, firedSet) {
  const keys = stallLineKeys(line);
  return !!keys.length && keys.some(key => firedSet.has(key));
}

/** Drop this line's id and card key so a later stale line on the same card can fire again. */
export function clearStallFired(fired, line) {
  const set = fired instanceof Set ? fired : loadStallFired(fired);
  for (const key of stallLineKeys(line)) set.delete(key);
  return set;
}

export function rememberStallFired(fired, line) {
  const set = fired instanceof Set ? fired : loadStallFired(fired);
  for (const key of stallLineKeys(line)) set.add(key);
  return set;
}

/** Update the existing inbox row in place. Same id. The nudge time is nudged_at. t_ct stays. Never appends. */
export function applyLineNudge(inbox, lineId, { level, t_ct, woken } = {}) {
  const rows = Array.isArray(inbox) ? inbox : [];
  const id = String(lineId || '').trim();
  const line = id ? rows.find(row => row && String(row.id) === id) : null;
  if (!line) return { inbox: rows, line: null, wake: false, count: unackedWorkCount(rows) };
  const baseReason = String(line.reason || '').replace(/^nudge L\d:\s*/i, '');
  line.nudge_level = level;
  if (t_ct) line.nudged_at = t_ct;
  line.reason = ('nudge L' + level + ': ' + baseReason).slice(0, 300);
  const wokenSet = woken instanceof Set ? woken : null;
  const wake = !wokenSet || !lineAlreadyFired(line, wokenSet);
  if (wokenSet && wake) {
    for (const key of stallLineKeys(line)) wokenSet.add(key);
  }
  return { inbox: rows, line, wake, count: unackedWorkCount(rows) };
}

export function loadStallFired(rows) {
  return new Set((Array.isArray(rows) ? rows : []).map(x => String(x || '').trim()).filter(Boolean));
}

export function dumpStallFired(fired, cap = 2000) {
  const ids = [...(fired instanceof Set ? fired : [])];
  return ids.length > cap ? ids.slice(-cap) : ids;
}

/** Who the stall clock may still ring, and the unacked work count for the title. */
export function planStallWakes({ reason, deadlines, openBySeat, fired, cap = 2000 }) {
  const firedSet = fired instanceof Set ? fired : loadStallFired(fired);
  const wakes = [];
  const nextFired = new Set(firedSet);
  for (const seat of Object.keys(deadlines || {})) {
    const open = openBySeat && openBySeat[seat] ? openBySeat[seat] : [];
    const openCount = unackedWorkCount(open);
    if (reason === 'stall') {
      const work = (Array.isArray(open) ? open : []).filter(line => !isClockNudge(line));
      const fresh = work.filter(line => !lineAlreadyFired(line, firedSet));
      if (!fresh.length) continue;
      for (const key of stallWorkKeys(fresh)) nextFired.add(key);
    }
    wakes.push({ seat, openCount });
  }
  const kept = dumpStallFired(nextFired, cap);
  return { wakes, fired: new Set(kept) };
}

