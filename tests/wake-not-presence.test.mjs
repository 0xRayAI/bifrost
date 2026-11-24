import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('a delivered wake is not presence', () => {
  const start = src.indexOf('async function flushWake');
  const flush = src.slice(start, src.indexOf('\nasync function ', start + 20));
  const okAt = flush.indexOf('if (result.ok)');
  const elseAt = flush.indexOf('else releaseWaking');
  const ok = flush.slice(okAt, elseAt);
  assert.ok(start > 0 && okAt > 0 && elseAt > okAt);
  assert.doesNotMatch(ok, /touchSeat\(/);
  assert.match(ok, /wakeOkAt\[seat\] = st\.status\.at; persistWakeOk\(\)/);
  assert.match(ok, /serverActivity\(seat, 'turn', 'start', 'wake'/);
  assert.match(src, /if \(line\.by === 'server' && line\.tag === 'wake'\) continue/);
  assert.match(src, /ackLines\(who, what, review\); touchSeat\(who\)/);
});
