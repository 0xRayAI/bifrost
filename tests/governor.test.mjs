import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, runChoice, stallMove, isClockNudge, unackedWorkCount, stallWorkKey, stallLineKeys, planStallWakes, loadStallFired, dumpStallFired, applyLineNudge, clearStallFired } from '../governor.mjs';

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

test('the stall title count ignores clock and nudge lines', () => {
  const open = [
    { id: 'breaker:0xRayAI/xray#1082:1', type: 'needs_human', repo: '0xRayAI/xray', number: 1082 },
    { id: 'clock:1:blinky', type: 'timed_run' },
    { id: 'clock:2:blinky', type: 'timed_run' },
    { id: 'nudge:line:blinky:old', type: 'nudge' },
  ];
  assert.equal(unackedWorkCount(open), 1);
  assert.equal(isClockNudge(open[1]), true);
  assert.equal(stallWorkKey(open[0]), '0xrayai/xray#1082');
  assert.equal(stallWorkKey(open[1]), '');
});

test('a stall wake fires once per stale line id, even when the clock id changes', () => {
  const deadlines = { blinky: 't1' };
  const openBySeat = {
    blinky: [
      { id: 'breaker:0xRayAI/xray#1082:100', type: 'needs_human', repo: '0xRayAI/xray', number: 1082 },
      { id: 'clock:run1:blinky', type: 'timed_run' },
    ],
  };
  const first = planStallWakes({ reason: 'stall', deadlines, openBySeat, fired: new Set() });
  assert.equal(first.wakes.length, 1);
  assert.equal(first.wakes[0].seat, 'blinky');
  assert.equal(first.wakes[0].openCount, 1);
  const later = {
    blinky: [
      { id: 'breaker:0xRayAI/xray#1082:101', type: 'needs_human', repo: '0xRayAI/xray', number: 1082 },
      { id: 'clock:run1:blinky', type: 'timed_run' },
      { id: 'clock:run2:blinky', type: 'timed_run' },
    ],
  };
  const second = planStallWakes({ reason: 'stall', deadlines, openBySeat: later, fired: first.fired });
  assert.deepEqual(second.wakes, []);
  const dumped = dumpStallFired(second.fired);
  assert.ok(dumped.includes('0xrayai/xray#1082'));
  assert.ok(dumped.includes('breaker:0xRayAI/xray#1082:100'));
  assert.deepEqual([...loadStallFired(dumped)].sort(), dumped.slice().sort());
});

test('an empty-board clock still wakes, and a new work line can still fire after a prior stall', () => {
  const empty = planStallWakes({ reason: 'empty', deadlines: { blinky: 't' }, openBySeat: { blinky: [] }, fired: new Set() });
  assert.equal(empty.wakes.length, 1);
  assert.equal(empty.wakes[0].openCount, 0);
  const prior = new Set(['0xrayai/xray#1082']);
  const next = planStallWakes({
    reason: 'stall',
    deadlines: { mill: 't' },
    openBySeat: { mill: [{ id: 'handoff:xray#1199:ready:abc', type: 'packet', kind: 'ready', repo: '0xRayAI/xray', number: 1199 }] },
    fired: prior,
  });
  assert.equal(next.wakes.length, 1);
  assert.equal(next.wakes[0].seat, 'mill');
});

test('several line nudges update one inbox row and the open count stays 1', () => {
  const inbox = [{
    id: 'handoff:xray#1199:ready:abc',
    type: 'packet',
    kind: 'ready',
    repo: '0xRayAI/xray',
    number: 1199,
    reason: 'handoff ready',
    t_ct: '2026-11-22T08:00:00-06:00',
  }];
  const woken = new Set();
  const first = applyLineNudge(inbox, inbox[0].id, { level: 1, t_ct: '2026-11-22T08:20:00-06:00', woken });
  assert.equal(first.wake, true);
  assert.equal(first.count, 1);
  assert.equal(inbox.length, 1);
  const second = applyLineNudge(inbox, inbox[0].id, { level: 2, t_ct: '2026-11-22T08:35:00-06:00', woken });
  const third = applyLineNudge(inbox, inbox[0].id, { level: 3, t_ct: '2026-11-22T08:50:00-06:00', woken });
  assert.equal(second.wake, false);
  assert.equal(third.wake, false);
  assert.equal(inbox.length, 1);
  assert.equal(third.count, 1);
  assert.equal(unackedWorkCount(inbox), 1);
  assert.equal(inbox[0].id, 'handoff:xray#1199:ready:abc');
  assert.equal(inbox[0].nudge_level, 3);
  assert.equal(inbox[0].reason, 'nudge L3: handoff ready');
  assert.equal(inbox[0].t_ct, '2026-11-22T08:50:00-06:00');
  assert.deepEqual(stallLineKeys(inbox[0]), ['handoff:xray#1199:ready:abc', '0xrayai/xray#1199']);
});

test('after an ack, a new stale line on the same card gets one more stall wake', () => {
  const deadlines = { mill: 't' };
  const firstLine = { id: 'handoff:xray#1199:ready:aaa', type: 'packet', kind: 'ready', repo: '0xRayAI/xray', number: 1199 };
  const first = planStallWakes({ reason: 'stall', deadlines, openBySeat: { mill: [firstLine] }, fired: new Set() });
  assert.equal(first.wakes.length, 1);
  assert.equal(first.wakes[0].openCount, 1);
  const held = clearStallFired(first.fired, firstLine);
  const nextLine = { id: 'handoff:xray#1199:ready:bbb', type: 'packet', kind: 'ready', repo: '0xRayAI/xray', number: 1199 };
  const second = planStallWakes({ reason: 'stall', deadlines, openBySeat: { mill: [nextLine] }, fired: held });
  assert.equal(second.wakes.length, 1);
  assert.equal(second.wakes[0].seat, 'mill');
  const third = planStallWakes({ reason: 'stall', deadlines, openBySeat: { mill: [nextLine] }, fired: second.fired });
  assert.deepEqual(third.wakes, []);
});
