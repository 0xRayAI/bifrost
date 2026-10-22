// start_after writer. The stored form keeps a numeric offset. The offset is America/Chicago
// at the instant being written. A stamp already on disk is not rewritten.
export const START_AFTER_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2}$/;

/** Chicago calendar day for a ms instant or a parseable stamp. Empty when the instant is not a time. */
export function chicagoDay(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  const stamp = chicagoStamp(ms);
  return stamp ? stamp.slice(0, 10) : '';
}

export function chicagoStamp(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const abs = Math.abs(off);
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** America/Chicago wall time with milliseconds, same shape as the server ctStamp. */
export function clockStamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const base = chicagoStamp(d.getTime());
  if (!base || base.includes('.')) return base;
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return base.replace(/([+-]\d{2}:\d{2})$/, '.' + ms + '$1');
}

function offsetOf(iso) {
  const match = /([+-]\d{2}:\d{2})$/.exec(String(iso || ''));
  return match ? match[1] : '';
}

/** New stamp. Same offset keeps the caller's text. A wrong offset is rewritten for that instant. */
export function writeStartAfter(iso) {
  const text = typeof iso === 'string' ? iso.trim() : '';
  if (!START_AFTER_RE.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const stamped = chicagoStamp(at);
  if (!stamped) return null;
  if (offsetOf(text) === offsetOf(stamped)) return text;
  return stamped;
}

/** Load path. Existing stamps stay byte for byte, including a fixed offset from before this writer. */
export function keepStoredStartAfter(iso) {
  return typeof iso === 'string' ? iso : '';
}
