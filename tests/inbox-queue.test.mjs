import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backlogOf, keepStation, lineRank, liveLine, markShed, nudgeTargets, overWip, queueView, rSeat } from '../inbox-queue.mjs';

const line = (id, extra) => ({ id, t_ct: extra.t || '2026-10-30T10:00:00Z', type: 'issue_comment', repo: '0xRayAI/xray', number: 1, title: id, url: '', reason: 'ask', ...extra });

test('ready handoffs and a hotfix are the head, and nudges stay back', () => {
  const ready = line('h', { type: 'packet', kind: 'ready', title: 'handoff ready', t: '2026-10-30T12:00:00Z' });
  const hot = line('f', { type: 'issue_open', title: 'hotfix: pack the module', t: '2026-10-30T11:00:00Z' });
  const nudge = line('n', { type: 'nudge', kind: 'line', title: 'old card', t: '2026-10-30T09:00:00Z' });
  const station = line('s', { type: 'nudge', kind: 'station', title: 'Run station and re-read OP-PROC', t: '2026-10-30T08:00:00Z' });
  const comment = line('c', { title: 'soft follow-up', t: '2026-10-30T07:00:00Z' });
  assert.equal(lineRank(ready), 0);
  assert.equal(lineRank(hot), 1);
  assert.equal(lineRank(comment), 1);
  assert.equal(lineRank(nudge), 3);
  assert.equal(lineRank(station), 4);
  assert.deepEqual(queueView([nudge, station, comment, hot, ready]).map((row) => row.id), ['h', 'f', 'c']);
  assert.deepEqual(backlogOf([nudge, station, comment, hot, ready]).map((row) => row.id), ['n', 's']);
});

test('with no ready handoff, newest comments show, then one oldest nudge, then one station line', () => {
  const older = line('a', { t: '2026-10-30T01:00:00Z' });
  const newer = line('b', { t: '2026-10-30T02:00:00Z' });
  assert.deepEqual(queueView([newer, older]).map((row) => row.id), ['b', 'a']);
  const n1 = line('n1', { type: 'nudge', t: '2026-10-30T03:00:00Z' });
  const n2 = line('n2', { type: 'nudge', t: '2026-10-30T04:00:00Z' });
  assert.deepEqual(queueView([n2, n1]).map((row) => row.id), ['n1']);
  const s1 = line('s1', { type: 'nudge', kind: 'station', t: '2026-10-30T05:00:00Z' });
  const s2 = line('s2', { type: 'nudge', kind: 'station', t: '2026-10-30T06:00:00Z' });
  assert.deepEqual(queueView([s1, s2]).map((row) => row.id), ['s2']);
});

test('a comment titled P1 stays back when the packet does not name this seat', () => {
  const ready = line('h', { type: 'packet', kind: 'ready', title: 'handoff ready', t: '2026-10-30T12:00:00Z' });
  const noise = line('p', { title: 'P1: wake path', number: 768, t: '2026-10-30T11:00:00Z' });
  const cards = { 700: { title: 'unstick the seat', packet: { raci: 'R=Arch1 A=Blaze', goal: 'P1 unstick' } } };
  const real = line('tip', { title: 'htafolla comment · xray issue #700', number: 700, t: '2026-10-30T09:00:00Z' });
  const cardOf = (row) => cards[row.number] || null;
  const opts = { seat: 'arch1', cardOf };
  const head = queueView([noise, real, ready], opts).map((row) => row.id);
  assert.equal(rSeat('R=Arch1 A=Blaze'), 'arch1');
  assert.equal(head.includes('h'), true);
  assert.equal(head.includes('tip'), true);
  assert.equal(head.includes('p'), false);
  const open = [ready, line('old', { type: 'nudge', t: '2026-10-30T02:00:00Z' })];
  assert.equal(markShed(noise, open, opts).shed, true);
  assert.equal(markShed(real, open, opts).shed, undefined);
  assert.deepEqual(nudgeTargets([ready, ...open.slice(1), noise, real], opts).map((row) => row.id), ['h', 'tip']);
});

test('hotfix on the packet is read before an older P0, and P0 before P1', () => {
  const cards = {
    1: { title: 'pack the module', packet: { raci: 'R=Arch1 A=Blaze', goal: 'hotfix: pack the module' } },
    2: { title: 'first', packet: { raci: 'R=Arch1 A=Blaze', goal: 'P0 first' } },
    3: { title: 'second', packet: { raci: 'R=Arch1 A=Blaze', goal: 'P1 second' } },
  };
  const hot = line('hot', { number: 1, title: 'htafolla comment', t: '2026-10-30T12:00:00Z' });
  const p0 = line('p0', { number: 2, title: 'htafolla comment', t: '2026-10-30T08:00:00Z' });
  const p1 = line('p1', { number: 3, title: 'htafolla comment', t: '2026-10-30T01:00:00Z' });
  const cardOf = (row) => cards[row.number] || null;
  assert.deepEqual(queueView([p1, p0, hot], { seat: 'arch1', cardOf }).map((row) => row.id), ['hot', 'p0', 'p1']);
});

