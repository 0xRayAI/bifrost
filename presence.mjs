// Seat presence folding (pure; imported by server.mjs and tests).
import fs from 'node:fs';
import path from 'node:path';
const tsOf = s => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : 0; };

function addDest(out, src, dst) {
  const s = String(src || '').trim();
  const d = String(dst || '').trim();
  if (!s || !d || s === d) return;
  if (!out[s]) out[s] = [];
  if (!out[s].includes(d)) out[s].push(d);
}

function addValue(out, src, value) {
  if (typeof value === 'string') addDest(out, src, value);
  else if (Array.isArray(value)) for (const dst of value) if (typeof dst === 'string') addDest(out, src, dst);
}

// SEAT_PRESENCE (JSON). A seat whose activity also counts as another seat's presence.
// Values are a seat name or an array of seat names. A top-level array of pairs is accepted too.
// Default: builder-cloud activity counts as builder. Unset uses that default. Blank or {} maps nothing.
// Invalid JSON keeps the default.
export function seatPresence(raw = process.env.SEAT_PRESENCE) {
  let data = { 'builder-cloud': 'builder' };
  if (raw != null) { try { data = String(raw).trim() ? JSON.parse(raw) : {}; } catch { /* keep default */ } }
  const out = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      if (Array.isArray(row) && row.length >= 2) addDest(out, row[0], row[1]);
      else if (row && typeof row === 'object') for (const [k, v] of Object.entries(row)) addValue(out, k, v);
    }
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) addValue(out, k, v);
  }
  return out;
}

export function presentSeat(seats, name, presence = seatPresence()) {
  let last = tsOf(seats?.[name]?.last_ct), working = !!seats?.[name]?.working;
  const want = String(name).toLowerCase();
  for (const [src, dst] of Object.entries(presence)) {
    const dests = Array.isArray(dst) ? dst : [dst];
    if (!dests.some(d => String(d).toLowerCase() === want) || !seats?.[src]) continue;
    last = Math.max(last, tsOf(seats[src].last_ct));
    working = working || !!seats[src].working;
  }
  return { last, working };
}

// Seat activity beyond GitHub: a seat counts as active when the server saw it within the fleet window through a
// wake that landed (2xx), an inbox read or an ack. touch = {seatId: ms}. Pure: returns a new fleet view.
// A seat already on the fleet (matched by lower-cased name) gets active/last_ct/via='inbox' if this is newer;
// a touched seat not on it yet is added. fleet.active is recounted.
export function readWakeOk(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[String(k).toLowerCase()] = v;
    }
    return out;
  } catch { return {}; }
}

export function writeWakeOk(file, map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, file);
}

export function foldSeatTouch(fleet, touch, now = Date.now()) {
  const ids = Object.entries(touch || {}).filter(([, t]) => Number.isFinite(t) && t > 0);
  if (!ids.length) return fleet;
  const f = fleet ? { ...fleet, seats: { ...(fleet.seats || {}) } } : { as_of: new Date(now).toISOString(), window_min: 15, seats: {}, working: {}, active: 0, total: 0 };
  const win = (f.window_min || 15) * 60000;
  for (const [id, t] of ids) {
    const name = Object.keys(f.seats).find(n => n.toLowerCase() === id) || id;
    const o = { ...(f.seats[name] || { active: false, last_ct: null, via: null, working: false }) };
    if (t > tsOf(o.last_ct)) { o.last_ct = new Date(t).toISOString(); o.via = 'inbox'; }
    if (now - t <= win) o.active = true;
    f.seats[name] = o;
  }
  f.active = Object.values(f.seats).filter(v => v.active).length;
  f.total = Math.max(f.total || 0, Object.keys(f.seats).length);
  return f;
}

