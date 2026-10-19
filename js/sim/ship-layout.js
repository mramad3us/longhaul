// ============================================================
// LONGHAUL — Ship layout, geometry & crew pathfinding
//
// Ship coordinates: x = tile column, y = tile row counted from the bow
// across ALL decks, with a one-row gap between decks (the deck
// plating / ladder shaft). Crew positions are continuous ship coords.
// ============================================================

import { TileType, WALKABLE, TILE_MASS } from './tiles.js';

export const DECK_GAP = 1;

const T = TileType;
const E = T.EMPTY, HW = T.HULL_WALL, F = T.FLOOR, L = T.LADDER, CC = T.CRASH_COUCH;
const EV = T.EVA_LOCKER, BK = T.BUNK, TB = T.TABLE, ST = T.STORAGE;

/**
 * Default corvette-class hauler: seven decks stacked on the torch, one
 * ladder shaft down the spine. Bow first: command, living, working,
 * cargo, then the machinery.
 */
export function createDefaultLayout() {
  return [
    {
      name: 'Bridge', id: 'bridge',
      glow: { color: 'rgba(91, 192, 235, 0.06)', accent: '#5BC0EB' },
      tiles: [
        [E, HW, HW, HW, HW, HW, HW, HW, E],
        [HW, T.RADIO, T.OPS_CONSOLE, F, T.NAV_CONSOLE, F, CC, T.TRANSPONDER, HW],
        [HW, F, F, F, F, F, F, F, HW],
        [HW, EV, CC, F, L, F, CC, EV, HW],
      ],
    },
    {
      name: 'Quarters', id: 'quarters',
      glow: { color: 'rgba(192, 132, 252, 0.04)', accent: '#C084FC' },
      tiles: [
        [HW, BK, BK, F, L, F, BK, BK, HW],
        [HW, F, F, F, F, F, F, F, HW],
        [HW, T.HEAD, CC, F, L, F, CC, EV, HW],
      ],
    },
    {
      name: 'Mess', id: 'mess',
      glow: { color: 'rgba(107, 203, 119, 0.04)', accent: '#6BCB77' },
      tiles: [
        [HW, T.GALLEY, F, TB, L, TB, F, T.REC, HW],
        [HW, F, F, F, F, F, F, F, HW],
        [HW, EV, CC, F, L, F, CC, T.MEDBAY, HW],
      ],
    },
    {
      name: 'Utility', id: 'utility',
      glow: { color: 'rgba(91, 192, 235, 0.03)', accent: '#7EC8E3' },
      tiles: [
        [HW, T.LIFE_SUPPORT, F, F, L, F, F, T.WATER_RECYCLER, HW],
        [HW, F, F, F, F, F, F, F, HW],
        [HW, T.WORKBENCH, CC, F, L, F, CC, EV, HW],
      ],
    },
    {
      name: 'Cargo', id: 'cargo',
      glow: { color: 'rgba(79, 209, 197, 0.03)', accent: '#4FD1C5' },
      tiles: [
        [HW, ST, ST, F, L, F, ST, ST, HW],
        [HW, F, F, F, F, F, F, ST, HW],
        [HW, T.AIRLOCK, EV, F, L, F, EV, ST, HW],
      ],
    },
    {
      name: 'Engine', id: 'engineering',
      glow: { color: 'rgba(226, 163, 85, 0.06)', accent: '#E2A355' },
      tiles: [
        [HW, T.ENG_CONSOLE, F, CC, L, CC, F, EV, HW],
        [HW, F, F, F, F, F, F, F, HW],
        [HW, EV, T.ENGINE, F, L, F, T.ENGINE, F, HW],
      ],
    },
    {
      name: 'Reactor', id: 'reactor',
      glow: { color: 'rgba(226, 85, 85, 0.06)', accent: '#E25555' },
      tiles: [
        [E, HW, HW, F, L, F, HW, HW, E],
        [E, HW, EV, F, T.REACTOR, F, EV, HW, E],
        [E, E, HW, HW, HW, HW, HW, E, E],
      ],
    },
  ];
}

/** Deck index by layout id (decks can be reordered without breaking callers). */
export function deckIndex(ship, id) {
  return ship.decks.findIndex(d => d.id === id);
}

