// The header fleet line packs against the mark. It does not shove itself to the right edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'), 'utf8');

test('header .fleet uses margin-left 0', () => {
  const rule = html.match(/\.fleet \{[^}]+\}/);
  assert.ok(rule, 'missing .fleet rule');
  assert.match(rule[0], /margin-left:\s*0/);
  assert.doesNotMatch(rule[0], /margin-left:\s*auto/);
});

test('a narrow header gives .fleet its own row so the line can wrap', () => {
  const query = html.match(/@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.fleet \{([^}]+)\}/);
  assert.ok(query, 'missing 720px .fleet rule');
  assert.match(query[1], /flex:\s*1\s+1\s+100%/);
  assert.match(query[1], /min-width:\s*0/);
  assert.match(query[1], /white-space:\s*normal/);
});
