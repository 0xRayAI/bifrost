// Fleet mode is the board flag a wake reads first.
// P1 and a scheduled run pass in every mode. A seat wake does not write this flag.
// The Chicago schedule sets the mode. A manual switch holds until the next boundary.

export const FLEET_MODES = ['full', 'lights-on', 'dark'];
export const FLEET_ROUTES = ['arch1', 'cursor-cloud', 'grok-cli', 'none'];

export function normalizeFleetMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return FLEET_MODES.includes(mode) ? mode : '';
}

export function normalizeFleetRoute(value) {
  const route = String(value || '').trim().toLowerCase();
  return FLEET_ROUTES.includes(route) ? route : '';
}

export function defaultFleetMode() {
  return { mode: 'lights-on', route: 'none', by: 'default', at: '', source: 'default', boundary: '' };
}

function cardText(card) {
  if (!card || typeof card !== 'object') return '';
  const packet = card.packet || {};
  const labels = Array.isArray(card.labels) ? card.labels.join(' ') : '';
  return [card.title, packet.goal, packet.acceptance, labels].filter(Boolean).join('\n');
}

export function priorityWake(card) {
  const text = cardText(card);
  return /\bP[01]\b/.test(text) || /^hotfix:/im.test(text);
}

export function lightsOnCard(card) {
  return /\blights-on\b/i.test(cardText(card));
}

/** scheduled and P1 pass in every mode. lights-on also allows a lights-on card. dark allows nothing else. */
export function wakeAllowed(mode, card, opts = {}) {
  if (opts && opts.scheduled) return true;
  if (priorityWake(card)) return true;
  const current = normalizeFleetMode(mode) || 'lights-on';
  if (current === 'full') return true;
  if (current === 'lights-on') return lightsOnCard(card);
  return false;
}

function chicagoParts(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return { weekday: parts.weekday, mins: Number(parts.hour) * 60 + Number(parts.minute) };
}

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function officeOpen(now) {
  const { weekday, mins } = chicagoParts(now);
  return WEEKDAYS.has(weekday) && mins >= 7 * 60 + 30 && mins < 15 * 60 + 30;
}

/** Weekdays 7:30–15:30 America/Chicago are full. Every other minute is lights-on. Dark is manual only. */
export function scheduledFleetMode(now) {
  return officeOpen(now) ? 'full' : 'lights-on';
}

export function scheduleBoundary(now) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  return day + (officeOpen(now) ? ' full' : ' lights-on');
}

/** A manual switch holds through the current boundary. An env pin is not moved by the clock. */
export function applySchedule(state, now) {
  const base = state && typeof state === 'object' ? state : defaultFleetMode();
  if (base.source === 'env') return base;
  const boundary = scheduleBoundary(now);
  if (base.source === 'manual' && base.boundary === boundary) return base;
  const mode = scheduledFleetMode(now);
  if (base.mode === mode && base.source === 'schedule' && base.boundary === boundary) return base;
  return {
    mode,
    route: normalizeFleetRoute(base.route) || 'none',
    by: 'schedule',
    at: new Date(now).toISOString(),
    source: 'schedule',
    boundary,
  };
}

/** Cursor cloud launches only when the board route allows it. An unread board allows it for a P1 card only. */
export function cursorLaunchAllowed({ route, readable, p1 }) {
  if (readable === false) return p1 === true;
  return normalizeFleetRoute(route) === 'cursor-cloud';
}
