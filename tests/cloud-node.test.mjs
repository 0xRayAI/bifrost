// CloudAgents stays on the mesh. Open agents light it. An empty set keeps last_ct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCloudOwners, stampCloudMesh } from '../worktrack.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a non-empty open set lights CloudAgents and an empty set keeps last_ct', () => {
  const lit = stampCloudMesh({
    product_nodes: ['Bifrost'],
    fleet: {
      seats: { forge: { working: true, last_ct: '2026-10-28T12:00:00Z' } },
      working: { forge: { via: 'prompt' } },
      cloud: { open_agents: ['bc-1'], last_ct: '2026-10-28T13:00:00Z' },
    },
  });
  assert.deepEqual(lit.product_nodes, ['Bifrost', 'CloudAgents']);
  assert.equal(lit.fleet.cloud.working, true);
  assert.equal(lit.fleet.cloud.active, true);
  assert.deepEqual(lit.fleet.cloud.open_agents, ['bc-1']);
  assert.equal(lit.fleet.seats.forge.working, true);
  assert.ok(lit.fleet.working.forge);
  assert.ok(lit.fleet.working.CloudAgents);

  const idle = stampCloudMesh({
    product_nodes: ['Bifrost'],
    fleet: { cloud: { open_agents: [], last_ct: '2026-10-28T12:00:00Z', working: true, github_last_ct: '2026-10-28T11:00:00Z' } },
  });
  assert.ok(idle.product_nodes.includes('CloudAgents'));
  assert.equal(idle.fleet.cloud.working, false);
  assert.equal(idle.fleet.cloud.active, false);
  assert.equal(idle.fleet.cloud.last_ct, '2026-10-28T12:00:00Z');
  assert.deepEqual(idle.fleet.cloud.open_agents, []);
  assert.equal(idle.fleet.working.CloudAgents, undefined);

  const fromGithub = stampCloudMesh({
    product_nodes: ['Bifrost'],
    fleet: { cloud: { open_agents: [], github_last_ct: '2026-10-28T09:00:00Z' } },
  });
  assert.equal(fromGithub.fleet.cloud.last_ct, '2026-10-28T09:00:00Z');
  assert.ok(fromGithub.product_nodes.includes('CloudAgents'));

  const bare = stampCloudMesh({});
  assert.deepEqual(bare.product_nodes, ['CloudAgents']);
  assert.deepEqual(bare.fleet.cloud.open_agents, []);
  assert.equal(bare.fleet.cloud.last_ct, null);
  assert.equal(bare.fleet.cloud.working, false);
});

function loadMesh() {
  const L = {
    SOURCES: [], AGENTS: [], SEAT_NAMES: [], SATS: {}, COLOR: {}, LABEL: {}, SUB: {}, GLYPH: {}, SQUARE: {}, EDGES: [],
    BOT_IMAGES: [], KIND_WORD: {}, NODE_KEY: {},
    applyFeed(state, feed) { return { state: { events: feed.events || [] }, feed, added: [] }; },
  };
  const window = {
    LiveMesh: L,
    FLEET_SPEC: {
      name: 'Bifrost',
      title: 'Bifrost',
      board_names: ['Bifrost', 'burst-live'],
      seats: [
        { id: 'forge', role: 'eng primary' },
        { id: 'critic', role: 'reviewer' },
      ],
      layout: {},
    },
  };
  new Function('window', 'location', fs.readFileSync(path.join(APP, 'public', 'live-config.js'), 'utf8'))(window, { search: '' });
  new Function('window', fs.readFileSync(path.join(APP, 'public', 'site-config.js'), 'utf8'))(window);
  return L;
}

test('the first seat does not cover the owner', () => {
  const live = fs.readFileSync(path.join(APP, 'public', 'live.js'), 'utf8');
  const prev = globalThis.LiveMesh;
  new Function(live)();
  const seats = ['arch1', 'forge', 'critic', 'blinky', 'herald', 'nibbler', 'sound', 'magnet', 'mill', 'near']
    .map(id => ({ id, role: 'seat' }));
  function load(spec) {
    globalThis.FLEET_SPEC = spec;
    new Function('window', 'location', fs.readFileSync(path.join(APP, 'public', 'live-config.js'), 'utf8'))(globalThis, { search: '' });
    new Function('window', fs.readFileSync(path.join(APP, 'public', 'site-config.js'), 'utf8'))(globalThis);
    return globalThis.LiveMesh.SATS;
  }
  function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  const sats = load({ owner: 'Blaze', name: 'Bifrost', title: 'Bifrost', seats, layout: { sats: {} }, aliases: {} });
  assert.ok(dist(sats.Blaze, sats.arch1) >= 80, 'arch1 covers Blaze');
  assert.ok(dist(sats.Railway, sats.nibbler) >= 80, 'a seat covers Railway');
  const ids = Object.keys(sats);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      assert.ok(dist(sats[ids[i]], sats[ids[j]]) >= 50, `${ids[i]} covers ${ids[j]}`);
    }
  }
  const placed = load({
    owner: 'Blaze', name: 'Bifrost', title: 'Bifrost', seats: [{ id: 'arch1', role: 'seat' }],
    layout: { sats: { arch1: [12, 34] } }, aliases: {},
  });
  assert.deepEqual(placed.arch1, [12, 34]);
  if (prev) globalThis.LiveMesh = prev;
});

