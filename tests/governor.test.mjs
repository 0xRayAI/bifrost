import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, runChoice, stallMove } from '../governor.mjs';

const tripMs = 30 * 60000;

test('stall noise does not move the clock', () => {
  for (const kind of ['check_run', 'check_suite', 'workflow_run', 'ci_pass', 'ci_fail', 'pr_commit', 'commit_status', 'health_ok', 'health_fail', 'deploy', 'deploy_fail', 'deploy_pending', 'op_deploy', 'probe', 'feed_push', 'x_out_root', 'seat_turn', 'seat_prompt']) {
    assert.equal(stallMove({ id: kind, kind }), false, kind);
  }
  assert.equal(stallMove({ id: 'c', kind: 'issue_comment' }), true);
  assert.equal(stallMove({ id: 'm', kind: 'merged' }), true);
  assert.equal(stallMove({ id: 'p', kind: 'pr_open' }), true);
  assert.equal(stallMove({ id: 'w', kind: 'issue_comment', moves: false }), false);
  assert.equal(stallMove({ id: 't', kind: 'subagent_done' }), false);
});

test('a still board wakes once and a move clears it', () => {
  const clock = createClock({ tripMs, perSeatMs: 60000, now: 0 });
  const board = { openCards: 2, openSeats: ['arch1'], coord: 'blinky' };
  assert.equal(clock.observe('a', 0, board), null);
  assert.equal(clock.observe('a', tripMs - 1, board), null);
  assert.equal(clock.observe('a', tripMs, board), 'stall');
  assert.equal(clock.run.reason, 'stall');
  assert.deepEqual(Object.keys(clock.run.deadlines), ['arch1']);
  assert.equal(clock.observe('a', tripMs * 3, board), null);
  assert.equal(clock.observe('b', tripMs * 3, board), 'cleared');
  assert.equal(clock.run, null);
  assert.equal(clock.observe('b', tripMs * 4, board), 'stall');
});

test('nudges cover open cards and an empty board wakes the coord', () => {
  const covered = runChoice({ openCards: 3, openSeats: [], coord: 'blinky', nudgeCovered: true });
  assert.equal(covered, null);
  const missed = runChoice({ openCards: 1, openSeats: [], coord: 'blinky' });
  assert.equal(missed.reason, 'stall');
  assert.deepEqual(missed.seats, ['blinky']);
  const empty = runChoice({ openCards: 0, coord: 'blinky' });
  assert.equal(empty.reason, 'empty');
  const quiet = runChoice({ openCards: 0, coord: 'blinky', burnQuiet: true });
  assert.equal(quiet.reason, 'quiet');
  const parked = runChoice({ openCards: 0, coord: 'blinky', scheduled: 2 });
  assert.equal(parked, null);
});

test('a due plan joins a stall and owns an otherwise empty board', () => {
  const stall = runChoice({ openCards: 1, openSeats: ['forge'], coord: 'blinky', planDue: true });
  assert.deepEqual(stall.seats, ['forge', 'blinky']);
  assert.equal(stall.planSeat, 'blinky');
  const plan = runChoice({ openCards: 0, coord: 'blinky', planDue: true });
  assert.equal(plan.reason, 'plan');
  assert.deepEqual(plan.seats, ['blinky']);
});

test('the hand clock starts the empty run and stays quiet on burn', () => {
  const clock = createClock({ tripMs, perSeatMs: 60000, now: 0 });
  const quiet = clock.startFromBoard(0, { openCards: 0, coord: 'blinky', burnQuiet: true }, 'blinky');
  assert.equal(quiet, null);
  const run = clock.startFromBoard(0, { openCards: 0, coord: 'blinky' }, 'blinky');
  assert.equal(run.reason, 'empty');
  assert.equal(run.by, 'blinky');
  assert.deepEqual(Object.keys(run.deadlines), ['blinky']);
});

test('weekly burn logs once until the board moves', () => {
  const clock = createClock({ tripMs, perSeatMs: 60000, now: 0 });
  const board = { openCards: 0, coord: 'blinky', burnQuiet: true };
  assert.equal(clock.observe('a', 0, board), null);
  assert.equal(clock.observe('a', tripMs, board), 'quiet');
  assert.equal(clock.run, null);
  assert.equal(clock.observe('a', tripMs * 4, board), null);
});
