// Plain words on the board face, and a fleet image in place of the wordmark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadLive() {
  const box = {};
  new Function('globalThis', fs.readFileSync(path.join(root, 'public/live.js'), 'utf8'))(box);
  return box.LiveMesh;
}

test('a turn and the clock use plain words', () => {
  const L = loadLive();
  assert.equal(L.activityDetail({ kind: 'seat_turn', from: 'arch1' }).label, 'working');
  assert.equal(L.activityDetail({ kind: 'seat_turn', label: 'arch1 turn start' }).label, 'started');
  assert.equal(L.activityDetail({ kind: 'seat_turn', label: 'turn end' }).label, 'finished');
  assert.equal(L.activityDetail({ kind: 'pr_open', label: 'Fix the door' }).label, 'Fix the door');
  assert.equal(L.activityDetail({ kind: 'pr_open' }).label, 'open');
  assert.equal(L.activityDetail({ kind: 'op_deploy' }).label, 'op deploy');
  const clock = L.fmtCt(Date.parse('2026-11-24T17:21:12Z'));
  assert.match(clock, /Nov 24/);
  assert.match(clock, /11:21/);
  assert.match(clock, /AM/);
  assert.match(clock, /Central$/);
  assert.doesNotMatch(clock, /\bCT\b/);
  assert.doesNotMatch(clock, /:12/);
  const brand = L.setBrand({ logo: 'fleet-logo.png', alt: 'North fleet' });
  assert.equal(brand.logo, 'fleet-logo.png');
  assert.equal(L.brand.alt, 'North fleet');
  assert.equal(L.brand.byline, '');
});

test('the picture uses plain words and the header mark can be a fleet image', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /Work passing between people/);
  assert.match(html, /a circle is a person/);
  assert.match(html, />Just got work</);
  assert.match(html, />Here, idle</);
  assert.match(html, />Work leaving</);
  assert.match(html, />To themselves</);
  assert.match(html, /id="fleetLogo"/);
  assert.match(html, /L\.brand && L\.brand\.logo/);
  assert.match(html, /🌈 bifrost by 0xray/);
  assert.doesNotMatch(html, /PING-PONG/);
  assert.doesNotMatch(html, /Hot ring/);
  assert.doesNotMatch(html, /One-node ring/);
});
