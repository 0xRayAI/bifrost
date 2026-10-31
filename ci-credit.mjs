// CI from/who. The actor or the app names the seat. GitHub and CI stay when neither maps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CI_KINDS = new Set(['workflow_run', 'check_suite', 'check_run', 'ci_pass', 'ci_fail']);
const SKIP = new Set(['github', 'ci', 'others', 'example', '']);
// Cursor cloud agents. Bugbot (cursor[bot]) is not one of them.
const CLOUD = /^cursor-?(?:cloud-?)?agents?(?:\[bot\])?$/i;

export function loadCiNodes(file) {
  const target = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed', 'fleet-nodes.json');
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function seatOf(login, nodes) {
  const name = String(login || '').trim();
  if (!name) return '';
  if (CLOUD.test(name)) return 'CloudAgents';
  const seat = nodes[name.toLowerCase()];
  if (!seat || SKIP.has(String(seat).toLowerCase())) return '';
  return String(seat);
}

/** Seat from the event's actor, then its app slug. Empty when neither maps. */
export function ciSeat(row, nodes) {
  if (!row || typeof row !== 'object') return '';
  const map = {};
  for (const [key, value] of Object.entries(nodes || {})) map[String(key).toLowerCase()] = value;
  const logins = [];
  for (const key of ['actor', 'author', 'sender', 'triggering_actor']) {
    if (typeof row[key] === 'string' && row[key].trim()) logins.push(row[key].trim());
  }
  if (typeof row.app === 'string' && row.app.trim()) {
    const slug = row.app.trim();
    logins.push(slug);
    if (!slug.toLowerCase().endsWith('[bot]')) logins.push(`${slug}[bot]`);
  }
  for (const login of logins) {
    const seat = seatOf(login, map);
    if (seat) return seat;
  }
  return '';
}

const FOLDED = new Set(['github', 'ci', 'others', 'example']);

/** Stored and new CI rows. from stays GitHub when the actor and the app do not map. */
export function creditCiFrom(row, nodes) {
  if (!row || typeof row !== 'object' || !CI_KINDS.has(row.kind)) return row;
  const seat = ciSeat(row, nodes);
  if (!seat) return row;
  const from = String(row.from || '');
  if (from && !FOLDED.has(from.toLowerCase())) return row;
  if (from === seat) return row;
  return { ...row, from: seat };
}
