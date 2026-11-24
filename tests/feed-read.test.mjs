// A read-only feed key is not a seat. /v1/events masks private repo names. /v1/roles lists jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function start(data, extra = {}) {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    cwd: APP,
    env: {
      PORT: '0',
      LIVE_PUBLIC: '0',
      MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'),
      PATH: process.env.PATH,
      MESH_DATA_DIR: data,
      COLLECTOR: 'off',
      SERVER_ROUTING: 'off',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const baseOf = () => { const m = /listening on :(\d+)/.exec(logs); return m ? `http://127.0.0.1:${m[1]}` : null; };
  const ready = (async () => {
    for (let i = 0; i < 300; i++) {
      const base = baseOf();
      try { if (base && (await fetch(base + '/healthz')).status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('healthz did not come up\n' + logs);
  })();
  return {
    child,
    get base() { return baseOf(); },
    ready,
    logs: () => logs,
    password: extra.MESH_PASSWORD,
  };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}

function githubMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (u.pathname === '/orgs/example/repos') {
        const rows = u.searchParams.get('page') === '1' ? [{ full_name: 'Secret/Name', archived: false }] : [];
        res.end(JSON.stringify(rows));
        return;
      }
      if (u.pathname === '/repos/Secret/Name') {
        res.end(JSON.stringify({ private: true, full_name: 'Secret/Name' }));
        return;
      }
      res.statusCode = 404;
      res.end('[]');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function login(base, password) {
  const res = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(password),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mesh_session=/);
  return cookie;
}

async function ingest(base, secret, events) {
  const res = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ generated_at: new Date().toISOString(), events }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 300));
}

function event(id, repo, title) {
  return { id, t_ct: new Date().toISOString(), kind: 'issue_open', repo, title, number: 7, seat: 'forge', from: 'forge' };
}

