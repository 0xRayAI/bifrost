// xray#1060: a seat's own App / bot login does not ring that seat. xray#979: the breaker survives a restart.
import { test, after, describe } from 'node:test';
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
  SEAT_COMMENT_LIMIT, wakeConfig, createWakeState, classifyBatch, gateLine, noteSent,
  actorSeat, dumpBreaker, restoreBreaker,
} from '../wake-gate.mjs';

const MAP = new Map([
  ['forge0x1[bot]', 'forge'],
  ['critic0x[bot]', 'critic'],
]);
const ctx = { loginToSeat: MAP, defaultSeat: 'forge' };
const issue = (over) => ({
  id: 'iss', type: 'issue_open', repo: 'acme/one', number: 1060, title: 't', url: 'https://github.com/acme/one/issues/1060',
  reason: 'unowned: coordinator routes', ...over,
});
const cfg = wakeConfig({ WAKE_KIND_COOLDOWN_S: '0', WAKE_MAX_PER_HOUR: '60', LIVE_TURN_OPEN_MIN: '20', WAKE_BATCH_S: '0' });
cfg.isExternal = seat => seat === 'arch1';
const T0 = 1_700_000_000_000;
const comment = (over) => ({
  id: 'c', type: 'pr_comment', repo: 'acme/one', number: 7, title: 't', url: 'https://github.com/acme/one/pull/7',
  reason: 'comment on your PR', ...over,
});
const offer = (st, seat, line, t) => {
  const d = gateLine({ seat, line }, st, t, cfg);
  if (d.op === 'send') noteSent(st, seat, [line], t);
  return d;
};

test('actorSeat maps a routing login and passes a seat id through', () => {
  assert.equal(actorSeat({ from: 'forge0x1[bot]' }, ctx), 'forge');
  assert.equal(actorSeat({ actor: 'critic0x[bot]' }, ctx), 'critic');
  assert.equal(actorSeat({ from: 'forge' }, ctx), 'forge');
  assert.equal(actorSeat({ from: 'forge' }), 'forge');
});

test('issue_open by forge0x1[bot] does not wake forge; a line for critic still wakes critic', () => {
  const r = classifyBatch([
    issue({ id: 'i1', seat: 'blinky', from: 'forge0x1[bot]' }),
    { id: 'c1', type: 'issue_comment', repo: 'acme/one', number: 1060, title: 't', url: 'https://github.com/acme/one/issues/1060', reason: 'mention @critic', seat: 'critic', from: 'forge0x1[bot]' },
  ], ctx);
  assert.equal(r.wakes.some(w => w.seat === 'forge'), false);
  assert.equal(r.skips.some(s => s.seat === 'forge' && s.reason === 'own_actor'), true);
  assert.deepEqual(r.wakes.filter(w => w.seat === 'critic').map(w => w.line.id), ['c1']);
});

test('a default issue_open with no from still wakes forge, and packet R still rings the opener', () => {
  const plain = classifyBatch([issue({ id: 'open-plain', seat: 'blinky' })], ctx);
  assert.deepEqual(plain.wakes.map(w => w.seat), ['forge']);
  const filed = classifyBatch([
    issue({ id: 'r1', seat: 'blinky', from: 'forge0x1[bot]', reason: 'unowned: coordinator routes' }),
    issue({ id: 'r1', seat: 'forge', from: 'forge0x1[bot]', reason: 'packet R' }),
  ], ctx);
  assert.equal(filed.wakes.some(w => w.seat === 'forge'), true);
  assert.equal(filed.skips.some(s => s.reason === 'own_actor'), false);
});

test('breaker state dumped and restored onto a fresh state stays paused', () => {
  const st = createWakeState();
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 1; i++) {
    offer(st, 'forge', comment({ id: 'b' + i, from: 'critic' }), T0 + i * 1000);
  }
  assert.equal(st.breaker.has('acme/one#7'), true);
  const dump = dumpBreaker(st, T0 + 10_000);
  const fresh = createWakeState();
  restoreBreaker(fresh, dump, T0 + 10_000);
  const paused = offer(fresh, 'forge', comment({ id: 'after', type: 'ci_fail', sha: 'abc' }), T0 + 11_000);
  assert.equal(paused.reason, 'breaker');
  const expired = createWakeState();
  restoreBreaker(expired, dump, T0 + 60 * 60 * 1000 + 20_000);
  const later = offer(expired, 'forge', comment({ id: 'late', type: 'ci_fail', sha: 'def' }), T0 + 60 * 60 * 1000 + 21_000);
  assert.equal(later.op, 'send');
});

