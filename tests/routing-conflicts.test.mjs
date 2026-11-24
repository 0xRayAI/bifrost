import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingConflicts } from '../routes.mjs';

test('one login or @handle claimed by two seats names both, in map order', () => {
  const rows = routingConflicts({
    routing: {
      cloud: { login: 'app[bot]', aliases: ['Cloud'] },
      builder: { login: 'App', aliases: ['builder'] },
    },
    extra_seats: {
      cloud: { needles: ['@app'] },
      builder: { needles: ['@app'] },
    },
  });
  assert.deepEqual(rows, [{ handle: 'app', seats: ['cloud', 'builder'] }]);
  assert.deepEqual(routingConflicts({ routing: { forge: { login: 'forge0x[bot]', aliases: ['forge'] } } }), []);
});
