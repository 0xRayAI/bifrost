/* Bifrost overlay (our install only; app/deploy.sh copies house/live/site/public/ over the kit public/).
   Roster chips come from the feed roster (seat config union the node map). This file does not install a strip.
   The canvas draws the seats in SATS. Arch1 stays on the canvas as core dev.
   Parked seats are not drawn on the canvas. Blaze is the owner node.
   No Lead / Others node (unknown senders go to GitHub's node). No product node: burst-live IS the Bifrost board, never a node on it (Blaze 2026-10-14). */
(function (L) {
  'use strict';
  function reset(obj, next) { Object.keys(obj).forEach(function (k) { delete obj[k]; }); for (var k in next) obj[k] = next[k]; }
  var ROLE = { blinky: 'chief of staff', critic: 'reviewer', forge: 'eng primary', mill: 'implementer', near: 'NEAR scout', nibbler: 'feed scout', herald: 'outreach', arch1: 'core dev' };
  // The kit list is a template. The live roster replaces it when the feed arrives.
  L.AGENTS.splice(0, L.AGENTS.length);
  L.SEAT_NAMES.splice(0, L.SEAT_NAMES.length);
  // 920 x 400 canvas: a network. GitHub is the mesh at the center; seats and rails ring it (Blaze 2026-11-16).
  // CloudAgents is the cursor cloud-agent circle. Pings land on it, not on GitHub.
  reset(L.SATS, { GitHub: [460, 200], Blaze: [460, 50], forge: [640, 70], mill: [772, 125], near: [820, 200], nibbler: [772, 275],
    herald: [640, 330], Railway: [460, 335], Assistant: [280, 330], CloudAgents: [148, 275], arch1: [100, 200], blinky: [148, 125], critic: [280, 70] });
  var C = { blinky: [88, 210, 180], critic: [255, 150, 90], forge: [255, 140, 70], mill: [230, 190, 90], near: [120, 220, 140], nibbler: [190, 150, 240], herald: [240, 120, 180], arch1: [255, 120, 100],
    GitHub: [200, 210, 230], Blaze: [255, 120, 60], Railway: [170, 130, 255], CloudAgents: [130, 190, 255], Assistant: [116, 170, 156] };
  reset(L.COLOR, C);
  var RAIL = { GitHub: 1, Railway: 1, Blaze: 1, CloudAgents: 1, Assistant: 1, arch1: 1 };
  var drawn = Object.keys(L.SATS).filter(function (s) { return !RAIL[s]; });
  var LAB = { Blaze: 'Blaze', GitHub: 'GitHub', Railway: 'Railway', Assistant: 'Assistant', arch1: 'Arch1', CloudAgents: 'Cloud agents' };
  drawn.forEach(function (s) { LAB[s] = s; });
  reset(L.LABEL, LAB);
  var SUB = { Blaze: 'owner', GitHub: 'PRs · Issues', Railway: 'deploys', Assistant: 'MCP calls', arch1: 'core dev', CloudAgents: 'cursor agents' };
  drawn.forEach(function (s) { if (ROLE[s]) SUB[s] = ROLE[s]; });
  reset(L.SUB, SUB);
  reset(L.SQUARE, { GitHub: 1, Railway: 1 });
  L.EDGES.splice.apply(L.EDGES, [0, L.EDGES.length].concat(drawn.map(function (s) { return [s, 'GitHub']; }),
    [['arch1', 'GitHub'], ['Blaze', 'GitHub'], ['GitHub', 'Railway'], ['CloudAgents', 'GitHub'], ['Assistant', 'GitHub']]));
  // feed names -> our nodes: each drawn seat is its own node; Blaze / Lead / unknown senders / CI fold into GitHub
  var NK = L.NODE_KEY;
  drawn.forEach(function (s) { NK[s] = s; });
  NK.arch1 = 'arch1';
  NK.Coord = 'blinky'; NK.Blaze = 'Blaze'; NK.Blaze0x1 = 'Blaze'; NK.htafolla = 'Blaze'; NK.Lead = 'Blaze'; NK['lead-alt'] = 'Blaze'; NK['lead-login'] = 'Blaze';
  NK.Others = 'GitHub'; NK.other = 'GitHub'; NK.CI = 'GitHub';
  NK.CloudAgents = 'CloudAgents'; NK['Cloud agents'] = 'CloudAgents'; NK.cursoragent = 'CloudAgents';
  // burst-live IS the board: no node for it. Events to/from the board (its own deploys, /health, turn lines) are
  // dropped before the kit maps them, so nothing falls back to GitHub; hops through it are skipped.
  var BOARD = { Bifrost: 1, 'burst-live': 1, 'mymuse.house': 1 };
  delete NK.Bifrost; delete NK['burst-live'];
  var DEPLOY = { deploy: 1, deploy_fail: 1, deploy_pending: 1, op_deploy: 1 };
  function boardEnd(n) { return !!BOARD[n]; }
  function retarget(e) {
    var hops = (e.hops && e.hops.length) ? e.hops.slice() : [e.from, e.to];
    var touches = boardEnd(e.from) || boardEnd(e.to) || hops.some(boardEnd);
    if (!touches) return e;
    var kind = String(e.kind || '');
    if (kind.indexOf('seat_') === 0) {
      var seat = boardEnd(e.from) ? e.to : e.from;
      if (!seat || boardEnd(seat)) return null;
      return Object.assign({}, e, { from: seat, to: seat, hops: [seat] });
    }
    if (kind === 'merged' || kind === 'pr_close' || kind === 'issue_close') return e;
    if (DEPLOY[kind]) {
      var rail = hops.filter(function (h) { return h && !boardEnd(h); }).map(function (h) { return h === 'Operator' ? 'GitHub' : h; });
      if (rail.indexOf('GitHub') < 0) rail.unshift('GitHub');
      if (rail.indexOf('Railway') < 0) rail.push('Railway');
      var clean = [];
      rail.forEach(function (h) { if (clean[clean.length - 1] !== h) clean.push(h); });
      return Object.assign({}, e, { from: clean[0], to: clean[clean.length - 1], hops: clean });
    }
    return null;
  }
  var kitApply = L.applyFeed;
  L.applyFeed = function (state, feed, nowMs) {
    // Bifrost is the board, not a circle. CloudAgents stays a mesh node, so its events are not dropped.
    if (feed && Array.isArray(feed.events)) {
      var nodes = Array.isArray(feed.product_nodes) ? feed.product_nodes.filter(function (n) { return n && !BOARD[n]; }) : [];
      feed = Object.assign({}, feed, { product_nodes: nodes, events: feed.events.map(retarget).filter(Boolean) });
    }
    return kitApply(state, feed, nowMs);
  };
  L.FROM_FALLBACK = 'GitHub';
  L.REVIEW_SEAT = 'critic';
  // avatars we ship in avatars/ (arch1 = minime0x); Blaze = x.com/Blaze0x1 profile picture;
  // the rest use the drawn letter badge (no 404s).
  L.setAvatars({ blinky: 'blinky', critic: 'critic', forge: 'forge', near: 'near', herald: 'herald', arch1: 'arch1', Blaze: 'blaze' });
  L.GLYPH = Object.assign(L.GLYPH || {}, { nibbler: '\uD83E\uDEB1', mill: '\u2699\uFE0F' });
  L.SITE_FOOT = 'Bifrost · built in public';
})(window.LiveMesh);