// ---- SEATS ----
// Fixtures a crew member occupies (moves onto). Secure seats protect
// against sustained G (couch gel, juice); restraints only against being
// thrown around (a sleeper in a bunk is strapped in, but not juiced).

export const SEAT_KINDS = new Set(['couch', 'helm', 'ops', 'engStation', 'medbay', 'bunk', 'head', 'rec']);
const SECURE_SEATS = new Set(['couch', 'helm', 'ops', 'engStation', 'medbay']);
const RESTRAINTS = new Set([...SECURE_SEATS, 'bunk']);

export const seatKind = (seatId) => seatId ? seatId.slice(0, seatId.indexOf(':')) : null;
export const isSecureSeat = (seatId) => SECURE_SEATS.has(seatKind(seatId));
export const isRestraint = (seatId) => RESTRAINTS.has(seatKind(seatId));

export function computeShipMass(ship, crewMassKg = 75) {
  let total = 0;
  for (const deck of ship.decks) for (const row of deck.tiles) for (const t of row) total += TILE_MASS[t] || 0;
  return total + ship.crew.length * crewMassKg;
}

// ---- GEOMETRY (cached per layout) ----

const _geo = new WeakMap();

/**
 * Derived geometry for a ship's decks: row offsets, walk graph, fixtures.
 * Cached on the decks array identity.
 */
export function shipGeometry(ship) {
  let g = _geo.get(ship.decks);
  if (!g) { g = buildGeometry(ship.decks); _geo.set(ship.decks, g); }
  return g;
}

function buildGeometry(decks) {
  const deckStart = [];
  let y = 0;
  for (const d of decks) { deckStart.push(y); y += d.tiles.length + DECK_GAP; }
  const totalRows = y - DECK_GAP;
  const cols = Math.max(...decks.map(d => d.tiles[0].length));

  // Nodes: walkable tiles
  const nodes = [];
  const index = new Map();
  const key = (d, x, yy) => `${d},${x},${yy}`;
  decks.forEach((deck, di) => {
    deck.tiles.forEach((row, ry) => row.forEach((t, rx) => {
      if (!WALKABLE.has(t)) return;
      index.set(key(di, rx, ry), nodes.length);
      nodes.push({ deck: di, x: rx, y: ry, sx: rx, sy: deckStart[di] + ry, tile: t });
    }));
  });
  const adj = nodes.map(() => []);
  const link = (a, b, cost) => { adj[a].push({ to: b, cost }); adj[b].push({ to: a, cost }); };
  nodes.forEach((n, i) => {
    const right = index.get(key(n.deck, n.x + 1, n.y));
    const down = index.get(key(n.deck, n.x, n.y + 1));
    if (right !== undefined) link(i, right, 1);
    if (down !== undefined) link(i, down, 1);
  });
  // Ladder shafts between decks
  const shafts = [];
  for (let di = 0; di < decks.length - 1; di++) {
    const a = decks[di], b = decks[di + 1];
    const lastRow = a.tiles.length - 1;
    for (let x = 0; x < cols; x++) {
      if (a.tiles[lastRow]?.[x] === T.LADDER && b.tiles[0]?.[x] === T.LADDER) {
        link(index.get(key(di, x, lastRow)), index.get(key(di + 1, x, 0)), 1 + DECK_GAP);
        shafts.push({ upper: di, lower: di + 1, x });
      }
    }
  }

  // Fixtures (furniture crew interact with), each with an access node
  const fixtures = {};
  const add = (kind, f) => (fixtures[kind] ||= []).push(f);
  decks.forEach((deck, di) => deck.tiles.forEach((row, ry) => row.forEach((t, rx) => {
    const kind = FIXTURE_KIND[t];
    if (!kind) return;
    const self = index.get(key(di, rx, ry));
    // Access: where a crew member stands to use it — open floor preferred
    // over the ladder shaft or a doorway
    let access = self, fallback;
    if (access === undefined) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = index.get(key(di, rx + dx, ry + dy));
        if (n === undefined) continue;
        if (nodes[n].tile === T.FLOOR) { access = n; break; }
        fallback ??= n;
      }
      access ??= fallback;
    }
    add(kind, { kind, deck: di, x: rx, y: ry, sx: rx, sy: deckStart[di] + ry, access: access ?? null, id: `${kind}:${di}:${rx}:${ry}` });
  })));
  const fixtureById = new Map();
  for (const list of Object.values(fixtures)) for (const f of list) fixtureById.set(f.id, f);

  // Ship coords → deck lookup
  const deckOfRow = (sy) => {
    for (let di = decks.length - 1; di >= 0; di--) if (sy >= deckStart[di] - 0.5) return di;
    return 0;
  };

  return { deckStart, totalRows, cols, nodes, index, adj, shafts, fixtures, fixtureById, deckOfRow, key, trees: new Map() };
}

