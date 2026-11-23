// --ack stale clears a merged merge handoff with the pull URL, and leaves a newer unreviewed head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'server.mjs');
const REPO = 'example-org/app';
const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const REVIEW_AT = '2026-11-18T15:00:00-06:00';
const LATER = '2026-11-19T15:00:00-06:00';

function start(data, extra) {
  const child = spawn(process.execPath, [APP], {
    cwd: ROOT,
    env: {
      PORT: '0', PATH: process.env.PATH, COLLECTOR: 'on', SERVER_ROUTING: 'off', MESH_DATA_DIR: data,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'),
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
      try { if (base && (await fetch(base + '/healthz')).status) return; } catch { /* not up */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('healthz did not come up\n' + logs);
  })();
  return { child, get base() { return baseOf(); }, ready, logs: () => logs };
}

function handoff(number, sha) {
  return {
    id: `handoff:${REPO}#${number}:merge:${sha}`,
    t_ct: LATER, seat: 'critic', from: 'forge', to: 'critic', type: 'packet', kind: 'merge',
    repo: REPO, number, sha, title: 'handoff merge',
    url: `https://github.com/${REPO}/pull/${number}`, reason: 'handoff merge',
  };
}

function pass(number, sha, t_ct) {
  return {
    id: `ci:${REPO}#${number}:ci_pass:${sha}`,
    t_ct, seat: 'critic', type: 'ci_pass', kind: 'ci_pass',
    repo: REPO, number, sha, title: 'ci pass',
    url: `https://github.com/${REPO}/pull/${number}`, reason: 'ci pass',
  };
}

function merged(number) {
  return { id: `${REPO}#${number}:merged`, t_ct: LATER, kind: 'merged', repo: REPO, number, from: 'GitHub', to: 'GitHub' };
}

function review(number, sha) {
  return {
    id: `${REPO}#${number}:review:1`, t_ct: REVIEW_AT, kind: 'review', repo: REPO, number,
    sha, state: 'CHANGES_REQUESTED', from: 'GitHub', to: 'GitHub',
  };
}

function card(number) {
  return {
    key: `${REPO}#${number}`, repo: REPO, number, title: 'open pull',
    url: `https://github.com/${REPO}/pull/${number}`,
    owner: 'critic', stage: 'done', state: 'closed', kind: 'pr',
  };
}

function ackFiles(data) {
  const rows = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (name === 'acks.jsonl') {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line) rows.push(JSON.parse(line));
      }
    }
  };
  walk(data);
  return rows;
}

test('stale apply clears merged handoffs and keeps a newer ci_pass', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-stale-'));
  const criticKey = 'critic-' + crypto.randomBytes(4).toString('hex');
  const heads = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NEW];
  const mergedLines = [801, 802, 803].map((number, i) => handoff(number, heads[i]));
  const newer = pass(38, NEW, LATER);
  const same = pass(39, OLD, LATER);
  const bare = pass(41, NEW, LATER);
  const open = handoff(14, OLD);
  fs.mkdirSync(path.join(data, 'live', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(data, 'feed'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live', 'inbox', 'critic.jsonl'), [...mergedLines, newer, same, bare, open].map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: '2026-11-19T16:00:00Z',
    cards: [card(38), card(39), card(41)],
  }));
  fs.writeFileSync(path.join(data, 'feed', 'github-events.json'), JSON.stringify({
    generated_at: '2026-11-19T16:00:00Z',
    events: [merged(801), merged(802), merged(803), review(38, OLD), review(803, OLD), review(39, OLD)],
  }));
  const srv = start(data, {
    SEAT_KEYS: JSON.stringify({ critic: crypto.createHash('sha256').update(criticKey).digest('hex') }),
  });
  try {
    await srv.ready;
    const auth = { Authorization: 'Bearer ' + criticKey, 'Content-Type': 'application/json' };
    const staleRes = await fetch(srv.base + '/inbox/critic?stale=1', { headers: auth });
    const staleBody = await staleRes.json();
    assert.equal(staleRes.status, 200);
    const staleIds = (staleBody.lines || []).map(l => l.id);
    for (const line of mergedLines) assert.equal(staleIds.includes(line.id), true, line.id);
    assert.equal(staleIds.includes(same.id), true);
    assert.equal(staleIds.includes(newer.id), false);
    assert.equal(staleIds.includes(bare.id), false);
    assert.equal(staleIds.includes(open.id), false);
    for (const id of staleIds) {
      const res = await fetch(srv.base + '/inbox/critic/ack', { method: 'POST', headers: auth, body: JSON.stringify({ id }) });
      const text = await res.text();
      assert.equal(res.status, 200, id + ' ' + text);
    }
    const stored = ackFiles(data);
    for (const line of mergedLines) {
      const row = stored.find(r => r.line === line.id);
      assert.equal(row && row.review, line.url);
    }
    const openAck = await fetch(srv.base + '/inbox/critic/ack', { method: 'POST', headers: auth, body: JSON.stringify({ id: open.id }) });
    const openBody = await openAck.json();
    assert.equal(openAck.status, 400);
    assert.equal(openBody.error, 'merge handoff requires a review link');
    const left = await (await fetch(srv.base + '/inbox/critic', { headers: auth })).json();
    const leftIds = (left.lines || []).map(l => l.id);
    assert.equal(leftIds.includes(newer.id), true);
    assert.equal(leftIds.includes(bare.id), true);
    assert.equal(leftIds.includes(open.id), true);
    assert.equal(leftIds.includes(same.id), false);
  } finally {
    const done = new Promise(r => srv.child.exitCode != null || srv.child.signalCode ? r() : srv.child.once('exit', r));
    srv.child.kill();
    await done;
    fs.rmSync(data, { recursive: true, force: true });
  }
});

