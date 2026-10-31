// Acks a ci_fail inbox line once that head is green, or once the pull's current head is green.

const FAIL = new Set(['failure', 'failed', 'timed_out', 'cancelled', 'canceled', 'startup_failure', 'action_required']);
const HEAD = new Set(['pr_open', 'pr_commit', 'pr_force_push', 'pr_update']);

function low(value) {
  return String(value || '').trim().toLowerCase();
}

function shaOf(event) {
  const raw = low(event && (event.sha || event.head_sha));
  if (raw.length < 7 || /[^0-9a-f]/.test(raw)) return '';
  return raw;
}

function numOf(event) {
  const number = Number(event && event.number);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function stampOf(event) {
  return String(event && event.t_ct || '');
}

function greenKeys(events) {
  const suites = new Map();
  const runs = new Map();
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const repo = low(event.repo);
    const sha = shaOf(event);
    if (!repo || !sha) continue;
    const kind = low(event.kind);
    const conclusion = low(event.conclusion);
    const stamp = stampOf(event);
    const key = repo + '\0' + sha;
    if (kind === 'check_suite' && conclusion) {
      const color = conclusion === 'success' ? 'green' : FAIL.has(conclusion) ? 'red' : '';
      const prev = suites.get(key);
      if (!prev || stamp >= prev[0]) suites.set(key, [stamp, color]);
    } else if (kind === 'check_run' || kind === 'workflow_run' || kind === 'ci_pass' || kind === 'ci_fail') {
      const color = conclusion === 'success' || kind === 'ci_pass' ? 'green' : (kind === 'ci_fail' || FAIL.has(conclusion)) ? 'red' : '';
      if (!color) continue;
      const prev = runs.get(key);
      if (!prev || stamp >= prev[0]) runs.set(key, [stamp, color]);
    }
  }
  const green = new Set();
  for (const key of new Set([...suites.keys(), ...runs.keys()])) {
    const suite = suites.get(key);
    const color = suite && suite[1] ? suite[1] : (runs.get(key) || [])[1];
    if (color === 'green') green.add(key);
  }
  return green;
}

function headSha(events) {
  const found = new Map();
  for (const event of events || []) {
    if (!event || !HEAD.has(low(event.kind))) continue;
    const repo = low(event.repo);
    const sha = shaOf(event);
    const number = numOf(event);
    if (!repo || !sha || !number) continue;
    const key = repo + '#' + number;
    const stamp = stampOf(event);
    const prev = found.get(key);
    if (!prev || stamp >= prev[0]) found.set(key, [stamp, sha]);
  }
  const heads = new Map();
  for (const [key, row] of found) heads.set(key, row[1]);
  return heads;
}

export function idsToAck(lines, events) {
  const green = greenKeys(events);
  const heads = headSha(events);
  const ids = [];
  for (const line of lines || []) {
    if (!line || typeof line !== 'object') continue;
    if (low(line.type || line.kind) !== 'ci_fail') continue;
    const repo = low(line.repo);
    const sha = low(line.sha);
    const number = Number(line.number);
    if (!repo || !sha || !Number.isInteger(number)) continue;
    const head = heads.get(repo + '#' + number) || '';
    if (green.has(repo + '\0' + sha) || (head && green.has(repo + '\0' + head))) {
      if (line.id) ids.push(String(line.id));
    }
  }
  return ids;
}
