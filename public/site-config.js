/* Installs this deploy's fleet onto the mesh. window.FLEET_SPEC is generated at boot from
   the roster, site.json, and the owner name. An empty spec leaves the rail-only canvas. */
(function (L) {
  'use strict';
  var spec = window.FLEET_SPEC;
  if (!spec || typeof spec !== 'object') return;

  function reset(obj, next) {
    Object.keys(obj).forEach(function (k) { delete obj[k]; });
    Object.keys(next).forEach(function (k) { obj[k] = next[k]; });
  }
  var PALETTE = [
    [88, 210, 180], [255, 150, 90], [110, 170, 255], [240, 120, 180],
    [190, 150, 240], [230, 190, 90], [120, 220, 140], [255, 140, 120],
    [150, 200, 255], [255, 180, 100]
  ];
  var placed = spec.layout && spec.layout.sats ? spec.layout.sats : {};
  var customColor = spec.layout && spec.layout.colors ? spec.layout.colors : {};
  var customLabel = spec.layout && spec.layout.labels ? spec.layout.labels : {};
  var owner = String(spec.owner || '').trim();
  var drawn = (spec.seats || []).filter(function (s) { return s && s.id && !s.parked; });
  var sats = { GitHub: [460, 200], Railway: [460, 340], CloudAgents: [160, 300], Assistant: [760, 300] };
  if (owner) sats[owner] = [460, 48];
  drawn.forEach(function (s, i) {
    var n = drawn.length || 1;
    var a = -Math.PI / 2 + (i * 2 * Math.PI / n);
    sats[s.id] = [Math.round(460 + Math.cos(a) * 300), Math.round(200 + Math.sin(a) * 140)];
  });
  Object.keys(placed).forEach(function (k) {
    if (Array.isArray(placed[k]) && placed[k].length >= 2) sats[k] = placed[k];
  });
  reset(L.SATS, sats);

  var color = { GitHub: [200, 210, 230], Railway: [170, 130, 255], CloudAgents: [130, 190, 255], Assistant: [116, 170, 156] };
  if (owner) color[owner] = [255, 120, 60];
  drawn.forEach(function (s, i) { color[s.id] = PALETTE[i % PALETTE.length]; });
  Object.keys(customColor).forEach(function (k) { if (Array.isArray(customColor[k])) color[k] = customColor[k]; });
  reset(L.COLOR, color);

  var label = { GitHub: 'GitHub', Railway: 'Railway', CloudAgents: 'Cloud agents', Assistant: 'Assistant' };
  if (owner) label[owner] = owner;
  drawn.forEach(function (s) { label[s.id] = s.id; });
  Object.keys(customLabel).forEach(function (k) { if (customLabel[k]) label[k] = String(customLabel[k]); });
  reset(L.LABEL, label);

  var sub = { GitHub: 'PRs · Issues', Railway: 'deploys', CloudAgents: 'cursor agents', Assistant: 'MCP calls' };
  if (owner) sub[owner] = 'owner';
  drawn.forEach(function (s) { if (s.role) sub[s.id] = s.role; });
  reset(L.SUB, sub);
  reset(L.SQUARE, { GitHub: 1, Railway: 1 });
  reset(L.GLYPH, {});

  var edges = [];
  Object.keys(sats).forEach(function (k) { if (k !== 'GitHub') edges.push([k, 'GitHub']); });
  L.EDGES.splice(0, L.EDGES.length);
  edges.forEach(function (e) { L.EDGES.push(e); });

  L.AGENTS.splice(0, L.AGENTS.length);
  L.SEAT_NAMES.splice(0, L.SEAT_NAMES.length);
  (spec.seats || []).forEach(function (s) {
    if (!s || !s.id) return;
    L.AGENTS.push([s.id, s.role || '']);
    L.SEAT_NAMES.push(s.id);
  });

  var NK = L.NODE_KEY || {};
  L.NODE_KEY = NK;
  Object.keys(sats).forEach(function (k) { NK[k] = k; });
  var aliases = spec.aliases || {};
  L.SEAT_ALIAS = aliases;
  Object.keys(aliases).forEach(function (from) { if (aliases[from]) NK[from] = aliases[from]; });

  L.OUTSIDE_SEATS = {};
  (spec.seats || []).forEach(function (s) { if (s && s.outside && s.id) L.OUTSIDE_SEATS[s.id] = 1; });
  L.OUTSIDE_LOGIN = spec.outside_logins || {};
  L.REVIEW_SEAT = spec.review || null;
  L.FROM_FALLBACK = 'GitHub';
  if (typeof L.setAvatars === 'function') {
    var files = {};
    (spec.avatars || []).forEach(function (id) { files[id] = String(id).toLowerCase(); });
    if (owner && files[owner.toLowerCase()]) files[owner] = owner.toLowerCase();
    L.setAvatars(files);
  }
  if (spec.foot) L.SITE_FOOT = spec.foot;

  var BOARD = {};
  (spec.board_names || []).forEach(function (n) { if (n) BOARD[n] = 1; });
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
      var rail = hops.filter(function (h) { return h && !boardEnd(h); });
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
    if (feed && Array.isArray(feed.events)) {
      var nodes = Array.isArray(feed.product_nodes) ? feed.product_nodes.filter(function (n) { return n && !BOARD[n]; }) : [];
      feed = Object.assign({}, feed, { product_nodes: nodes, events: feed.events.map(retarget).filter(Boolean) });
    }
    return kitApply(state, feed, nowMs);
  };
})(window.LiveMesh);