// A FIX on an old head stops ringing the author once the head moves. A review on the current head stays.
test('a review or critic_fail on a superseded head is settled, and one on the current head stays open', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-superseded-'));
  const key = 'forge-' + crypto.randomBytes(4).toString('hex');
  const at = (n, kind, sha, id) => ({
    id, t_ct: REVIEW_AT, seat: 'forge', from: 'critic', to: 'forge', type: kind, kind,
    repo: REPO, number: n, sha, title: 'critic ' + kind, url: `https://github.com/${REPO}/pull/${n}`, reason: 'critic ' + kind,
  });
  const oldFix = at(50, 'review', OLD, 'review:old-fix');
  const oldFail = at(50, 'critic_fail', OLD, 'handoff:old-fail');
  const oldShort = at(52, 'review', OLD, 'review:old-short');
  const curFix = at(51, 'review', NEW, 'review:cur-fix');
  const noVerdict = at(53, 'review', OLD, 'review:no-verdict');
  const open = (n, head, reviewer) => ({
    key: `${REPO}#${n}`, repo: REPO, number: n, title: 'open pull', url: `https://github.com/${REPO}/pull/${n}`,
    owner: 'forge', stage: 'review', state: 'live', kind: 'pr', head, ...(reviewer ? { reviewer } : {}),
  });
  fs.mkdirSync(path.join(data, 'live', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(data, 'feed'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live', 'inbox', 'forge.jsonl'), [oldFix, oldFail, oldShort, curFix, noVerdict].map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'live', 'cards.json'), JSON.stringify({
    updated_ct: '2026-11-19T16:00:00Z',
    cards: [
      open(50, NEW, { verdict: 'FIX', sha: OLD, t: Date.parse(REVIEW_AT), at_head: false, stale: true }),
      open(51, NEW, { verdict: 'FIX', sha: NEW, t: Date.parse(REVIEW_AT), at_head: true, stale: false }),
      open(52, NEW.slice(0, 7), { verdict: 'FIX', sha: OLD.slice(0, 7), t: Date.parse(REVIEW_AT), at_head: false, stale: true }),
      open(53, NEW),
    ],
  }));
  fs.writeFileSync(path.join(data, 'feed', 'github-events.json'), JSON.stringify({
    generated_at: '2026-11-19T16:00:00Z',
    events: [review(50, OLD), review(51, NEW), review(52, OLD), review(53, OLD)],
  }));
  const srv = start(data, { SEAT_KEYS: JSON.stringify({ forge: crypto.createHash('sha256').update(key).digest('hex') }) });
  try {
    await srv.ready;
    const auth = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    const open1 = await (await fetch(srv.base + '/inbox/forge', { headers: auth })).json();
    const openIds = (open1.lines || []).map(l => l.id);
    assert.equal(openIds.includes(curFix.id), true, 'a review on the current head stays');
    assert.equal(openIds.includes(noVerdict.id), true, 'a card with no verdict is not superseded');
    for (const l of [oldFix, oldFail, oldShort]) assert.equal(openIds.includes(l.id), false, l.id + ' stops showing as open work');
    // The board sweep acks a settled review line. Lines still open are not acked.
    let acked = [];
    for (let i = 0; i < 40 && acked.length < 2; i++) {
      await new Promise(r => setTimeout(r, 100));
      acked = ackFiles(data).map(r => r.line);
    }
    for (const l of [oldFix, oldShort]) assert.equal(acked.includes(l.id), true, l.id + ' is acked by the sweep');
    assert.equal(acked.includes(oldFail.id), false, 'a critic_fail is hidden from open work, not acked');
    assert.equal(acked.includes(curFix.id), false);
    assert.equal(acked.includes(noVerdict.id), false);
  } finally {
    const done = new Promise(r => srv.child.exitCode != null || srv.child.signalCode ? r() : srv.child.once('exit', r));
    srv.child.kill();
    await done;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
