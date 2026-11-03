import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchedule, cursorLaunchAllowed, scheduledFleetMode, wakeAllowed } from '../fleet-mode.mjs';

test('P1 and a scheduled run pass in every mode', () => {
  const p1 = { title: 'P1: fleet mode' };
  const plain = { title: 'quiet card' };
  const marked = { title: 'lights-on: keep the board' };
  for (const mode of ['full', 'lights-on', 'dark']) {
    assert.equal(wakeAllowed(mode, p1), true);
    assert.equal(wakeAllowed(mode, plain, { scheduled: true }), true);
  }
  assert.equal(wakeAllowed('lights-on', marked), true);
  assert.equal(wakeAllowed('lights-on', plain), false);
  assert.equal(wakeAllowed('dark', plain), false);
  assert.equal(wakeAllowed('dark', marked), false);
  assert.equal(wakeAllowed('full', plain), true);
  assert.equal(scheduledFleetMode(Date.parse('2026-11-02T14:00:00Z')), 'full');
  assert.equal(scheduledFleetMode(Date.parse('2026-11-02T21:30:00Z')), 'lights-on');
  const held = { mode: 'dark', route: 'none', by: 'blaze', source: 'manual', boundary: '2026-11-02 full' };
  assert.equal(applySchedule(held, Date.parse('2026-11-02T14:00:00Z')).mode, 'dark');
  assert.equal(applySchedule(held, Date.parse('2026-11-02T21:30:00Z')).by, 'schedule');
  assert.equal(cursorLaunchAllowed({ route: 'none', readable: false, p1: true }), true);
  assert.equal(cursorLaunchAllowed({ route: 'none', readable: true, p1: true }), false);
});
