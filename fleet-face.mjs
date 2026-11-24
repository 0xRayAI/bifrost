// Fleet face for one deploy. Seats, roles, station wakes, and the page spec come from
// the roster, LIVE_SEAT_IDS, site.json, and the owner name. Nothing here names a team.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUMBING = ['builder', 'builder-cloud'];
const SEAT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ROLE_COORD = /^(chief of staff|coordinator|coord|cos)$/i;
const ROLE_OPS = /^(eng primary|operator|ops)$/i;
const ROLE_REVIEW = /^(reviewer|review)$/i;

function readJson(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

function seatId(value) {
  const id = String(value || '').trim().toLowerCase();
  return SEAT_RE.test(id) ? id : '';
}

function unique(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = seatId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return unique(value);
}

function rolesOf(data) {
  const out = {};
  const roles = data && data.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return out;
  for (const [seat, role] of Object.entries(roles)) {
    const id = seatId(seat);
    const text = String(role || '').trim().slice(0, 40);
    if (id && text) out[id] = text;
  }
  return out;
}

function envList(value) {
  return unique(String(value || '').split(','));
}

function routingSeat(routing, key) {
  const row = routing && routing.seats && routing.seats[key];
  if (!row || row.off || !row.seat) return '';
  return seatId(row.seat);
}

function roleSeat(roles, re) {
  for (const [seat, role] of Object.entries(roles)) {
    if (re.test(String(role || '').trim())) return seat;
  }
  return '';
}

function pickRole(envName, routeKey, re, seats, env, routing, roles) {
  const fromEnv = seatId(env[envName]);
  if (fromEnv && seats.has(fromEnv)) return fromEnv;
  const fromRoute = routingSeat(routing, routeKey);
  if (fromRoute && seats.has(fromRoute)) return fromRoute;
  const fromRole = roleSeat(roles, re);
  if (fromRole && seats.has(fromRole)) return fromRole;
  return '';
}

function cleanPoints(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    if (!Array.isArray(value) || value.length < 2) continue;
    const x = Number(value[0]);
    const y = Number(value[1]);
    const name = String(key || '').trim().slice(0, 64);
    if (!name || /[<>]/.test(name) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > 2000 || y < 0 || y > 2000) continue;
    out[name] = [Math.round(x), Math.round(y)];
  }
  return out;
}

function cleanColors(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    if (!Array.isArray(value) || value.length < 3) continue;
    const rgb = value.slice(0, 3).map(Number);
    const name = String(key || '').trim().slice(0, 64);
    if (!name || /[<>]/.test(name) || rgb.some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
    out[name] = rgb;
  }
  return out;
}

function cleanLabels(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const name = String(key || '').trim().slice(0, 64);
    const label = String(value || '').trim().slice(0, 40);
    if (!name || !label || /[<>]/.test(name) || /[<>]/.test(label)) continue;
    out[name] = label;
  }
  return out;
}

function cleanAliases(map, allowed) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const from = String(key || '').trim().slice(0, 64);
    const to = String(value || '').trim().slice(0, 64);
    if (!from || !to || /[<>]/.test(from) || /^https?:/i.test(from) || /^https?:/i.test(to)) continue;
    if (!allowed.has(to) && !allowed.has(to.toLowerCase())) continue;
    out[from] = allowed.has(to) ? to : to.toLowerCase();
  }
  return out;
}

function boardNames(site, extra) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const name = String(value || '').trim().slice(0, 80);
    const key = name.toLowerCase();
    if (!name || /[<>]/.test(name) || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  add(site && site.name);
  add(site && site.node);
  if (site && site.hosts && typeof site.hosts === 'object' && !Array.isArray(site.hosts)) {
    for (const value of Object.values(site.hosts)) add(value);
  }
  if (Array.isArray(extra)) for (const value of extra) add(value);
  return out;
}

