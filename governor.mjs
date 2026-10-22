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
//   plan: the plan card is due and the board has no other open card -> the CoS seat is woken once;
//   empty: no open cards -> the CoS (coord role) seat is woken to pull the next work.
//          Weekly burn at or above 75% keeps that wake quiet (no seat is woken).
// The CoS can start a run by hand (POST /clock). Blockers come back as one line; the countdown shows on the board until a
// seat moves something, which clears the clock. Each trigger fires at most once per window: it re-arms only after the
// board moves or another full window passes, never on every tick.
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
     *  moveFp: fingerprint of seat moves (events, acks); board: { openCards, openSeats, coord, planDue, burnQuiet }.
     *  A due plan does not hide a stall: seats with open work are still woken.
     *  burnQuiet skips the empty-board wake and does not start a run. */
    observe(moveFp, t, board) {
      if (moveFp !== lastFp) {
        const first = lastFp === null; lastFp = moveFp; lastMove = t; lastTrip = null;
        if (!first && run) { run = null; return 'cleared'; }
        return null;
      }
      const armed = lastTrip === null || t - lastTrip >= tripMs;
      if (!armed || t - lastMove < tripMs) return null;
      const { openCards = 0, openSeats = [], coord = null, scheduled = 0, planDue = false, burnQuiet = false } = board || {};
      if (openCards > 0) {
        const seats = openSeats.length ? [...openSeats] : [coord];
        if (planDue && coord && !seats.includes(coord)) seats.push(coord);
        if (!seats.filter(Boolean).length) return null;
        start(t, seats, 'stall', null, { planSeat: planDue ? coord : null });
        return 'stall';
      }
      if (planDue && coord) { start(t, [coord], 'plan', null, { planSeat: coord }); return 'plan'; }
      if (scheduled > 0) return null;   // a card waiting on start_after is not an empty board
      if (!coord) return null;
      if (burnQuiet) { lastTrip = t; return 'quiet'; }   // 75% weekly burn: no empty-board wake
      start(t, [coord], 'empty'); return 'empty';
    },
    startByHand(t, seats, by) { return start(t, seats, 'cos', by); },
  };
}
