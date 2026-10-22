// Wake gate. One seat is woken for real new work. The field for a P1 mark is `labels`.
// Unassigned issue_open (and a P1 label on an issue) wakes forge. Blinky's routed copy is stored, not woken.
// A pr_comment stored for blinky and the author wakes the author. Blinky is the extra copy.
// A missing sha is never a repeat. The hour is a rolling 60 minutes. flag: hotfix skips the cap and the kind cooldown.

export const ROLLING_HOUR_MS = 60 * 60 * 1000;
const COMMENT = new Set(['pr_comment', 'issue_comment', 'review_comment', 'comment']);

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

export function createWakeState() {
  return {
    sentSha: new Map(), queuedSha: new Map(), cool: new Map(), sentAt: new Map(), turnOpen: new Map(),
    hold: [], sent: [], skips: [],
  };
}

const seatOf = line => String(line && line.seat || '').trim().toLowerCase();
const typeOf = line => String(line && (line.type || line.kind) || '').trim().toLowerCase();
const repoKey = line => `${String(line && line.repo || '').trim().toLowerCase()}#${Number.isInteger(line && line.number) ? line.number : Number(line && line.number) || 0}`;
const shaKeyOf = (seat, line) => `${seat}|${repoKey(line)}`;
const coolKeyOf = (seat, line) => `${seat}|${typeOf(line)}|${repoKey(line)}`;

export function hasSha(line) {
  return !!(line && typeof line.sha === 'string' && line.sha.trim());
}
const shaOf = line => (hasSha(line) ? line.sha.trim() : '');

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

// Routed seat, then handoff `to`, then the card owner, then forge for an unassigned issue.
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
    const target = owner || 'forge';
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

// A new sha inside the cooldown or the rolling hour is queued, not dropped.
// An unchanged sha is a drop. An empty sha never matches. A hotfix skips both waits.
export function gateLine(wake, state, now, cfg) {
  const seat = wake.seat;
  const line = wake.line;
  if (cfg.paused) return { op: 'skip', reason: 'paused', seat, line };
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
  if (sha && (sha === sentSha || sha === queuedSha)) return { op: 'skip', reason: 'repeat_sha', seat, line };
  const hotfix = isHotfix(line);
  const lastCool = state.cool.get(coolKeyOf(seat, line)) || 0;
  const inCool = !hotfix && !!lastCool && now - lastCool < cfg.cooldownMs;
  const freshSha = !!sha && sha !== sentSha;
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
