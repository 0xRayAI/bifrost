import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAgent, escalateTarget, wakeUnreachable } from '../wake-gate.mjs';

const seats = ['blinky', 'critic', 'forge', 'arch1'];

test('forge falls through to arch1 and arch1 is the end of the chain', () => {
  assert.equal(nextAgent('forge', seats), 'arch1');
  assert.equal(nextAgent('arch1', seats), '');
  assert.equal(nextAgent('critic', seats), 'forge');
  assert.equal(nextAgent('forge', ['forge']), '');
});

test('a dead forge webhook lands on arch1, and a dead critic stops at a live forge', () => {
  const down = id => id === 'forge';
  assert.equal(escalateTarget('forge', seats, down), 'arch1');
  assert.equal(escalateTarget('critic', seats, down), 'arch1');
  assert.equal(escalateTarget('critic', seats, () => false), 'forge');
  assert.equal(escalateTarget('arch1', seats, down), '');
});

test('the server moves a dead webhook, a failed delivery, and a seat that does not answer', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(seatUnreachable\(id\)\) \{\n    if \(escalateLine\(id, line, 'webhook unreachable'\)\) return;/);
  assert.match(src, /\} else releaseWaking\(wakeState, seat, batch\);\n    if \(!result\.ok && wakeUnreachable\(st\.status\)\)/);
  assert.match(src, /if \(lvl >= 2\) \{\n      const next = escalateLine\(seat, l, 'no answer'\)/);
  assert.match(src, /if \(SEAT_WEBHOOKS\[next\] && !seatUnreachable\(next\)\)/);
});

test('a disabled, missing, or unreachable wake is a reason to escalate', () => {
  assert.equal(wakeUnreachable({ ok: false, error: 'http_400_disabled', detail: 'Automation is disabled' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'timeout' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'network' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'no_key' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'http_502' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'UND_ERR_SOCKET' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'ENETUNREACH' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'EHOSTUNREACH' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'EPIPE' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'ETIMEDOUT' }), true);
  assert.equal(wakeUnreachable({ ok: false, error: 'http_400', detail: 'bad json' }), false);
  assert.equal(wakeUnreachable({ ok: false, error: 'http_500' }), false);
  assert.equal(wakeUnreachable({ ok: true, error: 'disabled' }), false);
  assert.equal(wakeUnreachable(null), false);
});
