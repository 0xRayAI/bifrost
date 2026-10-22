// Wave schedule. A wave is the cards named in the fleet seed, in rank order.
// When a real wave is closed or merged, one "plan next wave" card is raised for
// the CoS seat. The card names the next open wave. The window is a Chicago cron,
// stored on the card, so a restart does not re-arm it. This module only decides.
// It does not post to a board.

import path from 'node:path';

export const PLAN_TITLE = 'plan next wave';
export const PLAN_FLAG = 'nothing carded';
export const DEFAULT_WINDOW = '0 9 * * 1';
export const BURN_QUIET = 0.75;
export const PLAN_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The badge is only a packet PR whose PACKET.md is missing. Ordinary PRs pass. */
export function briefOk(card) {
  if (!card || typeof card !== 'object' || card.pinned) return true;
  const kind = String(card.kind || '');
  const title = String(card.title || '').trim();
  const alias = String(card.alias || '').toLowerCase();
  const packetPr = kind === 'pr' && (/^packet\b/i.test(title) || alias.startsWith('packet:'));
  if (!packetPr) return true;
  return !!card.packet_file;
}

/** packet_ok follows briefOk. A packet PR with no PACKET.md is false. Everything else is true. */
export function applyBrief(card) {
  if (!card || typeof card !== 'object') return card;
  if (!briefOk(card)) {
    if (card.packet_ok === false && Array.isArray(card.missing) && card.missing.includes('PACKET.md')) return card;
    return { ...card, packet_ok: false, missing: ['PACKET.md'] };
  }
  if (card.packet_ok === true && (!Array.isArray(card.missing) || card.missing.length === 0)) return card;
  return { ...card, packet_ok: true, missing: [] };
}

export function cardKey(card) {
  if (!card || typeof card !== 'object') return '';
  if (typeof card.key === 'string' && card.key) return card.key.toLowerCase();
  if (card.repo && card.number != null && card.number !== '') return `${String(card.repo).toLowerCase()}#${card.number}`;
  return '';
}

export function isPlanCard(card) {
  return !!(card && (card.kind === 'plan' || card.title === PLAN_TITLE));
}

/** Live cards that are open work. A plan card is the scheduler's, not a stalled seat. */
export function liveWorkCount(cards) {
  return (Array.isArray(cards) ? cards : []).filter((card) => card && card.state === 'live' && !isPlanCard(card)).length;
}

export function isSyntheticCard(card) {
  if (!card || typeof card !== 'object' || isPlanCard(card)) return false;
  const number = card.number != null && card.number !== '' ? Number(card.number) : NaN;
  return !card.repo || !Number.isInteger(number);
}

export function cardClosed(card) {
  if (!card || typeof card !== 'object') return false;
  const state = String(card.state || '').toLowerCase();
  const stage = String(card.stage || '').toLowerCase();
  if (state === 'closed' || state === 'merged' || stage === 'done') return true;
  const beats = Array.isArray(card.beats) ? card.beats : [];
  return beats.some((beat) => {
    const what = String(beat && (beat.what || beat.kind) || '').toLowerCase();
    return what === 'merged' || what.startsWith('merged ');
  });
}

export function seedWaves(seed) {
  const waves = Array.isArray(seed && seed.waves) ? seed.waves : [];
  return waves
    .map((wave, index) => ({
      id: String(wave && wave.id || ''),
      rank: Number.isFinite(wave && wave.rank) ? wave.rank : index + 1,
      title: String(wave && wave.title || ''),
      cards: Array.isArray(wave && wave.cards) ? wave.cards : [],
    }))
    .filter((wave) => wave.id)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export function chicagoParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map = {};
  for (const part of fmt.formatToParts(new Date(ms))) map[part.type] = part.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: WEEKDAY[map.weekday],
  };
}

function cronAtom(field, value, sunday) {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const stepBits = part.split('/');
    const step = stepBits.length > 1 ? Number(stepBits[1]) : 0;
    const base = stepBits[0];
    const norm = (n) => (sunday && n === 7 ? 0 : n);
    if (base.includes('-')) {
      const [a, b] = base.split('-').map((n) => norm(Number(n)));
      if (value < a || value > b) return false;
      return step ? (value - a) % step === 0 : true;
    }
    if (base === '*') return step ? value % step === 0 : true;
    const start = norm(Number(base));
    if (!step) return value === start;
    return value >= start && (value - start) % step === 0;
  });
}

