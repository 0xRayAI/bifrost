// xray#976: a comment a seat bot wrote never wakes another seat. Pure gate cases, then the real server.
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
import {
  ROLLING_HOUR_MS, SEAT_COMMENT_LIMIT, wakeConfig, createWakeState, gateLine, noteSent, commentRepeatKey, isSeatComment,
} from '../wake-gate.mjs';

const cfg = wakeConfig({ WAKE_KIND_COOLDOWN_S: '0', WAKE_MAX_PER_HOUR: '60', LIVE_TURN_OPEN_MIN: '20', WAKE_BATCH_S: '0' });
cfg.isExternal = seat => seat === 'arch1';   // the roster's `outside` list
const T0 = 1_700_000_000_000;
const c = (over) => ({
  id: 'c', type: 'pr_comment', repo: 'acme/one', number: 7, title: 't', url: 'https://github.com/acme/one/pull/7', reason: 'comment on your PR', ...over,
});
const offer = (st, seat, line, t) => {
  const d = gateLine({ seat, line }, st, t, cfg);
  if (d.op === 'send') noteSent(st, seat, [line], t);
  return d;
};

test('two seats ping-pong comments on an unchanged head: at most the first wakes each seat, zero after that', () => {
  const st = createWakeState();
  const sent = [];
  for (let i = 0; i < 12; i++) {
    const from = i % 2 ? 'forge' : 'critic';
    const to = i % 2 ? 'critic' : 'forge';
    const d = offer(st, to, c({ id: 'pp' + i, from, sha: 'abc123' }), T0 + i * 20_000);
    if (d.op === 'send') sent.push(i);
  }
  assert.deepEqual(sent, [0, 1], 'only the first comment each seat sees can wake, and only for the head it had not seen');
  const bare = createWakeState();
  for (let i = 0; i < SEAT_COMMENT_LIMIT; i++) {
    const d = offer(bare, i % 2 ? 'critic' : 'forge', c({ id: 'n' + i, from: i % 2 ? 'forge' : 'critic' }), T0 + i * 20_000);
    assert.equal(d.op, 'skip');
    assert.equal(d.reason, 'seat_comment');
  }
});

test('a seat ack comment ("Received L1 nudge") never wakes the other seat, with or without a sha', () => {
  const st = createWakeState();
  const ack = c({ id: 'ack1', from: 'forge', title: 'Received L1 nudge (next owner)', reason: 'comment watch' });
  assert.equal(offer(st, 'critic', ack, T0).reason, 'seat_comment');
  assert.equal(offer(st, 'blinky', ack, T0).reason, 'seat_comment');
  const seen = c({ id: 'ack2', from: 'critic', type: 'issue_comment', title: 'Seen' });
  assert.equal(offer(st, 'forge', seen, T0 + 1).reason, 'seat_comment');
});

test('a human comment still wakes, with or without a sha, and a repeat human comment is not a repeat', () => {
  const st = createWakeState();
  assert.equal(offer(st, 'forge', c({ id: 'h1' }), T0).op, 'send');
  assert.equal(offer(st, 'forge', c({ id: 'h2' }), T0 + 1000).op, 'send');
  assert.equal(offer(st, 'forge', c({ id: 'h3', from: 'arch1x' }), T0 + 2000).op, 'send');
  assert.equal(isSeatComment(c({ from: 'arch1x' }), cfg), false);
});

test('a seat comment with a new head sha wakes once; the same head again is a repeat', () => {
  const st = createWakeState();
  const first = offer(st, 'critic', c({ id: 's1', from: 'forge', sha: 'aaaa1111' }), T0);
  assert.equal(first.op, 'send');
  assert.equal(offer(st, 'critic', c({ id: 's2', from: 'forge', sha: 'aaaa1111' }), T0 + 5000).op, 'skip');
  const next = offer(st, 'critic', c({ id: 's3', from: 'forge', sha: 'bbbb2222' }), T0 + 10_000);
  assert.equal(next.op, 'send');
  assert.equal(commentRepeatKey('critic', c({ id: 'x1', sha: 'bbbb2222' })), commentRepeatKey('critic', c({ id: 'x2', sha: 'bbbb2222' })));
  assert.notEqual(commentRepeatKey('critic', c({ sha: 'bbbb2222' })), commentRepeatKey('critic', c({ sha: 'cccc3333' })));
  assert.equal(commentRepeatKey('critic', c({ id: 'y' })), 'critic|acme/one#7|nosha');
});

