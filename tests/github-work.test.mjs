// A mapped GitHub merge lights that seat after the card closes, for the turn window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function start(data) {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    cwd: APP,
    env: {
      PORT: '0',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'),
      PATH: process.env.PATH,
      MESH_DATA_DIR: data,
      COLLECTOR: 'on',
      SERVER_ROUTING: 'off',
      STATION_NUDGE: 'off',
      BIFROST_TICK_S: '3600',
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

function seed(data, t) {
  fs.mkdirSync(path.join(data, 'live'), { recursive: true });
  fs.mkdirSync(path.join(data, 'feed'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: new Date().toISOString(),
    cards: [{
      key: '0xrayai/xray#664', repo: '0xRayAI/xray', number: 664, kind: 'pr',
      state: 'closed', stage: 'done', title: 'Merged', owner: 'arch1',
    }],
  }));
  fs.writeFileSync(path.join(data, 'feed', 'github-events.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    events: [{
      id: 'merge-664', t_ct: new Date(t).toISOString(), kind: 'merged',
      repo: '0xRayAI/xray', number: 664, from: 'GitHub',
      actor: 'arch10x[bot]', merged_by: 'arch10x[bot]', title: 'merge',
    }],
  }));
}

async function arch1Working(srv) {
  await srv.ready;
  const body = await (await fetch(srv.base + '/live-events.json')).json();
  const fleet = body.fleet || {};
  const seat = fleet.seats && fleet.seats.arch1;
  const row = fleet.working && fleet.working.arch1;
  return { seat, row };
}

test('a fresh Arch1 merge lights Arch1 after the card closes', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-work-'));
  seed(data, Date.now() - 60 * 1000);
  const srv = start(data);
  try {
    const { seat, row } = await arch1Working(srv);
    assert.equal(seat && seat.working, true);
    assert.equal(row && row.via, 'github');
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('an old Arch1 merge does not keep the light', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-work-old-'));
  seed(data, Date.now() - 3 * 60 * 60 * 1000);
  const srv = start(data);
  try {
    const { seat, row } = await arch1Working(srv);
    assert.equal(!!(seat && seat.working), false);
    assert.equal(row, undefined);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
