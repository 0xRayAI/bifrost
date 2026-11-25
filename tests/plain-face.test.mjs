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
  assert.equal(L.activityDetail({ kind: 'seat_turn', label: 'arch1 turn start' }).label, 'working');
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
  const brand = L.setBrand({ logo: 'fleet-logo.png', logoDark: 'mark-dark.png', logoLight: 'mark-light.png', alt: 'North fleet' });
  assert.equal(brand.logo, 'fleet-logo.png');
  assert.equal(L.brand.alt, 'North fleet');
  assert.equal(L.brand.byline, '');
  assert.equal(L.brandLogo('dark'), 'mark-dark.png');
  assert.equal(L.brandLogo('light'), 'mark-light.png');
  L.setBrand({ logo: 'only.png', logoDark: '', logoLight: '' });
  assert.equal(L.brandLogo('dark'), 'only.png');
  assert.equal(L.brandLogo('light'), 'only.png');
});

test('the picture uses plain words and the header mark can be a fleet image', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /class="lg-dot"/);
  assert.match(html, /class="lg-circle"/);
  assert.match(html, /class="lg-square"/);
  assert.match(html, /id="meshCounts"/);
  assert.doesNotMatch(html, /id="headTime"/);
  assert.doesNotMatch(html, /data-fold="mesh"/);
  assert.doesNotMatch(html, /mesh-legend/);
  assert.doesNotMatch(html, /Just got work/);
  assert.match(html, /id="fleetLogo"/);
  assert.match(html, /L\.brand && L\.brand\.logo/);
  assert.match(html, /🌈 bifrost by 0xray/);
  assert.doesNotMatch(html, /PING-PONG/);
  assert.doesNotMatch(html, /Hot ring/);
  assert.doesNotMatch(html, /One-node ring/);
});
