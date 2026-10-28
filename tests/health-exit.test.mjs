import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beatLate } from '../health-exit.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supervisor = path.join(appDir, 'health-exit.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function writeStub(name, body) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, body);
  return file;
}

function runSupervisor(port, child, extra = {}) {
  return spawn(process.execPath, [supervisor], {
    env: {
      ...process.env,
      PORT: String(port),
      HEALTH_CHILD: child,
      HEALTH_STDIO: 'ignore',
      HEALTH_EXIT_MISS_MS: '400',
      HEALTH_EXIT_EVERY_MS: '40',
      HEALTH_EXIT_GRACE_MS: '250',
      HEALTH_EXIT_TIMEOUT_MS: '100',
      ...extra,
    },
    stdio: 'ignore',
  });
}

function waitExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('supervisor stayed up')), 8000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

test('a fresh beat is not late and a missed beat is', () => {
  assert.equal(beatLate(1000, 1200, 300), false);
  assert.equal(beatLate(1000, 1301, 300), true);
});

test('a live /healthz stays up until a stop exits 0', async () => {
  const port = await freePort();
  const stub = writeStub('bifrost-health-live.mjs', `
    import http from 'node:http';
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 404);
      res.end('ok');
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const child = runSupervisor(port, stub);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  assert.equal(await waitExit(child), 0);
  fs.unlinkSync(stub);
});

test('a quiet /healthz exits the supervisor non-zero', async () => {
  const port = await freePort();
  const stub = writeStub('bifrost-health-hang.mjs', `
    import http from 'node:http';
    const server = http.createServer(() => {});
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => {});
    process.on('SIGUSR2', () => {});
  `);
  const child = runSupervisor(port, stub);
  assert.equal(await waitExit(child), 1);
  await new Promise((resolve, reject) => {
    const probe = net.connect({ host: '127.0.0.1', port }, () => {
      probe.end();
      reject(new Error('hung child still accepts'));
    });
    probe.on('error', () => resolve());
  });
  fs.unlinkSync(stub);
});

test('a live loop exits on SIGUSR2 and the supervisor exits 1', async () => {
  const port = await freePort();
  const mark = path.join(os.tmpdir(), 'bifrost-health-usr2-' + process.pid);
  fs.rmSync(mark, { force: true });
  const stub = writeStub('bifrost-health-usr2.mjs', `
    import http from 'node:http';
    import fs from 'node:fs';
    const server = http.createServer(() => {});
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGUSR2', () => { fs.writeFileSync(process.env.MARK, '1'); process.exit(1); });
  `);
  const child = runSupervisor(port, stub, { MARK: mark });
  assert.equal(await waitExit(child), 1);
  assert.equal(fs.readFileSync(mark, 'utf8'), '1');
  fs.unlinkSync(stub);
  fs.rmSync(mark, { force: true });
});

test('railway keeps one replica and the supervisor does not kill its own pid', () => {
  const railway = JSON.parse(fs.readFileSync(path.join(appDir, 'railway.json'), 'utf8'));
  assert.equal(railway.deploy.restartPolicyType, 'ON_FAILURE');
  assert.equal(railway.deploy.numReplicas, 1);
  assert.equal(railway.deploy.healthcheckPath, '/healthz');
  assert.equal(railway.deploy.startCommand, '/app/docker-entrypoint.sh');
  const exitSrc = fs.readFileSync(supervisor, 'utf8');
  const serverSrc = fs.readFileSync(path.join(appDir, 'server.mjs'), 'utf8');
  const entry = fs.readFileSync(path.join(appDir, 'docker-entrypoint.sh'), 'utf8');
  const docker = fs.readFileSync(path.join(appDir, 'Dockerfile'), 'utf8');
  assert.equal(exitSrc.includes('worker_threads'), false);
  assert.equal(exitSrc.includes('process.kill(process.pid'), false);
  assert.equal(exitSrc.includes("child.kill('SIGUSR2')"), true);
  assert.equal(exitSrc.includes('collector'), false);
  assert.equal(serverSrc.includes("process.on('SIGUSR2', () => process.exit(1));"), true);
  assert.equal(entry.includes('node health-exit.mjs'), true);
  assert.equal(entry.includes('HEALTH_EXIT'), true);
  assert.equal(docker.includes('health-exit.mjs'), true);
  assert.equal(docker.includes('ENTRYPOINT ["/app/docker-entrypoint.sh"]'), true);
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.0');
  assert.equal(pkg.private, true);
});
