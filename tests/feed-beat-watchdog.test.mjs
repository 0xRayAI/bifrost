// #65: a collector whose big feed never finishes parsing, but which writes the beat every pass, is alive.
// The watchdog must read the beat clock even when the feed signature keeps changing. On main it killed the collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a fresh beat keeps a collector alive while the feed parse never lands', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-bin-'));
  // Stand-in collector (python3 on PATH): rewrites a feed the worker cannot parse, so the signature changes every
  // pass and lastWrite never moves from the feed. The beat file is the only clock.
  fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh
out=""; while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done
beat="\${out%.json}.beat.json"; i=0
while :; do i=$((i+1)); printf '{"events":[%s' "$i" > "$out"; printf '{"generated_at":"t%s"}\\n' "$i" > "$beat"; sleep 0.3; done
`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], {
    env: {
      PORT: '0', MESH_PASSWORD: 'pw', SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      INGEST_SECRET: crypto.randomBytes(32).toString('hex'), PATH: bin + ':' + process.env.PATH,
      MESH_DATA_DIR: data, GITHUB_READ_TOKEN: 'test-not-a-token', COLLECTOR_WATCH_S: '1', SERVER_ROUTING: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  try {
    const t0 = Date.now();
    while (!/collector: started pid/.test(logs) && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 100));
    assert.match(logs, /collector: started pid/, logs.slice(-2000));
    await new Promise(r => setTimeout(r, 8000));   // limit is 3 s (1 s x 3); give it well over two limits
    assert.doesNotMatch(logs, /feed loop stalled/, logs.slice(-2000));
  } finally {
    child.kill('SIGKILL');
  }
});
