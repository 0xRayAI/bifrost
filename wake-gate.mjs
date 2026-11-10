// Wake gate. One seat is woken for real new work. The field for a P1 mark is `labels`.
// Unassigned issue_open (and a P1 label on an issue) wakes the default seat. That is forge, or arch1 when forge is dark. Blinky's routed copy is stored, not woken.
// A pr_comment stored for blinky and the author wakes the author. Blinky is the extra copy.
// A missing sha is never a repeat. The hour is a rolling 60 minutes. flag: hotfix skips the cap and the kind cooldown.
// A comment authored by a fleet seat bot (line.from is a fleet seat id) never wakes another fleet seat. It stays on the
// board only, unless it carries a real change: a new head sha, a verdict, or a handoff kind. Human comments (no seat
// `from`) wake as before. A seat outside the fleet (cfg.isExternal, the roster's `outside` list, e.g. arch1) is not
// filtered either way: a comment to it or from it wakes as before, and the breaker never pauses it. Forge tips an
// outside party only by @-mentioning it in a comment.
// The repeat key of a seat comment is repo#n plus the head sha, or `nosha`. It is never the comment id.
// More than SEAT_COMMENT_LIMIT seat comments on one repo#n inside a rolling hour trips a breaker: that repo#n is paused
// for an hour (a human comment clears it) and one needs_human line goes to the coordinator for Blaze.

export const ROLLING_HOUR_MS = 60 * 60 * 1000;
const COMMENT = new Set(['pr_comment', 'issue_comment', 'review_comment', 'comment']);
export const SEAT_COMMENT_LIMIT = 3;
const REAL_CHANGE_KINDS = new Set(['ready', 'critic_fail', 'live_pass', 'merge', 'ci_fail', 'ci_pass', 'review', 'verdict']);
const DEFAULT_SEATS = ['builder', 'builder-cloud', 'arch1', 'forge', 'critic', 'blinky', 'herald', 'nibbler', 'sound', 'magnet'];

