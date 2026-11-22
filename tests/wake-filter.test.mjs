import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeState, gateLine, noteSent, recordFlush, viewLine, wakeConfig } from '../wake-gate.mjs';
import { allowWake, commitWake, owedSeat, readWakeFilter, filterMode, criticGreenLine, dumpGreenHeads, restoreGreenHeads, rememberGreen, githubHeadRuns, createCriticHeads, greenSeen, assignCloudRaci } from '../wake-filter.mjs';

const NOW = 1_700_000_000_000;
const on = readWakeFilter({});
function ctx(over = {}) {
  return { now: NOW, state: createWakeState(), owner: '', head: '', ...over };
}
const line = (over) => ({ id: 'l', type: 'pr_comment', repo: 'acme/one', number: 5, title: 't', reason: 'note', ...over });

test('the default is actionable, and a seat can opt back to every wake', () => {
  assert.equal(filterMode(on, 'forge'), 'actionable');
  assert.equal(filterMode(readWakeFilter({ SEAT_WAKE_FILTER: 'all' }), 'forge'), 'all');
  const mixed = readWakeFilter({ SEAT_WAKE_FILTER: JSON.stringify({ mode: 'actionable', seats: { blinky: 'all' } }) });
  assert.equal(filterMode(mixed, 'blinky'), 'all');
  assert.equal(filterMode(mixed, 'forge'), 'actionable');
  assert.equal(allowWake(mixed, 'blinky', line({ type: 'pr_open' }), ctx()).allow, true);
});

test('a mention or an owner prompt wakes, and a bare comment does not', () => {
  assert.equal(allowWake(on, 'forge', line({ title: 'please @forge' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'forge', line({ mentions: ['forge'] }), ctx()).allow, true);
  assert.equal(allowWake(on, 'blinky', line({ title: 'please @blinky' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'blinky', line({ mentions: ['@blinky'] }), ctx()).allow, true);
  assert.equal(allowWake(on, 'blinky', line({ type: 'prompt', kind: 'seat_prompt' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'dispatch', reason: 'handoff' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'start_after', reason: 'start after 2020-01-01T08:00-06:00' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'prompt', kind: 'seat_prompt' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'issue_comment', title: 'hello' }), ctx()).allow, false);
  assert.equal(allowWake(on, 'forge', line({ type: 'needs_human', kind: 'needs_human' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'needs_human', kind: 'needs_human' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'blinky', line({ type: 'needs_human', kind: 'needs_human', to: 'human' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'blinky', line({ type: 'stop', kind: 'stop' }), ctx()).allow, true);
  for (const type of ['pr_update', 'pr_open', 'issue_open', 'deploy', 'cloud_finished', 'cloud_reply']) {
    assert.equal(allowWake(on, 'forge', line({ type }), ctx()).allow, false, type);
  }
});

test('a review or a current-head ci_fail wakes only the owner', () => {
  const own = ctx({ owner: 'forge', head: 'abc123' });
  assert.equal(allowWake(on, 'forge', line({ type: 'critic_pass', sha: 'abc123' }), own).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'critic_fail', sha: 'abc123' }), own).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'critic_fail', sha: 'abc123' }), own).allow, false);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: 'abc123' }), own).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: 'old', t_ct: new Date(NOW - 60000).toISOString() }), ctx({ owner: 'forge', head: 'abc123', headAt: NOW })).allow, false);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: 'abc123', conclusion: 'cancelled' }), own).allow, false);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail' }), ctx({ owner: 'forge', head: '' })).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: '' }), ctx({ owner: 'forge', head: 'abc123' })).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: '', conclusion: 'cancelled' }), ctx({ owner: 'forge' })).allow, false);
});