function avatarIds(dir, ids) {
  if (!dir) return [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const have = new Set();
  for (const file of files) {
    const match = /^([a-z0-9][a-z0-9_-]{0,31})\.png$/i.exec(file);
    if (match) have.add(match[1].toLowerCase());
  }
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (!have.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function outsideLogins(nodeMap, outside) {
  const out = {};
  if (!nodeMap || typeof nodeMap !== 'object' || Array.isArray(nodeMap)) return out;
  for (const [login, target] of Object.entries(nodeMap)) {
    const seat = seatId(target);
    const from = String(login || '').trim().toLowerCase().slice(0, 80);
    if (!seat || !outside.has(seat) || !from || /^https?:/i.test(from)) continue;
    out[from] = seat;
  }
  return out;
}

// One deploy's seats and the public page spec. `owner` is the already-resolved owner name.
export function loadFleetFace({ env = process.env, root, owner = '' } = {}) {
  const base = root || path.dirname(fileURLToPath(import.meta.url));
  const rosterFile = env.BIFROST_ROSTER || path.join(base, 'collector', 'fleet-roster.json');
  const routingFile = path.join(env.BIFROST_ROUTING_DIR || path.join(base, 'collector', 'routing'), 'inbox-roles.json');
  const siteFile = env.LIVE_SITE_FILE || path.join(base, 'collector', 'site.json');
  const nodeFile = path.join(path.dirname(rosterFile), 'fleet-nodes.json');
  const layoutFile = env.LIVE_LAYOUT_FILE || path.join(base, 'config', 'layout.json');
  const roster = readJson(rosterFile) || {};
  const routing = readJson(routingFile) || {};
  const site = readJson(siteFile) || {};
  const nodes = readJson(nodeFile) || {};
  const layout = readJson(layoutFile) || {};
  const replaced = String(env.LIVE_SEAT_IDS || '').trim();
  const rosterSeats = stringList(roster.seats);
  const fleetSeats = replaced ? envList(env.LIVE_SEAT_IDS) : rosterSeats;
  const seatIds = unique([...PLUMBING, ...fleetSeats]);
  const fleet = new Set(fleetSeats);
  const roleText = rolesOf(roster);
  const roles = {
    coord: pickRole('LIVE_ROLE_COORD', 'coord', ROLE_COORD, fleet, env, routing, roleText),
    operator: pickRole('LIVE_ROLE_OPS', 'operator', ROLE_OPS, fleet, env, routing, roleText),
    review: pickRole('LIVE_ROLE_REVIEW', 'reviewer', ROLE_REVIEW, fleet, env, routing, roleText),
  };
  const parked = new Set(replaced ? [] : stringList(roster.parked).filter(id => fleet.has(id)));
  const outside = new Set([
    ...(replaced ? [] : stringList(roster.outside)),
    ...envList(env.LIVE_OUTSIDE_SEATS),
  ].filter(id => fleet.has(id)));
  let station;
  if (String(env.STATION_SEATS || '').trim()) station = envList(env.STATION_SEATS).filter(id => fleet.has(id));
  else if (!replaced && stringList(roster.station).length) station = stringList(roster.station).filter(id => fleet.has(id));
  else station = fleetSeats.filter(id => !parked.has(id));
  const ownerName = String(owner || '').trim().slice(0, 40);
  const allowed = new Set([...fleetSeats, ownerName, ownerName.toLowerCase(), 'GitHub', 'Railway', 'CloudAgents', 'Assistant'].filter(Boolean));
  const seats = fleetSeats.map(id => ({
    id,
    role: roleText[id] || '',
    outside: outside.has(id),
    parked: parked.has(id),
  }));
  const avatarDir = String(env.LIVE_AVATAR_DIR || '').trim();
  const avatarKeys = avatarIds(avatarDir, ownerName ? [...fleetSeats, ownerName] : fleetSeats);
  const spec = {
    name: String(env.LIVE_SITE_NAME || site.name || 'Bifrost').replace(/[<>&"']/g, '').slice(0, 60) || 'Bifrost',
    title: String(env.LIVE_SITE_TITLE || site.title || '').replace(/[<>&"']/g, '').slice(0, 80),
    owner: ownerName,
    seats,
    review: roles.review,
    aliases: cleanAliases(layout.aliases, allowed),
    outside_logins: outsideLogins(nodes, outside),
    avatars: avatarKeys,
    board_names: boardNames(site, layout.board_names),
    wordmark: layout.wordmark === true,
    foot: typeof layout.foot === 'string' ? layout.foot.replace(/[<>]/g, '').slice(0, 80) : '',
    layout: {
      sats: cleanPoints(layout.sats),
      colors: cleanColors(layout.colors),
      labels: cleanLabels(layout.labels),
    },
  };
  return { seatIds, publicSeats: fleetSeats, roles, station, spec };
}
