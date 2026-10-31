// Arch1 backlog tile and the L3 hold while that backlog is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueView } from '../inbox-queue.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'example/app#1';

function station(id, t) {
  return {
    id, t_ct: t, seat: 'arch1', type: 'note', kind: 'station',
    repo: '', number: 0, title: id, url: '', reason: 'station',
  };
}

test('two station lines leave one in the arch1 backlog', () => {
  const rows = [station('s1', '2026-10-31T10:00:00-05:00'), station('s2', '2026-10-31T11:00:00-05:00')];
  const head = queueView(rows, { titleOf: () => '' });
  assert.equal(head.length, 1);
  assert.equal(Math.max(0, rows.length - head.length), 1);
});

function start(data, extra = {}) {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    cwd: APP,
    env: {
      PORT: '0',
      MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: extra.INGEST_SECRET,
      PATH: process.env.PATH,
      MESH_DATA_DIR: data,
      COLLECTOR: 'off',
      NUDGE_L1_S: '1',
      NUDGE_L2_S: '1',
      NUDGE_L3_S: '1',
      BIFROST_TICK_S: '3600',
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

function seedInbox(data, lines) {
  const dir = path.join(data, 'live', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'arch1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function seedNudges(data, rows) {
  const dir = path.join(data, 'live');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nudges.jsonl'), rows.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function card(beat) {
  return {
    key: KEY, repo: 'Example/App', number: 1, kind: 'issue', state: 'live', stage: 'open',
    title: 'Quiet card', owner: 'forge', packet_ok: true, last_beat_t: beat,
    beats: [{ t: beat, what: 'opened' }],
  };
}

function nudge(beat, level, t, n) {
  return {
    id: level === 1 ? `nudge:${KEY}:L1:${beat}` : `nudge:${KEY}:L3:${beat}:${n}`,
    t, t_ct: new Date(t).toISOString(), card: KEY, repo: 'Example/App', number: 1,
    title: 'Quiet card', url: '', stage: 'open', level, seat: 'forge',
    via: level === 3 ? 'repeat' : 'card owner', beat_t: beat,
  };
}

async function ingest(base, secret, beat) {
  const res = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generated_at: new Date().toISOString(),
      events: [{ id: 'e1', t_ct: new Date().toISOString(), kind: 'issue_open', repo: 'Example/App', number: 1 }],
      board: {
        updated_ct: new Date().toISOString(),
        stats: {
          issues_opened_24h: 1, issues_opened_24h_ids: [KEY],
          issues_closed_24h: 0, issues_closed_24h_ids: [],
          prs_opened_24h: 0, prs_opened_24h_ids: [],
          prs_merged_24h: 0, prs_merged_24h_ids: [],
          prs_closed_unmerged_24h: 0, prs_closed_unmerged_24h_ids: [],
          open_total: 1, open_total_ids: [KEY],
        },
        cards: [card(beat)],
      },
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 300));
}

function openL3(data) {
  const file = path.join(data, 'live', 'nudges.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return rows.filter(n => n.card === KEY && n.level === 3 && !n.closed_at);
}

async function feedStats(base) {
  const res = await fetch(base + '/live-events.json', { headers: { 'Accept-Encoding': 'identity' } });
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 300));
  const body = JSON.parse(text);
  return body.board && body.board.stats;
}

test('arch1 backlog is on the feed and an existing L3 is not repeated while it is open', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-backlog-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const beat = now - 60000;
  seedInbox(data, [station('s1', new Date(now).toISOString()), station('s2', new Date(now + 1).toISOString())]);
  seedNudges(data, [nudge(beat, 1, now - 10000, 1), nudge(beat, 3, now - 5000, 1)]);
  const srv = start(data, { INGEST_SECRET: secret });
  try {
    await srv.ready;
    const health = await (await fetch(srv.base + '/healthz')).json();
    assert.equal(health.arch1_launch.enabled, false);
    await ingest(srv.base, secret, beat);
    const stats = await feedStats(srv.base);
    assert.equal(stats.arch1_backlog, 1);
    assert.equal(openL3(data).length, 1, srv.logs());
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('the first L3 still lands while the backlog is open', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-backlog-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const beat = now - 60000;
  seedInbox(data, [station('s1', new Date(now).toISOString()), station('s2', new Date(now + 1).toISOString())]);
  seedNudges(data, [nudge(beat, 1, now - 10000, 1)]);
  const srv = start(data, { INGEST_SECRET: secret });
  try {
    await srv.ready;
    await ingest(srv.base, secret, beat);
    assert.equal(openL3(data).length, 1, srv.logs());
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('an existing L3 repeats once the arch1 backlog is clear', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-backlog-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const beat = now - 60000;
  seedNudges(data, [nudge(beat, 1, now - 10000, 1), nudge(beat, 3, now - 5000, 1)]);
  const srv = start(data, { INGEST_SECRET: secret });
  try {
    await srv.ready;
    await ingest(srv.base, secret, beat);
    const stats = await feedStats(srv.base);
    assert.equal(stats.arch1_backlog, 0);
    assert.equal(openL3(data).length, 2, srv.logs());
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
