import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBatch, defaultIssueSeat } from '../wake-gate.mjs';

const line = (over) => ({ id: over.id || 'l', type: 'issue_open', repo: 'acme/one', number: 1, title: 't', reason: 'opened', ...over });

test('unassigned issue_open wakes arch1 when forge is dark and forge otherwise', () => {
  const dark = classifyBatch([line({ id: 'iss-dark', seat: 'blinky' })], { defaultSeat: 'arch1' });
  assert.deepEqual(dark.wakes.map(w => w.seat), ['arch1']);
  const fleet = classifyBatch([line({ id: 'iss-fleet', seat: 'blinky' })]);
  assert.deepEqual(fleet.wakes.map(w => w.seat), ['forge']);
  assert.equal(defaultIssueSeat({ FORGE_DARK: '1' }), 'arch1');
  assert.equal(defaultIssueSeat({}), 'forge');
});
