/* Kit overlay for the upstream live page (live.js is served unmodified apart from the feed URL).
   Feed = this server's own live-events.json only. */
(function (L) {
  'use strict';
  function reset(obj, next) { Object.keys(obj).forEach(function (k) { delete obj[k]; }); for (var k in next) obj[k] = next[k]; }
  var FEED = (window.LIVE_FEED_URL || 'live-events.json');
  L.SOURCES.splice(0, L.SOURCES.length, { name: 'feed', api: true, url: FEED }, { name: 'feed', url: FEED });
  // Poll every 10 s: the pusher uploads right after each feed write, and an unchanged feed is a 304 with an empty body
  // (If-None-Match against this server's ETag), so the page's 'Refreshed' age stays under ~75 s.
  L.POLL_MS = 10000;
  // Delta polls: the full feed once (first load, or after the server reports a reset), then ?since=<cursor> returns
  // only events new or changed since then plus the header fields (304 when nothing changed). applyFeed already
  // unions incoming events into the page state by id, so handing it the delta keeps Replay (first load) and
  // play-each-new-id-once exactly as with full feeds.
  L.fetchFeed = function (fetchFn, nowMs, mem) {
    function full() {
      return fetchFn(FEED, { cache: 'no-store' }).then(function (res) {
        // A show-poll drops the cursor once. A server that still answers 304 is an unchanged feed, not an error.
        if (res.status === 304) return { source: 'feed', feed: null };
        if (!res.ok) throw new Error('feed HTTP ' + res.status);
        return res.json().then(function (f) {
          mem.cursor = (f && f.cursor) || null;
          return { source: 'feed', feed: f };
        });
      });
    }
    var unconditional = !mem.cursor || mem.force;
    if (mem.force) mem.force = 0;
    if (unconditional) return full();
    var url = FEED + (FEED.indexOf('?') < 0 ? '?' : '&') + 'since=' + encodeURIComponent(mem.cursor);
    return fetchFn(url, { cache: 'no-store' }).then(function (res) {
      if (res.status === 304) return { source: 'feed', feed: null };
      if (!res.ok) throw new Error('feed HTTP ' + res.status);
      return res.json().then(function (d) {
        if (d && d.delta) {
          mem.cursor = d.cursor || null;
          var f = {}; for (var k in d) if (k !== 'delta' && k !== 'removed') f[k] = d[k];
          return { source: 'feed', feed: f };
        }
        if (d && !d.reset && Array.isArray(d.events)) { mem.cursor = d.cursor || null; return { source: 'feed', feed: d }; }  // pre-delta server
        mem.cursor = null;
        return full();   // server restarted / cursor too old
      });
    });
  };
  // Bots (the "a of b bots active" count; the feed's fleet state marks seats active from file mtimes too).
  // Coord uses the upstream 'blinky' key. QA = QaOne + QA two + QA (one seat, one stream).
  L.AGENTS.splice(0, L.AGENTS.length, ['Builder', 'builder'], ['Builder-cloud', 'cloud builder'], ['Reviewer', 'gate'], ['Tester', 'lab tester'],
    ['QA', 'lab testers'], ['Operator', 'infra'], ['blinky', 'Coordinator'], ['CloudAgents', 'cloud agents'], ['Assistant', 'emitter']);
  // Cloud agents is a header seat (ACTIVE/IDLE) but not one of the bots counted in 'N of M bots active'.
  L.SEAT_NAMES.splice(0, L.SEAT_NAMES.length, 'Builder', 'Builder-cloud', 'Reviewer', 'Tester', 'QA', 'Operator', 'blinky');
  // Nodes (920 x 400 canvas, hub at 500,200). One product node (product + dev / labtest / prod instances; the
  // instance is a tag on the event label). 'mymuse.house' / 'blinky' / 'X' are upstream's fixed keys,
  // shown as the product / Coord / Others.
  // Lead = lead-login and lead-alt (his renamed login): one node. CI is folded into GitHub.
  reset(L.SATS, { Builder: [90, 50], 'Builder-cloud': [190, 125], Reviewer: [280, 50], X: [470, 50], GitHub: [680, 55], Railway: [850, 55],
    Lead: [110, 200], Operator: [300, 200], blinky: [690, 200], 'mymuse.house': [850, 200],
    CloudAgents: [150, 330], Tester: [400, 330], QA: [640, 330], Assistant: [860, 330] });
  reset(L.COLOR, { Builder: [110, 170, 255], 'Builder-cloud': [150, 200, 255], Reviewer: [255, 150, 90], Tester: [240, 120, 190], QA: [140, 230, 200],
    Operator: [88, 210, 180], CloudAgents: [130, 190, 255], Lead: [255, 120, 100], X: [150, 160, 180],
    GitHub: [200, 210, 230], Railway: [170, 130, 255], Assistant: [116, 170, 156],
    'mymuse.house': [255, 200, 90], blinky: [88, 210, 180] });
  reset(L.LABEL, { CloudAgents: 'Cloud agents', Builder: 'Builder', 'Builder-cloud': 'Builder-cloud', Reviewer: 'Reviewer', Tester: 'Tester', QA: 'QA', Operator: 'Operator',
    Lead: 'Lead', X: 'Others', GitHub: 'GitHub', Railway: 'Railway',
    'mymuse.house': 'Product', blinky: 'Coord', Assistant: 'Assistant / emitter' });
  reset(L.SUB, { CloudAgents: 'cursor agents', Builder: 'builder', 'Builder-cloud': 'builder (cloud)', Reviewer: 'gate', Tester: 'lab tester', QA: 'qa-one · qa two',
    Operator: 'infra', Lead: 'Architect', X: 'other actors',
    GitHub: 'PRs · commits · checks', Railway: 'deploys', 'mymuse.house': 'dev · labtest · prod', blinky: 'Coordinator', Assistant: 'MCP tool calls' });
  reset(L.GLYPH, {});
  reset(L.SQUARE, { GitHub: 1, Railway: 1 });
  L.EDGES.splice(0, L.EDGES.length, ['Builder', 'GitHub'], ['Builder-cloud', 'GitHub'], ['Lead', 'GitHub'],
    ['Reviewer', 'GitHub'], ['Tester', 'GitHub'], ['X', 'GitHub'], ['Operator', 'Railway'], ['CloudAgents', 'GitHub'], ['Operator', 'CloudAgents'], ['Lead', 'Operator'],
    ['GitHub', 'Railway'], ['Railway', 'mymuse.house'], ['Tester', 'mymuse.house'], ['QA', 'mymuse.house'],
    ['blinky', 'mymuse.house'], ['Assistant', 'mymuse.house'], ['Operator', 'blinky'], ['Operator', 'GitHub']);
  // Avatars: avatars/<file>.png when present; a missing file falls back to the normal drawing (onerror).
  // builder-app[bot] -> builder, reviewer-app(/[bot]) -> reviewer, ops-app[bot] -> operator, Tester app -> tester,
  // The product node -> live (mailbox mark). lead-login and lead-alt (Lead's renamed login) -> the Lead node.
  // lead-login (Lead, the Architect) uses lead.png; the merged QA seat uses qa.
  // The kit ships no avatar files, so it maps none (no /avatars/*.png 404s); a fleet's overlay (site-config.js) sets
  // L.setAvatars({node: file}) for the images it ships in avatars/. Unmapped nodes use the drawn fallback.
  L.AVATAR = {};
  L.setAvatars = function (m) {
    L.AVATAR = m || {};
    L.BOT_IMAGES.splice(0, L.BOT_IMAGES.length);
    Object.keys(L.AVATAR).forEach(function (k) { L.BOT_IMAGES.push(k); });
  };
  L.setAvatars({});
  L.botImage = function (key) { return L.AVATAR[key] ? 'avatars/' + L.AVATAR[key] + '.png' : null; };
  var W = { lab_bug: 'lab bug', lab_bug_update: 'lab bug', lab_issue: 'lab issue', lab_run: 'lab test run',
    lab_calls: 'lab calls', board_card: 'board card', board_status: 'board', lab_retest_pass: 'lab retest PASS', lab_retest_fail: 'lab retest FAIL', critic_pass: 'reviewer PASS',
    critic_fail: 'reviewer FIX', critic_hold: 'reviewer FIX (legacy HOLD)', critic_recheck: 'reviewer re-check', pr_commit: 'PR push',
    review: 'review', pr_comment: 'PR comment', issue_comment: 'issue comment', review_comment: 'review comment',
    commit: 'commit', check_run: 'check run', check_suite: 'check suite', workflow_run: 'workflow run',
    commit_status: 'status', deploy_pending: 'deploy pending', tag: 'tag', release: 'release' };
  for (var k in W) L.KIND_WORD[k] = W[k];
  // Responsiveness: keep the most recent N events in the page (live-events.json holds everything).
  // ?n=5000 changes N; ?kinds=pr_,merged,reviewer filters by kind prefix.
  var q = new URLSearchParams(location.search);
  var MAX = Math.max(100, Number(q.get('n')) || 3000);
  var KINDS = (q.get('kinds') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  // Every feed from/to maps onto a drawn node key (L.SATS). Feed names -> node keys; anything else -> fallback.
  var NODE_KEY = { Blaze: 'Lead', CI: 'GitHub', forge: 'GitHub', Others: 'X', Coord: 'blinky', reviewer: 'Reviewer',
    labtest: 'mymuse.house',
    'QA': 'QA', QaOne: 'QA', QaTwo: 'QA', 'QA two': 'QA',
    'lead-alt': 'Lead', 'lead-login': 'Lead', 'Cloud agents': 'CloudAgents', cursoragent: 'CloudAgents' };
  L.NODE_KEY = NODE_KEY;   // a fleet overlay may add or remap feed names
  L.FROM_FALLBACK = 'X';   // node for an unmapped sender ('Others'); an overlay without X points it elsewhere
  function nodeKey(v, fallback) {
    if (/^(lead-alt|lead-login)$/i.test(String(v))) v = 'Lead';   // any alias of Lead's logins
    var k = Object.prototype.hasOwnProperty.call(NODE_KEY, v) ? NODE_KEY[v] : v;
    if (!Object.prototype.hasOwnProperty.call(L.SATS, k) && /(^|\.)live\.ai$/.test(String(k))) k = 'mymuse.house';
    return Object.prototype.hasOwnProperty.call(L.SATS, k) ? k : fallback;
  }
  // Hop list (feed names) -> drawn node keys; a hop that cannot be drawn is skipped, never crashes the page.
  function hopKeys(h) {
    if (!Array.isArray(h)) return null;
    var out = [];
    h.forEach(function (v) { var k = nodeKey(v, null); if (k && out[out.length - 1] !== k) out.push(k); });
    return out.length >= 2 ? out : null;
  }
  // Checks / runs / statuses (CI folded into GitHub): green on success, red on failure, neutral otherwise.
  var CHECK_KINDS = { check_run: 1, check_suite: 1, workflow_run: 1, commit_status: 1 };
  L.liveColor = function (e) {
    if (!e || !CHECK_KINDS[e.kind]) return null;
    var c = String(e.conclusion || e.state || '').toLowerCase();
    if (c === 'success') return [90, 220, 120];
    if (c === 'failure' || c === 'error' || c === 'timed_out' || c === 'startup_failure') return [240, 90, 80];
    return [165, 175, 190];
  };
  L.liveNodeKey = nodeKey;
  L.liveHopKeys = hopKeys;
  var applyFeed = L.applyFeed;
  L.applyFeed = function (state, feed, nowMs) {
    // the feed header names the product node, its instance hosts and services (feed/site.json); they all draw as
    // the one product node, so the kit page carries no install's names
    if (feed && Array.isArray(feed.product_nodes)) feed.product_nodes.forEach(function (n) { if (typeof n === 'string' && n && !(n in L.SATS)) NODE_KEY[n] = 'mymuse.house'; });
    if (feed && Array.isArray(feed.events)) {
      window.LIVE_FEED_TOTAL = typeof feed.event_count === 'number' ? feed.event_count : feed.events.length;
      var ev = feed.events;
      if (KINDS.length) ev = ev.filter(function (e) { return KINDS.some(function (p) { return String(e.kind).indexOf(p) === 0; }); });
      ev = ev.slice().sort(function (a, b) { return Date.parse(a.t_ct) - Date.parse(b.t_ct); }).slice(-MAX);
      ev = ev.map(function (e) {
        var f = nodeKey(e.from, L.FROM_FALLBACK), t = nodeKey(e.to, 'GitHub');
        if (f === t && t === 'mymuse.house') f = 'Railway';   // no product -> product self-hop
        return Object.assign({}, e, { from: f, to: t, hops: hopKeys(e.hops) });
      });
      if (feed.fleet && typeof feed.fleet === 'object') window.LIVE_FLEET = feed.fleet;
      feed = Object.assign({}, feed, { events: ev });
    }
    var out = applyFeed(state, feed, nowMs);
    if (out.state.events.length > MAX) out.state.events = out.state.events.slice(-MAX);
    return out;
  };
  L.blackoutLine = function () { return ''; };
  L.SITE_FOOT = '';   // footer line; the kit shows none (a fleet overlay sets its own)
  // Lens label box: centred on the node, shifted so it never runs off the canvas edge.
  L.labelX = function (x, w, width) { return Math.min(Math.max(x, w / 2 + 2), width - w / 2 - 2); };
  // Board as of a timeline point (rewound / replay): only cards that existed then (first beat at or before t), with
  // beats up to t. Live (t == null) = every card. Pinned cards always show.
  L.boardAt = function (cards, t) {
    if (t == null) return cards;
    var out = [];
    (cards || []).forEach(function (c) {
      if (c.pinned) { out.push(c); return; }
      var bs = (c.beats || []).filter(function (b) { return b.t <= t; });
      var first = (c.beats || []).length ? c.beats[0].t : c.last_beat_t;
      if (first != null && first > t) return;
      out.push(bs.length === (c.beats || []).length ? c : Object.assign({}, c, { beats: bs, last_beat_t: bs.length ? bs[bs.length - 1].t : c.last_beat_t }));
    });
    return out;
  };
  // Board bucket for a card under its seat. Parked stays visible (not folded into done).
  // The function is assigned after seatView so a parked card is its own bucket.
  // Seat groups for the board: each card under its seat (next owner, else owner); a card in review is ALSO waiting
  // on the review seat (L.REVIEW_SEAT, e.g. critic), so the reviewer's group shows its queue, not only its done cards.
  L.REVIEW_SEAT = null;
  L.boardGroups = function (cards, seatOf) {
    var by = {}, order = [];
    function add(s, c) { if (!by[s]) { by[s] = []; order.push(s); } by[s].push(c); }
    (cards || []).forEach(function (c) {
      var s = seatOf(c); add(s, c);
      if (L.REVIEW_SEAT && s !== L.REVIEW_SEAT && L.cardBucket(c) === 'review') add(L.REVIEW_SEAT, Object.assign({}, c, { _bucket: 'waiting' }));
    });
    order.sort(function (a, b) { return String(L.LABEL[a] || a).localeCompare(String(L.LABEL[b] || b)); });
    return order.map(function (s) { return { name: s, cards: by[s] }; });
  };
  // ONE derived seat state, used by the header chip text, its dot and the canvas node alike:
  //   working (in-flight spinner) > live (a ping on the board right now) > active (fleet, last 15 min) > idle
  // lit is working only. seen is a recent ping or a 15-minute beat, and it is not the working sheen.
  L.seatState = function (working, live, active) {
    return working ? 'working' : live ? 'live' : active ? 'active' : 'idle';
  };
  var SEAT_WORD = { working: 'WORKING', live: 'LIVE', active: 'ACTIVE', idle: 'IDLE' };
  L.seatView = function (st) {   // everything the chip and the node show, from that one state
    return {
      word: SEAT_WORD[st] || 'IDLE',
      lit: st === 'working',
      blink: st === 'working',
      nodeWorking: st === 'working',
      seen: st === 'live' || st === 'active'
    };
  };
  // A seat quiet this long is dormant. Seven days is the named count for that class.
  L.DORMANT_MS = 7 * 24 * 60 * 60 * 1000;
  L.seatDormant = function (lastCt, now) {
    var t = typeof lastCt === 'number' ? lastCt : Date.parse(lastCt || '');
    if (!(t > 0)) return false;
    return (now || Date.now()) - t >= L.DORMANT_MS;
  };
  L.workOnKey = function (raw) {
    var m = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/.exec(String(raw || '').trim());
    return m ? m[1].toLowerCase() + '#' + m[2] : '';
  };
  L.cardWorkKey = function (c) {
    if (!c) return '';
    if (c.repo != null && c.number != null && String(c.repo)) return L.workOnKey(String(c.repo) + '#' + c.number);
    return L.workOnKey(c.key);
  };
  L.seatWorkOn = function (fleet, seat) {
    if (!fleet || !seat) return '';
    var names = [seat, String(seat).toLowerCase()];
    if (seat === 'blinky' || seat === 'Coord' || String(seat).toLowerCase() === 'blinky') names.push('blinky', 'Coord');
    var working = fleet.working || {};
    var seats = fleet.seats || {};
    var mark = '';
    for (var i = 0; i < names.length; i++) {
      var row = working[names[i]];
      if (row && row.working_on) { mark = row.working_on; break; }
    }
    if (!mark) {
      for (var j = 0; j < names.length; j++) {
        var src = seats[names[j]];
        if (src && src.working_on) { mark = src.working_on; break; }
      }
    }
    return L.workOnKey(mark);
  };
  L.cardInWork = function (c, fleet) {
    var want = L.cardWorkKey(c);
    var seat = c && (c._seat || c.seat);
    if (!want || !seat) return false;
    return L.seatWorkOn(fleet, seat) === want;
  };
  L.rosterKept = function (rows, feed) {
    var fleet = feed && feed.fleet;
    var seats = fleet && fleet.seats;
    if (!seats || typeof seats !== 'object') return rows || [];
    var keys = {};
    Object.keys(seats).forEach(function (k) { keys[String(k).toLowerCase()] = 1; });
    var products = {};
    var nodes = feed.product_nodes;
    if (Array.isArray(nodes)) nodes.forEach(function (n) { if (typeof n === 'string' && n) products[n.toLowerCase()] = 1; });
    return (rows || []).filter(function (a) {
      var low = String((a && a[0]) || '').toLowerCase();
      if (!low) return false;
      if (products[low]) return true;
      return !!keys[low];
    });
  };
  function freshClock(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return m + ' min';
    var h = Math.round(m / 60);
    if (h < 48) return h + ' h';
    return Math.round(h / 24) + ' d';
  }
  // dataAt is the newest GitHub event. moveAt is the newest non-CI event that lands on an open card.
  // CI does not move the light. A comment, a running check, or an ordinary label does not either.
  L.freshTone = function (dataAt, cardsAt, moveAt, now) {
    if (!(cardsAt > 0)) return { tone: 'amber', line: 'Cards still building' };
    if (!(dataAt > 0)) return { tone: 'amber', line: 'No GitHub activity yet' };
    var dataAge = Math.max(0, now - dataAt);
    var cardAge = Math.max(0, now - cardsAt);
    var cardsBehind = moveAt > cardsAt + 120000;
    if (cardsBehind && cardAge >= 3600000) return { tone: 'red', line: 'Cards last changed ' + freshClock(cardAge) + ' ago' };
    if (dataAge >= 3 * 3600000) return { tone: 'red', line: 'No new GitHub activity in ' + freshClock(dataAge) };
    if (cardsBehind) return { tone: 'amber', line: 'Cards last changed ' + freshClock(cardAge) + ' ago' };
    if (dataAge < 60000) return { tone: 'green', line: 'Last activity just now' };
    if (dataAge < 30 * 60000) return { tone: 'green', line: 'Last activity ' + freshClock(dataAge) + ' ago' };
    return { tone: 'amber', line: 'Last activity ' + freshClock(dataAge) + ' ago' };
  };
  // A held card (Held: comment, GITHUB_HOLD_LABEL, or Jira JIRA_HOLD_STATUS) displays as Parked with its named blocker.
  L.parkedLabel = function (c) {
    var why = c && c.hold && String(c.hold.reason || '').trim();
    return why ? 'Parked behind ' + why : 'Parked';
  };
  // One id for every compare. Lowercase, and a run of separators becomes one underscore.
  // The painted word is statusName. An id outside the six columns stays visible and is flagged.
  L.statusId = function (raw) {
    return String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  };
  L.statusName = function (raw) {
    var id = L.statusId(raw);
    if (!id) return '';
    return id.split('_').filter(Boolean).map(function (word) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
  };
  L.KNOWN_STATES = ['live', 'parked', 'held', 'closed', 'waiting'];
  L.KANBAN_STAGES = ['open', 'review', 'fix', 'merge', 'retest', 'done'];
  L.statusFlagged = function (raw) {
    var id = L.statusId(raw);
    if (!id) return false;
    if (L.KANBAN_STAGES.indexOf(id) >= 0) return false;
    if (L.KNOWN_STATES.indexOf(id) >= 0) return false;
    return true;
  };
  L.cardBucket = function (c) {
    if (!c) return 'waiting';
    var state = L.statusId(c.state);
    var stage = L.statusId(c.stage);
    if (state === 'parked') return 'parked';
    if (state === 'closed' || stage === 'done') return 'done';
    if (state === 'held') return 'held';
    if (stage === 'review') return 'review';
    return 'waiting';
  };
  L.cardsForStatus = function (cards, filter) {
    var id = L.statusId(filter);
    if (!id) return [];
    return (cards || []).filter(function (c) {
      return !!c && (L.statusId(c.stage) === id || L.statusId(c.state) === id);
    });
  };
  L.kanbanColumn = function (c) {
    if (!c) return 'open';
    var state = L.statusId(c.state);
    var stage = L.statusId(c.stage) || 'open';
    if (state === 'closed' || stage === 'done') return 'done';
    return stage;
  };
  L.cardGithubUrl = function (c) {
    if (!c) return '';
    var url = String(c.url || '');
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/[0-9]+\/?$/.test(url)) return url;
    if (c.pinned && (c.number == null || !c.repo)) return '';
    if (!c.repo || c.number == null) return '';
    var kind = c.kind === 'issue' ? 'issues' : 'pull';
    return 'https://github.com/' + c.repo + '/' + kind + '/' + Number(c.number);
  };
  // Spectrum stream defaults on. The page also honors ?spectrum=0 and reduced motion.
  L.SPECTRUM = true;
})(window.LiveMesh);
