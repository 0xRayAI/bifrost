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