export function cronMatches(cron, ms) {
  const bits = String(cron || '').trim().split(/\s+/);
  if (bits.length < 5) return false;
  const [minute, hour, dom, month, dow] = bits;
  const parts = chicagoParts(ms);
  if (!cronAtom(minute, parts.minute, false)) return false;
  if (!cronAtom(hour, parts.hour, false)) return false;
  if (!cronAtom(month, parts.month, false)) return false;
  const dayOk = cronAtom(dom, parts.day, false);
  const weekOk = cronAtom(dow, parts.weekday, true);
  if (dom === '*' && dow === '*') return true;
  if (dom === '*') return weekOk;
  if (dow === '*') return dayOk;
  return dayOk || weekOk;
}

export function nextChicagoCron(cron, fromMs) {
  const start = fromMs - (fromMs % 60000) + 60000;
  const end = fromMs + 8 * 24 * 60 * 60000;
  for (let t = start; t <= end; t += 60000) {
    if (cronMatches(cron, t)) return t;
  }
  return end;
}

export function burnQuiet(weeklyBurn) {
  const n = Number(weeklyBurn);
  return Number.isFinite(n) && n >= BURN_QUIET;
}

function findCard(wanted, cards) {
  const key = cardKey(wanted);
  const repo = wanted && wanted.repo ? String(wanted.repo).toLowerCase() : '';
  const number = wanted && wanted.number != null && wanted.number !== '' ? Number(wanted.number) : null;
  return (Array.isArray(cards) ? cards : []).find((card) => {
    if (key && cardKey(card) === key) return true;
    if (repo && number != null && String(card.repo || '').toLowerCase() === repo && Number(card.number) === number) return true;
    return false;
  }) || null;
}

/** 'closed' when every real seeded card is on the board and closed or merged. A card with no GitHub number is closed. Missing real cards stay open. */
export function waveStatus(wave, cards) {
  if (!wave.cards.length) return 'open';
  const real = wave.cards.filter((wanted) => !isSyntheticCard(wanted));
  if (!real.length) return 'closed';
  let missing = false;
  let open = false;
  for (const wanted of real) {
    const card = findCard(wanted, cards);
    if (!card) { missing = true; continue; }
    if (!cardClosed(card)) open = true;
  }
  if (open) return 'live';
  if (missing) return 'open';
  return 'closed';
}

export function rankedBacklog(seed, cards) {
  return seedWaves(seed)
    .filter((wave) => waveStatus(wave, cards) !== 'closed')
    .map((wave) => ({
      rank: wave.rank,
      wave: wave.id,
      title: wave.title,
      cards: wave.cards.map(cardKey).filter(Boolean),
    }));
}

export function nextWave(seed, cards) {
  return rankedBacklog(seed, cards)[0] || null;
}

function realWaveClosed(seed, cards) {
  return seedWaves(seed).some((wave) => wave.cards.some((wanted) => !isSyntheticCard(wanted)) && waveStatus(wave, cards) === 'closed');
}

function closeSynthetic(card) {
  if (!isSyntheticCard(card)) return card;
  return { ...card, state: 'closed', stage: 'done' };
}

export function cardsFromSeed(seed, { now = Date.now(), coord = 'coord' } = {}) {
  const cards = [];
  for (const wave of seedWaves(seed)) {
    const wanted = wave.cards.length ? wave.cards : [{ title: wave.title }];
    for (const raw of wanted) {
      const key = cardKey(raw) || `wave:${wave.id.toLowerCase()}`;
      const number = raw.number != null && raw.number !== '' ? Number(raw.number) : null;
      const repo = raw.repo ? String(raw.repo) : '';
      cards.push(closeSynthetic({
        key,
        repo,
        number,
        title: String(raw.title || wave.title),
        url: raw.url || (repo && number ? `https://github.com/${repo}/issues/${number}` : ''),
        owner: raw.owner || coord,
        stage: raw.stage || 'open',
        state: raw.state || 'live',
        kind: raw.kind || (number ? 'issue' : 'wave'),
        wave: wave.id,
        rank: wave.rank,
        packet: {
          goal: String(raw.title || wave.title).slice(0, 200),
          constraints: `wave ${wave.id}`.slice(0, 200),
          path: 'house/bifrost-waves.json',
          acceptance: 'the wave card is closed or merged',
          evidence: '',
          'next owner': raw.owner || coord,
          escalate: 'coordinator',
        },
        packet_ok: true,
        missing: [],
        beats: [],
        last_beat_t: now,
        stall: false,
        raised_at: now,
      }));
    }
  }
  return cards;
}