// ---- real server: own-actor issue_open, then a mid-trip restart ----
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const got = [];
const sink = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => { b += d; });
  q.on('end', () => { got.push({ path: q.url, body: JSON.parse(b || '{}') }); s.writeHead(200); s.end('{}'); });
});
await new Promise(r => sink.listen(0, '127.0.0.1', r));
const W = `http://127.0.0.1:${sink.address().port}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-own-'));
const ING = crypto.randomBytes(32).toString('hex');
const hooks = ['forge', 'blinky', 'critic', 'arch1'].map(s => [s, { url: `${W}/${s}` }]);
const envOf = () => ({
  PORT: '0', PATH: process.env.PATH, COLLECTOR: 'off', MESH_DATA_DIR: DATA, INGEST_SECRET: ING,
  MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  SEAT_WEBHOOKS: JSON.stringify(Object.fromEntries(hooks)),
  WAKE_KEY_FORGE: 'kf', WAKE_KEY_BLINKY: 'kb', WAKE_KEY_CRITIC: 'kc', WAKE_KEY_ARCH1: 'ka',
  WAKE_BATCH_S: '0', WAKE_STAGGER_MS: '0', WAKE_COALESCE_MS: '20', WAKE_RETRY_MS: '10', LIVE_TURN_OPEN_MIN: '0',
  WAKE_KIND_COOLDOWN_S: '0', WAKE_MAX_PER_HOUR: '60',
  SEAT_WAKE_FILTER: 'all',
});
const start = async () => {
  let logs = '';
  const srv = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: envOf(), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { logs += d; });
  srv.stderr.on('data', d => { logs += d; });
  const port = await listenPort(srv);
  return { srv, logs: () => logs, base: `http://127.0.0.1:${port}` };
};
const stop = async (srv) => {
  srv.kill();
  await new Promise(r => (srv.exitCode != null || srv.signalCode ? r() : srv.once('exit', r)));
};
const until = async fn => { for (let i = 0; i < 80 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); return fn(); };
const quiet = ms => new Promise(r => setTimeout(r, ms));
const post = async (base, lines) => {
  const res = await fetch(base + '/inbox', { method: 'POST', headers: { 'X-Live-Ingest': ING, 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const row = (over) => ({
  id: over.id, t_ct: new Date().toISOString(), seat: over.seat, type: over.type || 'issue_open', repo: 'acme/one',
  number: over.number, title: over.title || 't', url: `https://github.com/acme/one/issues/${over.number}`,
  reason: over.reason || 'unowned: coordinator routes',
  ...(over.from ? { from: over.from } : {}), ...(over.sha ? { sha: over.sha } : {}), ...(over.kind ? { kind: over.kind } : {}),
});
const wakesFor = (seat, ids) => got.filter(g => g.path === '/' + seat && ids.some(id => g.body.ids && g.body.ids.includes(id)));

let running;
describe('server', { concurrency: 1 }, () => {
test('server: forge opening an issue does not wake forge; critic still wakes', async () => {
  running = await start();
  const n = 1060;
  const own = 'own-1060-zz';
  const other = 'crit-1060-zz';
  assert.equal((await post(running.base, [
    row({ id: own, seat: 'blinky', number: n, from: 'forge' }),
    row({ id: other, seat: 'critic', number: n, type: 'ci_fail', from: 'forge', sha: 'deadbeef01', reason: 'ci fail', title: 'ci' }),
  ])).status, 200);
  assert.ok(await until(() => wakesFor('critic', [other]).length === 1), running.logs());
  await quiet(300);
  assert.equal(wakesFor('forge', [own]).length, 0);
  assert.match(running.logs(), /wake: skip forge own_actor own-1060-zz/);
});

test('server: breaker state survives a restart mid-trip', async () => {
  const n = 979;
  for (let i = 0; i < SEAT_COMMENT_LIMIT + 1; i++) {
    const id = `loop-979-${i}-zz`;
    const from = i % 2 ? 'forge' : 'critic';
    const to = i % 2 ? 'critic' : 'forge';
    assert.equal((await post(running.base, [row({ id, seat: to, number: n, type: 'pr_comment', from, title: 'Seen', reason: 'comment on your PR' })])).status, 200);
  }
  await quiet(400);
  assert.match(running.logs(), /wake: breaker acme\/one#979/);
  const file = path.join(DATA, 'live', 'wake-breaker.json');
  assert.ok(await until(() => fs.existsSync(file)), 'wake-breaker.json was not written');
  await stop(running.srv);
  got.length = 0;
  running = await start();
  const after = 'after-restart-979-zz';
  assert.equal((await post(running.base, [row({ id: after, seat: 'forge', number: n, type: 'ci_fail', sha: 'abcd1234', title: 'ci', reason: 'ci fail' })])).status, 200);
  await quiet(400);
  assert.equal(wakesFor('forge', [after]).length, 0, running.logs());
  assert.match(running.logs(), /wake: skip forge breaker after-restart-979-zz/);
});

});

after(async () => {
  if (running && running.srv) await stop(running.srv);
  sink.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