test('a card with a different owner and assignee wakes the assignee', () => {
  const card = { owner: 'forge', assignee: 'mill' };
  const owed = owedSeat(card, value => String(value || '').trim().toLowerCase());
  assert.equal(owed, 'mill');
  assert.equal(owedSeat({ owner: 'forge' }, value => String(value || '')), 'forge');
  const view = ctx({ owner: owed, head: 'abc123' });
  assert.equal(allowWake(on, 'mill', line({ type: 'critic_fail', sha: 'abc123' }), view).allow, true);
  assert.equal(allowWake(on, 'mill', line({ type: 'ci_fail', sha: 'abc123' }), view).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'critic_pass', sha: 'abc123' }), view).allow, false);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: 'abc123' }), view).allow, false);
});

test('a delivered line, a stale head, and a merged pull do not wake; the current head does', () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const state = createWakeState();
  const repo = '0xRayAI/xray';
  const live = line({ id: 'wake:forge:xray#1170:' + sha, type: 'ci_fail', kind: 'ci_fail', repo, number: 1170, sha, run_id: 42, t_ct: new Date(NOW).toISOString() });
  const current = ctx({ state, owner: 'forge', head: sha, headAt: NOW, closed: false });
  assert.equal(allowWake(on, 'forge', live, current).allow, true);
  commitWake(state, 'forge', live, NOW);
  assert.equal(recordFlush(state, 'forge', [live], { ok: true, outcome: 'delivered' }, NOW), true);
  assert.equal(allowWake(on, 'forge', live, current).allow, false);
  const sameKey = line({ id: 'wake:forge:xray#1170:again', type: 'ci_fail', kind: 'ci_fail', repo, number: 1170, sha, run_id: 42, t_ct: new Date(NOW).toISOString() });
  assert.equal(allowWake(on, 'forge', sameKey, current).allow, false);
  const stale = line({ id: 'wake:forge:xray#1166:old', type: 'ci_fail', kind: 'ci_fail', repo, number: 1166, sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', t_ct: new Date(NOW - 60000).toISOString() });
  assert.equal(allowWake(on, 'forge', stale, ctx({ state, owner: 'forge', head: sha, headAt: NOW })).allow, false);
  const merged = line({ id: 'wake:critic:xray#1154:' + sha, type: 'ci_pass', kind: 'ci_pass', repo, number: 1154, sha, reason: 'CI green on current head' });
  assert.equal(allowWake(on, 'critic', merged, ctx({ state, head: sha, headAt: NOW, closed: true })).allow, false);
  const open = line({ id: 'wake:forge:xray#1168:' + sha, type: 'ci_fail', kind: 'ci_fail', repo, number: 1168, sha, t_ct: new Date(NOW).toISOString() });
  assert.equal(allowWake(on, 'forge', open, ctx({ state, owner: 'forge', head: sha, headAt: NOW, closed: false })).allow, true);
  commitWake(state, 'forge', open, NOW);
  recordFlush(state, 'forge', [open], { ok: true, outcome: 'delivered' }, NOW);
});

test('a failed flush leaves the line wakeable and a successful flush marks it', () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const state = createWakeState();
  const repo = '0xRayAI/xray';
  const live = line({ id: 'wake:forge:fail', type: 'ci_fail', kind: 'ci_fail', repo, number: 1170, sha, run_id: 7, t_ct: new Date(NOW).toISOString() });
  const view = ctx({ state, owner: 'forge', head: sha, headAt: NOW, closed: false });
  assert.equal(allowWake(on, 'forge', live, view).allow, true);
  commitWake(state, 'forge', live, NOW);
  assert.equal(recordFlush(state, 'forge', [live], { ok: false, outcome: 'failed' }, NOW), false);
  assert.equal(allowWake(on, 'forge', live, view).allow, true);
  commitWake(state, 'forge', live, NOW);
  assert.equal(recordFlush(state, 'forge', [viewLine(live)], { ok: true, outcome: 'delivered' }, NOW), true);
  assert.equal(allowWake(on, 'forge', live, view).allow, false);
});

