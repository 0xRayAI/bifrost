// A ready handoff must not replace the GitHub card title. GET /cards keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faceFromGithubIssue, packetCardFace, restoreHandoffFace } from '../wave-schedule.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'server.mjs');

const GHOSTS = [
  [741, 'Fleet news: remediate Cursor marketplace'],
  [742, 'Fleet news: track Ubuntu fix for CVE-2026-98432'],
  [389, 'feat: ponder'],
  [169, 'MCP security lessons'],
  [165, 'WAVEBOARD: cards need Done-when + Stops-at'],
];

function ghost(number) {
  return {
    key: `0xrayai/xray#${number}`, born: 'packet', kind: 'packet', repo: '0xRayAI/xray', number,
    title: 'handoff ready', url: `https://github.com/0xRayAI/xray/pull/${number}`,
    owner: 'arch1', stage: 'open', state: 'live',
  };
}

function opened(number, title, kind = 'issue_open') {
  const leaf = kind === 'issue_open' ? 'issues' : 'pull';
  return {
    id: `0xRayAI/xray!${number}:open`, t_ct: '2026-10-01T12:00:00-05:00', kind, repo: '0xRayAI/xray', number,
    title, label: `xray #${number} opened · ${title}`,
    source: `https://github.com/0xRayAI/xray/${leaf}/${number}`, pr_state: 'open',
  };
}

test('a handoff label is not stored, and the open event restores the GitHub title', () => {
  assert.deepEqual(packetCardFace({ title: 'handoff ready', url: 'https://github.com/0xRayAI/xray/pull/741' }), { title: '', url: '' });
  assert.equal(packetCardFace({ title: 'card live-1', url: 'https://github.com/0xRayAI/xray/issues/12' }).title, 'card live-1');
  const events = GHOSTS.map(([number, title]) => opened(number, title));
  const faced = restoreHandoffFace(GHOSTS.map(([number]) => ghost(number)), events);
  for (const [number, title] of GHOSTS) {
    const card = faced.find(row => row.number === number);
    assert.equal(card.title, title);
    assert.equal(card.url, `https://github.com/0xRayAI/xray/issues/${number}`);
    assert.equal(card.kind, 'issue');
  }
  const kept = { key: '0xrayai/xray#389', kind: 'issue', repo: '0xRayAI/xray', number: 389, title: 'feat: ponder', url: 'https://github.com/0xRayAI/xray/issues/389' };
  assert.equal(restoreHandoffFace([kept], events)[0], kept);
  const pull = restoreHandoffFace(
    [{ ...ghost(70), title: '' }],
    [opened(70, 'held pull', 'pr_open')],
  )[0];
  assert.equal(pull.title, 'held pull');
  assert.equal(pull.url, 'https://github.com/0xRayAI/xray/pull/70');
  assert.equal(pull.kind, 'pr');
});

