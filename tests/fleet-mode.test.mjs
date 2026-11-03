import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeAllowed } from '../fleet-mode.mjs';

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
});