test('a push that lands before the card head moves still wakes', () => {
  const oldSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const state = createWakeState();
  const repo = '0xRayAI/xray';
  const push = line({ id: 'push-new', type: 'ci_fail', kind: 'ci_fail', repo, number: 1166, sha, run_id: 3, t_ct: new Date(NOW).toISOString() });
  const early = ctx({ state, owner: 'forge', head: oldSha, headAt: NOW - 60000, closed: false });
  assert.equal(allowWake(on, 'forge', push, early).allow, true);
  commitWake(state, 'forge', push, NOW);
  assert.equal(recordFlush(state, 'forge', [push], { ok: true, outcome: 'delivered' }, NOW), true);
  const behind = line({ id: 'push-old', type: 'ci_fail', kind: 'ci_fail', repo, number: 1166, sha: oldSha, run_id: 1, t_ct: new Date(NOW - 120000).toISOString() });
  assert.equal(allowWake(on, 'forge', behind, ctx({ state, owner: 'forge', head: sha, headAt: NOW })).allow, false);
  const unsure = line({ id: 'push-unsure', type: 'ci_fail', kind: 'ci_fail', repo, number: 1166, sha: oldSha, run_id: 2 });
  assert.equal(allowWake(on, 'forge', unsure, ctx({ state, owner: 'forge', head: sha })).allow, true);
});

test('a same-sha re-run and a force-back still wake', () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const state = createWakeState();
  const repo = '0xRayAI/xray';
  const first = line({ id: 'ci-run-1', type: 'ci_fail', kind: 'ci_fail', repo, number: 1171, sha, run_attempt: 1, t_ct: new Date(NOW).toISOString() });
  const view = ctx({ state, owner: 'forge', head: sha, headAt: NOW, closed: false });
  assert.equal(allowWake(on, 'forge', first, view).allow, true);
  commitWake(state, 'forge', first, NOW);
  assert.equal(recordFlush(state, 'forge', [first], { ok: true, outcome: 'delivered' }, NOW), true);
  const again = line({ id: 'ci-run-2', type: 'ci_fail', kind: 'ci_fail', repo, number: 1171, sha, run_attempt: 2, t_ct: new Date(NOW).toISOString() });
  assert.equal(allowWake(on, 'forge', again, view).allow, true);
  const same = line({ id: 'ci-run-1b', type: 'ci_fail', kind: 'ci_fail', repo, number: 1171, sha, run_attempt: 1, t_ct: new Date(NOW).toISOString() });
  assert.equal(allowWake(on, 'forge', same, view).allow, false);
  const back = line({ id: 'force-2', type: 'pr_force_push', kind: 'pr_force_push', repo, number: 1171, sha, t_ct: new Date(NOW).toISOString() });
  const prior = line({ id: 'force-1', type: 'pr_force_push', kind: 'pr_force_push', repo, number: 1171, sha, t_ct: new Date(NOW - 1000).toISOString() });
  commitWake(state, 'forge', prior, NOW);
  recordFlush(state, 'forge', [prior], { ok: true, outcome: 'delivered' }, NOW);
  const all = readWakeFilter({ SEAT_WAKE_FILTER: 'all' });
  assert.equal(allowWake(all, 'forge', back, view).allow, true);
  assert.equal(allowWake(all, 'forge', prior, view).allow, false);
});

