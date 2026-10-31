// Read the collector feed off the server thread. A pass rewrites the file even when no event changed
// (generated_at and the board clock move). Parsing that file on the request thread makes /healthz sit silent.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import crypto from 'node:crypto';

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

try {
  const raw = fs.readFileSync(workerData.file, 'utf8');
  const st = fs.statSync(workerData.file);
  const f = JSON.parse(raw);
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (!f || typeof f !== 'object' || Array.isArray(f) || !Array.isArray(f.events) || f.events.length > 200000) {
    parentPort.postMessage({ ok: false, error: 'invalid', sig });
  } else {
    const h = crypto.createHash('sha1');
    for (const e of f.events) h.update(stable(e));
    h.update('\n');
    const eventHash = h.digest('hex') + ':' + f.events.length;
    const same = !!workerData.prevHash && workerData.prevHash === eventHash;
    if (same) {
      const header = {};
      for (const k of Object.keys(f)) if (k !== 'events' && k !== 'cursor') header[k] = f[k];
      parentPort.postMessage({ ok: true, same: true, eventHash, header, sig, mtimeMs: st.mtimeMs });
    } else {
      parentPort.postMessage({ ok: true, same: false, eventHash, feed: f, sig, mtimeMs: st.mtimeMs });
    }
  }
} catch {
  parentPort.postMessage({ ok: false, error: 'read' });
}