test('a seat comment that carries a handoff kind or a verdict wakes', () => {
  const st = createWakeState();
  for (const kind of ['ready', 'critic_fail', 'live_pass', 'merge', 'ci_fail']) {
    const d = offer(st, 'forge', c({ id: 'k-' + kind, from: 'critic', kind, number: 8 + kind.length }), T0);
    assert.equal(d.op, 'send', kind);
  }
});

test('breaker: the 4th seat comment in an hour pauses wakes for that issue and flags Blaze once', () => {
  const st = createWakeState();
  const ds = [];
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 1; i++) ds.push(offer(st, 'forge', c({ id: 'b' + i, from: 'critic' }), T0 + i * 60_000));
  assert.equal(ds.slice(0, SEAT_COMMENT_LIMIT).every(d => d.reason === 'seat_comment' && !d.needsHuman), true);
  assert.equal(ds[SEAT_COMMENT_LIMIT].reason, 'breaker');
  assert.equal(ds[SEAT_COMMENT_LIMIT].needsHuman, true);
  // The same 4th comment copied to another seat does not flag twice.
  const copy = offer(st, 'blinky', c({ id: 'b' + SEAT_COMMENT_LIMIT, from: 'critic' }), T0 + 5 * 60_000);
  assert.equal(copy.reason, 'breaker');
  assert.equal(copy.needsHuman, undefined);
  // Everything else on that issue is paused, a nudge too. A hotfix, a needs_human line, and other issues are not.
  assert.equal(offer(st, 'forge', c({ id: 'p1', type: 'ci_fail', sha: 'fff' }), T0 + 6 * 60_000).reason, 'breaker');
  assert.equal(offer(st, 'forge', c({ id: 'p2', type: 'nudge', reason: 'nudge L1: x' }), T0 + 6 * 60_000).reason, 'breaker');
  assert.equal(offer(st, 'forge', c({ id: 'p3', type: 'ci_fail', flag: 'hotfix' }), T0 + 7 * 60_000).op, 'send');
  assert.equal(offer(st, 'blinky', c({ id: 'p4', type: 'needs_human', kind: 'needs_human', to: 'human' }), T0 + 7 * 60_000).op, 'send');
  assert.equal(offer(st, 'forge', c({ id: 'p5', type: 'ci_fail', number: 99, sha: 'x' }), T0 + 7 * 60_000).op, 'send');
  // A human comment ends the pause.
  assert.equal(offer(st, 'forge', c({ id: 'human' }), T0 + 8 * 60_000).op, 'send');
  assert.equal(offer(st, 'forge', c({ id: 'p6', type: 'ci_fail', sha: 'f2' }), T0 + 9 * 60_000).op, 'send');
});

test('breaker: the pause and the count both age out after the rolling hour', () => {
  const st = createWakeState();
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 1; i++) offer(st, 'forge', c({ id: 'a' + i, from: 'critic' }), T0 + i);
  assert.equal(offer(st, 'forge', c({ id: 'q', type: 'ci_fail', sha: 'q1' }), T0 + ROLLING_HOUR_MS - 1000).reason, 'breaker');
  assert.equal(offer(st, 'forge', c({ id: 'q2', type: 'ci_fail', sha: 'q2' }), T0 + ROLLING_HOUR_MS + 1000).op, 'send');
  assert.equal(offer(st, 'forge', c({ id: 'late', from: 'critic' }), T0 + ROLLING_HOUR_MS + 2000).reason, 'seat_comment');
});