test('a closed pull still wakes review and deploy, and a reopen clears that book', () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const state = createWakeState();
  const repo = '0xRayAI/xray';
  const closed = ctx({ state, owner: 'forge', head: sha, headAt: NOW, closed: true });
  const review = line({ id: 'rev-1', type: 'review', kind: 'review', repo, number: 1154, sha, title: 'LGTM' });
  assert.equal(allowWake(on, 'forge', review, closed).allow, true);
  commitWake(state, 'forge', review, NOW);
  assert.equal(recordFlush(state, 'forge', [review], { ok: true, outcome: 'delivered' }, NOW), true);
  assert.equal(allowWake(on, 'forge', review, closed).allow, false);
  const deploy = line({ id: 'dep-1', type: 'deploy', kind: 'deploy', repo, number: 1154, sha });
  assert.equal(allowWake(on, 'forge', deploy, closed).allow, true);
  const ci = line({ id: 'ci-closed', type: 'ci_fail', kind: 'ci_fail', repo, number: 1154, sha, run_id: 9, t_ct: new Date(NOW).toISOString() });
  assert.equal(allowWake(on, 'forge', ci, closed).allow, false);
  const live = ctx({ state, owner: 'forge', head: sha, headAt: NOW, closed: false });
  const openCi = line({ id: 'ci-open', type: 'ci_fail', kind: 'ci_fail', repo, number: 1154, sha, run_id: 8, t_ct: new Date(NOW).toISOString() });
  assert.equal(allowWake(on, 'forge', openCi, live).allow, true);
  commitWake(state, 'forge', openCi, NOW);
  recordFlush(state, 'forge', [openCi], { ok: true, outcome: 'delivered' }, NOW);
  assert.equal(allowWake(on, 'forge', openCi, live).allow, false);
  const other = line({ id: 'ci-other', type: 'ci_fail', kind: 'ci_fail', repo, number: 1160, sha, run_id: 4, t_ct: new Date(NOW).toISOString() });
  commitWake(state, 'forge', other, NOW);
  recordFlush(state, 'forge', [other], { ok: true, outcome: 'delivered' }, NOW);
  const reopen = line({ id: 're-1', type: 'pr_reopen', kind: 'pr_reopen', repo, number: 1154 });
  assert.equal(allowWake(on, 'forge', reopen, closed).allow, true);
  assert.equal(allowWake(on, 'forge', openCi, live).allow, true);
  assert.equal(allowWake(on, 'forge', review, closed).allow, true);
  assert.equal(allowWake(on, 'forge', other, ctx({ state, owner: 'forge', head: sha, headAt: NOW })).allow, false);
});

test('a builder-cloud card gives mill R and forge A', () => {
  const card = assignCloudRaci({ owner: 'builder-cloud', packet: { 'next owner': 'mill applies the patch' } });
  assert.equal(card.packet.raci, 'R=mill A=forge');
  assert.equal(owedSeat(card, value => String(value || '').trim().toLowerCase()), 'mill');
  assert.equal(owedSeat({ owner: 'arch1' }, value => String(value || '').trim().toLowerCase()), 'forge');
});

