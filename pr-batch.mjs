// One buffer per PR. Follow-ups collapse on PR + head sha.
// Flushes are run_end and ci_pass only. A green head queues critic on run_end
// when the checks are already green, and on a later ci_pass after run_end.
// A green event seen before run_end is not replayed. Pending waits.
// Collector ci rows carry head_sha. That is the head when sha is absent.

const FOLLOW = new Set(['ci_fail', 'critic_fail', 'ready', 'live_pass', 'merge', 'handoff', 'pr_review', 'review']);
const FAILED = new Set(['failure', 'failed', 'error', 'cancelled', 'timed_out', 'startup_failure']);
const PENDING = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested']);
const OK = new Set(['success', 'passed', 'green', 'skipped', 'neutral']);

export function paceHolds(text, hotfix = false) {
  if (hotfix) return false;
  const raw = String(text || '');
  if (/over pace/i.test(raw)) return true;
  const burn = raw.match(/weekly\s+burn[^0-9%]{0,40}(\d{1,3})\s*%/i);
  if (burn && Number(burn[1]) >= 75) return true;
  if (/pipe down[^.\n]{0,40}\bfull\b/i.test(raw)) return true;
  return false;
}

export function headColor(checks) {
  const list = (Array.isArray(checks) ? checks : []).filter((row) => row && row.required !== false);
  if (!list.length) return 'pending';
  const conclusion = (row) => String(row.conclusion || '').toLowerCase();
  const status = (row) => String(row.status || '').toLowerCase();
  if (list.some((row) => FAILED.has(conclusion(row)) || FAILED.has(status(row)))) return 'red';
  if (list.some((row) => !OK.has(conclusion(row)) && (PENDING.has(status(row)) || !status(row)))) return 'pending';
  if (list.every((row) => OK.has(conclusion(row)) || OK.has(status(row)))) return 'green';
  return 'pending';
}

function keyOf(repo, number) {
  const name = String(repo || '').trim().toLowerCase();
  const n = Number(number);
  if (!name || !Number.isInteger(n) || n < 1) return '';
  return name + '#' + n;
}

