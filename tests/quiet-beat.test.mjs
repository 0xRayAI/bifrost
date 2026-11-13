// A quiet pass must leave the event document in place and keep the beat small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a matching board signature leaves the document and keeps the beat small', () => {
  const code = `
import json, os, sys, tempfile
from pathlib import Path
root = Path(tempfile.mkdtemp())
os.environ.update(LIVE_MODE="github", GH_TOKEN="x", MESH_RUN=str(root), LIVE_MESH_SRC=${JSON.stringify(path.join(APP, 'collector', 'upstream'))})
sys.path.insert(0, ${JSON.stringify(path.join(APP, 'collector'))})
import live_mesh as lm
out = root / "github-events.json"
ev = [{"id": "e1", "t_ct": "2026-10-13T09:00:00-05:00", "kind": "pr_open"}]
board = {"updated_ct": "t1", "cards": [{"key": "k", "state": "live", "stage": "do", "closed_t": 1, "title": "t" * 40} for _ in range(30)], "stats": {"open_total": 1}}
lm._write({"events": ev, "generated_at": "t1", "board": board}, out)
raw = out.read_bytes()
sig = json.loads((root / "github-events.beat.json").read_text())["board_sig"]
clock = dict(board, updated_ct="t2", cards=[{**c, "closed_t": 99} for c in board["cards"]])
n = lm._write({"events": ev, "generated_at": "t2", "board": clock}, out)
kept = out.read_bytes() == raw
beat = json.loads((root / "github-events.beat.json").read_text())
changed = dict(board, cards=[{**board["cards"][0], "state": "closed", "stage": "done"}, *board["cards"][1:]])
lm._write({"events": ev, "generated_at": "t3", "board": changed}, out)
doc = json.loads(out.read_text())
beat2 = json.loads((root / "github-events.beat.json").read_text())
print(json.dumps({
  "n": n,
  "kept": kept,
  "at": beat.get("generated_at"),
  "board": "board" in beat,
  "sig": beat.get("board_sig"),
  "same_sig": beat.get("board_sig") == sig,
  "small": (root / "github-events.beat.json").stat().st_size < 2 * 1024 * 1024,
  "rewritten": doc.get("board", {}).get("cards", [{}])[0].get("state"),
  "beat_board": "board" in beat2,
  "new_sig": beat2.get("board_sig") not in (None, sig),
}))
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(got.n, 0);
  assert.equal(got.kept, true);
  assert.equal(got.at, 't2');
  assert.equal(got.board, false);
  assert.equal(got.same_sig, true);
  assert.equal(typeof got.sig, 'string');
  assert.equal(got.small, true);
  assert.equal(got.rewritten, 'closed');
  assert.equal(got.beat_board, false);
  assert.equal(got.new_sig, true);
});