test('open work with no R packet stays on the head when that head would otherwise be empty', () => {
  const noise = line('p', { title: 'still open', number: 384, t: '2026-10-30T11:00:00Z' });
  const opts = { seat: 'arch1', cardOf: () => null };
  assert.deepEqual(queueView([noise], opts).map((row) => row.id), ['p']);
  assert.equal(markShed(noise, [noise], opts).shed, undefined);
  assert.deepEqual(nudgeTargets([noise], opts).map((row) => row.id), ['p']);
  const ready = line('h', { type: 'packet', kind: 'ready', title: 'handoff ready', t: '2026-10-30T12:00:00Z' });
  const head = queueView([noise, ready], opts).map((row) => row.id);
  assert.equal(head.includes('h'), true);
  assert.equal(head.includes('p'), false);
});

test('a plain card whose packet names this seat stays on the head and is laddered', () => {
  const cards = { 12: { title: 'do the work', packet: { raci: 'R=Arch1 A=Blaze', goal: 'do the work' } } };
  const plain = line('plain', { number: 12, title: 'htafolla comment', t: '2026-10-30T09:00:00Z' });
  const nudge = line('old', { type: 'nudge', t: '2026-10-30T02:00:00Z' });
  const opts = { seat: 'arch1', cardOf: (row) => cards[row.number] || null };
  assert.deepEqual(queueView([plain, nudge], opts).map((row) => row.id), ['plain']);
  assert.deepEqual(nudgeTargets([plain, nudge], opts).map((row) => row.id), ['plain']);
  assert.equal(markShed(plain, [plain, nudge], opts).shed, undefined);
});

test('a P1 line joins the head and a station nudge waits for an empty inbox', () => {
  const p1 = line('p', { title: 'P1: wake path', t: '2026-10-30T01:00:00Z' });
  const noise = line('n', { type: 'nudge', t: '2026-10-30T02:00:00Z' });
  assert.deepEqual(queueView([noise, p1]).map((row) => row.id), ['p']);
  assert.equal(keepStation([]), true);
  assert.equal(keepStation([p1]), false);
  assert.equal(keepStation([noise]), false);
});

test('a new comment stays in the head and older comments past the cap stay stored', () => {
  const ready = line('h', { type: 'packet', kind: 'ready', title: 'handoff ready', t: '2026-10-30T01:00:00Z' });
  const comments = Array.from({ length: 9 }, (_, i) => line('c' + i, {
    title: 'htafolla comment · xray issue #' + (700 + i),
    number: 700 + i,
    t: '2026-10-30T' + String(10 + i).padStart(2, '0') + ':00:00Z',
  }));
  const nudge = line('n', { type: 'nudge', t: '2026-10-30T20:00:00Z' });
  const head = queueView([ready, nudge, ...comments], { wip: 8 }).map((row) => row.id);
  assert.equal(head[0], 'h');
  assert.equal(head.includes('c8'), true);
  assert.equal(head.includes('c0'), false);
  assert.equal(head.includes('n'), false);
  assert.equal(backlogOf([ready, nudge, ...comments], { wip: 8 }).some((row) => row.id === 'c0'), true);
});

test('a comment on a P1 card stays in the head even when the cap is full', () => {
  const comments = Array.from({ length: 8 }, (_, i) => line('c' + i, {
    title: 'comment',
    number: 800 + i,
    t: '2026-10-30T' + String(10 + i).padStart(2, '0') + ':00:00Z',
  }));
  const tip = line('tip', { title: 'htafolla comment · xray issue #768', number: 768, t: '2026-10-30T08:00:00Z' });
  const titles = (row) => row.number === 768 ? 'P1: Arch1 unstick' : '';
  const head = queueView([tip, ...comments], { wip: 8, titleOf: titles }).map((row) => row.id);
  assert.equal(head.includes('tip'), true);
  assert.equal(queueView([tip, ...comments], { wip: 0, titleOf: titles }).map((row) => row.id).includes('tip'), true);
  assert.deepEqual(queueView([tip, ...comments], { nudge: true, titleOf: titles }).map((row) => row.id), ['tip']);
});