test('near or mill get an R assignment, and a green head does not wake', () => {
  assert.equal(allowWake(on, 'critic', line({ type: 'ci_pass', sha: 'abc', repo: 'acme/one', number: 9 }), ctx()).allow, false);
  assert.equal(allowWake(on, 'critic', line({ type: 'check_suite', sha: '3781168cc00a', conclusion: 'success', status: 'completed' }), ctx()).allow, false);
  assert.equal(allowWake(on, 'mill', line({ type: 'pr_open', reason: 'packet R' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'near', line({ type: 'pr_open', raci: 'R=near A=forge' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'pr_open', reason: 'packet R' }), ctx()).allow, false);
});

test('critic wakes once when every actions run is green, and a partial head stays quiet', () => {
  const full = '3781168cc00a136b458ebdd97be1399ea195da29';
  const short = full.slice(0, 12);
  const runs = [
    { name: 'unit', status: 'completed', conclusion: 'success' },
    { name: 'lint', status: 'completed', conclusion: 'skipped' },
    { name: 'docs', status: 'completed', conclusion: 'neutral' },
  ];
  const ev = { repo: '0xRayAI/clearing', number: 28, sha: short, head_sha: full };
  assert.equal(criticGreenLine(ev, [], {}), null);
  assert.equal(criticGreenLine(ev, [{ name: 'unit', status: 'queued', conclusion: null }], {}), null);
  assert.equal(criticGreenLine(ev, [runs[0], { name: 'lint', status: 'in_progress', conclusion: '' }], {}), null);
  assert.equal(criticGreenLine(ev, [{ name: 'unit', status: 'completed', conclusion: 'failure' }], {}), null);
  const ping = criticGreenLine(ev, runs, {});
  assert.equal(ping.sha, full);
  assert.equal(ping.seat, 'critic');
  const state = createWakeState();
  assert.equal(allowWake(on, 'critic', ping, ctx({ state })).allow, true);
  commitWake(state, 'critic', ping, NOW);
  assert.equal(allowWake(on, 'critic', { ...ping, sha: short }, ctx({ state })).allow, false);
  const newer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const again = criticGreenLine({ ...ev, sha: newer, head_sha: newer }, runs, {});
  assert.equal(allowWake(on, 'critic', again, ctx({ state })).allow, true);
});

test('one green run does not wake while another has not reported', async () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const page = Number(new URL(url).searchParams.get('page') || '1');
    if (page === 1) {
      return { ok: true, status: 200, json: async () => ({ total_count: 2, workflow_runs: [
        { name: 'unit', status: 'completed', conclusion: 'success' },
      ] }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const runs = await githubHeadRuns('0xRayAI/clearing', sha, { token: 'ghs_test', fetch: fetchImpl });
  assert.equal(runs, null);
  assert.equal(criticGreenLine({ repo: '0xRayAI/clearing', number: 28, sha }, runs || [], {}), null);
  assert.match(urls[0], /\/actions\/runs\?/);
  assert.match(urls[0], new RegExp('head_sha=' + sha));
  assert.equal(urls.some(url => url.includes('check-runs') || url.includes('check-suites')), false);
});

test('an unset read token does not fetch actions runs', async () => {
  let called = false;
  const runs = await githubHeadRuns('0xRayAI/clearing', '3781168cc00a136b458ebdd97be1399ea195da29', {
    token: '', fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(runs, null);
  assert.equal(called, false);
  assert.equal(criticGreenLine({ repo: '0xRayAI/clearing', number: 28, sha: '3781168cc00a136b458ebdd97be1399ea195da29' }, runs || [], {}), null);
});

test('a sha is fetched once, and a 403 is logged once', async () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const state = { fetched: new Map(), quietUntil: 0, deniedLogged: false };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ total_count: 1, workflow_runs: [
      { name: 'ci', status: 'completed', conclusion: 'success' },
    ] }) };
  };
  const first = await githubHeadRuns('0xRayAI/clearing', sha, { token: 'ghs_test', fetch: fetchImpl, state, now: 1 });
  const second = await githubHeadRuns('0xRayAI/clearing', sha, { token: 'ghs_test', fetch: fetchImpl, state, now: 2 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.equal(criticGreenLine({ repo: '0xRayAI/clearing', number: 28, sha }, first, {}).sha, sha);

  const denied = { fetched: new Map(), quietUntil: 0, deniedLogged: false };
  const logs = [];
  let hits = 0;
  const denyFetch = async () => { hits += 1; return { ok: false, status: 403, json: async () => ({}) }; };
  const opt = { token: 'ghs_test', fetch: denyFetch, state: denied, backoffMs: 5000, log: (line) => logs.push(line) };
  assert.equal(await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 1000 }), null);
  assert.equal(await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 2000 }), null);
  assert.equal(hits, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /403/);
  assert.equal(await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 7000 }), null);
  assert.equal(hits, 2);
  assert.equal(logs.length, 1);
});

test('a pending head is fetched again after 60s and wakes once it is green', async () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const state = { fetched: new Map(), quietUntil: 0, deniedLogged: false };
  let phase = 'pending';
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const head = new URL(url).searchParams.get('head_sha');
    const conclusion = phase === 'green' && head === sha ? 'success' : null;
    const status = conclusion ? 'completed' : 'in_progress';
    return { ok: true, status: 200, json: async () => ({ total_count: 1, workflow_runs: [
      { name: 'ci', workflow_id: 4, event: 'pull_request', run_attempt: 1, status, conclusion },
    ] }) };
  };
  const ev = { repo: '0xRayAI/clearing', number: 28, sha };
  const opt = { token: 'ghs_test', fetch: fetchImpl, state, gapMs: 60_000 };
  const pending = await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 0 });
  assert.equal(criticGreenLine(ev, pending || [], {}), null);
  assert.equal(await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 30_000 }), null);
  assert.equal(calls, 1);
  const switched = await githubHeadRuns('0xRayAI/clearing', other, { ...opt, now: 30_000 });
  assert.equal(calls, 2);
  assert.equal(criticGreenLine({ ...ev, sha: other, head_sha: other }, switched || [], {}), null);
  phase = 'green';
  const green = await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 60_000 });
  assert.equal(calls, 3);
  const ping = criticGreenLine(ev, green, {});
  assert.equal(ping && ping.sha, sha);
  assert.equal(await githubHeadRuns('0xRayAI/clearing', sha, { ...opt, now: 120_000 }), green);
  assert.equal(calls, 3);
});

