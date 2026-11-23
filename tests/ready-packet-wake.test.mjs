// bifrost#108: a board ready handoff (type packet, kind ready) wakes the seat it is addressed to,
// even when the seat is busy and the line is queued. A superseded head, the author's own line, and a repeat stay quiet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenPort } from './free-port.mjs';
import { createWakeState } from '../wake-gate.mjs';
import { allowWake, readWakeFilter, readyPacket } from '../wake-filter.mjs';

const NOW = 1_700_000_000_000;
const on = readWakeFilter({});
const OLD = 'aaaaaaa1111111111111111111111111111111aa';
const NEW = 'bbbbbbb2222222222222222222222222222222bb';
const ctx = (over = {}) => ({ now: NOW, state: createWakeState(), owner: '', head: '', ...over });
const ready = (over = {}) => ({
  id: 'handoff:0xrayai/xray#1234:ready:' + NEW, t_ct: new Date(NOW).toISOString(), seat: 'critic', from: 'forge', to: 'critic',
  type: 'packet', kind: 'ready', repo: '0xRayAI/xray', number: 1234, sha: NEW, title: 'handoff ready', url: 'https://github.com/0xRayAI/xray/pull/1234', reason: 'handoff ready', ...over,
});

test('a ready packet is the handoff line live-inbox posts', () => {
  assert.equal(readyPacket(ready()), true);
  assert.equal(readyPacket(ready({ kind: 'critic_fail' })), false);
  assert.equal(readyPacket(ready({ type: 'pr_update' })), false);
});

test('a ready packet on the current head wakes the seat it is addressed to', () => {
  assert.equal(allowWake(on, 'critic', ready(), ctx({ head: NEW, headAt: NOW - 1000 })).allow, true);
  assert.equal(allowWake(on, 'critic', ready(), ctx({ head: NEW.slice(0, 7), headAt: NOW - 1000 })).allow, true);
  assert.equal(allowWake(on, 'critic', ready(), ctx()).allow, true);
});

test('a ready packet addressed to another seat does not wake this one', () => {
  assert.equal(allowWake(on, 'blinky', ready({ to: 'critic' }), ctx({ head: NEW })).allow, false);
});

test('a ready packet for a head the card has moved past is still dropped', () => {
  const stale = ready({ id: 'handoff:0xrayai/xray#1234:ready:' + OLD, sha: OLD, t_ct: new Date(NOW - 120000).toISOString() });
  assert.equal(allowWake(on, 'critic', stale, ctx({ head: NEW, headAt: NOW })).allow, false);
});

test('a ready packet already delivered is not allowed twice', async () => {
  const { markDelivered } = await import('../wake-filter.mjs');
  const state = createWakeState();
  assert.equal(allowWake(on, 'critic', ready(), ctx({ state, head: NEW })).allow, true);
  markDelivered(state, 'critic', ready());
  assert.equal(allowWake(on, 'critic', ready(), ctx({ state, head: NEW })).allow, false);
});

// ---- real server: critic is busy, so the handoff queues behind its work, and the wake still goes out ----
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const got = [];
const sink = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => { b += d; });
  q.on('end', () => { got.push({ path: q.url, body: JSON.parse(b || '{}') }); s.writeHead(200); s.end('{}'); });
});
await new Promise(r => sink.listen(0, '127.0.0.1', r));
const W = `http://127.0.0.1:${sink.address().port}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-wake-'));
const ING = crypto.randomBytes(32).toString('hex');
const RAW = { critic: crypto.randomBytes(8).toString('hex') + '-critic', forge: crypto.randomBytes(8).toString('hex') + '-forge' };
const KEYS = Object.fromEntries(Object.entries(RAW).map(([seat, t]) => [seat, crypto.createHash('sha256').update(t).digest('hex')]));
fs.mkdirSync(path.join(DATA, 'live'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'live', 'cards.json'), JSON.stringify({
  updated_ct: new Date().toISOString(),
  cards: [{ repo: '0xRayAI/xray', number: 1234, owner: 'critic', state: 'live', stage: 'fix', packet: { raci: 'R=critic A=forge' } }],
}));
const hooks = Object.fromEntries(['critic', 'forge'].map(s => [s, { url: `${W}/${s}` }]));
let logs = '';
const srv = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
  env: {
    PORT: '0', PATH: process.env.PATH, COLLECTOR: 'off', SERVER_ROUTING: 'off', STATION_NUDGE: 'off', MESH_DATA_DIR: DATA,
    INGEST_SECRET: ING, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), SEAT_KEYS: JSON.stringify(KEYS),
    SEAT_WEBHOOKS: JSON.stringify(hooks), WAKE_KEY_CRITIC: 'kc', WAKE_KEY_FORGE: 'kf',
    WAKE_BATCH_S: '0', WAKE_STAGGER_MS: '0', WAKE_COALESCE_MS: '20', WAKE_RETRY_MS: '10', LIVE_TURN_OPEN_MIN: '0',
    WAKE_KIND_COOLDOWN_S: '0', WAKE_MAX_PER_HOUR: '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => { logs += d; });
srv.stderr.on('data', d => { logs += d; });
const base = `http://127.0.0.1:${await listenPort(srv)}`;
const until = async fn => { for (let i = 0; i < 80 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); return fn(); };
const quiet = ms => new Promise(r => setTimeout(r, ms));
const post = async (row) => (await (await fetch(base + '/inbox', {
  method: 'POST', headers: { 'X-Live-Ingest': ING, 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [row] }),
})).json());
const wakesFor = (seat, id) => got.filter(g => g.path === '/' + seat && g.body.ids && g.body.ids.includes(id));

after(async () => {
  srv.kill();
  await new Promise(r => (srv.exitCode != null || srv.signalCode ? r() : srv.once('exit', r)));
  sink.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('server: a queued ready packet still offers and sends the wake once', async () => {
  const turn = await fetch(base + '/activity', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RAW.critic, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'turn', action: 'start', t_ct: new Date().toISOString() }),
  });
  assert.equal(turn.status, 202, await turn.text());
  const row = ready({ id: 'handoff:0xrayai/xray#1234:ready:cccccccc33333333', sha: 'cccccccc33333333', t_ct: new Date().toISOString() });
  const placed = await post(row);
  assert.equal(placed.seat, 'critic');
  assert.equal(placed.queued, true, 'critic is busy, so the line queues');
  assert.ok(await until(() => wakesFor('critic', row.id).length === 1), logs);
  const again = await post(row);
  assert.equal(again.added, 0);
  await quiet(300);
  assert.equal(wakesFor('critic', row.id).length, 1, 'a repeat post does not wake twice');
});

test('server: the author of a ready line is not woken by it', async () => {
  const row = ready({ id: 'handoff:0xrayai/xray#1234:ready:dddddddd44444444', sha: 'dddddddd44444444', from: 'critic', to: 'critic', t_ct: new Date().toISOString() });
  await post(row);
  await quiet(400);
  assert.equal(wakesFor('critic', row.id).length, 0, logs);
  assert.match(logs, /wake: skip critic own_actor handoff:0xrayai\/xray#1234:ready:dddddddd44444444/);
});