export function createBatch() {
  const slots = new Map();

  function slot(key) {
    let row = slots.get(key);
    if (!row) {
      row = {
        sha: '', parts: [], checks: [], seen: new Set(),
        runEnded: false, live: '', criticFails: 0, criticQueued: false,
        why: '', touched: false, pondered: false, seq: 0, hotfix: false, replay: null,
      };
      slots.set(key, row);
    }
    return row;
  }

  function shiftSha(row, sha) {
    const next = String(sha || '').trim().toLowerCase();
    if (!next) return;
    if (row.sha && next !== row.sha) {
      row.parts = [];
      row.checks = [];
      row.runEnded = false;
      row.criticQueued = false;
      row.hotfix = false;
      row.replay = null;
      if (row.live === 'critic') row.live = '';
    }
    row.sha = next;
  }

  function addPart(row, kind, title, sha) {
    const name = String(kind || 'event').toLowerCase();
    const head = String(sha || row.sha || '').toLowerCase();
    if (row.parts.some((part) => part.kind === name && part.sha === head)) return;
    row.parts.push({ kind: name, sha: head, title: String(title || name).slice(0, 120) });
    if (name === 'critic_fail') row.criticFails += 1;
    row.touched = true;
  }

  function held(row, opts) {
    const hot = !!(row && row.hotfix) || !!(opts && (opts.hotfix || (opts.line && opts.line.flag === 'hotfix')));
    return paceHolds(opts && opts.attention, hot);
  }

  function deliver(key, row, action) {
    row.seq += 1;
    const [repo, num] = key.split('#');
    const title = action === 'critic' ? 'ci_pass' : action === 'blaze' ? 'second critic FAIL' : 'red head';
    const text = row.parts.map((part) => part.kind + ': ' + part.title).join(' · ');
    const batch = (text || title).slice(0, 2000);
    row.parts = [];
    row.why = title;
    row.touched = true;
    if (action === 'worker') { row.live = 'worker'; row.runEnded = false; }
    if (action === 'critic') { row.live = 'critic'; row.criticQueued = true; }
    return {
      action,
      line: {
        id: `batch:${key}:${row.sha}:${action}:${row.seq}`,
        seat: action === 'critic' ? 'critic' : action === 'blaze' ? 'blinky' : 'forge',
        type: 'batch',
        repo,
        number: Number(num),
        sha: row.sha,
        title,
        batch,
        kind: action === 'critic' ? 'ci_pass' : action === 'blaze' ? 'needs_human' : 'ci_fail',
        reason: title,
        url: `https://github.com/${repo}/pull/${num}`,
        ...(action === 'blaze' ? { to: 'human' } : {}),
      },
    };
  }

  return {
    inBeat(key) {
      const row = slots.get(String(key || '').toLowerCase());
      return !!(row && row.parts.length);
    },
    busy(key) {
      const row = slots.get(String(key || '').toLowerCase());
      return !!(row && row.live);
    },
    absorb(line, busy) {
      if (!line || line.type === 'batch' || String(line.id || '').startsWith('batch:')) return false;
      const key = keyOf(line.repo, line.number);
      const kind = String(line.kind || '').toLowerCase();
      if (!key || !FOLLOW.has(kind)) return false;
      if (!busy && !this.busy(key)) return false;
      const row = slot(key);
      const seen = line.id ? 'in:' + line.id : '';
      if (seen && row.seen.has(seen)) return true;
      if (seen) row.seen.add(seen);
      shiftSha(row, line.sha);
      addPart(row, kind, line.title || line.reason, line.sha);
      if (busy && !row.live) row.live = 'worker';
      return true;
    },
    runEnd(line, opts = {}) {
      const key = keyOf(line && line.repo, line && line.number);
      if (!key) return { action: 'wait' };
      const row = slot(key);
      const seen = line.id ? 'end:' + line.id : '';
      if (seen && row.seen.has(seen)) return { action: 'wait' };
      shiftSha(row, line.sha);
      if (line.flag === 'hotfix') row.hotfix = true;
      const from = String(line.from || '').toLowerCase();
      const critic = from === 'critic' || row.live === 'critic';
      const gate = { ...opts, line };
      const color = headColor(row.checks);
      if (held(row, gate) && (critic || color === 'red' || color === 'green')) {
        row.replay = { op: 'end', line };
        row.touched = true;
        return { action: 'hold' };
      }
      if (seen) row.seen.add(seen);
      row.replay = null;
      if (critic) {
        row.live = '';
        row.touched = true;
        if (row.criticFails >= 2) return deliver(key, row, 'blaze');
        if (row.criticFails >= 1) return deliver(key, row, 'worker');
        row.why = row.why || 'critic pass';
        return { action: 'idle' };
      }
      row.live = '';
      row.runEnded = true;
      row.touched = true;
      if (color === 'red') return deliver(key, row, 'worker');
      if (color === 'green' && !row.criticQueued) return deliver(key, row, 'critic');
      return { action: 'wait' };
    },
    observeCi(ev, opts = {}) {
      const key = keyOf(ev && ev.repo, ev && ev.number);
      if (!key || !ev) return null;
      const row = slot(key);
      const seen = ev.id ? 'ci:' + ev.id : '';
      if (seen && row.seen.has(seen)) return null;
      const head = ev.sha || ev.head_sha;
      shiftSha(row, head);
      const name = String(ev.name || ev.context || ev.kind || 'check');
      let check = row.checks.find((item) => item.name === name);
      if (!check) {
        check = { name, required: ev.required !== false };
        row.checks.push(check);
      }
      if (ev.status) check.status = String(ev.status).toLowerCase();
      const conclusion = ev.conclusion || (ev.kind === 'ci_pass' ? 'success' : ev.kind === 'ci_fail' ? 'failure' : '');
      if (conclusion) check.conclusion = String(conclusion).toLowerCase();
      if (ev.required === false) check.required = false;
      const live = !!(opts.busy) || !!row.live;
      if ((live || row.runEnded) && (ev.kind === 'ci_fail' || FAILED.has(check.conclusion))) addPart(row, 'ci_fail', name, head);
      const color = headColor(row.checks);
      const idle = row.live !== 'worker' && row.live !== 'critic' && !row.criticQueued;
      const wantWorker = color === 'red' && row.runEnded && idle;
      const wantCritic = color === 'green' && row.runEnded && idle;
      if ((wantWorker || wantCritic) && held(row, opts)) {
        row.replay = { op: 'ci', ev };
        return { action: 'hold' };
      }
      if (seen) row.seen.add(seen);
      row.replay = null;
      if (wantWorker) return deliver(key, row, 'worker');
      if (wantCritic) return deliver(key, row, 'critic');
      return null;
    },
    drain(opts = {}) {
      const out = [];
      for (const row of [...slots.values()]) {
        if (!row.replay) continue;
        const replay = row.replay;
        row.replay = null;
        const result = replay.op === 'end' ? this.runEnd(replay.line, opts) : this.observeCi(replay.ev, opts);
        if (result && result.line) out.push(result);
      }
      return out;
    },
    ponder(key, why) {
      const id = String(key || '').toLowerCase();
      const row = slots.get(id);
      if (!row || !row.touched || row.pondered) return null;
      row.pondered = true;
      return { key: id, rounds: row.criticFails, why: row.why || why || 'closed' };
    },
  };
}
