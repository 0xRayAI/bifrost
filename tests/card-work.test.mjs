// A cloud launch or reply, or a handoff, moves an open card to in_progress.
// The owner is the latest seat on that card. builder-cloud is not an owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampWorkCards } from '../worktrack.mjs';

const SEATS = ['mill', 'forge', 'eng', 'critic', 'arch1'];

function card(over = {}) {
  return {
    key: '0xrayai/clearing#39',
    repo: '0xRayAI/clearing',
    number: 39,
    stage: 'open',
    state: 'live',
    owner: 'forge',
    ...over,
  };
}

test('a cloud reply tagged with the card moves open to in_progress and does not move a later stage back', () => {
  const moved = stampWorkCards([card()], {
    seats: SEATS,
    activity: [{
      kind: 'cloud_agent',
      action: 'reply',
      tag: '0xRayAI/clearing#39',
      agent: 'bc-fba6bbae',
      seat: 'mill',
      t_ct: '2026-11-17T17:54:00Z',
    }],
  });
  assert.equal(moved[0].stage, 'in_progress');
  assert.equal(moved[0].owner, 'mill');

  const held = stampWorkCards([card({ stage: 'review' }), card({ key: '0xrayai/clearing#40', number: 40, stage: 'fix' })], {
    seats: SEATS,
    activity: [
      { kind: 'cloud_agent', action: 'reply', tag: '0xRayAI/clearing#39', agent: 'bc-1', seat: 'mill', t_ct: '2026-11-17T18:00:00Z' },
      { kind: 'cloud_agent', action: 'launch', tag: '0xRayAI/clearing#40', agent: 'bc-2', seat: 'mill', t_ct: '2026-11-17T18:00:00Z' },
    ],
  });
  assert.equal(held[0].stage, 'review');
  assert.equal(held[1].stage, 'fix');
});

test('a handoff moves an open card to in_progress and a finish does not move it backward', () => {
  const moved = stampWorkCards([card({ stage: 'open' })], {
    seats: SEATS,
    lines: [{
      type: 'packet',
      kind: 'ready',
      repo: '0xRayAI/clearing',
      number: 39,
      from: 'arch1',
      to: 'mill',
      t_ct: '2026-11-17T17:55:00Z',
    }],
  });
  assert.equal(moved[0].stage, 'in_progress');
  assert.equal(moved[0].owner, 'mill');

  const stayed = stampWorkCards([card({ stage: 'in_progress', owner: 'mill' })], {
    seats: SEATS,
    activity: [{
      kind: 'cloud_agent',
      action: 'finished',
      tag: '0xRayAI/clearing#39',
      agent: 'bc-1',
      seat: 'mill',
      t_ct: '2026-11-17T19:00:00Z',
    }],
  });
  assert.equal(stayed[0].stage, 'in_progress');
  assert.equal(stayed[0].owner, 'mill');
});

test('the latest handoff, cloud line, or receipt owns the card, and a nudge reads that owner', () => {
  const [owned] = stampWorkCards([card({ owner: 'forge', assignee: 'forge' })], {
    seats: SEATS,
    lines: [{
      type: 'packet', kind: 'ready', repo: '0xRayAI/clearing', number: 39,
      to: 'forge', t_ct: '2026-11-17T16:00:00Z',
    }],
    activity: [{
      kind: 'cloud_agent', action: 'launch', tag: '0xRayAI/clearing#39',
      agent: 'bc-1', seat: 'eng', t_ct: '2026-11-17T17:00:00Z',
    }],
    comments: [{
      kind: 'issue_comment', repo: '0xRayAI/clearing', number: 39,
      from: 'mill', body: 'receipt: minted the suit', t_ct: '2026-11-17T17:31:00Z',
    }],
  });
  assert.equal(owned.owner, 'mill');
  const nudgeSeat = owned.owner;
  assert.equal(nudgeSeat, 'mill');
});

test('builder-cloud maps to the seat that owns the bc, and a quiet card falls back to the assignee or author', () => {
  const [mapped] = stampWorkCards([card({ owner: 'builder-cloud' })], {
    seats: SEATS,
    agents: [{ bcId: 'bc-fba6bbae-f3c4-5575-b22f-96ca581d5525', seat: 'mill', card: '0xRayAI/clearing#39' }],
    activity: [{
      kind: 'cloud_agent', action: 'reply', tag: '0xRayAI/clearing#39',
      agent: 'bc-fba6bbae', seat: 'builder-cloud', t_ct: '2026-11-17T17:54:00Z',
    }],
  });
  assert.equal(mapped.owner, 'mill');
  assert.notEqual(mapped.owner, 'builder-cloud');

  const [assigned] = stampWorkCards([card({ owner: 'builder-cloud', assignee: 'mill', stage: 'review' })], { seats: SEATS });
  assert.equal(assigned.owner, 'mill');
  assert.equal(assigned.stage, 'review');

  const [authored] = stampWorkCards([card({ owner: 'github', labels: ['forge'], stage: 'open' })], { seats: SEATS });
  assert.equal(authored.owner, 'forge');
  assert.equal(authored.stage, 'open');
});