test('a failed attempt does not block the successful re-run', async () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ total_count: 2, workflow_runs: [
    { name: 'ci', workflow_id: 9, event: 'pull_request', run_attempt: 2, status: 'completed', conclusion: 'success' },
    { name: 'ci', workflow_id: 9, event: 'pull_request', run_attempt: 1, status: 'completed', conclusion: 'failure' },
  ] }) });
  const runs = await githubHeadRuns('0xRayAI/clearing', sha, { token: 'ghs_test', fetch: fetchImpl });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_attempt, 2);
  assert.equal(criticGreenLine({ repo: '0xRayAI/clearing', number: 28, sha }, runs, {}).sha, sha);
});

test('noteCi retries a pending sha after the gap and wakes once', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const done = calls > 1;
      return { ok: true, status: 200, json: async () => ({ total_count: 2, workflow_runs: [
        { name: 'A', workflow_id: 1, event: 'pull_request', run_attempt: 1, status: 'completed', conclusion: 'success' },
        { name: 'B', workflow_id: 2, event: 'pull_request', run_attempt: 1, status: done ? 'completed' : 'in_progress', conclusion: done ? 'success' : null },
      ] }) };
    };
    const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
    const wake = createWakeState();
    const wakes = [];
    const heads = createCriticHeads({
      state: { fetched: new Map(), quietUntil: 0, deniedLogged: false },
      token: () => 'ghs_test',
      api: () => 'https://api.github.com',
      fetch: fetchImpl,
      seen: (repo, n, head) => greenSeen(wake, { repo, number: n, sha: head }),
      deliver: (batch) => {
        const rows = Array.isArray(batch) ? batch : [batch];
        for (const ping of rows) { wakes.push(ping); rememberGreen(wake, ping); }
      },
    });
    const ev = { repo: '0xRayAI/clearing', number: 28, sha, kind: 'ci_pass' };
    await heads.noteCi(ev, 28);
    assert.equal(wakes.length, 0);
    assert.equal(calls, 1);
    await heads.noteCi({ ...ev, name: 'B' }, 28);
    assert.equal(wakes.length, 0);
    assert.equal(calls, 1);
    mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wakes.length, 1);
    assert.equal(calls, 2);
    mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wakes.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('noteCi wakes critic and R once through commitWake', async () => {
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ total_count: 1, workflow_runs: [
    { name: 'ci', workflow_id: 4, event: 'pull_request', run_attempt: 1, status: 'completed', conclusion: 'success' },
  ] }) });
  const card = { owner: 'builder-cloud', repo: '0xRayAI/clearing', number: 28, packet: { 'next owner': 'mill applies the patch' } };
  const wake = createWakeState();
  const sent = [];
  const heads = createCriticHeads({
    state: { fetched: new Map(), quietUntil: 0, deniedLogged: false },
    token: () => 'ghs_test',
    api: () => 'https://api.github.com',
    fetch: fetchImpl,
    seen: (repo, n, head) => greenSeen(wake, { repo, number: n, sha: head }),
    card: () => card,
    deliver: (batch) => {
      const lines = Array.isArray(batch) ? batch : [batch];
      if (!lines.some(row => !greenSeen(wake, row))) return;
      const owner = owedSeat(card, value => String(value || '').trim().toLowerCase());
      for (const row of lines) {
        const kept = allowWake(on, row.seat, row, ctx({ state: wake, owner, head: sha }));
        if (!kept.allow) continue;
        commitWake(wake, row.seat, row, NOW);
        sent.push(row.seat);
      }
    },
  });
  const ev = { repo: card.repo, number: card.number, sha, kind: 'ci_pass' };
  await heads.noteCi(ev, card.number);
  await heads.noteCi(ev, card.number);
  assert.deepEqual(sent.filter(seat => seat === 'critic'), ['critic']);
  assert.deepEqual(sent.filter(seat => seat === 'mill'), ['mill']);
  assert.equal(assignCloudRaci(card).packet.raci, 'R=mill A=forge');
});

