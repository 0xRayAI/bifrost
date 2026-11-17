// Critic handoff lines follow the card chain, not the seat named on the line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffChain, routeHandoff } from '../handoff.mjs';
import { seatStatus } from '../presence.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'abcdef1234567890';

test('seat status is online, busy, or offline from the heartbeat', () => {
  const now = Date.now();
  assert.equal(seatStatus({ last_ct: new Date(now).toISOString() }, now, 60000), 'online');
  assert.equal(seatStatus({ last_ct: new Date(now).toISOString(), working: true }, now, 60000), 'busy');
  assert.equal(seatStatus({ last_ct: new Date(now - 120000).toISOString(), working: true }, now, 60000), 'offline');
  assert.equal(seatStatus({}, now, 60000), 'offline');
});

test('the chain is packet R, then the author, then A', () => {
  const card = { owner: 'forge', packet: { raci: 'R=mill A=forge', 'next owner': 'critic' } };
  assert.deepEqual(handoffChain(card), ['mill', 'forge', 'critic']);
  assert.deepEqual(handoffChain({ owner: 'forge', packet: {} }), ['forge']);
});

test('an offline primary yields to the next seat, and a busy primary stays queued', () => {
  const card = { owner: 'arch1', packet: { raci: 'R=arch1 A=forge' } };
  const state = { arch1: 'offline', forge: 'online' };
  assert.deepEqual(routeHandoff(card, seat => state[seat]), { seat: 'forge', queued: false, chain: ['arch1', 'forge'] });
  state.arch1 = 'busy';
  assert.equal(routeHandoff(card, seat => state[seat]).queued, true);
  assert.equal(routeHandoff(card, seat => state[seat]).seat, 'arch1');
});

function key(seat) {
  return crypto.randomBytes(8).toString('hex') + '-' + seat;
}

function line(kind, number, seat = 'arch1') {
  return {
    id: `handoff:0xrayai/xray#${number}:${kind}:${SHA}`,
    t_ct: new Date().toISOString(), seat, from: 'critic', to: seat,
    type: 'packet', kind, repo: '0xRayAI/xray', number, sha: SHA,
    title: 'handoff ' + kind, url: `https://github.com/0xRayAI/xray/pull/${number}`, reason: 'handoff ' + kind,
  };
}

test('critic merge and critic_fail follow the card, and a dedupe hit names that seat', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-handoff-'));
  const raw = {
    forge: key('forge'), mill: key('mill'), arch1: key('arch1'), critic: key('critic'),
  };
  const keys = Object.fromEntries(Object.entries(raw).map(([seat, token]) => [seat, crypto.createHash('sha256').update(token).digest('hex')]));
  fs.mkdirSync(path.join(data, 'live', 'inbox'), { recursive: true });
  const stuck = line('critic_fail', 1180);
  fs.writeFileSync(path.join(data, 'live', 'inbox', 'arch1.jsonl'), JSON.stringify(stuck) + '\n');
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: new Date().toISOString(),
    cards: [
      { repo: '0xRayAI/xray', number: 1180, owner: 'forge', state: 'live', stage: 'review', packet: { raci: 'R=forge A=mill', 'next owner': 'forge' } },
      { repo: '0xRayAI/xray', number: 1183, owner: 'mill', state: 'live', stage: 'review', packet: { raci: 'R=mill A=forge' } },
      { repo: '0xRayAI/xray', number: 30, owner: 'arch1', state: 'live', stage: 'fix', packet: { raci: 'R=arch1 A=forge' } },
      { repo: '0xRayAI/xray', number: 32, owner: 'forge', state: 'live', stage: 'fix', packet: { raci: 'R=forge A=mill', 'next owner': 'forge' } },
    ],
  }));
  const ingestSecret = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    cwd: APP,
    env: {
      PORT: '0', PATH: process.env.PATH, COLLECTOR: 'off', SERVER_ROUTING: 'off', STATION_NUDGE: 'off',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: ingestSecret,
      MESH_DATA_DIR: data,
      SEAT_KEYS: JSON.stringify(keys),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const auth = seat => ({ Authorization: 'Bearer ' + raw[seat] });
  try {
    let base = '';
    for (let i = 0; i < 50; i++) {
      const hit = /listening on :(\d+)/.exec(logs);
      base = hit ? `http://127.0.0.1:${hit[1]}` : '';
      try { if (base && (await fetch(base + '/healthz')).ok) break; } catch { /* boot */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!base) throw new Error(logs);
    const read = async (seat) => (await fetch(base + '/inbox/' + seat, { headers: auth(seat) })).json();
    await read('forge');
    await read('mill');
    const post = (row) => fetch(base + '/inbox', {
      method: 'POST',
      headers: { 'X-Live-Ingest': ingestSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [row] }),
    });
    const moved = await (await post(stuck)).json();
    assert.equal(moved.added, 0);
    assert.equal(moved.seat, 'forge');
    const merge = await (await post(line('merge', 1180))).json();
    assert.equal(merge.added, 1);
    assert.equal(merge.seat, 'forge');
    assert.equal(merge.queued, false);
    const again = await (await post(line('merge', 1180))).json();
    assert.equal(again.added, 0);
    assert.equal(again.seat, 'forge');
    const forge = await read('forge');
    assert.equal(forge.lines.some((row) => row.kind === 'critic_fail' && row.number === 1180), true);
    assert.equal(forge.lines.some((row) => row.kind === 'merge' && row.number === 1180), true);
    const archText = fs.readFileSync(path.join(data, 'live', 'inbox', 'arch1.jsonl'), 'utf8');
    assert.equal(archText.includes(stuck.id), false);
    const board = await (await fetch(base + '/live-events.json')).json();
    assert.equal(board.fleet.seats.arch1.status, 'offline');
    assert.equal(board.fleet.seats.forge.status, 'online');
    const millLine = await (await post(line('critic_fail', 1183))).json();
    assert.equal(millLine.seat, 'mill');
    const mill = await read('mill');
    assert.equal(mill.lines.some((row) => row.number === 1183), true);
    const fell = await (await post(line('merge', 30))).json();
    assert.equal(fell.seat, 'forge');
    assert.equal(fell.queued, false);
    const busy = await fetch(base + '/activity', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + raw.forge, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'turn', action: 'start', t_ct: new Date().toISOString() }),
    });
    assert.equal(busy.status, 202, await busy.text());
    const queued = await (await post(line('critic_fail', 32))).json();
    assert.equal(queued.seat, 'forge');
    assert.equal(queued.queued, true);
    const millAfter = await read('mill');
    assert.equal(millAfter.lines.some((row) => row.number === 32), false);
    const forgeAfter = await read('forge');
    assert.equal(forgeAfter.lines.some((row) => row.number === 32 && row.behind === true), true);
    const shown = await (await fetch(base + '/live-events.json')).json();
    assert.equal(shown.fleet.seats.forge.status, 'busy');
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode != null || child.signalCode ? r() : child.once('exit', r)));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
