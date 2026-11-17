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
import { createWakeState, gateLine, nextLineNudge, noteSent, wakeConfig, wokenItemKey } from '../wake-gate.mjs';

const cfg = wakeConfig({ WAKE_KIND_COOLDOWN_S: '900' });
const NOW = 1_700_000_000_000;

test('an open card, a sha, and a plain line use different woken keys', () => {
  const open = { id: 'a', type: 'issue_open', repo: 'acme/one', number: 50 };
  const again = { id: 'b', type: 'issue_open', repo: 'acme/one', number: 50 };
  assert.equal(wokenItemKey('forge', open), 'forge|acme/one#50|issue_open');
  assert.equal(wokenItemKey('forge', again), wokenItemKey('forge', open));
  assert.equal(wokenItemKey('forge', { id: 'c', type: 'ci_fail', repo: 'acme/one', number: 50, sha: 'abc' }), 'forge|acme/one#50|ci_fail|abc');
  assert.equal(wokenItemKey('forge', { id: 'd', type: 'issue_comment', repo: 'acme/one', number: 50 }), 'forge|d');
  assert.equal(nextLineNudge(3, 0), 0);
  assert.equal(nextLineNudge(0, 2), 3);
  assert.equal(nextLineNudge(1, 0), 2);
});

test('a delivered issue_open stays quiet past the cooldown, and a new sha still passes the gate', () => {
  const state = createWakeState();
  const open = { id: 'open-1', type: 'issue_open', repo: 'acme/one', number: 50, sha: '' };
  assert.equal(gateLine({ seat: 'forge', line: open }, state, NOW, cfg).op, 'send');
  noteSent(state, 'forge', [open], NOW);
  for (let i = 0; i < 11; i++) {
    const again = gateLine({ seat: 'forge', line: { ...open, id: 'open-' + (i + 2) } }, state, NOW + 901000 + i, cfg);
    assert.equal(again.reason, 'already_woke');
  }
  const sha = { id: 'sha-1', type: 'ci_fail', repo: 'acme/one', number: 50, sha: 'abc123' };
  assert.equal(gateLine({ seat: 'forge', line: sha }, state, NOW + 5000, cfg).op, 'send');
  noteSent(state, 'forge', [sha], NOW + 5000);
  assert.equal(gateLine({ seat: 'forge', line: { ...sha, id: 'sha-1b' } }, state, NOW + 6000, cfg).reason, 'already_woke');
  const newer = gateLine({ seat: 'forge', line: { ...sha, id: 'sha-2', sha: 'def456' } }, state, NOW + 960000, cfg);
  assert.notEqual(newer.reason, 'already_woke');
});

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const got = [];
const sink = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => { b += d; });
  q.on('end', () => { got.push({ path: q.url, body: JSON.parse(b || '{}') }); s.writeHead(200); s.end('{}'); });
});
await new Promise(r => sink.listen(0, '127.0.0.1', r));
const hook = `http://127.0.0.1:${sink.address().port}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-replay-'));
const ING = crypto.randomBytes(32).toString('hex');
const env = () => ({
  PORT: '0', PATH: process.env.PATH, COLLECTOR: 'off', MESH_DATA_DIR: DATA, INGEST_SECRET: ING,
  MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  SEAT_WEBHOOKS: JSON.stringify({ forge: { url: `${hook}/forge` } }),
  WAKE_KEY_FORGE: 'kf',
  WAKE_BATCH_S: '0', WAKE_STAGGER_MS: '0', WAKE_COALESCE_MS: '20', WAKE_RETRY_MS: '10', LIVE_TURN_OPEN_MIN: '0',
  NUDGE_LINE_S: '86400',
});
const start = async () => {
  let logs = '';
  const srv = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { logs += d; });
  srv.stderr.on('data', d => { logs += d; });
  const port = await listenPort(srv);
  return { srv, logs: () => logs, base: `http://127.0.0.1:${port}` };
};
const stop = async (srv) => {
  srv.kill();
  await new Promise(r => (srv.exitCode != null || srv.signalCode ? r() : srv.once('exit', r)));
};
const until = async (fn) => { for (let i = 0; i < 80 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); return fn(); };
const post = async (base, lines) => {
  const res = await fetch(base + '/inbox', { method: 'POST', headers: { 'X-Live-Ingest': ING, 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) });
  return res.status;
};
const row = (id, type, extra = {}) => ({
  id, t_ct: new Date().toISOString(), seat: 'forge', type, repo: 'acme/one', number: 50,
  title: 't', url: 'https://github.com/acme/one/issues/50', reason: '@forge replay', ...extra,
});
const forgePosts = () => got.filter(g => g.path === '/forge');
const countType = (type) => forgePosts().reduce((n, g) => {
  const lines = g.body.lines || [];
  if (lines.length) return n + lines.filter(l => l.type === type).length;
  return n + (g.body.type === type ? 1 : 0);
}, 0);

test('twelve issue_open replays post once, a restart posts none, and a real change still posts', async () => {
  const first = await start();
  try {
    for (let i = 0; i < 12; i++) assert.equal(await post(first.base, [row('open-' + i, 'issue_open')]), 200);
    assert.ok(await until(() => countType('issue_open') === 1), first.logs());
    await new Promise(r => setTimeout(r, 400));
    assert.equal(countType('issue_open'), 1, JSON.stringify(forgePosts().map(g => ({ type: g.body.type, ids: g.body.ids }))));
    assert.ok(fs.existsSync(path.join(DATA, 'live', 'woken-items.json')));
  } finally {
    await stop(first.srv);
  }
  const again = await start();
  try {
    const before = countType('issue_open');
    assert.equal(await post(again.base, [row('open-after-restart', 'issue_open')]), 200);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(countType('issue_open'), before, again.logs());
    assert.equal(await post(again.base, [row('cmt-1', 'issue_comment')]), 200);
    assert.equal(await post(again.base, [row('re-1', 'issue_reopen')]), 200);
    assert.equal(await post(again.base, [row('sha-1', 'ci_fail', { sha: 'abc123' })]), 200);
    assert.equal(await post(again.base, [row('sha-2', 'ci_fail', { sha: 'def456' })]), 200);
    assert.ok(await until(() => countType('issue_comment') === 1 && countType('issue_reopen') === 1 && countType('ci_fail') === 2), again.logs());
  } finally {
    await stop(again.srv);
  }
});

after(() => {
  sink.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});