const num = (env, name) => {
  if (env[name] == null || String(env[name]).trim() === '') return null;
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function wakeConfig(env = {}) {
  const raw = env.BIFROST_WAKES == null ? '' : String(env.BIFROST_WAKES).trim().toLowerCase();
  const batchS = num(env, 'WAKE_BATCH_S');
  const debounceS = num(env, 'WAKE_DEBOUNCE_S');
  const coolS = num(env, 'WAKE_KIND_COOLDOWN_S');
  const max = num(env, 'WAKE_MAX_PER_HOUR');
  const turnMin = num(env, 'LIVE_TURN_OPEN_MIN');
  const statH = num(env, 'WAKE_STAT_H');
  return {
    paused: raw === 'off' || raw === '0' || raw === 'false' || raw === 'no',
    batchMs: (batchS != null ? batchS : debounceS != null ? debounceS : 60) * 1000,
    cooldownMs: (coolS != null ? coolS : 900) * 1000,
    maxPerHour: max != null ? max : 6,
    turnOpenMs: (turnMin != null ? turnMin : 20) * 60000,
    statMs: (statH != null ? statH : 24) * 3600000,
  };
}

export function defaultIssueSeat(env = {}) {
  const mode = String(env.LIVE_MODE || env.BIFROST_LIVE_MODE || '').trim().toLowerCase();
  const dark = String(env.FORGE_DARK || '').trim().toLowerCase();
  if (mode === 'arch1' || mode === 'arch1-only' || dark === '1' || dark === 'true' || dark === 'on') return 'arch1';
  return 'forge';
}

export function createWakeState() {
  return {
    sentSha: new Map(), queuedSha: new Map(), cool: new Map(), sentAt: new Map(), turnOpen: new Map(),
    commentSha: new Map(), seatComments: new Map(), breaker: new Map(),
    hold: [], sent: [], skips: [],
  };
}

const seatOf = line => String(line && line.seat || '').trim().toLowerCase();
const typeOf = line => String(line && (line.type || line.kind) || '').trim().toLowerCase();
const repoKey = line => `${String(line && line.repo || '').trim().toLowerCase()}#${Number.isInteger(line && line.number) ? line.number : Number(line && line.number) || 0}`;
const shaKeyOf = (seat, line) => `${seat}|${repoKey(line)}`;
const coolKeyOf = (seat, line) => `${seat}|${typeOf(line)}|${repoKey(line)}`;
const kindOf = line => String(line && line.kind || '').trim().toLowerCase();
export const isCommentLine = line => COMMENT.has(typeOf(line));
/** The repeat key of a comment line: the issue or PR plus the linked head sha, or `nosha`. Never the comment id. */
export const commentRepeatKey = (seat, line) => `${seat}|${repoKey(line)}|${shaOf(line) || 'nosha'}`;

export function hasSha(line) {
  return !!(line && typeof line.sha === 'string' && line.sha.trim());
}
function shaOf(line) { return hasSha(line) ? line.sha.trim() : ''; }

export function labelsOf(line) {
  const raw = line && line.labels;
  const list = Array.isArray(raw) ? raw : [];
  return list.map(item => String(item).trim().toLowerCase()).filter(Boolean);
}
const isPr = line => /^pr_/.test(typeOf(line)) || typeOf(line) === 'pr';
const isIssue = line => /^issue_/.test(typeOf(line)) || typeOf(line) === 'issue';
export function isP1Issue(line) {
  return isIssue(line) && !isPr(line) && labelsOf(line).includes('p1');
}
const isIssueOpen = line => typeOf(line) === 'issue_open';
export function isHotfix(line) {
  return String(line && line.flag || '').trim().toLowerCase() === 'hotfix';
}
export function isLadder(line) {
  if (!line) return false;
  if (line.clock === true) return true;
  if (typeOf(line) === 'timed_run') return true;
  if (String(line.id || '').startsWith('clock:')) return true;
  const reason = String(line.reason || '');
  if (/^nudge L\d/i.test(reason)) return true;
  if (/^L3 no move/i.test(reason)) return true;
  if (/handoff missing/i.test(reason)) return true;
  if (/^L3 handoff/i.test(reason)) return true;
  return false;
}

export function viewLine(line) {
  const out = {
    id: String(line && line.id || '').slice(0, 300),
    type: String(line && line.type || line.kind || '').slice(0, 64),
    repo: String(line && line.repo || '').slice(0, 200),
    number: Number.isInteger(line && line.number) ? line.number : (Number.isFinite(Number(line && line.number)) ? Number(line.number) : 0),
    title: String(line && line.title || '').slice(0, 200),
    url: String(line && line.url || '').slice(0, 500),
    reason: String(line && line.reason || '').slice(0, 300),
  };
  if (hasSha(line)) out.sha = line.sha.trim().slice(0, 80);
  if (Array.isArray(line && line.labels) && line.labels.length) out.labels = line.labels.slice(0, 20).map(item => String(item).slice(0, 40));
  if (line && line.flag) out.flag = String(line.flag).slice(0, 40);
  if (line && line.kind) out.kind = String(line.kind).slice(0, 64);
  if (line && line.clock) out.clock = true;
  return out;
}

function authorIndex(rows, idxs) {
  const named = idxs.find(i => /comment on your/i.test(String(rows[i].line.reason || '')));
  if (named != null) return named;
  const others = idxs.filter(i => rows[i].seat !== 'blinky');
  if (idxs.some(i => rows[i].seat === 'blinky') && others.length === 1) return others[0];
  return null;
}

// Routed seat, then handoff `to`, then the card owner, then the default seat for an unassigned issue.
// Blinky keeps the inbox copy for an unassigned issue and for a comment the author also received.
export function classifyBatch(lines, ctx = {}) {
  const ownerOf = typeof ctx.owner === 'function' ? ctx.owner : () => '';
  const rows = (Array.isArray(lines) ? lines : []).filter(Boolean).map(line => ({ line, seat: seatOf(line) }));
  const skips = [];
  const wakes = [];
  const consumed = new Set();

  const comments = new Map();
  rows.forEach((row, i) => {
    if (!COMMENT.has(typeOf(row.line))) return;
    const key = `${repoKey(row.line)}|${String(row.line.id || '')}`;
    if (!comments.has(key)) comments.set(key, []);
    comments.get(key).push(i);
  });
  for (const idxs of comments.values()) {
    const author = authorIndex(rows, idxs);
    if (author == null) continue;
    for (const i of idxs) {
      if (rows[i].seat === 'blinky' && i !== author) {
        skips.push({ seat: 'blinky', line: rows[i].line, reason: 'fanout' });
        consumed.add(i);
      }
    }
  }

  const issues = new Map();
  rows.forEach((row, i) => {
    if (consumed.has(i)) return;
    if (!isIssueOpen(row.line) && !isP1Issue(row.line)) return;
    const key = repoKey(row.line);
    if (!issues.has(key)) issues.set(key, []);
    issues.get(key).push(i);
  });
  for (const idxs of issues.values()) {
    const sample = rows[idxs[0]].line;
    const owner = String(ownerOf(sample) || '').trim().toLowerCase();
    const fallback = String(ctx.defaultSeat || 'forge').trim().toLowerCase() || 'forge';
    const target = owner || fallback;
    let woke = false;
    for (const i of idxs) {
      const row = rows[i];
      if (row.seat === 'blinky' && target !== 'blinky') {
        skips.push({ seat: 'blinky', line: row.line, reason: 'fanout' });
        consumed.add(i);
        continue;
      }
      if (!woke) {
        wakes.push({ seat: target, line: row.line });
        woke = true;
        consumed.add(i);
        continue;
      }
      skips.push({ seat: row.seat, line: row.line, reason: 'fanout' });
      consumed.add(i);
    }
    if (!woke) wakes.push({ seat: target, line: sample });
  }

  rows.forEach((row, i) => {
    if (consumed.has(i)) return;
    const line = row.line;
    const type = typeOf(line);
    if (type === 'ack' || String(line.kind || '').toLowerCase() === 'ack') {
      skips.push({ seat: row.seat, line, reason: 'ack' });
      return;
    }
    if (type === 'turn' || String(line.kind || '').toLowerCase() === 'turn') {
      skips.push({ seat: row.seat, line, reason: 'turn' });
      return;
    }
    if (isLadder(line)) {
      const seat = row.seat || String(line.to || '').trim().toLowerCase();
      if (!seat) { skips.push({ seat: '', line, reason: 'unassigned' }); return; }
      wakes.push({ seat, line: { ...line, clock: true } });
      return;
    }
    let seat = row.seat;
    if (!seat && line.to) seat = String(line.to).trim().toLowerCase();
    if (!seat) {
      const owner = String(ownerOf(line) || '').trim().toLowerCase();
      if (owner) seat = owner;
    }
    if (!seat) { skips.push({ seat: '', line, reason: 'unassigned' }); return; }
    if (String(line.from || '').trim().toLowerCase() === seat) {
      skips.push({ seat, line, reason: 'own_post' });
      return;
    }
    wakes.push({ seat, line });
  });
  return { wakes, skips };
}

function hourStamps(state, seat, now) {
  return (state.sentAt.get(seat) || []).filter(t => now - t < ROLLING_HOUR_MS && now - t >= 0);
}

/** Lines held only until the open turn window are due when that turn ends. A longer cooldown stays held. */
export function releaseForTurn(state, seat, started, now, turnOpenMs) {
  const cap = started + turnOpenMs;
  const due = [];
  const rest = [];
  for (const item of state.hold || []) {
    if (item && item.seat === seat && item.until <= cap) {
      const key = shaKeyOf(seat, item.line);
      if (state.queuedSha && state.queuedSha.get(key)) state.queuedSha.delete(key);
      due.push(item.line);
    } else rest.push(item);
  }
  state.hold = rest;
  return due;
}

function seatTest(cfg) {
  if (cfg && typeof cfg.isSeat === 'function') return cfg.isSeat;
  const known = new Set(DEFAULT_SEATS);
  return from => known.has(String(from || '').trim().toLowerCase());
}
/** True for a seat outside the fleet (the roster's `outside` list). Nothing is outside unless the config says so. */
export function isExternalSeat(seat, cfg) {
  return !!(cfg && typeof cfg.isExternal === 'function' && cfg.isExternal(String(seat || '').trim().toLowerCase()));
}
/** True when a comment line was written by a fleet seat bot. A comment from an outside seat is a person's comment here. */
export function isSeatComment(line, cfg) {
  if (!isCommentLine(line)) return false;
  const from = String(line.from || '').trim().toLowerCase();
  return !!from && seatTest(cfg)(from) && !isExternalSeat(from, cfg);
}
/** A comment that reports something CI or the board did not already say: a handoff kind or a verdict. */
export function carriesRealChange(line) {
  return REAL_CHANGE_KINDS.has(kindOf(line)) || REAL_CHANGE_KINDS.has(typeOf(line));
}
const isClockLine = line => !!line && (line.clock === true || typeOf(line) === 'timed_run' || String(line.id || '').startsWith('clock:'));
const isNeedsHuman = line => typeOf(line) === 'needs_human' || kindOf(line) === 'needs_human';

/**
 * Seat-to-seat comment guard. Returns null to let the normal gate decide, or a skip decision.
 * It also counts seat comments for the breaker (one count per comment id, whatever seat copy it is).
 */
export function commentGuard(wake, state, now, cfg) {
  const seat = wake.seat;
  const line = wake.line;
  const key = repoKey(line);
  const keyed = !!(line && line.repo) && !/#0$/.test(key);
  if (!keyed) return null;
  const brk = state.breaker.get(key);
  if (isCommentLine(line) && !isSeatComment(line, cfg)) {
    if (brk) state.breaker.delete(key);   // a person spoke: the pause on this repo#n ends
    return null;
  }
  const outsideTarget = isExternalSeat(seat, cfg);   // a seat outside the fleet is never filtered and never paused
  if (isSeatComment(line, cfg) && !outsideTarget) {
    const id = String(line.id || '');
    const rows = (state.seatComments.get(key) || []).filter(r => now - r.t < ROLLING_HOUR_MS && now - r.t >= 0);
    if (!rows.some(r => r.id === id)) rows.push({ t: now, id });
    state.seatComments.set(key, rows);
    if (rows.length > SEAT_COMMENT_LIMIT) {
      const cur = state.breaker.get(key);
      if (!cur || cur.until <= now) {
        state.breaker.set(key, { until: now + ROLLING_HOUR_MS, since: now });
        return { op: 'skip', reason: 'breaker', seat, line, needsHuman: true };
      }
      return { op: 'skip', reason: 'breaker', seat, line };
    }
    if (isHotfix(line) || carriesRealChange(line)) return null;
    const sha = shaOf(line);
    if (sha && sha !== state.sentSha.get(shaKeyOf(seat, line)) && sha !== state.commentSha.get(commentRepeatKey(seat, line))) {
      return null;   // a new head: a real change
    }
    return { op: 'skip', reason: sha ? 'repeat_sha' : 'seat_comment', seat, line };
  }
  if (brk && brk.until > now && !outsideTarget && !isHotfix(line) && !isNeedsHuman(line) && !isClockLine(line)) {
    return { op: 'skip', reason: 'breaker', seat, line };
  }
  if (brk && brk.until <= now) state.breaker.delete(key);
  return null;
}

// A new sha inside the cooldown or the rolling hour is queued, not dropped.
// An unchanged sha is a drop. An empty sha never matches. A hotfix skips both waits.
export function gateLine(wake, state, now, cfg) {
  const seat = wake.seat;
  const line = wake.line;
  if (cfg.paused) return { op: 'skip', reason: 'paused', seat, line };
  const guard = commentGuard(wake, state, now, cfg);
  if (guard) return guard;
  const clock = isLadder(line);
  const turnAt = state.turnOpen.get(seat) || 0;
  const inTurn = !!(turnAt && now - turnAt < cfg.turnOpenMs);
  if (clock) {
    if (inTurn) return { op: 'queue', until: turnAt + cfg.turnOpenMs, seat, line };
    return { op: 'send', seat, line };
  }
  const sha = shaOf(line);
  const shaKey = shaKeyOf(seat, line);
  const sentSha = state.sentSha.get(shaKey) || '';
  const queuedSha = state.queuedSha.get(shaKey) || '';
  // A green head is a new ring on the same card. The earlier ready must not swallow it.
  const green = typeOf(line) === 'ci_pass';
  if (sha && (sha === sentSha || sha === queuedSha) && !green) return { op: 'skip', reason: 'repeat_sha', seat, line };
  const hotfix = isHotfix(line);
  const lastCool = state.cool.get(coolKeyOf(seat, line)) || 0;
  const inCool = !hotfix && !!lastCool && now - lastCool < cfg.cooldownMs;
  const freshSha = (!!sha && sha !== sentSha) || green;
  const stamps = hourStamps(state, seat, now);
  const over = !hotfix && stamps.length >= cfg.maxPerHour;
  let until = 0;
  if (inTurn) until = Math.max(until, turnAt + cfg.turnOpenMs);
  if (freshSha && inCool) until = Math.max(until, lastCool + cfg.cooldownMs);
  if (freshSha && over) {
    const sorted = stamps.slice().sort((a, b) => a - b);
    until = Math.max(until, sorted[sorted.length - cfg.maxPerHour] + ROLLING_HOUR_MS);
  }
  if (!freshSha && !hotfix && inCool) return { op: 'skip', reason: 'cooldown', seat, line };
  if (!freshSha && !hotfix && over) return { op: 'skip', reason: 'rate', seat, line };
  if (until > now) {
    if (sha) state.queuedSha.set(shaKey, sha);
    return { op: 'queue', until, seat, line };
  }
  return { op: 'send', seat, line };
}

export function noteSent(state, seat, lines, now) {
  let counted = false;
  for (const line of lines) {
    if (isLadder(line)) continue;
    counted = true;
    const sha = shaOf(line);
    const key = shaKeyOf(seat, line);
    if (isCommentLine(line)) state.commentSha.set(commentRepeatKey(seat, line), sha || 'nosha');
    if (sha) {
      state.sentSha.set(key, sha);
      if (state.queuedSha.get(key) === sha) state.queuedSha.delete(key);
    }
    state.cool.set(coolKeyOf(seat, line), now);
  }
  if (counted) {
    const arr = (state.sentAt.get(seat) || []).concat(now).filter(t => now - t < 48 * 3600000);
    state.sentAt.set(seat, arr);
  }
  const last = lines[lines.length - 1] || {};
  state.sent.push({ t: now, seat, id: String(last.id || '') });
}

export function releaseDue(state, now, cfg) {
  const keep = [];
  const due = [];
  const skips = [];
  for (const item of state.hold) {
    const sha = shaOf(item.line);
    const key = shaKeyOf(item.seat, item.line);
    if (sha && state.queuedSha.get(key) === sha) state.queuedSha.delete(key);
    const d = gateLine({ seat: item.seat, line: item.line }, state, now, cfg);
    if (d.op === 'send') due.push(d);
    else if (d.op === 'queue') {
      if (sha) state.queuedSha.set(key, sha);
      keep.push({ seat: d.seat, line: d.line, until: d.until });
    } else skips.push(d);
  }
  state.hold = keep;
  return { due, skips };
}

function inWindow(row, now, windowMs) {
  return row && Number.isFinite(row.t) && now - row.t <= windowMs && now - row.t >= 0;
}

export function publicStats(state, now, windowMs) {
  const seats = {};
  const slot = seat => seats[seat] || (seats[seat] = { sent: 0, skipped: 0, reasons: {} });
  for (const row of state.sent) {
    if (!inWindow(row, now, windowMs)) continue;
    slot(row.seat || 'unassigned').sent += 1;
  }
  for (const row of state.skips) {
    if (!inWindow(row, now, windowMs)) continue;
    const seat = slot(row.seat || 'unassigned');
    seat.skipped += 1;
    seat.reasons[row.reason] = (seat.reasons[row.reason] || 0) + 1;
  }
  return { window_h: windowMs / 3600000, seats };
}

export function fullStats(state, now, windowMs) {
  const body = publicStats(state, now, windowMs);
  const seats = new Set([...Object.keys(body.seats), ...state.hold.map(item => item.seat || 'unassigned')]);
  for (const seat of seats) {
    const row = body.seats[seat] || (body.seats[seat] = { sent: 0, skipped: 0, reasons: {} });
    row.skips = state.skips.filter(item => (item.seat || 'unassigned') === seat && inWindow(item, now, windowMs)).slice(-50)
      .map(item => ({ t: item.t, reason: item.reason, id: item.id || '', kind: item.kind || '' }));
    row.queued = state.hold.filter(item => (item.seat || 'unassigned') === seat).length;
  }
  return body;
}

export function restoreWakeBook(state, wakeRows, skipRows, now, windowMs) {
  for (const row of wakeRows || []) {
    if (!row || !row.ok || !row.seat) continue;
    const t = Date.parse(row.t_ct || '');
    if (!Number.isFinite(t) || now - t > windowMs || now - t < 0) continue;
    const seat = String(row.seat).toLowerCase();
    state.sent.push({ t, seat, id: String(row.id || '') });
    const arr = state.sentAt.get(seat) || [];
    arr.push(t);
    state.sentAt.set(seat, arr);
    const line = { repo: row.repo, number: row.number, type: row.kind || row.type || '', sha: row.sha };
    if (line.type) state.cool.set(coolKeyOf(seat, line), t);
    if (typeof row.sha === 'string' && row.sha.trim()) state.sentSha.set(shaKeyOf(seat, line), row.sha.trim());
  }
  for (const row of skipRows || []) {
    if (!row) continue;
    const t = Number.isFinite(row.t) ? row.t : Date.parse(row.t_ct || '');
    if (!Number.isFinite(t) || now - t > windowMs || now - t < 0) continue;
    state.skips.push({ t, seat: String(row.seat || ''), reason: String(row.reason || ''), id: String(row.id || ''), kind: String(row.kind || '') });
  }
}