/** Cards an apply may put on the board: the one current wave, never a synthetic card and never every wave. */
export function postedCards(seed, opts = {}) {
  const all = cardsFromSeed(seed, opts);
  const next = nextWave(seed, all);
  if (!next) return [];
  return all.filter((card) => card.wave === next.wave && !isSyntheticCard(card) && !cardClosed(card));
}

function planFrom(seed, cards, coord, now, window) {
  if (!realWaveClosed(seed, cards)) return null;
  const next = nextWave(seed, cards);
  if (!next) return null;
  const backlog = [next];
  const line = `${next.rank}. ${next.wave} ${next.title}`;
  const seen = cards.map(cardKey).filter((key) => key && key !== 'plan:next-wave');
  const due = nextChicagoCron(window, now);
  return {
    key: 'plan:next-wave',
    kind: 'plan',
    title: PLAN_TITLE,
    url: '',
    owner: coord || 'coord',
    stage: 'open',
    state: 'live',
    wave: next.wave,
    rank: 0,
    raised_at: now,
    due_at: due,
    flag: '',
    seen,
    backlog,
    packet: {
      goal: PLAN_TITLE,
      constraints: line.slice(0, 200),
      path: 'house/bifrost-waves.json',
      acceptance: 'the next wave is carded',
      evidence: '',
      'next owner': coord || 'coord',
      escalate: 'tripwire',
    },
    packet_ok: true,
    missing: [],
    beats: [],
    last_beat_t: now,
    stall: false,
  };
}

function refreshPlan(card, fresh, now, nudgeMs) {
  const same = JSON.stringify(card.backlog || []) === JSON.stringify(fresh.backlog || [])
    && (card.packet || {}).constraints === (fresh.packet || {}).constraints;
  const beat = Number(card.last_beat_t) || 0;
  const stale = !beat || now - beat >= nudgeMs;
  return {
    ...fresh,
    raised_at: card.raised_at || fresh.raised_at,
    due_at: card.due_at || fresh.due_at,
    last_beat_t: !same || stale ? now : beat,
    flag: card.flag || '',
    beats: Array.isArray(card.beats) ? card.beats : [],
    seen: Array.isArray(card.seen) ? card.seen : fresh.seen,
  };
}

function waveOf(card) {
  const backlog = Array.isArray(card && card.backlog) ? card.backlog : [];
  const named = backlog[0] && backlog[0].wave;
  return String(named || (card && card.wave) || '');
}

function planAgeExpired(card, now, expireMs) {
  const raised = Number(card && card.raised_at) || 0;
  return raised > 0 && now - raised >= expireMs;
}

function expirePlan(card, now) {
  return { ...card, state: 'closed', stage: 'done', flag: 'expired', last_beat_t: now };
}

export function isPacketBorn(card) {
  return !!(card && (card.born === 'packet' || String(card.key || '').toLowerCase().startsWith('packet:')));
}

function refName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/^refs\/heads\//, '').slice(0, 200);
}

function branchNames(event) {
  if (!event || typeof event !== 'object') return [];
  const names = [];
  const add = (value) => {
    const name = refName(value);
    if (name && !names.includes(name)) names.push(name);
  };
  add(event.branch);
  add(event.head_ref);
  add(event.ref);
  if (Array.isArray(event.branches)) {
    for (const name of event.branches) add(name);
  }
  return names;
}

