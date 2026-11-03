// Fleet mode is the board flag a wake reads first. The schedule lands in phase 3.
// P1 and a scheduled run pass in every mode. A seat wake does not write this flag.

export const FLEET_MODES = ['full', 'lights-on', 'dark'];

export function normalizeFleetMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return FLEET_MODES.includes(mode) ? mode : '';
}

export function defaultFleetMode() {
  return { mode: 'lights-on', by: 'default', at: '' };
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