test('owner and a lowercase seat name draw on the mesh', () => {
  const live = fs.readFileSync(path.join(APP, 'public', 'live.js'), 'utf8');
  const prev = globalThis.LiveMesh;
  new Function(live)();
  const window = globalThis;
  window.FLEET_SPEC = {
    owner: 'Blaze', name: 'Bifrost', title: 'Bifrost', seats: [{ id: 'forge', role: 'eng' }], layout: {}, aliases: {},
  };
  new Function('window', 'location', fs.readFileSync(path.join(APP, 'public', 'live-config.js'), 'utf8'))(window, { search: '' });
  new Function('window', fs.readFileSync(path.join(APP, 'public', 'site-config.js'), 'utf8'))(window);
  const mesh = window.LiveMesh;
  assert.deepEqual(mesh.resolveNodes({ kind: 'seat_prompt', from: 'owner', to: 'forge' }), ['Blaze', 'forge']);
  assert.deepEqual(mesh.resolveNodes({ kind: 'seat_prompt', from: 'blaze', to: 'Forge' }), ['Blaze', 'forge']);
  if (prev) globalThis.LiveMesh = prev;
});

test('the page keeps CloudAgents and drops only the board name', () => {
  const L = loadMesh();
  const out = L.applyFeed({ events: [] }, {
    product_nodes: ['Bifrost', 'CloudAgents'],
    events: [
      { id: 'c1', from: 'CloudAgents', to: 'GitHub', kind: 'pr_commit', hops: ['CloudAgents', 'GitHub'] },
      { id: 'b1', from: 'Bifrost', to: 'GitHub', kind: 'health_ok', hops: ['Bifrost', 'GitHub'] },
      { id: 'f1', from: 'forge', to: 'GitHub', kind: 'pr_open', hops: ['forge', 'GitHub'] },
    ],
  }, Date.now());
  assert.deepEqual(out.feed.product_nodes, ['CloudAgents']);
  assert.deepEqual(out.feed.events.map(e => e.id), ['c1', 'f1']);
});

test('roster working and CloudAgents light the same way on the mesh', () => {
  const L = loadMesh();
  const fleet = {
    seats: { Forge: { working: true }, critic: { working: false, last_ct: '2026-10-28T12:00:00Z' } },
    working: {},
    cloud: { open_agents: ['bc-9'], last_ct: '2026-10-28T14:00:00Z' },
  };
  assert.equal(L.meshWorking(fleet, 'forge'), true);
  assert.equal(L.meshWorking(fleet, 'critic'), false);
  assert.equal(L.meshWorking(fleet, 'CloudAgents'), true);
  assert.equal(L.cloudNode(fleet).lit, true);
  assert.equal(L.cloudNode(fleet).last_ct, '2026-10-28T14:00:00Z');
  const quiet = { cloud: { open_agents: [], last_ct: '2026-10-28T08:00:00Z' } };
  assert.equal(L.cloudNode(quiet).lit, false);
  assert.equal(L.cloudNode(quiet).present, true);
  assert.equal(L.cloudNode(quiet).last_ct, '2026-10-28T08:00:00Z');
  assert.equal(L.meshWorking(quiet, 'CloudAgents'), false);
  assert.equal(L.seatState(L.meshWorking(fleet, 'forge'), false, true), 'working');
  assert.equal(L.seatView('working').lit, true);
  const rows = [['forge', 'eng'], ['critic', 'reviewer'], ['herald', '']];
  assert.deepEqual(L.rosterKept(rows, { fleet: { seats: {} }, product_nodes: ['CloudAgents'] }).map(a => a[0]), []);
  assert.deepEqual(L.rosterKept(rows, { fleet }).map(a => a[0]), ['forge', 'critic']);
});

test('a cloud finish moves last_ct to that finish and leaves open_agents empty', () => {
  const finish = '2026-10-28T07:23:00-05:00';
  const old = '2026-10-27T05:34:00-05:00';
  const id = 'bc-043681df-9a95-5788-b990-e393349b3d53';
  const rows = [{ bcId: id, seat: 'critic', state: 'finished', updated_ct: finish }];
  const fleet = applyCloudOwners({
    seats: { critic: { working: false } },
    working: {},
    cloud: { open_agents: [id], last_ct: old, github_last_ct: old, active: true, working: true },
  }, rows, Date.parse('2026-10-28T18:00:00Z'));
  const header = stampCloudMesh({ product_nodes: ['Bifrost'], fleet }, rows);
  assert.ok(Date.parse(header.fleet.cloud.last_ct) >= Date.parse(finish));
  assert.deepEqual(header.fleet.cloud.open_agents, []);
  assert.equal(header.fleet.cloud.working, false);
  assert.equal(header.fleet.cloud.active, false);
  const running = [{ bcId: 'bc-running123', state: 'running', updated_ct: finish }];
  const live = stampCloudMesh({ fleet: { cloud: { open_agents: [], last_ct: old } } }, running);
  assert.deepEqual(live.fleet.cloud.open_agents, ['bc-running123']);
  assert.equal(live.fleet.cloud.working, true);
  assert.ok(Date.parse(live.fleet.cloud.last_ct) >= Date.parse(finish));
});
