// A body-only critic FIX can ring ready again on the same sha. A pass on that sha keeps it buried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CKEY = 'critic-' + crypto.randomBytes(8).toString('hex');
const INGEST = crypto.randomBytes(32).toString('hex');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rering-'));
const SHA = 'abcdef1234567890';
const READY = `handoff:0xrayai/xray#849:ready:${SHA}`;
const FAIL = `handoff:0xrayai/xray#849:critic_fail:${SHA}`;
const PASS = `handoff:0xrayai/xray#849:live_pass:${SHA}`;

function row(id, kind) {
  return {
    id, t_ct: new Date().toISOString(), seat: 'critic', from: 'arch1', to: 'critic',
    type: 'packet', kind, repo: '0xRayAI/xray', number: 849, sha: SHA,
    title: 'handoff ' + kind, url: 'https://github.com/0xRayAI/xray/pull/849', reason: 'handoff ' + kind,
  };
}

test('a popped ready rings again after critic_fail on the same sha, and stays buried after a pass', async () => {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    env: {
      PORT: '0', MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'), PATH: process.env.PATH,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), INGEST_SECRET: INGEST, MESH_DATA_DIR: DATA,
      COLLECTOR: 'off', FLEET_MODE: 'full', GITHUB_API_URL: 'http://127.0.0.1:1',
      SEAT_KEYS: JSON.stringify({ critic: crypto.createHash('sha256').update(CKEY).digest('hex') }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  let base = null;
  try {
    for (let i = 0; i < 50; i++) {
      const hit = /listening on :(\d+)/.exec(logs);
      base = hit ? `http://127.0.0.1:${hit[1]}` : null;
      try { if (base && (await fetch(base + '/healthz')).ok) break; } catch { /* boot */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!base) throw new Error(logs);
    const ingest = (lines) => fetch(base + '/inbox', {
      method: 'POST',
      headers: { 'X-Live-Ingest': INGEST, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    });
    const criticAuth = { Authorization: 'Bearer ' + CKEY };
    assert.equal((await (await ingest([row(READY, 'ready')])).json()).added, 1);
    const ack = await fetch(base + '/inbox/critic/ack', {
      method: 'POST', headers: { ...criticAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: READY }),
    });
    assert.equal((await ack.json()).acked, 1);
    assert.equal((await (await ingest([row(READY, 'ready')])).json()).added, 0);
    assert.equal((await (await ingest([row(FAIL, 'critic_fail')])).json()).added, 1);
    assert.equal((await (await ingest([row(READY, 'ready')])).json()).added, 1);
    const open = await (await fetch(base + '/inbox/critic', { headers: criticAuth })).json();
    assert.equal(open.lines.some((line) => line.id === READY), true);
    assert.equal((await (await ingest([row(PASS, 'live_pass')])).json()).added, 1);
    await fetch(base + '/inbox/critic/ack', {
      method: 'POST', headers: { ...criticAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: READY }),
    });
    assert.equal((await (await ingest([row(READY, 'ready')])).json()).added, 0);
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode != null || child.signalCode ? r() : child.once('exit', r)));
    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