test('a merged or closed pull does not wake critic', () => {
  const checks = [
    { name: 'unit', status: 'completed', conclusion: 'success' },
  ];
  const ev = { repo: '0xRayAI/clearing', number: 28, sha: '3781168cc00a136b458ebdd97be1399ea195da29' };
  assert.equal(criticGreenLine({ ...ev, merged: true }, checks, {}), null);
  assert.equal(criticGreenLine({ ...ev, state: 'closed' }, checks, {}), null);
  assert.equal(criticGreenLine({ ...ev, kind: 'merged' }, checks, {}), null);
  assert.equal(criticGreenLine(ev, checks, { closed: true }), null);
  const ping = criticGreenLine(ev, checks, {});
  assert.equal(allowWake(on, 'critic', ping, ctx({ closed: true })).allow, false);
});

test('a seen green head survives a restart, and a short sha is the full sha', () => {
  const full = '3781168cc00a136b458ebdd97be1399ea195da29';
  const short = full.slice(0, 12);
  const checks = [
    { name: 'unit', status: 'completed', conclusion: 'success' },
  ];
  const ev = { repo: '0xRayAI/clearing', number: 28, sha: short };
  const early = criticGreenLine(ev, checks, {});
  assert.equal(early.sha, short);
  const state = createWakeState();
  commitWake(state, 'critic', early, NOW);
  const later = criticGreenLine({ ...ev, sha: short, head_sha: full }, checks, {});
  assert.equal(later.sha, full);
  assert.equal(allowWake(on, 'critic', later, ctx({ state })).allow, false);
  assert.equal(rememberGreen(state, later), true);
  assert.equal(state.greenHeads[0].sha, full);
  const disk = JSON.parse(JSON.stringify({ seatComments: {}, breaker: {}, greenHeads: dumpGreenHeads(state) }));
  const fresh = createWakeState();
  restoreGreenHeads(fresh, disk);
  assert.equal(fresh.greenHeads[0].sha, full);
  assert.equal(allowWake(on, 'critic', later, ctx({ state: fresh })).allow, false);
  assert.equal(allowWake(on, 'critic', { ...later, sha: short, head_sha: '' }, ctx({ state: fresh })).allow, false);
});

test('a bare comment does not wake, and a review on the owed seat does', () => {
  for (const type of ['pr_comment', 'issue_comment', 'review_comment', 'comment']) {
    const got = allowWake(on, 'forge', line({ type, title: 'hello', reason: 'note' }), ctx());
    assert.deepEqual(got, { allow: false, reason: 'filter' }, type);
  }
  assert.equal(allowWake(on, 'forge', line({ type: 'review', title: 'LGTM' }), ctx({ owner: 'forge' })).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'review', title: 'LGTM' }), ctx({ owner: 'forge' })).allow, false);
});

test('a ci_fail wakes only the owed seat on the current head', () => {
  const none = ctx({ owner: '', head: 'abc123' });
  for (const seat of ['forge', 'critic', 'mill']) {
    assert.equal(allowWake(on, seat, line({ type: 'ci_fail', sha: 'abc123' }), none).allow, false, seat);
  }
  const owed = ctx({ owner: 'mill', head: 'abc123' });
  assert.equal(allowWake(on, 'mill', line({ type: 'ci_fail', sha: 'abc123' }), owed).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: 'abc123' }), owed).allow, false);
  assert.equal(allowWake(on, 'mill', line({ type: 'ci_fail', sha: 'oldhead', t_ct: new Date(NOW - 60000).toISOString() }), ctx({ owner: 'mill', head: 'abc123', headAt: NOW })).allow, false);
});

