// One latest row per card key, streamed. The multi-GB duplicate file is never loaded whole.
import fs from 'node:fs';
import path from 'node:path';
import { cardsReadMax, forEachJsonLine, mergeCardRow, validArchiveDate } from './archive.mjs';

function dayNames(archiveRoot) {
  try { return fs.readdirSync(archiveRoot).filter(validArchiveDate); }
  catch { return []; }
}

export function oversizedCardDays(archiveRoot) {
  const max = cardsReadMax();
  const days = [];
  for (const day of dayNames(archiveRoot)) {
    try {
      if (fs.statSync(path.join(archiveRoot, day, 'cards.jsonl')).size > max) days.push(day);
    } catch { /* that day has no card file */ }
  }
  return days;
}

export function compactOversized(archiveRoot) {
  const max = cardsReadMax();
  let days = 0;
  for (const day of oversizedCardDays(archiveRoot)) {
    const map = new Map();
    forEachJsonLine(path.join(archiveRoot, day, 'cards.jsonl'), (line) => {
      let row;
      try { row = JSON.parse(line); }
      catch { return; }
      const key = String(row && row.key || '').toLowerCase();
      if (!key) return;
      map.set(key, mergeCardRow(map.get(key), row));
    });
    const body = [...map.values()].map((row) => JSON.stringify(row)).join('\n') + (map.size ? '\n' : '');
    if (!map.size || Buffer.byteLength(body) > max) continue;
    const dest = path.join(archiveRoot, day, 'cards-folded.jsonl');
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dest);
    days += 1;
  }
  return days;
}

if (process.argv[1] && process.argv[1].endsWith('compact-cards.mjs')) {
  const root = process.argv[2] || '';
  if (!root) process.exit(1);
  compactOversized(root);
}