test('the feed key is not a seat and the v1 routes do not touch presence', () => {
  const src = fs.readFileSync(path.join(APP, 'server.mjs'), 'utf8');
  const seat = src.slice(src.indexOf('async function seatOf'), src.indexOf('function feedKeyOk'));
  const feedAt = seat.indexOf('if (FEED_READ_KEY && safeEq(h, FEED_READ_KEY)) return null;');
  assert.ok(feedAt > 0);
  assert.ok(feedAt < seat.indexOf('for (const s of SEAT_IDS)'));
  const act = src.slice(src.indexOf('function activitySeatOfKey'), src.indexOf('function activitySeatOk'));
  assert.match(act, /if \(FEED_READ_KEY && safeEq\(h, FEED_READ_KEY\)\) return '';/);
  const route = src.slice(src.indexOf("if (p === '/v1/events'"), src.indexOf("if (p === '/routing'"));
  assert.match(route, /feedKeyOk\(req\)/);
  assert.doesNotMatch(route, /touchSeat\(/);
  assert.doesNotMatch(route, /seatOf\(/);
  const view = src.slice(src.indexOf('function feedView'), src.indexOf('function roleList'));
  assert.match(view, /mask\(v\.e\)/);
  assert.doesNotMatch(view, /header/);
  assert.doesNotMatch(view, /touchSeat/);
});

test('a missing feed key stays shut', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-read-'));
  const password = 'pw-' + crypto.randomBytes(4).toString('hex');
  const srv = start(data, { MESH_PASSWORD: password, FEED_READ_KEY: 'not-a-hash' });
  try {
    await srv.ready;
    const headers = { Authorization: 'Bearer ' + crypto.randomBytes(16).toString('hex') };
    assert.equal((await fetch(srv.base + '/v1/events', { headers })).status, 401);
    assert.equal((await fetch(srv.base + '/v1/roles', { headers })).status, 401);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('the same bearer in SEAT_KEYS still is not a seat', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-read-'));
  const feedRaw = 'feed-' + crypto.randomBytes(8).toString('hex');
  const password = 'pw-' + crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const srv = start(data, {
    MESH_PASSWORD: password,
    INGEST_SECRET: secret,
    FEED_READ_KEY: sha(feedRaw),
    SEAT_KEYS: JSON.stringify({ forge: sha(feedRaw) }),
  });
  try {
    await srv.ready;
    const feed = { Authorization: 'Bearer ' + feedRaw };
    assert.equal((await fetch(srv.base + '/inbox/forge', { headers: feed })).status, 401);
    const events = await fetch(srv.base + '/v1/events', { headers: feed });
    assert.equal(events.status, 200);
    const body = await events.json();
    assert.deepEqual(Object.keys(body).sort(), ['cursor', 'events']);
    const roles = await fetch(srv.base + '/v1/roles', { headers: feed });
    assert.equal(roles.status, 200);
    const listed = await roles.json();
    assert.deepEqual(Object.keys(listed), ['roles']);
    const roster = JSON.parse(fs.readFileSync(path.join(APP, 'collector', 'fleet-roster.json'), 'utf8'));
    for (const [seat, role] of Object.entries(roster.roles)) {
      assert.ok(listed.roles.some((row) => row.seat === seat && row.role === role), seat);
    }
    await ingest(srv.base, secret, [event('e-plain', 'Example/App', 'public title')]);
    const cookie = await login(srv.base, password);
    const page = await fetch(srv.base + '/live-events.json', { headers: { Cookie: cookie, 'Accept-Encoding': 'identity' } });
    const live = await page.json();
    const row = live.fleet && live.fleet.seats && live.fleet.seats.forge;
    assert.ok(!row || row.via !== 'inbox');
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('the feed masks private repo names and a seat key still only counts on the inbox', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-read-'));
  const gh = await githubMock();
  const ghPort = gh.address().port;
  const feedRaw = 'feed-' + crypto.randomBytes(8).toString('hex');
  const seatRaw = 'seat-' + crypto.randomBytes(8).toString('hex');
  const password = 'pw-' + crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const srv = start(data, {
    MESH_PASSWORD: password,
    INGEST_SECRET: secret,
    FEED_READ_KEY: sha(feedRaw),
    SEAT_KEYS: JSON.stringify({ forge: sha(seatRaw) }),
    GITHUB_READ_TOKEN: 'read-token',
    GITHUB_API_URL: `http://127.0.0.1:${ghPort}`,
    COLLECTOR_ORG: 'example',
    LIVE_FLEET_SEATS: JSON.stringify({ seats: ['quill'], roles: { quill: 'feed reader' } }),
  });
  try {
    await srv.ready;
    for (let i = 0; i < 100 && !/collector: repos /.test(srv.logs()); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(srv.logs(), /collector: repos /, srv.logs());
    const feed = { Authorization: 'Bearer ' + feedRaw };
    const seat = { Authorization: 'Bearer ' + seatRaw };
    assert.equal((await fetch(srv.base + '/v1/events', { headers: seat })).status, 401);
    assert.equal((await fetch(srv.base + '/v1/roles', { headers: seat })).status, 401);
    assert.equal((await fetch(srv.base + '/inbox/forge', { headers: feed })).status, 401);
    assert.equal((await fetch(srv.base + '/v1/events')).status, 401);
    const posted = await fetch(srv.base + '/v1/events', { method: 'POST', headers: feed });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.get('allow'), 'GET');
    await ingest(srv.base, secret, [
      event('e-secret', 'Secret/Name', 'opened Secret/Name'),
      event('e-public', 'Example/App', 'public title'),
    ]);
    const fullRes = await fetch(srv.base + '/v1/events', { headers: feed });
    assert.equal(fullRes.status, 200);
    const full = await fullRes.json();
    assert.deepEqual(Object.keys(full).sort(), ['cursor', 'events']);
    const secretEv = full.events.find((e) => e.id === 'e-secret');
    const publicEv = full.events.find((e) => e.id === 'e-public');
    assert.equal(secretEv.repo, 'private repo');
    assert.equal(secretEv.label, 'private repo');
    assert.equal(secretEv.seat, 'forge');
    assert.equal(secretEv.title, undefined);
    assert.equal(publicEv.repo, 'Example/App');
    assert.equal(publicEv.title, 'public title');
    assert.equal(JSON.stringify(full).includes('Secret/Name'), false);
    const cookie = await login(srv.base, password);
    assert.equal((await fetch(srv.base + '/v1/events', { headers: { Cookie: cookie } })).status, 401);
    const page = await (await fetch(srv.base + '/live-events.json', {
      headers: { Cookie: cookie, 'Accept-Encoding': 'identity' },
    })).json();
    const before = page.fleet && page.fleet.seats && page.fleet.seats.forge;
    assert.ok(!before || before.via !== 'inbox');
    const roles = await (await fetch(srv.base + '/v1/roles', { headers: feed })).json();
    assert.deepEqual(Object.keys(roles), ['roles']);
    assert.ok(roles.roles.some((row) => row.seat === 'quill' && row.role === 'feed reader'));
    assert.ok(roles.roles.some((row) => row.seat === 'forge' && row.role === 'eng primary'));
    for (const row of roles.roles) assert.deepEqual(Object.keys(row).sort(), ['role', 'seat']);
    const seats = roles.roles.map((row) => row.seat);
    assert.deepEqual(seats, [...seats].sort((a, b) => a.localeCompare(b)));
    assert.equal(JSON.stringify(roles).includes('webhook'), false);
    const cursor = full.cursor;
    await ingest(srv.base, secret, [event('e-next', 'Example/App', 'next')]);
    const deltaRes = await fetch(srv.base + '/v1/events?since=' + encodeURIComponent(cursor), { headers: feed });
    const delta = await deltaRes.json();
    assert.equal(delta.delta, true);
    assert.deepEqual(Object.keys(delta).sort(), ['cursor', 'delta', 'events', 'removed']);
    assert.ok(delta.events.some((e) => e.id === 'e-next'));
    assert.equal(delta.fleet, undefined);
    const same = await fetch(srv.base + '/v1/events?since=' + encodeURIComponent(delta.cursor), { headers: feed });
    assert.equal(same.status, 304);
    const reset = await (await fetch(srv.base + '/v1/events?since=nope.1', { headers: feed })).json();
    assert.equal(reset.reset, true);
    assert.equal(reset.fleet, undefined);
    assert.equal((await fetch(srv.base + '/inbox/forge', { headers: seat })).status, 200);
    await ingest(srv.base, secret, [event('e-after', 'Example/App', 'after')]);
    const after = await (await fetch(srv.base + '/live-events.json', {
      headers: { Cookie: cookie, 'Accept-Encoding': 'identity' },
    })).json();
    assert.equal(after.fleet.seats.forge.via, 'inbox');
  } finally {
    await stop(srv.child);
    await new Promise((r) => gh.close(r));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
