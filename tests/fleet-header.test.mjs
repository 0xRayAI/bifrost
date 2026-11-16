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
