// A cloud launch or reply, or a handoff, moves an open card to in_progress.
// The owner is the latest seat on that card. builder-cloud is not an owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityKeepsNudge, mentionedCard, stampWorkCards } from '../worktrack.mjs';
import { project } from '../archive.mjs';

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

const ROLES = { handoffs: { reviewer: 'critic' }, seats: { operator: { seat: 'forge' }, coord: { seat: 'blinky' } } };

test('a tied seat activity beats the live card and does not move the owner', () => {
  const now = Date.parse('2026-11-25T18:00:00Z');
  const [beat] = stampWorkCards([card({ owner: 'arch1', beats: [], last_beat_t: now - 7200000, stall: true })], {
    seats: SEATS,
    now,
    roles: ROLES,
    activity: [{
      id: 'a1', kind: 'turn', action: 'start', seat: 'arch1',
      tag: 'merge 0xRayAI/clearing#39', t_ct: '2026-11-25T17:30:00Z',
    }],
  });
  assert.equal(beat.owner, 'arch1');
  assert.equal(beat.stage, 'open');
  assert.equal(beat.beats.length, 1);
  assert.equal(beat.beats[0].id, 'act:a1');
  assert.equal(beat.beats[0].what, 'activity');
  assert.equal(beat.beats[0].via, 'activity');
  assert.equal(beat.beats[0].seat, 'arch1');
  assert.match(beat.beats[0].note, /merge/i);
  assert.equal(beat.stall, false);
  assert.equal(beat.activity_seat, 'arch1');

  const again = stampWorkCards([beat], {
    seats: SEATS, now, roles: ROLES,
    activity: [{ id: 'a1', kind: 'turn', action: 'start', seat: 'arch1', tag: '0xRayAI/clearing#39', t: now }],
  });
  assert.equal(again[0].beats.length, 1);
});

test('an unrelated seat, a closed card, and an ambiguous bare number stay seat-only', () => {
  const now = Date.parse('2026-11-25T18:00:00Z');
  const live = card({ owner: 'arch1', beats: [] });
  const other = card({ key: '0xrayai/xray#39', repo: '0xRayAI/xray', number: 39, owner: 'mill', state: 'live', beats: [] });
  const closed = card({ key: '0xrayai/bifrost#39', repo: '0xRayAI/bifrost', number: 39, owner: 'arch1', state: 'closed', beats: [] });
  const [untied] = stampWorkCards([live], {
    seats: SEATS, now, roles: ROLES, board: [live],
    activity: [{ id: 'b1', kind: 'turn', action: 'tick', seat: 'mill', tag: '0xRayAI/clearing#39', t_ct: '2026-11-25T17:40:00Z' }],
  });
  assert.deepEqual(untied.beats, []);
  const [shut] = stampWorkCards([closed], {
    seats: SEATS, now, roles: ROLES,
    activity: [{ id: 'b2', kind: 'turn', action: 'tick', seat: 'arch1', tag: '0xRayAI/bifrost#39', t_ct: '2026-11-25T17:40:00Z' }],
  });
  assert.deepEqual(shut.beats, []);
  const ambiguous = stampWorkCards([live, other], {
    seats: SEATS, now, roles: ROLES, board: [live, other, closed],
    activity: [{ id: 'b3', kind: 'turn', action: 'tick', seat: 'arch1', tag: '#39', t_ct: '2026-11-25T17:45:00Z' }],
  });
  assert.deepEqual(ambiguous[0].beats, []);
  assert.deepEqual(ambiguous[1].beats, []);
});

test('a handoff to the reviewer keeps the working seat as owner', () => {
  const [kept] = stampWorkCards([card({ owner: 'mill', stage: 'open' })], {
    seats: SEATS,
    roles: ROLES,
    lines: [{ type: 'packet', kind: 'ready', from: 'mill', to: 'critic', seat: 'critic', repo: '0xRayAI/clearing', number: 39, t_ct: '2026-11-25T17:00:00Z' }],
  });
  assert.equal(kept.owner, 'mill');
});

test('a prompt note names the card it belongs on', () => {
  assert.deepEqual(mentionedCard('see 0xRayAI/xray#1263'), { repo: '0xRayAI/xray', number: 1263 });
  assert.equal(mentionedCard('no card here'), null);
  const kept = project('activity', { id: '1', seq: 1, seat: 'arch1', note: '0xRayAI/xray#1263', token: 'secret' });
  assert.equal(kept.note, '0xRayAI/xray#1263');
  assert.equal(kept.token, undefined);
});

test('an activity beat from another seat keeps that nudge open', () => {
  const cardRow = { last_beat_t: 200, activity_at: 200, activity_seat: 'mill' };
  assert.equal(activityKeepsNudge(cardRow, { beat_t: 100, seat: 'arch1' }), true);
  assert.equal(activityKeepsNudge(cardRow, { beat_t: 100, seat: 'mill' }), false);
  assert.equal(activityKeepsNudge({ last_beat_t: 300, activity_at: 200, activity_seat: 'mill' }, { beat_t: 100, seat: 'arch1' }), false);
});
