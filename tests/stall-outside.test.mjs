// Outside / CLI seats are rarely working. Stall on their cards follows GitHub
// activity on that card. A prompt with no working_on still does not spin it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');

function loadLive() {
  const L = { SOURCES: [], AGENTS: [], SEAT_NAMES: [], SATS: {}, COLOR: {}, LABEL: {}, SUB: {}, GLYPH: {}, SQUARE: {},
    EDGES: [], BOT_IMAGES: [], KIND_WORD: {}, applyFeed: (st, feed) => ({ state: { events: feed.events } }) };
  new Function('window', 'location', fs.readFileSync(path.join(APP, 'public', 'live-config.js'), 'utf8'))({ LiveMesh: L }, { search: '' });
  return L;
}

test('an Arch1 stall card follows Arch1 comment, push, and close, not a prompt', () => {
  const L = loadLive();
  const now = Date.parse('2026-10-28T16:00:00Z');
  const card = {
    key: '0xrayai/xray#661', repo: '0xRayAI/xray', number: 661, owner: 'arch1',
    state: 'live', stage: 'open', stall: true, last_beat_t: now - 3 * 60 * 60 * 1000,
  };
  const quiet = L.freshOutsideCards([card], [], now)[0];
  assert.equal(quiet.stall, true);
  assert.equal(quiet.last_beat_t, card.last_beat_t);

  function ev(kind, agoMin, extra) {
    return Object.assign({
      id: kind + agoMin, kind, repo: '0xRayAI/xray', number: 661,
      t_ct: new Date(now - agoMin * 60000).toISOString(), from: 'GitHub',
    }, extra);
  }
  const commented = L.freshOutsideCards([card], [ev('issue_comment', 10, { actor: 'arch10x[bot]' })], now)[0];
  assert.equal(commented.stall, false);
  assert.equal(commented.last_beat_t, now - 10 * 60000);
  assert.equal(commented.state, 'live');

  const pushed = L.freshOutsideCards([card], [ev('pr_commit', 5, { actor: 'arch10x[bot]', sha: 'abc1234' })], now)[0];
  assert.equal(pushed.stall, false);
  assert.equal(pushed.last_beat_t, now - 5 * 60000);

  const branchPush = L.freshOutsideCards([card], [ev('push', 8, { from: 'arch1', author: 'git:arch1' })], now)[0];
  assert.equal(branchPush.stall, false);

  const closed = L.freshOutsideCards([card], [ev('issue_close', 4, { actor: 'arch10x[bot]' })], now)[0];
  assert.equal(closed.stall, false);
  assert.equal(closed.last_beat_t, now - 4 * 60000);

  const stranger = L.freshOutsideCards([card], [ev('issue_comment', 2, { actor: 'somebody' })], now)[0];
  assert.equal(stranger.stall, true);
  assert.equal(stranger.last_beat_t, card.last_beat_t);

  const otherCard = L.freshOutsideCards([card], [ev('issue_comment', 2, { actor: 'arch10x[bot]', number: 662 })], now)[0];
  assert.equal(otherCard.stall, true);

  const forge = L.freshOutsideCards([Object.assign({}, card, { owner: 'forge' })], [ev('issue_comment', 2, { actor: 'arch10x[bot]' })], now)[0];
  assert.equal(forge.stall, true);
  assert.equal(forge.owner, 'forge');

  const prompt = {
    working: { arch1: { via: 'prompt', since_ct: '2026-10-28T15:55:00Z' } },
    seats: { arch1: { working: true, working_via: 'prompt' } },
  };
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 661, key: '0xrayai/xray#661', _seat: 'arch1' }, prompt), false);
  assert.match(html, /if \(asOf == null && L\.freshOutsideCards\) cards = L\.freshOutsideCards\(cards, state\.events, Date\.now\(\)\)/);
  assert.match(html, /L\.cardInWork\(Object\.assign\(\{\}, c, \{ _seat: cardSeat\(c\) \}\), window\.LIVE_FLEET, wb\.cloudAgents\)/);
});

test('flow keeps an Arch1 comment and push that were labeled GitHub, and a stranger stays off the card', () => {
  const py = `
import json, os, sys, tempfile, time
from datetime import datetime
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo
sys.path.insert(0, ${JSON.stringify(path.join(APP, 'collector'))})
os.environ.setdefault("MESH_RUN", tempfile.mkdtemp())
import live_collect, live_flow, live_board
CT = ZoneInfo("America/Chicago")
now = time.time()
def stamp(ago):
    return datetime.fromtimestamp(now - ago, CT).isoformat()
def row(eid, kind, ago, **extra):
    e = {"id": eid, "t_ct": stamp(ago), "from": "GitHub", "to": "GitHub", "kind": kind,
         "repo": "0xRayAI/xray", "number": 661, "src_file": "github-api", "label": kind,
         "source": "https://github.com/0xRayAI/xray/issues/661"}
    e.update(extra)
    return e
opened = row("open", "issue_open", 3 * 3600, **{"from": "arch1", "title": "stall", "pr_state": "open"})
comment = row("c", "issue_comment", 30, actor="arch10x[bot]")
push = row("p", "pr_commit", 20, actor="arch10x[bot]", sha="abc1234")
close = row("cl", "issue_close", 15, actor="arch10x")
stranger = row("s", "issue_comment", 10, actor="somebody")
bare = row("b", "push", 12, actor="git:arch1")
flow = live_flow.Flow({}, live_collect.node)
kept = live_collect.fleet_only(flow.apply([opened, comment, push, close, stranger, bare]))
ids = sorted(e["id"] for e in kept)
assert "s" not in ids, ids
assert {"open", "c", "p", "cl", "b"} <= set(ids), ids
m = live_board.model(kept, now=now)
card = [c for c in m["cards"] if c.get("number") == 661][0]
assert card["owner"] == "arch1", card["owner"]
assert card["state"] == "closed", card["state"]
assert card["stall"] is False
words = [b["what"] for b in card["beats"]]
assert "owner comment" in words, words
assert "pushed" in words, words
print("ok")
`;
  const run = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /ok/);
});
