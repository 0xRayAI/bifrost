// The roster wraps into columns. Eight seats are not one jammed row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NAMES = ['forge', 'critic', 'blinky', 'herald', 'magnet', 'nibbler', 'sound', 'arch1'];

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
  const body = JSON.stringify({
    generated_at: new Date().toISOString(),
    cursor: 'roster',
    events: [],
    queue: [],
    track: { items: [] },
    cloud_agents: [],
    roster: NAMES,
    roster_roles: { forge: 'merge' },
    board: { updated_ct: new Date().toISOString(), cards: [], stats: { open_total: 0 } },
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/live-events.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return; }
      if (url.pathname === '/history/cards' || url.pathname === '/history') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"cards":[],"days":[],"events":[]}'); return; }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.normalize(path.join(PUB, rel));
      if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function boxes(page) {
  return page.evaluate(() => {
    const grid = document.getElementById('seatGrid');
    const seats = [...grid.querySelectorAll('.seat')].map((el) => {
      const box = el.getBoundingClientRect();
      return { name: el.querySelector('.nm').textContent, x: box.x, y: box.y, r: box.right, w: box.width };
    });
    const view = document.documentElement.clientWidth;
    return {
      seats,
      view,
      display: getComputedStyle(grid).display,
      grid: grid.getBoundingClientRect().width,
      scroll: Math.max(grid.scrollWidth, document.documentElement.scrollWidth),
    };
  });
}

test('eight seats wrap into columns and stay inside a narrow viewport', async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  let browser;
  try {
    browser = await chromium.launch();
    const wide = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await wide.goto(base, { waitUntil: 'domcontentloaded' });
    await wide.waitForFunction((n) => document.querySelectorAll('#seatGrid .seat').length === n, NAMES.length);
    const desktop = await boxes(wide);
    const rows = new Set(desktop.seats.map((seat) => Math.round(seat.y)));
    const cols = new Set(desktop.seats.map((seat) => Math.round(seat.x)));
    assert.equal(desktop.display, 'grid');
    assert.ok(cols.size >= 2 && rows.size >= 2, JSON.stringify(desktop.seats));
    assert.equal(desktop.seats.length, 8);
    assert.ok(desktop.scroll <= desktop.view + 1, JSON.stringify(desktop));
    await wide.close();
    const narrow = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await narrow.goto(base, { waitUntil: 'domcontentloaded' });
    await narrow.waitForFunction((n) => document.querySelectorAll('#seatGrid .seat').length === n, NAMES.length);
    const phone = await boxes(narrow);
    assert.ok(phone.scroll <= phone.view + 1, JSON.stringify(phone));
    assert.ok(phone.seats.every((seat) => seat.r <= phone.view + 1), JSON.stringify(phone.seats));
    const rowsNarrow = new Set(phone.seats.map((seat) => Math.round(seat.y)));
    assert.ok(rowsNarrow.size >= 2, JSON.stringify(phone.seats));
    await narrow.locator('#seatGrid .seat', { hasText: 'FORGE' }).click();
    assert.equal(await narrow.locator('#seatGrid .seat', { hasText: 'FORGE' }).getAttribute('aria-expanded'), 'true');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
