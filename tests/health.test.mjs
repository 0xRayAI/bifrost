// Health body: building / empty / live. feed_quiet and cards_behind gate ok.
// data_age and box_age are reported and do not change ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function start(data, extra = {}) {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    env: {
      PORT: '0',   // #304: the OS picks the port; read it from the listening line
      MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'),
      PATH: process.env.PATH,
      MESH_DATA_DIR: data,
      COLLECTOR: 'off',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  const baseOf = () => { const m = /listening on :(\d+)/.exec(logs); return m ? `http://127.0.0.1:${m[1]}` : null; };
  const ready = (async () => {
    for (let i = 0; i < 300; i++) {
      const base = baseOf();
      try { if (base && (await fetch(base + '/healthz')).ok) return; } catch { /* not up */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('healthz did not come up\n' + logs);
  })();
  return { child, get base() { return baseOf(); }, ready, logs: () => logs };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  const done = new Promise(r => child.once('exit', r));
  child.kill();
  await done;
}

test('building when no cards; empty when a board was built with zero cards', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-'));
  const srv = start(data);
  try {
    await srv.ready;
    const res = await fetch(srv.base + '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    const body = await res.json();
    assert.equal(body.board, 'building');
    assert.equal(body.ok, true);
    assert.equal(body.card_age, null);
    assert.equal(body.data_age, null);
    assert.equal(body.origin, null);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-'));
  fs.mkdirSync(path.join(emptyDir, 'live'), { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'live', 'cards.json'), JSON.stringify({
    updated_ct: new Date().toISOString(), cards: [],
  }));
  const empty = start(emptyDir);
  try {
    await empty.ready;
    const body = await (await fetch(empty.base + '/healthz')).json();
    assert.equal(body.board, 'empty');
    assert.equal(body.ok, true);
    assert.equal(typeof body.card_age, 'number');
    assert.ok(body.card_age < 600);
  } finally {
    await stop(empty.child);
    fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('stale card_age stays informational and keeps HTTP 200', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-'));
  fs.mkdirSync(path.join(data, 'live'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: new Date(Date.now() - 3600 * 1000).toISOString(),
    cards: [{ key: 'acme/one#1', stage: 'review', state: 'live', title: 't', repo: 'acme/one', number: 1 }],
  }));
  const srv = start(data);
  try {
    await srv.ready;
    const res = await fetch(srv.base + '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.feed_quiet, false);
    assert.equal(body.board, 'live');
    assert.ok(body.card_age > 600);
    assert.equal(body.data_age, null);
    assert.equal(body.box_informational, true);
    assert.equal(body.arch1_launch.enabled, false);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('stale data_age stays informational while collector_age stays small; a full replace clears it', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-'));
  const feed = path.join(data, 'feed', 'github-events.json');
  fs.mkdirSync(path.dirname(feed), { recursive: true });
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(feed, JSON.stringify({
    generated_at: new Date().toISOString(),
    events: [{ id: 'old-gh', t_ct: old, kind: 'push', label: 'old' }],
  }));
  const srv = start(data, { COLLECTOR: 'on' });
  try {
    await srv.ready;
    let body, res;
    for (let i = 0; i < 40; i++) {
      res = await fetch(srv.base + '/healthz');
      body = await res.json();
      if (typeof body.data_age === 'number') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(body.ok, true);
    assert.equal(body.feed_quiet, false);
    assert.ok(body.data_age > 21600);
    assert.ok(typeof body.collector_age === 'number' && body.collector_age < 30);
    fs.writeFileSync(feed, JSON.stringify({ generated_at: new Date().toISOString(), events: [] }));
    let cleared;
    for (let i = 0; i < 40; i++) {
      cleared = await (await fetch(srv.base + '/healthz')).json();
      if (cleared.data_age === null) break;
      await new Promise(r => setTimeout(r, 150));
    }
    assert.equal(cleared.data_age, null);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.feed_quiet, false);
    assert.ok(cleared.collector_age < 30);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('a paused wake reports disabled, an old fail reports stale, and a bare http_400 stays fail', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-wake-'));
  fs.mkdirSync(path.join(data, 'live'), { recursive: true });
  const now = new Date();
  const old = new Date(now.getTime() - 7 * 3600 * 1000);
  const hooks = {};
  for (const seat of ['forge', 'critic', 'blinky', 'herald', 'arch1', 'near', 'mill', 'nibbler']) {
    hooks[seat] = { url: `http://127.0.0.1:9/${seat}` };
  }
  const rows = [
    { seat: 'forge', id: 'w-forge', t_ct: now.toISOString(), ok: false, attempts: 3, outcome: 'failed', error: 'http_400_disabled', detail: 'Automation is disabled' },
    { seat: 'critic', id: 'w-critic', t_ct: now.toISOString(), ok: false, attempts: 3, outcome: 'failed', error: 'http_500' },
    { seat: 'blinky', id: 'w-blinky', t_ct: old.toISOString(), ok: false, attempts: 3, outcome: 'failed', error: 'network' },
    { seat: 'herald', id: 'w-herald', t_ct: now.toISOString(), ok: true, attempts: 1, outcome: 'delivered' },
    { seat: 'arch1', id: 'w-arch1', t_ct: now.toISOString(), ok: false, attempts: 3, outcome: 'failed', error: 'http_400', detail: "Automation 'x' is disabled" },
    { seat: 'near', id: 'w-near', t_ct: now.toISOString(), ok: false, attempts: 3, outcome: 'failed', error: 'http_400' },
    { seat: 'mill', id: 'w-mill', t_ct: now.toISOString(), ok: false, attempts: 3, outcome: 'failed', error: 'network', detail: 'worker disabled' },
  ];
  fs.writeFileSync(path.join(data, 'live', 'wakes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const srv = start(data, {
    SEAT_WEBHOOKS: JSON.stringify(hooks),
    WAKE_KEY_FORGE: 'kf', WAKE_KEY_CRITIC: 'kc', WAKE_KEY_BLINKY: 'kb',
    WAKE_KEY_HERALD: 'kh', WAKE_KEY_ARCH1: 'ka', WAKE_KEY_NEAR: 'kn',
    WAKE_KEY_MILL: 'km',
  });
  try {
    await srv.ready;
    const body = await (await fetch(srv.base + '/healthz')).json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.wakes, {
      forge: 'disabled',
      critic: 'fail',
      blinky: 'stale',
      herald: 'ok',
      arch1: 'disabled',
      near: 'fail',
      mill: 'fail',
      nibbler: 'no_key',
    });
    assert.equal(body.wakes_at.forge, rows[0].t_ct);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
