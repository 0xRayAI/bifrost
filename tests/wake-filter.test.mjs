import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeState, gateLine, noteSent, wakeConfig } from '../wake-gate.mjs';
import { createBatch } from '../pr-batch.mjs';
import { allowWake, commitWake, owedSeat, readWakeFilter, filterMode, criticGreenLine, dumpGreenHeads, restoreGreenHeads, rememberGreen } from '../wake-filter.mjs';

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
  assert.equal(allowWake(on, 'forge', line({ type: 'needs_human', kind: 'needs_human' }), ctx()).allow, false);
  assert.equal(allowWake(on, 'critic', line({ type: 'needs_human', kind: 'needs_human' }), ctx()).allow, false);
  assert.equal(allowWake(on, 'blinky', line({ type: 'needs_human', kind: 'needs_human', to: 'human' }), ctx()).allow, false);
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
  assert.equal(allowWake(on, 'forge', line({ type: 'ci_fail', sha: 'old' }), own).allow, false);
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

test('near or mill get an R assignment, and a green head does not wake', () => {
  assert.equal(allowWake(on, 'critic', line({ type: 'ci_pass', sha: 'abc', repo: 'acme/one', number: 9 }), ctx()).allow, false);
  assert.equal(allowWake(on, 'critic', line({ type: 'check_suite', sha: '3781168cc00a', conclusion: 'success', status: 'completed' }), ctx()).allow, false);
  assert.equal(allowWake(on, 'mill', line({ type: 'pr_open', reason: 'packet R' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'near', line({ type: 'pr_open', raci: 'R=near A=forge' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'pr_open', reason: 'packet R' }), ctx()).allow, false);
});

test('critic wakes once when every check is green, and a partial head stays quiet', () => {
  const full = '3781168cc00a136b458ebdd97be1399ea195da29';
  const short = full.slice(0, 12);
  const runs = [
    { kind: 'check_run', name: 'unit', status: 'completed', conclusion: 'success' },
    { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'success' },
  ];
  const suite = { kind: 'check_suite', name: 'github-actions', status: 'completed', conclusion: 'success' };
  const ev = { repo: '0xRayAI/clearing', number: 28, sha: short, head_sha: full };
  assert.equal(criticGreenLine(ev, [suite], {}), null);
  assert.equal(criticGreenLine(ev, runs, {}), null);
  assert.equal(criticGreenLine(ev, [runs[0], { ...runs[1], status: 'in_progress', conclusion: '' }, suite], {}), null);
  assert.equal(criticGreenLine(ev, [runs[0], { ...runs[1], conclusion: 'failure' }, suite], {}), null);
  assert.equal(criticGreenLine(ev, [...runs, { ...suite, conclusion: 'failure' }], {}), null);
  const ping = criticGreenLine(ev, [...runs, suite], {});
  assert.equal(ping.sha, full);
  assert.equal(ping.seat, 'critic');
  const state = createWakeState();
  assert.equal(allowWake(on, 'critic', ping, ctx({ state })).allow, true);
  commitWake(state, 'critic', ping, NOW);
  assert.equal(allowWake(on, 'critic', { ...ping, sha: short }, ctx({ state })).allow, false);
  const newer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const again = criticGreenLine({ ...ev, sha: newer, head_sha: newer }, [...runs, suite], {});
  assert.equal(allowWake(on, 'critic', again, ctx({ state })).allow, true);
});

test('the batch list stays quiet until every run and the suite are green', () => {
  const batch = createBatch();
  const repo = '0xRayAI/clearing';
  const number = 28;
  const sha = '3781168cc00a136b458ebdd97be1399ea195da29';
  const key = '0xrayai/clearing#28';
  const ev = { repo, number, sha };
  batch.observeCi({ ...ev, kind: 'workflow_run', name: 'ci', status: 'completed', conclusion: 'success' });
  assert.equal(criticGreenLine(ev, batch.checksOf(key), {}), null);
  batch.observeCi({ ...ev, kind: 'check_run', name: 'unit', status: 'completed', conclusion: 'success' });
  batch.observeCi({ ...ev, kind: 'check_run', name: 'lint', status: 'in_progress' });
  assert.equal(criticGreenLine(ev, batch.checksOf(key), {}), null);
  batch.observeCi({ ...ev, kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'failure' });
  assert.equal(criticGreenLine(ev, batch.checksOf(key), {}), null);
  batch.observeCi({ ...ev, kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'success' });
  batch.observeCi({ ...ev, kind: 'check_suite', name: 'github-actions', status: 'completed', conclusion: 'success' });
  assert.equal(criticGreenLine(ev, batch.checksOf(key), {}).sha, sha);
});

test('a merged or closed pull does not wake critic', () => {
  const checks = [
    { kind: 'check_run', name: 'unit', status: 'completed', conclusion: 'success' },
    { kind: 'check_suite', name: 'github-actions', status: 'completed', conclusion: 'success' },
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
    { kind: 'check_run', name: 'unit', status: 'completed', conclusion: 'success' },
    { kind: 'check_suite', name: 'github-actions', status: 'completed', conclusion: 'success' },
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
  assert.equal(allowWake(on, 'mill', line({ type: 'ci_fail', sha: 'oldhead' }), owed).allow, false);
});

test('a ladder nudge and the stall clock still wake', () => {
  assert.equal(allowWake(on, 'forge', line({ type: 'nudge', reason: 'nudge L1: stale' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'critic', line({ type: 'timed_run', id: 'clock:1:critic' }), ctx()).allow, true);
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