test('a new issue open leads an older parent tip, and a passed parent stays shed', () => {
  const cards = {
    768: { title: 'P1: unstick', packet: { raci: 'R=Arch1 A=Blaze', goal: 'P1 unstick' } },
    809: { title: 'P1: wake token', packet: { raci: 'R=Arch1 A=Blaze', goal: 'P1 wake' } },
    12: { title: 'do the work', packet: { raci: 'R=Arch1 A=Blaze', goal: 'do the work' } },
  };
  const cardOf = (row) => cards[row.number] || null;
  const tip = line('tip', { number: 768, title: 'old parent tip', t: '2026-10-30T08:00:00Z' });
  const opened = line('open', { type: 'issue_open', number: 809, title: 'P1: wake token', t: '2026-11-02T11:00:00Z' });
  const ready = line('h', { type: 'packet', kind: 'ready', title: 'handoff ready', t: '2026-11-02T10:00:00Z' });
  assert.equal(liveLine([tip, opened], { seat: 'arch1', cardOf })[0].id, 'open');
  assert.equal(liveLine([tip, opened, ready], { seat: 'arch1', cardOf })[0].id, 'h');
  const later = line('later', { number: 768, title: 'newer parent tip', t: '2026-11-02T12:00:00Z' });
  const other = line('other', { number: 12, title: 'other card', t: '2026-10-30T09:00:00Z' });
  const shedCards = new Set(['0xrayai/xray#768']);
  assert.equal(liveLine([later, tip, other], { seat: 'arch1', cardOf, shedCards })[0].id, 'other');
});

test('over WIP a new non-P0 comment is stored off the head and is not laddered', () => {
  const ready = line('h', { type: 'packet', kind: 'ready', title: 'handoff ready', t: '2026-10-30T01:00:00Z' });
  const noise = line('old', { type: 'nudge', t: '2026-10-30T02:00:00Z' });
  const open = [ready, noise];
  assert.equal(overWip(open), true);
  const fresh = line('new', { title: 'htafolla comment · xray issue #800', number: 800, t: '2026-10-30T12:00:00Z' });
  const shed = markShed(fresh, open);
  assert.equal(shed.shed, true);
  const p1 = line('p1', { title: 'comment', number: 768, t: '2026-10-30T12:01:00Z' });
  const kept = markShed(p1, open, { titleOf: (row) => row.number === 768 ? 'P1: unstick' : '' });
  assert.equal(kept.shed, undefined);
  const lines = [ready, noise, shed];
  assert.equal(queueView(lines).some((row) => row.id === 'new'), false);
  assert.deepEqual(nudgeTargets(lines).map((row) => row.id), ['h']);
  assert.deepEqual(nudgeTargets([fresh]).map((row) => row.id), ['new']);
});

test('a ready handoff on an issue does not pin the live line', () => {
  const zombie = line('z', { type: 'packet', kind: 'ready', title: 'handoff ready', number: 389, t: '2026-10-01T00:00:00Z' });
  const merge = line('m', { type: 'packet', kind: 'merge', title: 'handoff merge', number: 804, t: '2026-11-01T12:00:00Z' });
  const cards = { 389: { kind: 'issue', title: 'ponder' }, 804: { kind: 'pr', title: 'note' } };
  const cardOf = (row) => cards[row.number] || null;
  assert.deepEqual(liveLine([zombie, merge], { cardOf }).map((row) => row.id), ['m']);
});

test('a newer merge tip on the same pull is the head', () => {
  const cards = { 811: { kind: 'pr', title: 'queue' }, 10: { kind: 'pr', title: 'ready' } };
  const cardOf = (row) => cards[row.number] || null;
  const oldTip = line('old', { type: 'packet', kind: 'merge', number: 811, t: '2026-11-02T12:31:00Z' });
  const newTip = line('new', { type: 'packet', kind: 'merge', number: 811, t: '2026-11-02T13:40:00Z' });
  assert.equal(liveLine([oldTip, newTip], { cardOf })[0].id, 'new');
  const ready = line('h', { type: 'packet', kind: 'ready', number: 10, t: '2026-11-02T10:00:00Z' });
  const other = line('m', { type: 'packet', kind: 'merge', number: 11, t: '2026-11-02T13:00:00Z' });
  const both = { ...cards, 11: { kind: 'pr', title: 'other' } };
  assert.equal(liveLine([other, ready], { cardOf: (row) => both[row.number] })[0].id, 'h');
});

test('the live line is the first line of the queue', () => {
  const older = line('a', { title: 'P0: first', t: '2026-10-30T01:00:00Z' });
  const newer = line('b', { title: 'P1: second', t: '2026-10-30T02:00:00Z' });
  assert.deepEqual(queueView([newer, older]).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(liveLine([newer, older]).map((row) => row.id), ['a']);
});
