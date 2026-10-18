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

/** Default corvette-class hauler: six decks stacked on the torch, central ladder shaft. */
export function createDefaultLayout() {
  return [
    {
      name: 'Bridge', id: 'bridge',
      glow: { color: 'rgba(91, 192, 235, 0.06)', accent: '#5BC0EB' },
      tiles: [
        [E, HW, HW, HW, HW, HW, HW, HW, E],
        [HW, T.RADIO, CC, F, F, F, CC, T.TRANSPONDER, HW],
        [HW, T.EVA_LOCKER, F, F, T.NAV_CONSOLE, F, F, T.EVA_LOCKER, HW],
        [HW, F, F, F, L, F, F, F, HW],
      ],
    },
    {
      name: 'Quarters', id: 'quarters',
      glow: { color: 'rgba(192, 132, 252, 0.04)', accent: '#C084FC' },
      tiles: [
        [HW, T.TERMINAL, CC, F, L, F, CC, T.TERMINAL, HW],
        [HW, T.EVA_LOCKER, F, F, F, F, F, T.EVA_LOCKER, HW],
        [HW, F, F, F, L, F, T.MEDBAY, F, HW],
      ],
    },
    {
      name: 'Mess', id: 'mess',
      glow: { color: 'rgba(107, 203, 119, 0.04)', accent: '#6BCB77' },
      tiles: [
        [HW, T.EVA_LOCKER, F, F, L, F, F, T.EVA_LOCKER, HW],
        [HW, T.TERMINAL, CC, F, F, F, CC, T.TERMINAL, HW],
        [HW, F, F, F, L, F, T.LIFE_SUPPORT, F, HW],
      ],
    },
    {
      name: 'Cargo', id: 'cargo',
      glow: { color: 'rgba(79, 209, 197, 0.03)', accent: '#4FD1C5' },
      tiles: [
        [HW, T.TERMINAL, CC, F, L, F, CC, T.TERMINAL, HW],
        [HW, T.STORAGE, T.STORAGE, F, F, F, T.STORAGE, T.STORAGE, HW],
        [HW, T.AIRLOCK, T.EVA_LOCKER, F, L, F, T.EVA_LOCKER, T.STORAGE, HW],
      ],
    },
    {
      name: 'Engine', id: 'engineering',
      glow: { color: 'rgba(226, 163, 85, 0.06)', accent: '#E2A355' },
      tiles: [
        [HW, T.TERMINAL, CC, F, L, F, CC, T.TERMINAL, HW],
        [HW, T.EVA_LOCKER, F, F, F, F, F, T.EVA_LOCKER, HW],
        [HW, F, T.ENGINE, F, L, F, T.ENGINE, F, HW],
      ],
    },
    {
      name: 'Reactor', id: 'reactor',
      glow: { color: 'rgba(226, 85, 85, 0.06)', accent: '#E25555' },
      tiles: [
        [E, HW, HW, F, L, F, HW, HW, E],
        [E, HW, T.EVA_LOCKER, F, T.REACTOR, F, T.EVA_LOCKER, HW, E],
        [E, E, HW, HW, HW, HW, HW, E, E],
      ],
    },
  ];
}

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
  const KIND = {
    [T.CRASH_COUCH]: 'couch', [T.MEDBAY]: 'medbay', [T.EVA_LOCKER]: 'locker',
    [T.LIFE_SUPPORT]: 'lifeSupport', [T.REACTOR]: 'reactor', [T.TERMINAL]: 'terminal',
    [T.RADIO]: 'radio', [T.TRANSPONDER]: 'transponder', [T.NAV_CONSOLE]: 'nav',
    [T.AIRLOCK]: 'airlock', [T.ENGINE]: 'engine', [T.STORAGE]: 'storage',
  };
  decks.forEach((deck, di) => deck.tiles.forEach((row, ry) => row.forEach((t, rx) => {
    const kind = KIND[t];
    if (!kind) return;
    const self = index.get(key(di, rx, ry));
    let access = self;
    if (access === undefined) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = index.get(key(di, rx + dx, ry + dy));
        if (n !== undefined) { access = n; break; }
      }
    }
    add(kind, { kind, deck: di, x: rx, y: ry, sx: rx, sy: deckStart[di] + ry, access: access ?? null, id: `${kind}:${di}:${rx}:${ry}` });
  })));

  // Ship coords → deck lookup
  const deckOfRow = (sy) => {
    for (let di = decks.length - 1; di >= 0; di--) if (sy >= deckStart[di] - 0.5) return di;
    return 0;
  };

  return { deckStart, totalRows, cols, nodes, index, adj, shafts, fixtures, deckOfRow, key };
}

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
 * Shortest walk between graph nodes (Dijkstra; graphs are ~150 nodes).
 * Returns ship-coord waypoints from (excluding) start to (including) goal, or null.
 */
export function findPath(geo, from, to) {
  if (from < 0 || to < 0) return null;
  if (from === to) return [];
  const n = geo.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === to) break;
    done[u] = 1;
    for (const { to: v, cost } of geo.adj[u]) {
      const nd = dist[u] + cost;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  if (dist[to] === Infinity) return null;
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

/** Walkable nodes on a deck (for patrols). */
export function deckNodes(geo, deck) {
  const out = [];
  geo.nodes.forEach((n, i) => { if (n.deck === deck && n.tile !== TileType.LADDER) out.push(i); });
  return out;
}
