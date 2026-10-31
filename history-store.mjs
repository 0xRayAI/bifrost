// Redis holds the latest card per key and each day's events. The duplicate card dump never lands here.
import { connectRedis } from './resp.mjs';
import { mergeCardRow } from './archive.mjs';

const CARDS = 'mesh:cards';
const READY = 'mesh:history-ready';

function eventKey(day) {
  return 'mesh:events:' + day;
}

function pairs(rows, fieldOf) {
  const out = [];
  for (const row of rows) {
    const field = fieldOf(row);
    if (!field) continue;
    out.push(field, JSON.stringify(row));
  }
  return out;
}

async function hsetChunks(client, key, flat) {
  const width = 200;
  for (let i = 0; i < flat.length; i += width * 2) {
    const chunk = flat.slice(i, i + width * 2);
    if (!chunk.length) continue;
    await client.command(['HSET', key, ...chunk]);
  }
}

function rowsFromFlat(flat) {
  const rows = [];
  if (!Array.isArray(flat)) return rows;
  for (let i = 0; i < flat.length; i += 2) {
    try { rows.push(JSON.parse(flat[i + 1])); }
    catch { /* skip a bad field */ }
  }
  return rows;
}

export async function openHistory(url) {
  const client = await connectRedis(url);
  return createHistory(client);
}

export function createHistory(client) {
  return {
    async putCard(row) {
      const key = String(row && row.key || '').toLowerCase();
      if (!key) return null;
      let next = row;
      try {
        const cur = await client.command(['HGET', CARDS, key]);
        if (typeof cur === 'string' && cur) next = mergeCardRow(JSON.parse(cur), row);
      } catch { /* missing or stale field: the new row stands */ }
      await client.command(['HSET', CARDS, key, JSON.stringify(next)]);
      return next;
    },
    async replaceCards(rows) {
      await hsetChunks(client, CARDS, pairs(rows, (row) => String(row && row.key || '').toLowerCase()));
    },
    async readCards() {
      const n = await client.command(['EXISTS', CARDS]);
      if (!n) return null;
      return rowsFromFlat(await client.command(['HGETALL', CARDS]));
    },
    async putEvent(day, row) {
      if (!day || !row || row.id == null) return;
      await client.command(['HSET', eventKey(day), String(row.id), JSON.stringify(row)]);
    },
    async replaceEvents(day, rows) {
      if (!day) return;
      await hsetChunks(client, eventKey(day), pairs(rows, (row) => (row && row.id == null ? '' : String(row.id))));
    },
    async readEvents(day) {
      const key = eventKey(day);
      const n = await client.command(['EXISTS', key]);
      if (!n) return null;
      const rows = rowsFromFlat(await client.command(['HGETALL', key]));
      rows.sort((a, b) => (Date.parse(a && a.t_ct) || 0) - (Date.parse(b && b.t_ct) || 0));
      return rows;
    },
    async markReady(info) {
      const body = JSON.stringify({
        cards: Number(info && info.cards) || 0,
        days: Number(info && info.days) || 0,
      });
      await client.command(['SET', READY, body]);
    },
    async close() { client.close(); },
  };
}