function start(data, extra) {
  const child = spawn(process.execPath, [APP], {
    cwd: ROOT,
    env: {
      PORT: '0', PATH: process.env.PATH, COLLECTOR: 'on', SERVER_ROUTING: 'off', MESH_DATA_DIR: data,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      MESH_PASSWORD: 'pw-' + crypto.randomBytes(8).toString('hex'),
      ARCH1_LAUNCH_ENABLED: '0',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  const baseOf = () => { const m = /listening on :(\d+)/.exec(logs); return m ? `http://127.0.0.1:${m[1]}` : null; };
  const ready = (async () => {
    for (let i = 0; i < 80; i++) {
      const base = baseOf();
      try { if (base && (await fetch(base + '/healthz')).ok) return; } catch { /* not up */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('healthz did not come up\n' + logs);
  })();
  return { child, get base() { return baseOf(); }, ready, logs: () => logs };
}

test('GET /cards keeps the GitHub title when a ready handoff arrives', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-face-'));
  const forgeKey = 'forge-' + crypto.randomBytes(4).toString('hex');
  const ingest = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.join(data, 'live'), { recursive: true });
  fs.mkdirSync(path.join(data, 'feed'), { recursive: true });
  const kept = {
    key: '0xrayai/xray#389', born: 'github', kind: 'issue', repo: '0xRayAI/xray', number: 389,
    title: 'feat: ponder', url: 'https://github.com/0xRayAI/xray/issues/389',
    owner: 'forge', stage: 'open', state: 'live', packet: {}, beats: [], last_beat_t: 1,
  };
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: '2026-11-02T00:00:00Z',
    cards: [{ ...ghost(741), owner: 'forge' }, kept],
  }));
  fs.writeFileSync(path.join(data, 'feed', 'github-events.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    events: [opened(741, GHOSTS[0][1]), opened(165, GHOSTS[4][1]), opened(389, 'feat: ponder')],
  }));
  const srv = start(data, {
    INGEST_SECRET: ingest,
    SEAT_KEYS: JSON.stringify({ forge: crypto.createHash('sha256').update(forgeKey).digest('hex') }),
  });
  try {
    await srv.ready;
    const auth = { Authorization: 'Bearer ' + forgeKey };
    const cards = async () => (await fetch(srv.base + '/cards?seat=forge', { headers: auth })).json();
    let body = null;
    let healed = null;
    for (let i = 0; i < 30; i++) {
      body = await cards();
      healed = (body.cards || []).find(card => card.key === '0xrayai/xray#741');
      if (healed && healed.title === GHOSTS[0][1]) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(healed && healed.title, GHOSTS[0][1], JSON.stringify(body && body.cards));
    assert.equal(healed.url, 'https://github.com/0xRayAI/xray/issues/741');
    assert.equal(String(healed.url).includes('/pull/'), false);
    const post = async (number) => {
      const res = await fetch(srv.base + '/inbox', {
        method: 'POST', headers: { 'X-Live-Ingest': ingest, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: [{
          id: `handoff:0xrayai/xray#${number}:ready:abc1234`, t_ct: new Date().toISOString(),
          seat: 'forge', from: 'arch1', to: 'forge', type: 'packet', kind: 'ready',
          repo: '0xRayAI/xray', number, sha: 'abc1234', title: 'handoff ready',
          url: `https://github.com/0xRayAI/xray/pull/${number}`, reason: 'handoff ready',
        }] }),
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
    };
    await post(389);
    body = await cards();
    const ponder = (body.cards || []).find(card => card.key === '0xrayai/xray#389');
    assert.equal(ponder && ponder.title, 'feat: ponder');
    assert.equal(ponder.url, 'https://github.com/0xRayAI/xray/issues/389');
    await post(165);
    let fresh = null;
    for (let i = 0; i < 20; i++) {
      body = await cards();
      fresh = (body.cards || []).find(card => card.key === '0xrayai/xray#165');
      if (fresh && fresh.title === GHOSTS[4][1]) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(fresh && fresh.title, GHOSTS[4][1], JSON.stringify(body && body.cards));
    assert.equal(fresh.url, 'https://github.com/0xRayAI/xray/issues/165');
  } finally {
    const done = new Promise(r => srv.child.exitCode != null || srv.child.signalCode ? r() : srv.child.once('exit', r));
    srv.child.kill();
    await done;
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('GET /cards takes the GitHub issue title when the feed has no open event', async () => {
  const title = 'Fleet news: remediate Cursor marketplace Anthropic.claude-code 2.1.313 (Oct 29)';
  const parsed = faceFromGithubIssue({ title, html_url: 'https://github.com/0xRayAI/xray/issues/741' }, { repo: '0xRayAI/xray', number: 741 });
  assert.equal(parsed.kind, 'issue');
  assert.equal(faceFromGithubIssue({ title: 'held pull', html_url: 'https://github.com/0xRayAI/xray/pull/70', pull_request: { url: 'x' } }, { repo: '0xRayAI/xray', number: 70 }).kind, 'pr');
  const mock = http.createServer((req, res) => {
    if (req.url === '/repos/0xRayAI/xray/issues/741') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title, html_url: 'https://github.com/0xRayAI/xray/issues/741' }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-face-gh-'));
  const forgeKey = 'forge-' + crypto.randomBytes(4).toString('hex');
  const ingest = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.join(data, 'live'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: '2026-11-02T00:00:00Z',
    cards: [{ ...ghost(741), owner: 'forge' }],
  }));
  const srv = start(data, {
    COLLECTOR: 'off',
    GITHUB_READ_TOKEN: 'test-token',
    GITHUB_API_URL: 'http://127.0.0.1:' + mock.address().port,
    INGEST_SECRET: ingest,
    SEAT_KEYS: JSON.stringify({ forge: crypto.createHash('sha256').update(forgeKey).digest('hex') }),
  });
  try {
    await srv.ready;
    const auth = { Authorization: 'Bearer ' + forgeKey };
    const posted = await fetch(srv.base + '/inbox', {
      method: 'POST', headers: { 'X-Live-Ingest': ingest, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [{
        id: 'live-hold', t_ct: new Date().toISOString(), seat: 'forge', type: 'packet',
        repo: 'acme/app', number: 3, title: 'card hold', url: 'https://github.com/acme/app/issues/3', reason: 'packet post',
      }] }),
    });
    assert.equal(posted.status, 200, await posted.text());
    let healed = null;
    let body = null;
    for (let i = 0; i < 30; i++) {
      body = await (await fetch(srv.base + '/cards?seat=forge', { headers: auth })).json();
      healed = (body.cards || []).find(card => card.key === '0xrayai/xray#741');
      if (healed && healed.title === title) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healed && healed.title, title, JSON.stringify(body && body.cards));
    assert.equal(healed.url, 'https://github.com/0xRayAI/xray/issues/741');
    assert.equal(healed.kind, 'issue');
  } finally {
    const done = new Promise(resolve => srv.child.exitCode != null || srv.child.signalCode ? resolve() : srv.child.once('exit', resolve));
    srv.child.kill();
    await done;
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(data, { recursive: true, force: true });
  }
});
