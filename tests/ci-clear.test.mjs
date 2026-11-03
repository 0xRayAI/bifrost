import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idsToAck, idsToAckOnClose } from '../ci-clear.mjs';

const R = 'example-org/app';

test('a green head acks a handoff ci_fail packet', () => {
  const sha = 'e'.repeat(40);
  const line = {
    id: `handoff:example-org/app#9:ci_fail:${sha}`,
    type: 'packet', kind: 'ci_fail', repo: 'example-org/app', number: 9, sha,
  };
  const open = [{ id: 'red', t_ct: '2026-10-28T10:00:00-05:00', kind: 'ci_fail', repo: 'example-org/app', number: 9, sha }];
  assert.deepEqual(idsToAck([line], open), []);
  const green = open.concat([{ id: 'ok', t_ct: '2026-10-28T11:00:00-05:00', kind: 'ci_pass', repo: 'example-org/app', number: 9, sha }]);
  assert.deepEqual(idsToAck([line], green), [line.id]);
});

test('a merge acks the card lines and leaves the merge handoff', () => {
  const sha = 'd'.repeat(40);
  const ready = { id: `handoff:${R}#9:ready:${sha}`, type: 'packet', kind: 'ready', repo: R, number: 9, sha };
  const merge = { id: `handoff:${R}#9:merge:${sha}`, type: 'packet', kind: 'merge', repo: R, number: 9, sha };
  const open = [{ id: 'open', t_ct: '2026-10-28T10:00:00-05:00', kind: 'pr_open', repo: R, number: 9, sha }];
  assert.deepEqual(idsToAckOnClose([ready, merge], open), []);
  const merged = open.concat([{ id: 'done', t_ct: '2026-10-28T11:00:00-05:00', kind: 'merged', repo: R, number: 9, sha }]);
  assert.deepEqual(idsToAckOnClose([ready, merge], merged), [ready.id]);
  const reopened = merged.concat([{ id: 'back', t_ct: '2026-10-28T12:00:00-05:00', kind: 'reopen', repo: R, number: 9 }]);
  assert.deepEqual(idsToAckOnClose([ready], reopened), []);
});