test('outside party: a forge comment that mentions arch1 wakes arch1, and the same comment still does not wake critic', () => {
  const st = createWakeState();
  const mention = { id: 'tip1', from: 'forge', reason: 'mention @arch10x' };
  assert.equal(offer(st, 'arch1', c(mention), T0).op, 'send');
  assert.equal(offer(st, 'critic', c({ ...mention, reason: 'comment watch' }), T0).reason, 'seat_comment');
  assert.equal(offer(st, 'blinky', c({ ...mention, reason: 'comment watch' }), T0).reason, 'seat_comment');
  // Several tips in a row, with no sha, are never filtered for the outside party.
  for (let i = 0; i < 6; i++) assert.equal(offer(st, 'arch1', c({ id: 'tip-n' + i, from: 'forge' }), T0 + 1000 + i).op, 'send');
  // arch1's own comment is not a seat comment: it wakes forge.
  assert.equal(isSeatComment(c({ from: 'arch1' }), cfg), false);
  assert.equal(offer(st, 'forge', c({ id: 'reply1', from: 'arch1' }), T0 + 9000).op, 'send');
});

test('outside party: a breaker trip on the issue does not stop the arch1 tip, and arch1 tips do not count toward the breaker', () => {
  const st = createWakeState();
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 1; i++) offer(st, 'forge', c({ id: 'loop' + i, from: 'critic', number: 9 }), T0 + i * 1000);
  assert.equal(st.breaker.has('acme/one#9'), true);
  assert.equal(offer(st, 'critic', c({ id: 'still-paused', from: 'forge', number: 9 }), T0 + 10_000).reason, 'breaker');
  const tip = offer(st, 'arch1', c({ id: 'tip-after-trip', from: 'forge', number: 9, reason: 'mention @arch10x' }), T0 + 11_000);
  assert.equal(tip.op, 'send');
  assert.equal(offer(st, 'arch1', c({ id: 'ci-for-arch1', type: 'ci_fail', number: 9, sha: 'e1' }), T0 + 12_000).op, 'send');
  // Tips to the outside party are not seat-to-seat traffic: ten of them trip nothing.
  const fresh = createWakeState();
  for (let i = 0; i < 10; i++) assert.equal(offer(fresh, 'arch1', c({ id: 'only-arch1-' + i, from: 'forge', number: 10 }), T0 + i * 1000).op, 'send');
  assert.equal(fresh.breaker.has('acme/one#10'), false);
  assert.equal(offer(fresh, 'critic', c({ id: 'next', from: 'forge', number: 10 }), T0 + 20_000).reason, 'seat_comment');
});

