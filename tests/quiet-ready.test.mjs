import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeState, gateLine, noteSent, wakeConfig } from '../wake-gate.mjs';
import { seatMessage } from '../chat-doorbell.mjs';

const cfg = wakeConfig({});
const sha = 'a'.repeat(40);
const ready = { id: 'h1', seat: 'critic', type: 'packet', kind: 'ready', repo: '0xRayAI/xray', number: 850, sha, title: 'handoff ready', url: 'https://github.com/0xRayAI/xray/pull/850', reason: 'handoff ready' };
const green = { ...ready, id: 'h2', type: 'ci_pass', kind: 'ci_pass', title: 'green head returns to critic', reason: 'green head returns to critic' };
const next = { ...ready, id: 'h3', number: 852, sha: 'b'.repeat(40), url: 'https://github.com/0xRayAI/xray/pull/852' };

test('a green head is not swallowed by the ready on that sha', () => {
  const state = createWakeState();
  const now = 1_700_000_000_000;
  const first = gateLine({ seat: 'critic', line: ready }, state, now, cfg);
  assert.equal(first.op, 'send');
  noteSent(state, 'critic', [ready], now);
  const again = gateLine({ seat: 'critic', line: ready }, state, now + 1000, cfg);
  assert.equal(again.op, 'skip');
  assert.equal(again.reason, 'repeat_sha');
  const strict = gateLine({ seat: 'critic', line: green }, state, now + 1000, cfg);
  assert.equal(strict.op, 'send');
});

test('a ready names clear Quiet and a green head names Strict', () => {
  assert.match(seatMessage(next).note, /clear Quiet/);
  assert.match(seatMessage(green).note, /Strict/);
  assert.doesNotMatch(seatMessage(green).note, /clear Quiet/);
});
