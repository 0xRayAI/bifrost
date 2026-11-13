// A quiet pass must leave the event document in place and keep the beat small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a quiet beat omits the board and stays under 2 MiB', () => {
  const code = `
import json, os, sys, tempfile
from pathlib import Path
root = Path(tempfile.mkdtemp())
os.environ.update(LIVE_MODE="github", GH_TOKEN="x", MESH_RUN=str(root), LIVE_MESH_SRC=${JSON.stringify(path.join(APP, 'collector', 'upstream'))})
sys.path.insert(0, ${JSON.stringify(path.join(APP, 'collector'))})
import live_mesh as lm
out = root / "github-events.json"
ev = [{"id": "e1", "t_ct": "2026-10-13T09:00:00-05:00", "kind": "pr_open"}]
lm._write({"events": ev, "generated_at": "t1"}, out)
raw = out.read_bytes()
board = {"cards": [{"key": "k", "title": "t" * 40} for _ in range(30)]}
n = lm._write({"events": ev, "generated_at": "t2", "board": board}, out)
beat_path = root / "github-events.beat.json"
beat = json.loads(beat_path.read_text())
print(json.dumps({
  "n": n,
  "kept": out.read_bytes() == raw,
  "at": beat.get("generated_at"),
  "board": "board" in beat,
  "small": beat_path.stat().st_size < 2 * 1024 * 1024,
}))
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(got.n, 0);
  assert.equal(got.kept, true);
  assert.equal(got.at, 't2');
  assert.equal(got.board, false);
  assert.equal(got.small, true);
});
