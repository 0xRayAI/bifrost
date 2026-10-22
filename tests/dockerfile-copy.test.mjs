// Every local module server.mjs imports must be named on a Dockerfile COPY line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function localImports(file, seen = new Set()) {
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    let rel = m[1];
    if (!/\.(mjs|js|cjs)$/.test(rel)) rel += '.mjs';
    const full = path.resolve(dir, rel);
    if (seen.has(full)) continue;
    seen.add(full);
    if (fs.existsSync(full)) localImports(full, seen);
  }
  return seen;
}

test('Dockerfile pins the patched Node 24 LTS', () => {
  const docker = fs.readFileSync(path.join(APP, 'Dockerfile'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.match(docker, /^FROM node:24\.22\.1-bookworm-slim\s*$/m);
  assert.equal(pkg.engines.node, '>=24.22.1');
});

test('Dockerfile COPY names every local module server.mjs imports', () => {
  const docker = fs.readFileSync(path.join(APP, 'Dockerfile'), 'utf8');
  const copy = docker.split('\n').filter(line => /^\s*COPY\s/.test(line)).join('\n');
  const imported = [...localImports(path.join(APP, 'server.mjs'))];
  assert.ok(imported.length >= 2, 'server imports local modules');
  for (const file of imported) {
    const base = path.basename(file);
    assert.match(copy, new RegExp(`\\b${base.replace('.', '\\.')}\\b`), base);
  }
});
