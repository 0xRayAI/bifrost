// Page source for the stats strip. Same checks as the xray page test for this board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');

test('board stats strip: 24h counts + open now from feed.board.stats, textContent only', () => {
  assert.match(html, /<div class="wave-stats" id="waveStats"/);
  for (const k of ['issues_opened_24h', 'issues_closed_24h', 'prs_opened_24h', 'prs_merged_24h', 'prs_closed_unmerged_24h', 'owner_prompts_24h', 'owner_prompts_24h_ids', 'owner_prompts_24h_bytes', 'open_total', 'arch1_backlog']) {
    assert.match(html, new RegExp('S\\.' + k));
  }
  assert.match(html, /'owner prompts'/);
  assert.match(html, /wb\.stats = r\.feed\.board\.stats \|\| null/);
});

test('stats strip is eight columns, with arch1 backlog before open now and no 24h suffix on either', () => {
  assert.match(html, /\.wave-stats \{ display: grid; grid-template-columns: repeat\(8, 1fr\);/);
  const keys = html.match(/var statKeys = \[([^\]]+)\]/);
  assert.ok(keys, 'statKeys');
  const order = keys[1];
  assert.ok(order.indexOf("'arch1_backlog'") < order.indexOf("'open_total'"), order);
  assert.ok(order.indexOf("'owner_prompts_24h'") < order.indexOf("'arch1_backlog'"), order);
  assert.match(html, /\['arch1 backlog', S\.arch1_backlog\]/);
  assert.match(html, /var noDay = key === 'owner_prompts_24h' \|\| key === 'open_total' \|\| key === 'arch1_backlog'/);
  assert.match(html, /key === 'open_total' \? ' total'/);
  assert.match(html, /else if \(wb\.statFilter === 'arch1_backlog'\) cards = \[\];/);
});

test('a spinner is only the card in working_on, and a 7-day seat is dormant', () => {
  const L = { SOURCES: [], AGENTS: [], SEAT_NAMES: [], SATS: {}, COLOR: {}, LABEL: {}, SUB: {}, GLYPH: {}, SQUARE: {},
    EDGES: [], BOT_IMAGES: [], KIND_WORD: {}, applyFeed: (st, feed) => ({ state: { events: feed.events } }) };
  new Function('window', 'location', fs.readFileSync(path.join(APP, 'public', 'live-config.js'), 'utf8'))({ LiveMesh: L }, { search: '' });
  assert.equal(L.DORMANT_MS, 7 * 24 * 60 * 60 * 1000);
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(L.seatDormant('2026-10-20T12:00:00Z', now), true);
  assert.equal(L.seatDormant('2026-10-22T12:00:00Z', now), false);
  assert.equal(L.seatDormant('', now), false);
  const fleet = {
    working: { arch1: { via: 'prompt', since_ct: '2026-10-28T11:00:00Z' } },
    seats: {
      arch1: { working: true, working_on: '0xRayAI/xray#5' },
      critic: { working: true, working_on: '0xRayAI/xray#6' },
      magnet: { working: false, last_ct: '2026-10-01T12:00:00Z' },
    },
  };
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 5, _seat: 'arch1' }, fleet), true);
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 9, _seat: 'arch1' }, fleet), false);
  fleet.working.arch1.working_on = '0xRayAI/xray#6';
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 5, _seat: 'arch1' }, fleet), false);
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 6, _seat: 'arch1' }, fleet), true);
  delete fleet.working.arch1.working_on;
  delete fleet.seats.arch1.working_on;
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 5, _seat: 'arch1' }, fleet), false);
  const prompt = {
    working: { forge: { via: 'prompt', since_ct: '2026-10-31T21:03:01.000-05:00' } },
    seats: { forge: { working: true, working_via: 'prompt' } },
  };
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 751, key: '0xrayai/xray#751', _seat: 'forge' }, prompt), false);
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 763, key: '0xrayai/xray#763', _seat: 'forge' }, prompt), false);
  prompt.working.forge.working_on = '0xRayAI/xray#755';
  prompt.seats.forge.working_on = '0xRayAI/xray#755';
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 755, key: '0xrayai/xray#755', _seat: 'Arch1' }, prompt), true);
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 751, key: '0xrayai/xray#751', _seat: 'forge' }, prompt), false);
  assert.equal(L.cardInWork({ repo: '0xRayAI/bifrost', number: 3, key: '0xrayai/bifrost#3', _seat: 'forge' }, prompt), false);
  const running = [{ state: 'running', card: '0xRayAI/xray#751', bcId: 'bc-running' }];
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 751, key: '0xrayai/xray#751', _seat: 'forge' }, prompt, running), true);
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 763, key: '0xrayai/xray#763', _seat: 'forge' }, prompt, running), false);
  assert.equal(L.cardInWork({ repo: '0xRayAI/xray', number: 751, _seat: 'forge' }, prompt, [{ state: 'finished', card: '0xRayAI/xray#751' }]), false);
  const rows = [['sound', ''], ['arch1', ''], ['CloudAgents', ''], ['magnet', '']];
  const kept = L.rosterKept(rows, { fleet, product_nodes: ['CloudAgents'] });
  assert.deepEqual(kept.map(a => a[0]), ['arch1', 'CloudAgents', 'magnet']);
  assert.deepEqual(L.rosterKept(rows, {}), rows);
  assert.match(html, /L\.cardInWork\(Object\.assign\(\{\}, c, \{ _seat: cardSeat\(c\) \}\), window\.LIVE_FLEET, wb\.cloudAgents\)/);
  assert.match(html, /statusId\(c\.state\) === 'parked' \|\| statusId\(c\.state\) === 'held' \|\| statusId\(c\.stage\) === 'done'\) return false/);
  assert.match(html, /L\.rosterKept\) rosterRows = L\.rosterKept\(rosterRows, r\.feed\)/);
});
