// The board tick posts one station nudge per seat on the weekday half hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stationDue, stationHourKey, stationSeats, STATION_SENTENCE } from '../station-tick.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDS = ['builder', 'builder-cloud', 'arch1', 'forge', 'critic', 'blinky', 'herald'];
const OPEN = '2026-10-26T07:30:00-05:00';
const HOUR = '2026-10-26T07';

test('the half hour is the only open weekday slot', () => {
  assert.equal(stationHourKey('2026-10-26T07:29:00-05:00'), null);
  assert.equal(stationHourKey(OPEN), HOUR);
  assert.equal(stationHourKey('2026-10-26T08:00:00-05:00'), null);
  assert.equal(stationHourKey('2026-10-26T08:29:00-05:00'), null);
  assert.equal(stationHourKey('2026-10-26T08:30:00-05:00'), '2026-10-26T08');
  assert.equal(stationHourKey('2026-10-26T17:30:00-05:00'), '2026-10-26T17');
  assert.equal(stationHourKey('2026-10-26T17:59:00-05:00'), '2026-10-26T17');
  assert.equal(stationHourKey('2026-10-26T18:00:00-05:00'), null);
  assert.equal(stationHourKey('2026-10-25T13:30:00-05:00'), null);
  assert.equal(stationHourKey('2026-10-24T13:30:00-05:00'), null);
});

test('arch1 is included only when that id is in the fleet', () => {
  assert.deepEqual(stationSeats(['forge', 'critic', 'blinky', 'herald']), ['forge', 'critic', 'blinky']);
  assert.deepEqual(stationSeats(IDS), ['forge', 'critic', 'blinky', 'arch1']);
  assert.deepEqual(stationSeats(['herald']), []);
});

test('a due hour names one station line per seat and the same hour is quiet', () => {
  const due = stationDue(OPEN, '', IDS);
  assert.equal(due.hour, HOUR);
  assert.deepEqual(due.lines.map((line) => line.seat), ['forge', 'critic', 'blinky', 'arch1']);
  for (const line of due.lines) {
    assert.equal(line.id, `nudge:station:${line.seat}:${HOUR}`);
    assert.equal(line.type, 'nudge');
    assert.equal(line.kind, 'station');
    assert.equal(line.title, STATION_SENTENCE);
    assert.equal(line.reason, STATION_SENTENCE);
  }
  assert.equal(stationDue(OPEN, due.hour, IDS), null);
  assert.equal(stationDue('2026-10-26T18:00:00-05:00', '', IDS), null);
});

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
      BIFROST_TICK_S: '3600',
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
      try { if (base && (await fetch(base + '/healthz')).ok) return; } catch { /* not up */ }
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

function seedOpen(data, seat) {
  const dir = path.join(data, 'live', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const line = {
    id: `open:${seat}`,
    t_ct: new Date().toISOString(),
    seat,
    type: 'issue_comment',
    repo: 'example/app',
    number: 1,
    title: 'still open',
    url: '',
    reason: 'open ask',
  };
  fs.writeFileSync(path.join(dir, seat + '.jsonl'), JSON.stringify(line) + '\n');
}

function storedIds(data, seat) {
  const file = path.join(data, 'live', 'inbox', seat + '.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row).id);
}

test('a busy weekday half hour still stores the station line', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'station-tick-'));
  const seats = ['forge', 'critic', 'blinky'];
  for (const seat of seats) seedOpen(data, seat);
  const keys = {};
  const raw = {};
  for (const seat of [...seats, 'arch1']) {
    raw[seat] = seat + '-key-' + crypto.randomBytes(6).toString('hex');
    keys[seat] = crypto.createHash('sha256').update(raw[seat]).digest('hex');
  }
  const srv = start(data, {
    STATION_NUDGE: 'on',
    STATION_NOW: OPEN,
    SEAT_KEYS: JSON.stringify(keys),
  });
  try {
    await srv.ready;
    for (const seat of seats) {
      const ids = storedIds(data, seat);
      assert.equal(ids.includes(`open:${seat}`), true, seat);
      assert.equal(ids.includes(`nudge:station:${seat}:${HOUR}`), true, seat);
    }
    assert.deepEqual(storedIds(data, 'arch1'), [`nudge:station:arch1:${HOUR}`]);
    assert.equal(storedIds(data, 'herald').some((id) => id.startsWith('nudge:station:')), false);
    const seen = await (await fetch(srv.base + '/inbox/forge?queue=1', {
      headers: { Authorization: 'Bearer ' + raw.forge },
    })).json();
    assert.deepEqual((seen.lines || []).map((line) => line.id), ['open:forge']);
    const all = await (await fetch(srv.base + '/inbox/forge?all=1', {
      headers: { Authorization: 'Bearer ' + raw.forge },
    })).json();
    assert.equal((all.lines || []).some((line) => line.id === `nudge:station:forge:${HOUR}` && line.reason === STATION_SENTENCE), true);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('before the half hour and on a test bind the tick stays quiet', async () => {
  const early = fs.mkdtempSync(path.join(os.tmpdir(), 'station-early-'));
  const earlySrv = start(early, { STATION_NUDGE: 'on', STATION_NOW: '2026-10-26T07:29:00-05:00' });
  try {
    await earlySrv.ready;
    assert.equal(storedIds(early, 'forge').some((id) => id.startsWith('nudge:station:')), false);
  } finally {
    await stop(earlySrv.child);
    fs.rmSync(early, { recursive: true, force: true });
  }

  const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'station-quiet-'));
  const quietSrv = start(quiet, { STATION_NOW: OPEN, RAILWAY_ENVIRONMENT: 'production' });
  try {
    await quietSrv.ready;
    assert.equal(storedIds(quiet, 'forge').some((id) => id.startsWith('nudge:station:')), false);
  } finally {
    await stop(quietSrv.child);
    fs.rmSync(quiet, { recursive: true, force: true });
  }
});
