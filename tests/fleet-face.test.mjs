// A fleet is the roster or LIVE_SEAT_IDS. The page sources do not name a team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFleetFace } from '../fleet-face.mjs';
import { stationHourKey } from '../station-tick.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function recentStationNow() {
  for (let back = 0; back < 6; back++) {
    const day = new Date(Date.now() - back * 86400000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(day).map((p) => [p.type, p.value]));
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') continue;
    const guess = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, 7, 30));
    const wall = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(guess).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+wall.year, +wall.month - 1, +wall.day, +wall.hour, +wall.minute, +wall.second);
    const instant = new Date(guess.getTime() - (asUtc - guess.getTime()));
    const hour = stationHourKey(instant);
    if (!hour || Date.now() - instant.getTime() >= 6 * 86400000) continue;
    return { now: instant.toISOString(), date: hour.slice(0, 10) };
  }
  throw new Error('no recent station hour');
}

function start(data, extra = {}) {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    cwd: APP,
    env: {
      PORT: '0',
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
  return { child, get base() { return baseOf(); }, ready, logs: () => logs };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}

test('the committed roster is this deploy, and the page sources do not repeat a team', () => {
  const roster = JSON.parse(fs.readFileSync(path.join(APP, 'collector', 'fleet-roster.json'), 'utf8'));
  const face = loadFleetFace({ root: APP, env: {}, owner: 'owner' });
  assert.deepEqual(face.publicSeats, roster.seats);
  assert.equal(face.roles.coord, 'blinky');
  assert.equal(face.roles.operator, 'forge');
  assert.equal(face.roles.review, 'critic');
  assert.deepEqual(face.station, ['forge', 'critic', 'blinky', 'arch1']);
  assert.equal(face.spec.wordmark, false);
  assert.deepEqual(face.spec.avatars, []);
  assert.equal(face.spec.owner, 'owner');
  assert.equal(face.spec.outside_logins['arch10x[bot]'], 'arch1');
  assert.equal(face.spec.name, 'Bifrost');
  const banned = /\b(blinky|arch1|arch10x|mymuse|minime0x|nibbler|herald|blaze)\b|mymuse\.house|\bCoord\b/;
  for (const file of ['live.js', 'live-config.js', 'site-config.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(APP, 'public', file), 'utf8'), banned, file);
  }
  const html = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /--seat-(blinky|critic|forge|arch1|blaze|mill|mymuse)/);
  assert.doesNotMatch(html, /aria-label="0xRay"/);
  assert.doesNotMatch(html, /k === 'blinky'|=== 'critic'/);
});

test('a replaced roster shows and wakes only that fleet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-face-'));
  const roster = path.join(dir, 'fleet-roster.json');
  fs.writeFileSync(roster, JSON.stringify({
    seats: ['coordinator', 'implementer', 'reviewer'],
    roles: { coordinator: 'coordinator', implementer: 'implementer', reviewer: 'reviewer' },
    parked: ['reviewer'],
  }));
  const face = loadFleetFace({
    root: dir,
    owner: 'Ada',
    env: {
      BIFROST_ROSTER: roster,
      BIFROST_ROUTING_DIR: dir,
      LIVE_SITE_FILE: path.join(dir, 'site.json'),
    },
  });
  assert.deepEqual(face.publicSeats, ['coordinator', 'implementer', 'reviewer']);
  assert.deepEqual(face.seatIds.slice(0, 2), ['builder', 'builder-cloud']);
  assert.equal(face.seatIds.includes('blinky'), false);
  assert.equal(face.seatIds.includes('arch1'), false);
  assert.equal(face.roles.coord, 'coordinator');
  assert.equal(face.roles.operator, '');
  assert.equal(face.roles.review, 'reviewer');
  assert.deepEqual(face.station, ['coordinator', 'implementer']);
  assert.equal(face.spec.owner, 'Ada');
  assert.equal(face.spec.wordmark, false);
  assert.deepEqual(face.spec.outside_logins, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LIVE_SEAT_IDS replaces the roster station list, and a layout file is opt-in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-layout-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'layout.example.json'), JSON.stringify({ wordmark: true, aliases: { Coord: 'alpha' } }));
  const quiet = loadFleetFace({
    root: dir,
    owner: '',
    env: { LIVE_SEAT_IDS: 'alpha,beta', BIFROST_ROUTING_DIR: dir },
  });
  assert.deepEqual(quiet.publicSeats, ['alpha', 'beta']);
  assert.deepEqual(quiet.station, ['alpha', 'beta']);
  assert.equal(quiet.roles.coord, '');
  assert.equal(quiet.spec.wordmark, false);
  assert.deepEqual(quiet.spec.aliases, {});
  fs.writeFileSync(path.join(dir, 'config', 'layout.json'), JSON.stringify({
    wordmark: true,
    aliases: { Coord: 'alpha', Other: 'https://example.invalid' },
    board_names: ['mymuse.house'],
  }));
  const on = loadFleetFace({
    root: dir,
    owner: 'Ada',
    env: {
      LIVE_SEAT_IDS: 'alpha,beta',
      BIFROST_ROUTING_DIR: dir,
      LIVE_ROLE_COORD: 'alpha',
      STATION_SEATS: 'beta',
    },
  });
  assert.equal(on.roles.coord, 'alpha');
  assert.deepEqual(on.station, ['beta']);
  assert.equal(on.spec.wordmark, true);
  assert.equal(on.spec.aliases.Coord, 'alpha');
  assert.equal(on.spec.aliases.Other, undefined);
  assert.ok(on.spec.board_names.includes('mymuse.house'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('portraits are ids from LIVE_AVATAR_DIR only', () => {
  const face = loadFleetFace({
    root: APP,
    owner: 'Blaze',
    env: { LIVE_AVATAR_DIR: path.join(APP, 'config', 'avatars'), LIVE_SEAT_IDS: 'blinky,near,absent' },
  });
  assert.deepEqual(face.spec.avatars, ['blinky', 'near', 'blaze']);
});

test('GET /healthz lists seat ids for the fleet and no launch fields for a fleet without that seat', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-health-'));
  const busy = recentStationNow();
  const srv = start(data, {
    LIVE_SEAT_IDS: 'coordinator,implementer,reviewer',
    STATION_NUDGE: 'on',
    STATION_NOW: busy.now,
  });
  try {
    await srv.ready;
    const res = await fetch(srv.base + '/healthz');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.seats, ['coordinator', 'implementer', 'reviewer']);
    for (const id of body.seats) assert.match(id, /^[a-z0-9][a-z0-9_-]{0,31}$/);
    assert.equal(body.arch1_launch, undefined);
    assert.equal(body.arch1_inbox, undefined);
    assert.equal(Object.hasOwn(body, 'webhooks'), false);
    assert.equal(JSON.stringify(body.seats).includes('http'), false);
    const file = path.join(data, 'live', 'inbox', 'coordinator.jsonl');
    const ids = fs.readFileSync(file, 'utf8');
    assert.match(ids, new RegExp(`nudge:station:coordinator:${busy.date}`));
    assert.equal(fs.existsSync(path.join(data, 'live', 'inbox', 'forge.jsonl')), false);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('GET /healthz for the committed roster keeps that seat list and the arch1 fields', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-health-own-'));
  const roster = JSON.parse(fs.readFileSync(path.join(APP, 'collector', 'fleet-roster.json'), 'utf8'));
  const srv = start(data);
  try {
    await srv.ready;
    const body = await (await fetch(srv.base + '/healthz')).json();
    assert.deepEqual(body.seats, roster.seats);
    assert.equal(body.arch1_launch.enabled, false);
    assert.equal(typeof body.arch1_inbox.open, 'number');
    assert.equal(typeof body.arch1_inbox.backlog, 'number');
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