// ---- the real server ----
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const got = [];
const sink = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => { b += d; });
  q.on('end', () => { got.push({ path: q.url, body: JSON.parse(b || '{}') }); s.writeHead(200); s.end('{}'); });
});
await new Promise(r => sink.listen(0, '127.0.0.1', r));
const W = `http://127.0.0.1:${sink.address().port}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-comment-'));
const ING = crypto.randomBytes(32).toString('hex');
const hooks = ['forge', 'blinky', 'critic', 'arch1'].map(s => [s, { url: `${W}/${s}` }]);
let logs = '';
const srv = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
  env: {
    PORT: '0', PATH: process.env.PATH, COLLECTOR: 'off', MESH_DATA_DIR: DATA, INGEST_SECRET: ING,
    MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    SEAT_WEBHOOKS: JSON.stringify(Object.fromEntries(hooks)),
    WAKE_KEY_FORGE: 'kf', WAKE_KEY_BLINKY: 'kb', WAKE_KEY_CRITIC: 'kc', WAKE_KEY_ARCH1: 'ka',
    WAKE_BATCH_S: '0', WAKE_STAGGER_MS: '0', WAKE_COALESCE_MS: '20', WAKE_RETRY_MS: '10', LIVE_TURN_OPEN_MIN: '0',
    WAKE_KIND_COOLDOWN_S: '0', WAKE_MAX_PER_HOUR: '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => { logs += d; });
srv.stderr.on('data', d => { logs += d; });
const port = await listenPort(srv);
const BASE = `http://127.0.0.1:${port}`;
after(async () => {
  srv.kill();
  await new Promise(r => (srv.exitCode != null || srv.signalCode ? r() : srv.once('exit', r)));
  sink.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
const until = async fn => { for (let i = 0; i < 80 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); return fn(); };
const quiet = ms => new Promise(r => setTimeout(r, ms));
const post = async (lines) => {
  const res = await fetch(BASE + '/inbox', { method: 'POST', headers: { 'X-Live-Ingest': ING, 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const row = (over) => ({
  id: over.id, t_ct: new Date().toISOString(), seat: over.seat, type: over.type || 'pr_comment', repo: 'acme/one',
  number: over.number, title: over.title || 'comment', url: `https://github.com/acme/one/pull/${over.number}`, reason: over.reason || 'comment on your PR',
  ...(over.from ? { from: over.from } : {}), ...(over.sha ? { sha: over.sha } : {}), ...(over.kind ? { kind: over.kind } : {}),
});
const wakesFor = (seat, ids) => got.filter(g => g.path === '/' + seat && ids.some(id => g.body.ids && g.body.ids.includes(id)));

test('server: seat bots trade ack comments, zero wake lines are delivered, the breaker flags Blaze, a human wakes', async () => {
  const n = 61;
  const ids = [];
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 3; i++) {
    const id = `pp-${i}-zz`;
    ids.push(id);
    const from = i % 2 ? 'forge' : 'critic';
    const to = i % 2 ? 'critic' : 'forge';
    assert.equal((await post([row({ id, seat: to, number: n, from, title: 'Seen' })])).status, 200);
  }
  await quiet(400);
  assert.equal(got.some(g => (g.body.ids || []).some(id => ids.includes(id))), false, JSON.stringify(got));
  assert.match(logs, /wake: skip (forge|critic) seat_comment pp-0-zz/);
  assert.match(logs, /wake: breaker acme\/one#61/);
  assert.ok(await until(() => got.some(g => g.path === '/blinky' && String(g.body.inbox_id || '').startsWith('breaker:acme/one#61'))), logs);
  assert.equal(logs.split('wake: breaker acme/one#61').length - 1, 1);
  const human = 'human-61-zz';
  assert.equal((await post([row({ id: human, seat: 'forge', number: n })])).status, 200);
  assert.ok(await until(() => wakesFor('forge', [human]).length === 1), logs);
});

test('server: a seat comment with a new head sha wakes, the same head again does not', async () => {
  const n = 62;
  const first = 'sha-62-a-zz';
  assert.equal((await post([row({ id: first, seat: 'critic', number: n, from: 'forge', sha: 'deadbeef01' })])).status, 200);
  assert.ok(await until(() => wakesFor('critic', [first]).length === 1), logs);
  const again = 'sha-62-b-zz';
  assert.equal((await post([row({ id: again, seat: 'critic', number: n, from: 'forge', sha: 'deadbeef01' })])).status, 200);
  await quiet(300);
  assert.equal(wakesFor('critic', [again]).length, 0);
  const fresh = 'sha-62-c-zz';
  assert.equal((await post([row({ id: fresh, seat: 'critic', number: n, from: 'forge', sha: 'deadbeef02' })])).status, 200);
  assert.ok(await until(() => wakesFor('critic', [fresh]).length === 1), logs);
});

test('server: a forge comment that mentions arch1 wakes arch1, not critic, and still wakes arch1 after the breaker trips', async () => {
  const n = 63;
  const tip = 'tip-63-a-zz';
  assert.equal((await post([
    row({ id: tip, seat: 'arch1', number: n, from: 'forge', reason: 'mention @arch10x' }),
    row({ id: tip, seat: 'critic', number: n, from: 'forge', reason: 'comment watch' }),
  ])).status, 200);
  assert.ok(await until(() => wakesFor('arch1', [tip]).length === 1), logs);
  await quiet(300);
  assert.equal(wakesFor('critic', [tip]).length, 0);
  assert.match(logs, /wake: skip critic seat_comment tip-63-a-zz/);
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 1; i++) {
    assert.equal((await post([row({ id: `loop-63-${i}-zz`, seat: i % 2 ? 'critic' : 'forge', number: n, from: i % 2 ? 'forge' : 'critic' })])).status, 200);
  }
  await quiet(300);
  assert.match(logs, /wake: breaker acme\/one#63/);
  const after = 'tip-63-b-zz';
  assert.equal((await post([row({ id: after, seat: 'arch1', number: n, from: 'forge', reason: 'mention @arch10x' })])).status, 200);
  assert.ok(await until(() => wakesFor('arch1', [after]).length === 1), logs);
});

