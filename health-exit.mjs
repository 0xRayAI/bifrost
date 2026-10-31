import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function beatLate(lastOk, now, missMs) {
  return now - lastOk > missMs;
}

function positive(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function directRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

function supervise() {
  const missMs = positive('HEALTH_EXIT_MISS_MS', 30000);
  // The first feed apply can block /healthz longer than the steady miss.
  // Killing that boot crash-loops the one replica until Railway leaves it crashed.
  const bootMs = positive('HEALTH_EXIT_BOOT_MS', 120000);
  const everyMs = positive('HEALTH_EXIT_EVERY_MS', 5000);
  const graceMs = positive('HEALTH_EXIT_GRACE_MS', 6000);
  const timeoutMs = positive('HEALTH_EXIT_TIMEOUT_MS', 4000);
  const portEnv = String(process.env.PORT ?? '').trim();
  const port = portEnv === '0' ? 0 : (Number(portEnv) || 8080);
  const childEntry = process.env.HEALTH_CHILD || path.join(here, 'server.mjs');
  const stdio = process.env.HEALTH_STDIO === 'ignore' ? 'ignore' : 'inherit';
  const child = spawn(process.execPath, [childEntry], { env: process.env, stdio });
  let mode = 'run';
  let lastOk = Date.now();
  let seenBeat = false;
  let probing = false;
  let graceTimer = null;
  let capTimer = null;

  function finish(code) {
    if (mode === 'done') return;
    mode = 'done';
    if (graceTimer) clearTimeout(graceTimer);
    if (capTimer) clearTimeout(capTimer);
    process.exit(code);
  }

  child.on('exit', (code, signal) => {
    if (mode === 'stop') finish(0);
    else if (mode === 'miss') finish(1);
    else finish(signal || code !== 0 ? 1 : 0);
  });
  child.on('error', () => finish(1));

  function probe() {
    if (mode !== 'run' || !port || probing) return;
    probing = true;
    const req = http.get({ hostname: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode === 200 || res.statusCode === 503) {
        lastOk = Date.now();
        seenBeat = true;
      }
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.on('close', () => { probing = false; });
  }

  function limitMs() {
    return seenBeat ? missMs : Math.max(missMs, bootMs);
  }

  function beginMiss() {
    if (mode !== 'run') return;
    mode = 'miss';
    try { child.kill('SIGUSR2'); } catch { /* already gone */ }
    graceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, graceMs);
    graceTimer.unref();
    capTimer = setTimeout(() => finish(1), graceMs + 1000);
    capTimer.unref();
  }

  function stopClean() {
    if (mode === 'done' || mode === 'stop') return;
    mode = 'stop';
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    capTimer = setTimeout(() => finish(0), graceMs);
    capTimer.unref();
  }

  process.on('SIGTERM', stopClean);
  process.on('SIGINT', stopClean);

  if (!port) return;
  probe();
  const timer = setInterval(() => {
    if (mode !== 'run') return;
    probe();
    if (beatLate(lastOk, Date.now(), limitMs())) beginMiss();
  }, everyMs);
  timer.unref();
}

if (directRun()) supervise();