function shaOf(event) {
  if (!event || typeof event !== 'object') return '';
  return String(event.sha || event.head_sha || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}

function branchOf(event) {
  const names = branchNames(event);
  return names[0] || '';
}

function headOf(event) {
  return branchOf(event) || refName(event && event.head);
}

function shaBranchIndex(events) {
  const found = new Map();
  for (const event of events) {
    const sha = shaOf(event);
    const names = branchNames(event);
    if (!sha || !names.length) continue;
    const bucket = found.get(sha) || [];
    for (const name of names) if (!bucket.includes(name)) bucket.push(name);
    found.set(sha, bucket);
  }
  return found;
}

function baseBySha(events) {
  const found = new Map();
  for (const event of events) {
    if (!event || event.kind !== 'pr_open') continue;
    const sha = shaOf(event);
    const base = refName(event.base);
    if (!sha || !base) continue;
    const skip = found.get(sha) || new Set();
    skip.add(base);
    found.set(sha, skip);
  }
  return found;
}

function chosenBranch(event, bases) {
  const names = branchNames(event);
  if (!names.length) return '';
  const skip = bases.get(shaOf(event));
  return names.find((name) => !skip || !skip.has(name)) || names[0];
}

function prLinks(events) {
  const found = new Map();
  for (const event of events) {
    if (!event || event.kind !== 'pr_commit' || !positiveEvent(event)) continue;
    const sha = shaOf(event);
    const repo = String(event.repo || '').toLowerCase();
    if (!sha || !repo) continue;
    const bucket = found.get(sha) || [];
    const pair = repo + '#' + Number(event.number);
    if (!bucket.includes(pair)) bucket.push(pair);
    found.set(sha, bucket);
  }
  return found;
}

function shaLinked(event, card, links) {
  const numbers = (links.get(shaOf(event)) || [])
    .filter((pair) => pair.startsWith(String(card.repo || '').toLowerCase() + '#'))
    .map((pair) => Number(pair.slice(pair.lastIndexOf('#') + 1)));
  if (!numbers.length) return false;
  const cardNumber = Number(card.number);
  if (Number.isInteger(cardNumber) && cardNumber >= 1 && !numbers.includes(cardNumber)) return false;
  return true;
}

const BASE_NAMES = new Set(['develop', 'main']);

function featureBranch(card) {
  const branch = refName(card && card.branch);
  if (!branch || BASE_NAMES.has(branch)) return '';
  return branch;
}

function branchFor(card, events, list, bases, links) {
  const touching = [];
  for (const event of events) {
    if (!event || event.kind === 'pr_open' || event.kind === 'issue_open') continue;
    const branch = chosenBranch(event, bases);
    if (!branch || !eventTouches(card, event, list)) continue;
    touching.push([event, branch]);
  }
  const linked = touching.filter(([event]) => shaLinked(event, card, links));
  const pool = linked.length ? linked : touching;
  const feature = pool.find(([, branch]) => !BASE_NAMES.has(branch));
  return feature ? feature[1] : '';
}

function agreedOpen(event, links) {
  if (!event || event.kind !== 'pr_open' || !positiveEvent(event)) return false;
  const sha = shaOf(event);
  if (!sha) return false;
  return (links.get(sha) || []).includes(String(event.repo || '').toLowerCase() + '#' + Number(event.number));
}

function branchHit(event, shaBranches, links, feature) {
  const sha = shaOf(event);
  const named = headOf(event) === feature;
  const bySha = !!(sha && (shaBranches.get(sha) || []).includes(feature));
  if (!named && !bySha) return false;
  const pairs = links.get(sha) || [];
  if (!pairs.length) return true;
  return pairs.includes(String(event.repo || '').toLowerCase() + '#' + Number(event.number));
}

function joinEvent(card, events, shaBranches, links, list) {
  const feature = featureBranch(card);
  const hits = [];
  const agreed = [];
  for (const event of events) {
    if (!event || event.kind !== 'pr_open' || !positiveEvent(event)) continue;
    if (!eventTouches(card, event, list)) continue;
    if (feature && branchHit(event, shaBranches, links, feature)) hits.push(event);
    if (agreedOpen(event, links)) agreed.push(event);
  }
  if (hits.length) return hits[0];
  const numbers = new Set(agreed.map((event) => String(event.repo || '').toLowerCase() + '#' + Number(event.number)));
  if (!feature && numbers.size === 1) return agreed[0];
  return null;
}

function branchFromOpen(event) {
  const ref = refName(event && event.head_ref);
  if (ref) return ref;
  const head = headOf(event);
  const base = refName(event && event.base);
  if (head && head !== base) return head;
  return '';
}

function positiveEvent(event) {
  const number = Number(event && event.number);
  return !!(event && event.repo && Number.isInteger(number) && number >= 1);
}

function eventTouches(card, event, list) {
  if (!event || typeof event !== 'object') return false;
  const key = String(card.key || '').toLowerCase();
  const named = String(event.card || '').trim().toLowerCase();
  if (named && named === key) return true;
  const repo = String(event.repo || '').toLowerCase();
  const number = Number(event.number);
  const cardRepo = String(card.repo || '').toLowerCase();
  if (repo && repo === cardRepo && Number.isInteger(number) && number >= 1 && Number(card.number) === number) return true;
  if (!named && key.startsWith('packet:') && repo && repo === cardRepo) {
    const only = list.filter((other) => String(other.key || '').toLowerCase().startsWith('packet:') && String(other.repo || '').toLowerCase() === repo);
    return only.length === 1 && only[0] === card;
  }
  return false;
}

/** Rewrite a holding card onto the PR that pr_open and pr_commit share. */
export function attachPacketCards(cards, events) {
  const list = (Array.isArray(cards) ? cards : []).filter((card) => card && typeof card === 'object').map((card) => ({ ...card }));
  const evs = Array.isArray(events) ? events : [];
  const bases = baseBySha(evs);
  const shaBranches = shaBranchIndex(evs);
  const links = prLinks(evs);
  for (const card of list) {
    if (card.branch) continue;
    const branch = branchFor(card, evs, list, bases, links);
    if (branch) card.branch = branch;
  }
  const gone = new Set();
  for (const card of list) {
    const key = String(card.key || '');
    if (!key.toLowerCase().startsWith('packet:') || gone.has(card)) continue;
    const hit = joinEvent(card, evs, shaBranches, links, list);
    if (!hit) continue;
    const nextKey = String(hit.repo).toLowerCase() + '#' + Number(hit.number);
    const branch = featureBranch(card) || branchFromOpen(hit) || refName(card.branch);
    const existing = list.find((other) => other !== card && !gone.has(other) && String(other.key || '').toLowerCase() === nextKey);
    if (existing) {
      if (!existing.alias) existing.alias = key;
      if (branch && !featureBranch(existing)) existing.branch = branch;
      gone.add(card);
      continue;
    }
    card.alias = key;
    card.key = nextKey;
    card.repo = String(hit.repo);
    card.number = Number(hit.number);
    if (branch) card.branch = branch;
    const url = typeof hit.url === 'string' ? hit.url : (typeof hit.source === 'string' ? hit.source : '');
    if (url) card.url = url.slice(0, 300);
    if (card.kind === 'packet') card.kind = 'pr';
    card.last_beat_t = Date.now();
  }
  return list.filter((card) => !gone.has(card));
}

function packetSettled(card, closed) {
  if (card.state === 'closed' || card.stage === 'done') return true;
  return typeof closed === 'function' && closed(card);
}

/** Keep a plan card, a packet-born card, and loaded wave cards the collector does not send. Earlier cards win on key.
 * A packet-born card whose item is already closed or merged is not kept. */
export function retainSeedCards(collector, prior, seedCards, closed) {
  const base = Array.isArray(collector) ? collector.slice() : [];
  const have = new Set(base.map(cardKey).filter(Boolean));
  const extras = [...(Array.isArray(prior) ? prior : []), ...(Array.isArray(seedCards) ? seedCards : [])];
  for (const card of extras) {
    const key = cardKey(card);
    if (!key || have.has(key)) continue;
    if (isPacketBorn(card) && packetSettled(card, closed)) continue;
    if (!isPlanCard(card) && !card.wave && card.kind !== 'wave' && card.kind !== 'plan' && !isPacketBorn(card)) continue;
    base.push(card);
    have.add(key);
  }
  return base;
}

function oneWave(list, seed) {
  const kept = list.filter((card) => isPlanCard(card) || !isSyntheticCard(card));
  const next = nextWave(seed, kept);
  const id = next ? next.wave : '';
  return kept.filter((card) => {
    if (isPlanCard(card) || !card.wave) return true;
    if (cardClosed(card)) return true;
    return card.wave === id;
  });
}

export function scheduleWaves(incoming, seed, opts = {}) {
  const now = opts.now || Date.now();
  const coord = opts.coord || 'coord';
  const window = opts.window || (seed && seed.window) || DEFAULT_WINDOW;
  const nudgeMs = opts.nudgeMs > 0 ? opts.nudgeMs : 60 * 60000;
  const expireMs = opts.expireMs > 0 ? opts.expireMs : PLAN_EXPIRE_MS;
  const quiet = burnQuiet(opts.weeklyBurn);
  const list = oneWave(
    retainSeedCards(incoming, opts.prior, [], opts.closed).filter((card) => {
      if (!isPlanCard(card) || !cardClosed(card)) return true;
      return card.flag === 'expired';
    }),
    seed,
  );
  const openPlan = list.find((card) => isPlanCard(card) && !cardClosed(card));
  const expiredPlan = list.find((card) => isPlanCard(card) && card.flag === 'expired');
  const fresh = quiet ? null : planFrom(seed, list, coord, now, window);
  let cards = list;
  if (fresh && openPlan) {
    cards = list.map((card) => {
      if (!isPlanCard(card) || cardClosed(card)) return card;
      const refreshed = refreshPlan(card, fresh, now, nudgeMs);
      if (waveOf(card) === waveOf(fresh)) return refreshed;
      return { ...refreshed, raised_at: now, state: 'live', stage: 'open', flag: '' };
    });
  } else if (fresh && expiredPlan && waveOf(expiredPlan) === waveOf(fresh)) {
    cards = list;
  } else if (fresh && expiredPlan) {
    cards = list.map((card) => (isPlanCard(card) ? fresh : card));
  } else if (fresh) {
    cards = [...list, fresh];
  } else if (openPlan && quiet) {
    cards = list.map((card) => (isPlanCard(card) && !cardClosed(card) ? { ...card, last_beat_t: now, flag: '' } : card));
  }
  cards = cards.map((card) => {
    if (!isPlanCard(card) || cardClosed(card)) return card;
    if (!planAgeExpired(card, now, expireMs)) return card;
    return expirePlan(card, now);
  });
  let planDue = false;
  cards = cards.map((card) => {
    if (!isPlanCard(card) || cardClosed(card)) return card;
    const dueAt = Number(card.due_at) || Date.parse(card.due_at) || 0;
    const seen = new Set(Array.isArray(card.seen) ? card.seen.map((key) => String(key).toLowerCase()) : []);
    const carded = cards.some((other) => {
      if (isPlanCard(other)) return false;
      const key = cardKey(other);
      return key && !seen.has(key);
    });
    if (carded || quiet || !dueAt || now < dueAt) {
      if (card.flag === PLAN_FLAG) return { ...card, flag: '' };
      return card;
    }
    planDue = true;
    if (card.flag === PLAN_FLAG) return card;
    return { ...card, flag: PLAN_FLAG };
  });
  const stamp = (rows) => JSON.stringify((rows || []).map((card) => [
    cardKey(card), card.flag || '', card.title, card.state, card.owner,
    card.last_beat_t || 0, card.due_at || '', ((card.backlog || []).map((item) => item.wave)).join(','),
  ]));
  return { cards, planDue, changed: stamp(cards) !== stamp(incoming) };
}

/**
 * Empty incoming cards do not replace a non-empty board while the collector is
 * stalled or the feed file is older than the stall window. A missing file is age 0.
 * A non-empty incoming list still replaces. A fresh empty board still clears.
 */
export function acceptWaveCards(incoming, existing, opts = {}) {
  const next = Array.isArray(incoming) ? incoming : [];
  const prior = Array.isArray(existing) ? existing : [];
  if (next.length > 0 || prior.length === 0) return next;
  const windowMs = Number(opts.stallWindowMs);
  const age = Number(opts.feedAgeMs);
  const staleFile = Number.isFinite(age) && Number.isFinite(windowMs) && age > windowMs;
  if (opts.stalled || staleFile) return prior;
  return next;
}

/** House file first (OP-PROC). The bundled copy beside the server is what the image can read. */
export function resolveWaveSeed(appDir, env = {}, exists = () => false) {
  if (env.BIFROST_WAVE_SEED) return env.BIFROST_WAVE_SEED;
  const house = path.join(appDir, '..', '..', '..', 'house', 'bifrost-waves.json');
  if (exists(house)) return house;
  return path.join(appDir, 'bifrost-waves.json');
}