/** Tile type → fixture kind (the furniture crew walk to and use). */
export const FIXTURE_KIND = {
  [T.CRASH_COUCH]: 'couch', [T.MEDBAY]: 'medbay', [T.EVA_LOCKER]: 'locker',
  [T.LIFE_SUPPORT]: 'lifeSupport', [T.REACTOR]: 'reactor', [T.TERMINAL]: 'terminal',
  [T.RADIO]: 'radio', [T.TRANSPONDER]: 'transponder', [T.NAV_CONSOLE]: 'helm',
  [T.AIRLOCK]: 'airlock', [T.ENGINE]: 'engine', [T.STORAGE]: 'storage',
  [T.BUNK]: 'bunk', [T.TABLE]: 'table', [T.GALLEY]: 'galley', [T.HEAD]: 'head',
  [T.WATER_RECYCLER]: 'recycler', [T.WORKBENCH]: 'workbench', [T.OPS_CONSOLE]: 'ops',
  [T.ENG_CONSOLE]: 'engStation', [T.REC]: 'rec',
};

/** Node index nearest to a ship-coord point (same deck preferred). */
export function nearestNode(geo, sx, sy) {
  const deck = geo.deckOfRow(sy);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < geo.nodes.length; i++) {
    const n = geo.nodes[i];
    const d = (n.sx - sx) ** 2 + (n.sy - sy) ** 2 + (n.deck === deck ? 0 : 100);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Shortest-path tree from one node (Dijkstra). Trees are cached per
 * source on the geometry, so a crew of eight walking all day costs one
 * Dijkstra per distinct starting tile — then path lookups are O(length).
 */
function treeFrom(geo, from) {
  let prev = geo.trees.get(from);
  if (prev) return prev;
  const n = geo.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const { to: v, cost } of geo.adj[u]) {
      const nd = dist[u] + cost;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  geo.trees.set(from, prev);
  return prev;
}

/**
 * Shortest walk between graph nodes.
 * Returns ship-coord waypoints from (excluding) start to (including) goal, or null.
 */
export function findPath(geo, from, to) {
  if (from < 0 || to < 0) return null;
  if (from === to) return [];
  const prev = treeFrom(geo, from);
  if (prev[to] < 0) return null;
  const chain = [];
  for (let v = to; v !== from; v = prev[v]) chain.push(v);
  chain.reverse();
  const pts = [];
  let last = geo.nodes[from];
  for (const v of chain) {
    const node = geo.nodes[v];
    if (node.deck !== last.deck) {
      // climb through the shaft gap
      pts.push({ sx: last.sx, sy: (last.sy + node.sy) / 2 });
    }
    pts.push({ sx: node.sx, sy: node.sy });
    last = node;
  }
  return pts;
}

/** Walking distance between two nodes (tiles), Infinity if unreachable. */
export function walkDistance(geo, from, to) {
  if (from === to) return 0;
  const prev = treeFrom(geo, from);
  if (prev[to] < 0) return Infinity;
  let d = 0;
  for (let v = to; v !== from; v = prev[v]) d += geo.nodes[v].deck !== geo.nodes[prev[v]].deck ? 1 + DECK_GAP : 1;
  return d;
}

/** Walkable nodes on a deck (for patrols). */
export function deckNodes(geo, deck) {
  const out = [];
  geo.nodes.forEach((n, i) => { if (n.deck === deck && n.tile !== TileType.LADDER) out.push(i); });
  return out;
}