test('a ladder nudge and the stall clock still wake', () => {
  assert.equal(allowWake(on, 'forge', line({ type: 'nudge', reason: 'nudge L1: stale' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'timed_run', id: 'clock:1:critic' }), ctx()).allow, true);
});

test('a nudge L1 prefix on a board-only GitHub line does not bypass the filter', () => {
  for (const type of ['pr_update', 'pr_open', 'pr_commit', 'push', 'deploy', 'pr_review']) {
    const got = allowWake(on, 'blinky', line({ type, kind: type, reason: 'nudge L1: heads-up: new PR or new head' }), ctx());
    assert.equal(got.allow, false, type);
  }
  // An unacked heads-up stays on the board. The prefix must not turn it into a wake.
  assert.equal(allowWake(on, 'blinky', line({ type: 'pr_update', reason: 'nudge L2: heads-up' }), ctx()).allow, false);
});

test('a second station nudge inside the hour is filtered', () => {
  const state = createWakeState();
  const nudge = line({ id: 'nudge:station:forge:2026-11-16T04', type: 'station' });
  assert.equal(allowWake(on, 'forge', nudge, ctx({ state })).allow, true);
  commitWake(state, 'forge', nudge, NOW);
  assert.equal(allowWake(on, 'forge', nudge, ctx({ state, now: NOW + 30 * 60 * 1000 })).allow, false);
  assert.equal(allowWake(on, 'forge', nudge, ctx({ state, now: NOW + 61 * 60 * 1000 })).allow, true);
});

test('a cooldown skip or a breaker skip does not spend the slot', () => {
  const cfg = wakeConfig({ WAKE_KIND_COOLDOWN_S: 900 });
  const state = createWakeState();
  const station = line({ id: 'nudge:station:forge', type: 'station', repo: 'acme/one', number: 4 });
  noteSent(state, 'forge', [station], NOW);
  assert.equal(allowWake(on, 'forge', station, ctx({ state, now: NOW + 1000 })).allow, true);
  const skipped = gateLine({ seat: 'forge', line: station }, state, NOW + 1000, cfg);
  assert.equal(skipped.op, 'skip');
  assert.equal(skipped.reason, 'cooldown');
  assert.equal(allowWake(on, 'forge', station, ctx({ state, now: NOW + 2000 })).allow, true);
  const sent = gateLine({ seat: 'forge', line: station }, state, NOW + 900000, cfg);
  assert.equal(sent.op, 'send');
  commitWake(state, 'forge', station, NOW + 900000);
  assert.equal(allowWake(on, 'forge', station, ctx({ state, now: NOW + 901000 })).allow, false);

  const held = createWakeState();
  const ping = line({ id: 'nudge:station:critic', type: 'station', repo: 'acme/one', number: 9 });
  held.breaker.set('acme/one#9', { until: NOW + 3600000, since: NOW });
  assert.equal(allowWake(on, 'critic', ping, ctx({ state: held })).allow, true);
  const blocked = gateLine({ seat: 'critic', line: ping }, held, NOW, cfg);
  assert.equal(blocked.op, 'skip');
  assert.equal(blocked.reason, 'breaker');
  assert.equal(allowWake(on, 'critic', ping, ctx({ state: held })).allow, true);
  const open = createWakeState();
  const again = line({ id: 'nudge:station:critic', type: 'station', sha: 'abc', repo: 'acme/one', number: 9 });
  noteSent(open, 'critic', [line({ type: 'station', sha: 'old', repo: 'acme/one', number: 9 })], NOW);
  const queued = gateLine({ seat: 'critic', line: again }, open, NOW + 1000, cfg);
  assert.equal(queued.op, 'queue');
  commitWake(open, 'critic', again, NOW + 1000);
  assert.equal(allowWake(on, 'critic', again, ctx({ state: open })).allow, false);
});
