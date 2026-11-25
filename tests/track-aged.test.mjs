// An acked handoff whose card has aged off the board stays closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTrack } from '../worktrack.mjs';

function line(id) {
  return {
    id, type: 'packet', kind: 'ready', seat: 'critic', repo: '0xRayAI/xray', number: 10,
    title: 'ready', t_ct: '2026-11-20T12:00:00Z',
  };
}

test('an acked handoff stays closed after its card ages off, and an open card does not', () => {
  const lines = [line('h1')];
  const acks = { critic: new Set(['h1']) };
  const aged = deriveTrack({
    lines, acks, now: Date.parse('2026-11-25T12:00:00Z'), windowMs: 3600000,
    closedKeys: new Set(), openKeys: new Set(),
  });
  assert.equal(aged.items[0].closed, true);

  const still = deriveTrack({
    lines, acks, now: Date.parse('2026-11-25T12:00:00Z'), windowMs: 3600000,
    closedKeys: new Set(), openKeys: new Set(['0xrayai/xray#10']),
  });
  assert.equal(still.items[0].closed, false);

  const unacked = deriveTrack({
    lines, acks: {}, now: Date.parse('2026-11-25T12:00:00Z'), windowMs: 3600000,
    closedKeys: new Set(), openKeys: new Set(),
  });
  assert.equal(unacked.items[0].closed, false);

  const legacy = deriveTrack({
    lines, acks, now: Date.parse('2026-11-25T12:00:00Z'), windowMs: 3600000,
    closedKeys: new Set(),
  });
  assert.equal(legacy.items[0].closed, false);
});
