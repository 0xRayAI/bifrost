import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seats = ['blinky', 'critic', 'forge', 'arch1'];

test('the fleet overlay names the seats and ships their avatars', () => {
  const text = fs.readFileSync(path.join(root, 'public', 'site-config.js'), 'utf8');
  assert.ok(!text.startsWith('/* Fleet overlay hook'), 'the kit hook is not the served overlay');
  for (const seat of seats) assert.match(text, new RegExp(`\\b${seat}\\b`));
  for (const name of [...seats, 'blaze']) {
    const file = path.join(root, 'public', 'avatars', `${name}.png`);
    assert.ok(fs.statSync(file).size > 100, name);
  }
});
