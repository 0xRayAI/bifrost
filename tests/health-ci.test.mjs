// /healthz: CI and pr_commit never set cards_behind. A card-worthy event still does.
// A quiet collector file is feed_quiet. data_age stays informational.
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
      PORT: '0',
      MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'),
      PATH: process.env.PATH,
      MESH_DATA_DIR: data,
      COLLECTOR: 'on',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  const baseOf = () => { const m = /listening on :(\d+)/.exec(logs); return m ? `http://127.0.0.1:${m[1]}` : null; };
  const up = (async () => {
    for (let i = 0; i < 300; i++) {
      const base = baseOf();
      try { if (base && (await fetch(base + '/healthz')).status) return; } catch { /* not up */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('healthz did not come up\n' + logs);
  })();
  return { child, get base() { return baseOf(); }, up, logs: () => logs };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  const done = new Promise(r => child.once('exit', r));
  child.kill();
  await done;
}

function drop(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function card(over = {}) {
  return {
    key: 'example/repo#7', repo: 'example/repo', number: 7, kind: 'pr', state: 'live',
    title: 'Open', head: 'deadbee', owner: 'builder', stage: 'review', ...over,
  };
}

function lay(data, { cards, events, ageMs = 0 }) {
  fs.mkdirSync(path.join(data, 'live'), { recursive: true });
  fs.mkdirSync(path.join(data, 'feed'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    cards,
  }));
  const feed = path.join(data, 'feed', 'github-events.json');
  fs.writeFileSync(feed, JSON.stringify({
    generated_at: new Date().toISOString(),
    events,
  }));
  if (ageMs) {
    const at = (Date.now() - ageMs) / 1000;
    fs.utimesSync(feed, at, at);
  }
  return feed;
}

async function bodyOf(srv) {
  await srv.up;
  let body, res;
  for (let i = 0; i < 40; i++) {
    res = await fetch(srv.base + '/healthz');
    body = await res.json();
    if (typeof body.collector_age === 'number' || body.status === 'warming') break;
    await new Promise(r => setTimeout(r, 100));
  }
  return { res, body };
}

test('main CI with no open card match stays up', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ci-'));
  lay(data, {
    cards: [card()],
    events: [{
      id: 'ci-main', t_ct: new Date(Date.now() - 5000).toISOString(), kind: 'check_run',
      conclusion: 'success', repo: 'example/repo', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }],
  });
  const srv = start(data);
  try {
    const { res, body } = await bodyOf(srv);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.cards_behind, false);
    assert.equal(body.feed_quiet, false);
    assert.equal(body.box_informational, true);
  } finally {
    await stop(srv.child);
    drop(data);
  }
});

test('completed CI or pr_commit on an open card does not put cards behind', async () => {
  for (const event of [
    { id: 'ci-head', kind: 'check_run', conclusion: 'success', repo: 'example/repo', sha: 'deadbee0123456789abcdef' },
    { id: 'ci-num', kind: 'ci_pass', conclusion: 'success', repo: 'example/repo', number: 7 },
    { id: 'push', kind: 'pr_commit', repo: 'example/repo', number: 7, sha: 'deadbee0123456789abcdef' },
  ]) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ci-'));
    lay(data, { cards: [card()], events: [{ ...event, t_ct: new Date(Date.now() - 5000).toISOString() }] });
    const srv = start(data);
    try {
      const { res, body } = await bodyOf(srv);
      assert.equal(res.status, 200, event.id);
      assert.equal(body.ok, true, event.id);
      assert.equal(body.cards_behind, false, event.id);
      assert.equal(body.feed_quiet, false, event.id);
    } finally {
      await stop(srv.child);
      drop(data);
    }
  }
});

test('a card-worthy event newer than the board puts cards behind', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ci-'));
  lay(data, {
    cards: [card()],
    events: [{ id: 'open-7', t_ct: new Date(Date.now() - 5000).toISOString(), kind: 'pr_open', repo: 'example/repo', number: 7 }],
  });
  const srv = start(data);
  try {
    const { res, body } = await bodyOf(srv);
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.cards_behind, true);
  } finally {
    await stop(srv.child);
    drop(data);
  }
});

test('CI on a closed card and an unfinished check do not put cards behind', async () => {
  const recent = new Date(Date.now() - 5000).toISOString();
  const cases = [
    { cards: [card({ state: 'closed' })], events: [{ id: 'ci-closed', t_ct: recent, kind: 'check_run', conclusion: 'success', repo: 'example/repo', sha: 'deadbee0123456789abcdef' }] },
    { cards: [card()], events: [{ id: 'ci-run', t_ct: recent, kind: 'check_run', status: 'in_progress', repo: 'example/repo', sha: 'deadbee0123456789abcdef' }] },
  ];
  for (const row of cases) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ci-'));
    lay(data, row);
    const srv = start(data);
    try {
      const { res, body } = await bodyOf(srv);
      assert.equal(res.status, 200, row.events[0].id);
      assert.equal(body.ok, true, row.events[0].id);
      assert.equal(body.cards_behind, false, row.events[0].id);
    } finally {
      await stop(srv.child);
      drop(data);
    }
  }
});

test('a quiet collector file fails health; a missing file is only warming', async () => {
  const quietDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-quiet-'));
  lay(quietDir, {
    cards: [card()],
    events: [{ id: 'old-push', t_ct: new Date(Date.now() - 48 * 3600 * 1000).toISOString(), kind: 'push', repo: 'example/repo' }],
    ageMs: 30_000,
  });
  const quiet = start(quietDir, { COLLECTOR_STALE_S: '1' });
  try {
    const { res, body } = await bodyOf(quiet);
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.feed_quiet, true);
    assert.equal(body.box_informational, true);
    assert.ok(body.data_age > 21600);
    assert.ok(body.collector_age >= 1);
  } finally {
    await stop(quiet.child);
    drop(quietDir);
  }

  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-warm-'));
  const warm = start(warmDir, { COLLECTOR_STALE_S: '30' });
  try {
    await warm.up;
    const res = await fetch(warm.base + '/healthz');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.feed_quiet, false);
    assert.equal(body.status, 'warming');
    assert.equal(body.collector_age, null);
  } finally {
    await stop(warm.child);
    drop(warmDir);
  }
});
