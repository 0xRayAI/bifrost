import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeState, gateLine, noteSent, wakeConfig } from '../wake-gate.mjs';
import { allowWake, commitWake, owedSeat, readWakeFilter, filterMode } from '../wake-filter.mjs';

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

test('critic gets one green head, and near or mill get an R assignment', () => {
  const state = createWakeState();
  const green = line({ type: 'ci_pass', sha: 'abc', repo: 'acme/one', number: 9 });
  assert.equal(allowWake(on, 'critic', green, ctx({ state })).allow, true);
  commitWake(state, 'critic', green, NOW);
  assert.equal(allowWake(on, 'critic', green, ctx({ state })).allow, false);
  assert.equal(allowWake(on, 'forge', green, ctx({ state, owner: 'forge' })).allow, false);
  assert.equal(allowWake(on, 'mill', line({ type: 'pr_open', reason: 'packet R' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'near', line({ type: 'pr_open', raci: 'R=near A=forge' }), ctx()).allow, true);
  assert.equal(allowWake(on, 'forge', line({ type: 'pr_open', reason: 'packet R' }), ctx()).allow, false);
});

test('a green head wakes critic once, a repeat is skipped, and a newer head wakes again', () => {
  const state = createWakeState();
  const green = (sha, kind) => line({
    type: kind, kind, sha, repo: '0xRayAI/clearing', number: 28,
    conclusion: 'success', status: 'completed',
  });
  const first = green('3781168cc00a', 'check_suite');
  assert.equal(allowWake(on, 'critic', first, ctx({ state })).allow, true);
  commitWake(state, 'critic', first, NOW);
  assert.equal(allowWake(on, 'critic', green('3781168cc00a', 'ci_pass'), ctx({ state })).allow, false);
  const next = green('aaaaaaaaaaaa', 'workflow_run');
  assert.equal(allowWake(on, 'critic', next, ctx({ state })).allow, true);
  commitWake(state, 'critic', next, NOW);
  assert.equal(allowWake(on, 'critic', green('aaaaaaaaaaaa', 'status'), ctx({ state })).allow, false);
  assert.equal(allowWake(on, 'critic', line({ type: 'check_suite', sha: 'bbbbbbbbbbbb', conclusion: 'failure' }), ctx({ state })).allow, false);
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
  const green = line({ type: 'ci_pass', sha: 'abc', repo: 'acme/one', number: 9 });
  held.breaker.set('acme/one#9', { until: NOW + 3600000, since: NOW });
  assert.equal(allowWake(on, 'critic', green, ctx({ state: held })).allow, true);
  const blocked = gateLine({ seat: 'critic', line: green }, held, NOW, cfg);
  assert.equal(blocked.op, 'skip');
  assert.equal(blocked.reason, 'breaker');
  assert.equal(allowWake(on, 'critic', green, ctx({ state: held })).allow, true);
  const open = createWakeState();
  noteSent(open, 'critic', [line({ type: 'ci_pass', sha: 'old', repo: 'acme/one', number: 9 })], NOW);
  const queued = gateLine({ seat: 'critic', line: green }, open, NOW + 1000, cfg);
  assert.equal(queued.op, 'queue');
  commitWake(open, 'critic', green, NOW + 1000);
  assert.equal(allowWake(on, 'critic', green, ctx({ state: open })).allow, false);
});
