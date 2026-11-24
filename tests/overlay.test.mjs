import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the page overlay does not name a team, and portraits are not in the public tree', () => {
  const text = fs.readFileSync(path.join(root, 'public', 'site-config.js'), 'utf8');
  assert.match(text, /window\.FLEET_SPEC/);
  assert.doesNotMatch(text, /\b(blinky|critic|forge|arch1|herald|nibbler|blaze)\b/i);
  const shipped = fs.readdirSync(path.join(root, 'public', 'avatars')).filter(name => name.endsWith('.png'));
  assert.deepEqual(shipped, []);
  const kept = fs.readdirSync(path.join(root, 'config', 'avatars')).filter(name => name.endsWith('.png')).sort();
  assert.deepEqual(kept, ['arch1.png', 'blaze.png', 'blinky.png', 'critic.png', 'forge.png', 'herald.png', 'near.png']);
});
