import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backlogOf, keepStation, lineRank, liveLine, markShed, nudgeTargets, overWip, queueView, rSeat, settleShed, shedTtlMs } from '../inbox-queue.mjs';

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
  const older = line('a', { number: 1, t: '2026-10-30T01:00:00Z' });
  const newer = line('b', { number: 2, t: '2026-10-30T02:00:00Z' });
  assert.deepEqual(queueView([newer, older]).map((row) => row.id), ['b', 'a']);
  const n1 = line('n1', { type: 'nudge', t: '2026-10-30T03:00:00Z' });
  const n2 = line('n2', { type: 'nudge', t: '2026-10-30T04:00:00Z' });
  assert.deepEqual(queueView([n2, n1]).map((row) => row.id), ['n1']);
  const s1 = line('s1', { type: 'nudge', kind: 'station', t: '2026-10-30T05:00:00Z' });
  const s2 = line('s2', { type: 'nudge', kind: 'station', t: '2026-10-30T06:00:00Z' });
  assert.deepEqual(queueView([s1, s2]).map((row) => row.id), ['s2']);
});

test('the newer tip on the same card is the head', () => {
  const cards = {
    566: { title: 'P1: Bifrost fleet mode', packet: { raci: 'R=Arch1 A=Blaze' } },
    700: { title: 'other card', packet: { raci: 'R=Arch1 A=Blaze' } },
  };
  const cardOf = (row) => cards[row.number] || null;
  const oldTip = line('old', { number: 566, t: '2026-11-02T15:18:00-06:00', title: 'forge comment' });
  const fresh = line('new', { number: 566, t: '2026-11-02T16:52:00-06:00', title: 'forge comment' });
  const opts = { seat: 'arch1', cardOf };
  assert.equal(liveLine([oldTip, fresh], opts)[0].id, 'new');
  assert.equal(queueView([oldTip, fresh], opts).some((row) => row.id === 'old'), false);
  const other = line('other', { number: 700, t: '2026-11-02T17:00:00-06:00' });
  assert.equal(queueView([oldTip, fresh, other], opts).some((row) => row.id === 'other'), true);
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

test('a newer ready on the same pull is the head when the card is not a pr', () => {
  const cards = { 831: { kind: 'packet', title: 'lookup' } };
  const cardOf = (row) => cards[row.number] || null;
  const oldReady = line('old', { type: 'packet', kind: 'ready', number: 831, sha: '3e1050b0', t: '2026-11-02T13:52:00-06:00' });
  const fresh = line('new', { type: 'packet', kind: 'ready', number: 831, sha: '2af5eebef', t: '2026-11-02T14:04:00-06:00' });
  const pass = line('pass', { type: 'ci_pass', kind: 'ci_pass', number: 831, sha: '2af5eebef', title: 'ci_pass', t: '2026-11-02T14:04:34-06:00' });
  const opts = { cardOf, seat: 'critic' };
  assert.equal(liveLine([oldReady, pass, fresh], opts)[0].id, 'new');
  assert.equal(queueView([oldReady, pass, fresh], opts).some((row) => row.id === 'old'), false);
  const oldPass = line('old-pass', { type: 'ci_pass', kind: 'ci_pass', number: 831, sha: '3e1050b0', title: 'ci_pass', t: '2026-11-02T13:59:00-06:00' });
  assert.equal(queueView([oldPass, pass], opts).some((row) => row.id === 'old-pass'), false);
  assert.equal(liveLine([oldPass, pass], opts)[0].id, 'pass');
});

test('a shed line is never the head, and a ready handoff leads a same-card tip', () => {
  const cards = { 821: { kind: 'pr', title: 'beat', packet: { raci: 'R=Arch1', goal: 'P1 beat' } } };
  const cardOf = (row) => cards[row.number] || null;
  const shed = line('soft', { number: 564, title: 'old soft tip', t: '2026-10-30T05:00:00Z', shed: true });
  assert.deepEqual(liveLine([shed], { seat: 'arch1', cardOf }), []);
  const tip = line('tip', { number: 821, title: 'parent tip', t: '2026-11-02T12:00:00Z' });
  const ready = line('h', { type: 'packet', kind: 'ready', number: 821, title: 'handoff ready', t: '2026-11-02T16:00:00Z' });
  assert.equal(liveLine([shed, tip, ready], { seat: 'arch1', cardOf })[0].id, 'h');
});

test('the live line is the first line of the queue', () => {
  const older = line('a', { number: 1, title: 'P0: first', t: '2026-10-30T01:00:00Z' });
  const newer = line('b', { number: 2, title: 'P1: second', t: '2026-10-30T02:00:00Z' });
  assert.deepEqual(queueView([newer, older]).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(liveLine([newer, older]).map((row) => row.id), ['a']);
});

const shedRows = (n) => Array.from({ length: n }, (_, i) => line(`s${i}`, { number: 100 + i, shed: true, t: `2026-11-01T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z` }));

test('56 shed rows plus one new tip: the new tip is not shed and is the head (#67)', () => {
  const open = shedRows(56);
  assert.equal(queueView(open).length, 0);
  const tip = markShed(line('tip', { number: 987, t: '2026-11-10T10:00:00Z' }), open);
  assert.equal(tip.shed, undefined);
  const head = queueView([...open, tip]);
  assert.equal(head.length, 1);
  assert.equal(head[0].id, 'tip');
});

test('an all-shed inbox keeps an empty head, and the next line of any kind still gets in (#67)', () => {
  const open = shedRows(56);
  assert.deepEqual(queueView(open), []);
  assert.equal(overWip(open), true);
  for (const extra of [{ title: 'a comment' }, { type: 'issue_open', title: 'new issue' }, { type: 'nudge', title: 'nudge' }]) {
    const next = markShed(line('n', { number: 987, t: '2026-11-10T10:00:00Z', ...extra }), open);
    assert.notEqual(next.shed, true);
    assert.equal(liveLine([...open, next])[0].id, 'n');
  }
});

test('over WIP with a non-empty head still sheds a new comment (#67)', () => {
  const open = [...shedRows(5), line('live', { number: 900, t: '2026-11-09T10:00:00Z' }), line('live2', { number: 901, t: '2026-11-09T11:00:00Z' })];
  const wip = { wip: 1 };
  assert.equal(overWip(open, wip), true);
  const fresh = markShed(line('late', { number: 902, t: '2026-11-10T10:00:00Z' }), open, wip);
  assert.equal(fresh.shed, true);
});

test('63 shed rows: closed targets settle, open targets unshed, head is non-empty, open count drops (#69)', () => {
  const rows = shedRows(63);
  assert.equal(queueView(rows).length, 0);
  assert.equal(overWip(rows), true);
  const closed = new Set(rows.slice(0, 40).map((row) => `0xrayai/xray#${row.number}`));
  const now = Date.parse('2026-11-10T11:00:00-06:00');
  const result = settleShed(rows, {
    now,
    ttlMs: 30 * 86400000,
    isSettled: (row) => closed.has(`0xrayai/xray#${row.number}`),
  });
  assert.equal(result.settled.length, 40);
  assert.equal(result.unshed.length, 23);
  assert.ok(result.unshed.every((row) => row.shed !== true));
  assert.ok(result.unshed.every((row) => row.t_ct === rows.find((src) => src.id === row.id).t_ct));
  const open = result.lines.filter((row) => row.shed !== true);
  assert.equal(open.length, 23);
  const head = queueView(open);
  assert.ok(head.length > 0);
  assert.equal(liveLine(open).length, 1);
  assert.ok(open.length < rows.length);
});

test('a shed row at or past the TTL is settled, a younger one is unshed (pinned clock) (#69)', () => {
  const now = Date.parse('2026-11-10T12:00:00-06:00');
  const ttlMs = 24 * 3600 * 1000;
  const aged = line('aged', { number: 1, shed: true, t: '2026-11-09T12:00:00-06:00' });
  const older = line('older', { number: 2, shed: true, t: '2026-11-08T12:00:00-06:00' });
  const fresh = line('fresh', { number: 3, shed: true, t: '2026-11-10T00:00:00-06:00' });
  const result = settleShed([aged, older, fresh], { now, ttlMs, isSettled: () => false });
  assert.deepEqual(result.settled.map((row) => row.id), ['aged', 'older']);
  assert.deepEqual(result.unshed.map((row) => row.id), ['fresh']);
  assert.equal(result.unshed[0].shed, undefined);
  assert.equal(result.unshed[0].t_ct, fresh.t_ct);
  assert.equal(shedTtlMs({}), 86400000);
  assert.equal(shedTtlMs({ BIFROST_SHED_TTL_S: '3600' }), 3600000);
  assert.equal(shedTtlMs({ BIFROST_SHED_TTL_S: '0' }), 86400000);
});

test("queueOpts('arch1') includes shedCards at the markShed guard (#69)", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
  assert.match(src, /function queueOpts\(seat\)/);
  assert.match(src, /shedCards:\s*shedCardsFor\(seat\)/);
  assert.match(src, /if \(s === 'arch1'\) stored = markShed\(stored, seatOpenRows\(s, false\), queueOpts\(s\)\)/);
  assert.match(src, /if \(sweepShed\(now\)\)/);
  assert.match(src, /try \{ if \(sweepShed\(\)\)/);
});