// Committed fleet config shipped by deploy.sh beside the collector: fleet-roster.json is the counted seat list (unless
// LIVE_FLEET_SEATS is set); fleet-nodes.json maps logins to seats. The committed map WINS over a LIVE_NODE_MAP service
// variable for every login it names (a stale var mapped htafolla -> "Blaze0x1" on burst-live); the var only adds logins.
export function fleetConfigOf(e, dir) {
  const out = {}, roster = path.join(dir, 'fleet-roster.json');
  if (e.LIVE_FLEET_SEATS == null && fs.existsSync(roster)) out.LIVE_FLEET_SEATS = roster;
  let nodes = {}; try { nodes = JSON.parse(fs.readFileSync(path.join(dir, 'fleet-nodes.json'), 'utf8')); } catch {}
  let extra = {}; try {   // inline JSON or a path (as live_fleet accepts)
    const raw = String(e.LIVE_NODE_MAP || '').trim();
    extra = raw ? JSON.parse(raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8')) : {};
  } catch {}
  const humans = {};
  for (const part of String(e.HUMAN_ALIASES || '').split(/[\s,]+/)) {
    const login = part.trim();
    if (login) humans[login] = 'Blaze';
  }
  const lc = new Set(Object.keys(nodes).map(k => k.toLowerCase()));
  const add = Object.fromEntries(Object.entries({ ...humans, ...(extra || {}) }).filter(([k]) => !lc.has(k.toLowerCase())));
  if (Object.keys(nodes).length) out.LIVE_NODE_MAP = JSON.stringify({ ...add, ...nodes });
  return out;
}

// Rails are not fleet seats. A node-map value in this set stays off the roster.
const RAIL_NODES = new Set(['ci', 'github', 'others', 'cloudagents', 'upstream', 'railway', 'assistant']);

function parseConfig(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    if (text[0] === '{' || text[0] === '[') return JSON.parse(text);
    return JSON.parse(fs.readFileSync(text, 'utf8'));
  } catch {
    return null;
  }
}

function stringsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
}

// Full seat list. A "board" subset is only the counted header, and only when "seats" is empty.
function namesFromSeatConfig(data) {
  if (Array.isArray(data)) return stringsOf(data);
  if (!data || typeof data !== 'object') return [];
  const seats = stringsOf(data.seats);
  if (seats.length) return seats;
  return stringsOf(data.board);
}

function rolesFrom(data) {
  const out = {};
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.roles || typeof data.roles !== 'object') return out;
  for (const [k, v] of Object.entries(data.roles)) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string') out[k.trim()] = v;
  }
  return out;
}

// Roster for the board chips. LIVE_FLEET_SEATS (JSON or a path) and every fleet-roster.json
// under dirs are unioned. A short board, a three-name strip, or invalid JSON does not drop
// the other source. When no seat list exists, LIVE_NODE_MAP and fleet-nodes.json supply the names.
export function configuredRoster(env = {}, dirs = []) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  const sources = [];
  const envParsed = parseConfig(env.LIVE_FLEET_SEATS);
  if (envParsed) sources.push(envParsed);
  const nodeMaps = [];
  const envMap = parseConfig(env.LIVE_NODE_MAP);
  if (envMap && typeof envMap === 'object' && !Array.isArray(envMap)) nodeMaps.push(envMap);
  for (const dir of list) {
    const roster = parseConfig(path.join(dir, 'fleet-roster.json'));
    if (roster) sources.push(roster);
    const nodes = parseConfig(path.join(dir, 'fleet-nodes.json'));
    if (nodes && typeof nodes === 'object' && !Array.isArray(nodes)) nodeMaps.push(nodes);
  }
  const names = [];
  const seen = new Set();
  const add = (s) => {
    const name = String(s || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || RAIL_NODES.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  let fromSeats = false;
  for (const data of sources) {
    const got = namesFromSeatConfig(data);
    if (got.length) fromSeats = true;
    for (const s of got) add(s);
  }
  if (!fromSeats) {
    const extra = [];
    for (const map of nodeMaps) {
      for (const v of Object.values(map)) if (typeof v === 'string' && v.trim()) extra.push(v.trim());
    }
    extra.sort((a, b) => a.localeCompare(b));
    for (const v of extra) add(v);
  }
  const roles = {};
  for (const data of sources) Object.assign(roles, rolesFrom(data));
  if (envParsed) Object.assign(roles, rolesFrom(envParsed));
  return { names, roles };
}
