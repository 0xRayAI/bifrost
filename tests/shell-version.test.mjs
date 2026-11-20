// Shell hash and the refresh notice. A feed tick keeps the hash. An HTML comment changes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellVersion, SHELL_FILES, SHELL_HEADER } from '../shell-version.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function filesFrom(dir) {
  const out = {};
  for (const name of SHELL_FILES) out[name] = fs.readFileSync(path.join(dir, name));
  return out;
}

function mesh() {
  const box = {};
  new Function('globalThis', fs.readFileSync(path.join(APP, 'public', 'live.js'), 'utf8'))(box);
  return box.LiveMesh;
}

test('a comment in the page changes the shell hash and a feed body does not', () => {
  const files = filesFrom(path.join(APP, 'public'));
  const first = shellVersion(files);
  assert.equal(shellVersion(files), first);
  assert.equal(first.length, 16);
  const commented = { ...files, 'index.html': Buffer.concat([files['index.html'], Buffer.from('\n<!-- shell -->\n')]) };
  assert.notEqual(shellVersion(commented), first);
  assert.equal(shellVersion({ ...files, 'feed.json': Buffer.from('{"events":[1]}') }), first);
});

test('the first shell is quiet, the same shell stays quiet, and a new shell asks once', () => {
  const L = mesh();
  assert.deepEqual(L.shellNotice('', 'aaa'), { seen: 'aaa', show: false });
  assert.deepEqual(L.shellNotice('aaa', 'aaa'), { seen: 'aaa', show: false });
  assert.deepEqual(L.shellNotice('aaa', ''), { seen: 'aaa', show: false });
  assert.deepEqual(L.shellNotice('aaa', 'bbb'), { seen: 'aaa', show: true });
  assert.deepEqual(L.shellNotice('aaa', 'bbb'), { seen: 'aaa', show: true });
});

test('a 304 still carries the shell header and does not invent a feed', async () => {
  const L = mesh();
  const headers = new Map([['X-Bifrost-Shell', 'abc'], ['ETag', '"feed"']]);
  const res = { status: 304, ok: false, headers: { get: (k) => headers.get(k) || null } };
  const out = await L.fetchFeed(() => Promise.resolve(res), 1000, { etag: '"feed"' });
  assert.equal(out.feed, null);
  assert.equal(out.shell, 'abc');
  assert.equal(out.source, 'feed');
});

function start(data) {
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    env: {
      PORT: '0',
      MESH_PASSWORD: 'pw-' + crypto.randomBytes(4).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'),
      PATH: process.env.PATH,
      MESH_DATA_DIR: data,
      COLLECTOR: 'off',
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

test('the public shell endpoint matches the header and the page hash', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-shell-'));
  const srv = start(data);
  try {
    await srv.ready;
    const expected = shellVersion(filesFrom(path.join(APP, 'public')));
    const body = await (await fetch(srv.base + '/shell-version')).text();
    assert.equal(body, expected + '\n');
    const health = await fetch(srv.base + '/healthz');
    assert.equal(health.headers.get(SHELL_HEADER), expected);
    const feed = await fetch(srv.base + '/live-events.json');
    assert.equal(feed.status, 200);
    assert.equal(feed.headers.get(SHELL_HEADER), expected);
    const etag = feed.headers.get('etag');
    assert.ok(etag);
    const again = await fetch(srv.base + '/live-events.json', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get(SHELL_HEADER), expected);
  } finally {
    await stop(srv.child);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
