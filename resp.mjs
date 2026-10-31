// Minimal Redis client. The live image has no npm dependencies. The URL and password are never logged.
import net from 'node:net';
import tls from 'node:tls';

export function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const body = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    parts.push(Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

export function parseRedisUrl(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('redis url'); }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') throw new Error('redis url');
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;
  return {
    tls: url.protocol === 'rediss:',
    host: url.hostname,
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    db: Number.isInteger(db) && db > 0 ? db : 0,
  };
}

// Returns { next, value } or null when the buffer does not hold a full reply yet.
export function readReply(buf, i = 0) {
  if (i >= buf.length) return null;
  const type = buf[i];
  if (type === 43 || type === 45 || type === 58) {
    const end = buf.indexOf(10, i);
    if (end < 0) return null;
    const lineEnd = end > i && buf[end - 1] === 13 ? end - 1 : end;
    const line = buf.toString('utf8', i + 1, lineEnd);
    const value = type === 45 ? { err: line } : type === 58 ? { int: Number(line) } : { ok: line };
    return { next: end + 1, value };
  }
  if (type === 36) {
    const end = buf.indexOf(10, i);
    if (end < 0) return null;
    const lineEnd = end > i && buf[end - 1] === 13 ? end - 1 : end;
    const n = Number(buf.toString('utf8', i + 1, lineEnd));
    if (!Number.isInteger(n)) return null;
    if (n < 0) return { next: end + 1, value: { bulk: null } };
    const start = end + 1;
    if (buf.length < start + n + 2) return null;
    return { next: start + n + 2, value: { bulk: buf.toString('utf8', start, start + n) } };
  }
  if (type === 42) {
    const end = buf.indexOf(10, i);
    if (end < 0) return null;
    const lineEnd = end > i && buf[end - 1] === 13 ? end - 1 : end;
    const n = Number(buf.toString('utf8', i + 1, lineEnd));
    if (!Number.isInteger(n)) return null;
    if (n < 0) return { next: end + 1, value: { arr: null } };
    let at = end + 1;
    const arr = [];
    for (let k = 0; k < n; k += 1) {
      const child = readReply(buf, at);
      if (!child) return null;
      arr.push(child.value);
      at = child.next;
    }
    return { next: at, value: { arr } };
  }
  return { next: i + 1, value: { err: 'proto' } };
}

function normalize(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.err != null) return { __err: true };
  if (value.int != null) return value.int;
  if (value.ok != null) return value.ok;
  if ('bulk' in value) return value.bulk;
  if ('arr' in value) return value.arr == null ? null : value.arr.map(normalize);
  return null;
}

function wrap(socket) {
  const waiters = [];
  let buf = Buffer.alloc(0);
  let dead = null;
  const fail = (err) => {
    if (dead) return;
    dead = err;
    while (waiters.length) waiters.shift().reject(err);
  };
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const parsed = readReply(buf, 0);
      if (!parsed) break;
      buf = buf.subarray(parsed.next);
      const waiter = waiters.shift();
      if (!waiter) continue;
      const value = normalize(parsed.value);
      if (value && value.__err) waiter.reject(new Error('redis'));
      else waiter.resolve(value);
    }
  });
  socket.on('error', () => fail(new Error('redis')));
  socket.on('close', () => fail(new Error('redis closed')));
  return {
    command(args) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('redis timeout'));
          try { socket.destroy(); } catch { /* closed */ }
        }, 15000);
        waiters.push({
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        socket.write(encodeCommand(args));
      });
    },
    close() {
      try { socket.end(); } catch { /* closed */ }
    },
  };
}

async function handshake(client, cfg) {
  if (cfg.password) {
    if (cfg.username) await client.command(['AUTH', cfg.username, cfg.password]);
    else await client.command(['AUTH', cfg.password]);
  }
  if (cfg.db) await client.command(['SELECT', String(cfg.db)]);
}

export function connectRedis(raw) {
  let cfg;
  try { cfg = parseRedisUrl(raw); }
  catch { return Promise.reject(new Error('redis url')); }
  if (!cfg.host || !Number.isInteger(cfg.port) || cfg.port <= 0) return Promise.reject(new Error('redis url'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = cfg.tls
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* closed */ }
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('redis timeout')), 3000);
    socket.once('error', () => fail(new Error('redis connect')));
    socket.once(cfg.tls ? 'secureConnect' : 'connect', () => {
      if (settled) return;
      clearTimeout(timer);
      const client = wrap(socket);
      handshake(client, cfg).then(() => {
        if (settled) return;
        settled = true;
        resolve(client);
      }, () => fail(new Error('redis auth')));
    });
  });
}
