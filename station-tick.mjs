// Weekday station reminder for the board process. The plist template is not loaded.
import { chicagoStamp } from './chicago-stamp.mjs';

export const STATION_SENTENCE = 'Run station and re-read OP-PROC';
const CORE = ['forge', 'critic', 'blinky'];

export function stationHourKey(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const stamp = chicagoStamp(d.getTime());
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):/.exec(stamp || '');
  if (!match) return null;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
  }).format(d);
  if (weekday === 'Sat' || weekday === 'Sun') return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour < 7 || hour > 17 || minute < 30) return null;
  return `${match[1]}T${match[2]}`;
}

export function stationSeats(ids) {
  const have = new Set();
  for (const id of ids || []) {
    const name = String(id || '').toLowerCase();
    if (name) have.add(name);
  }
  const seats = CORE.filter((seat) => have.has(seat));
  if (have.has('arch1')) seats.push('arch1');
  return seats;
}

export function stationLines(hour, seats, now) {
  const when = now instanceof Date ? now : new Date(now || Date.now());
  const t = Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString();
  return (seats || []).map((seat) => ({
    id: `nudge:station:${seat}:${hour}`,
    t_ct: t,
    seat,
    from: seat,
    to: seat,
    type: 'nudge',
    kind: 'station',
    repo: '',
    number: 0,
    title: STATION_SENTENCE,
    url: '',
    reason: STATION_SENTENCE,
  }));
}

export function stationDue(when, postedHour, ids) {
  const hour = stationHourKey(when);
  if (!hour || hour === postedHour) return null;
  const seats = stationSeats(ids);
  if (!seats.length) return null;
  return { hour, lines: stationLines(hour, seats, when) };
}
