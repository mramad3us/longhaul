// ============================================================
// LONGHAUL — Ship layout, geometry & crew pathfinding
//
// Our ship's interior is generated from its class's deck program: the
// decks a hull of that kind has, bow to stern, each drawn from a deck
// template and fitted to the class. The hull model (hulls.js) is built
// from the same program, so a docking collar on the outside opens onto
// an airlock on the right deck inside.
//
// Ship coordinates: x = tile column, y = tile row counted from the bow
// across ALL decks, with a one-row gap between decks (the deck
// plating / ladder shaft). Crew positions are continuous ship coords.
//
// Furniture faces open floor, its back to a wall if it has one
// (fixtureFacing: the room cameras draw it that way too, ui/roomcam.js).
// A mess table has its places (tableSpots): two stools at its front, a
// third at an end that opens onto floor nobody uses furniture from, and
// standing room at its front corners and, with floor behind it, its back;
// the galley's counter two places side by side, then waiting room on the
// open floor nearest it (counterSpots). Each crew member takes a place
// nobody else holds (crew-ai.js).
// ============================================================

import { TileType, WALKABLE, TILE_MASS } from './tiles.js';
import { CLASSES, PLAYER_CLASS, PLAYER_MAX_CREW, isArmed } from './ship-classes.js';

export const DECK_GAP = 1;

const T = TileType;

// ---- DECK ART ----
// Decks are drawn as strings, one character per tile, bow at the top of
// each deck. Hull walls are the outer columns; the ladder runs down the
// middle column.

const LEGEND = {
  ' ': T.EMPTY, '#': T.HULL_WALL, '.': T.FLOOR, '|': T.LADDER, '+': T.DOOR,
  c: T.CRASH_COUCH, e: T.EVA_LOCKER, b: T.BUNK, t: T.TABLE, s: T.STORAGE, p: T.PAX_BERTH,
  R: T.RADIO, O: T.OPS_CONSOLE, H: T.NAV_CONSOLE, W: T.WEAPONS_CONSOLE, X: T.TRANSPONDER,
  h: T.HEAD, g: T.GALLEY, r: T.REC, M: T.MEDBAY, L: T.LIFE_SUPPORT, w: T.WATER_RECYCLER, B: T.WORKBENCH,
  A: T.AIRLOCK, C: T.CARGO_DOOR, E: T.ENG_CONSOLE, D: T.ENGINE, P: T.PDC_MOUNT, T: T.TORPEDO_LAUNCHER, N: T.REACTOR,
};

/**
 * Deck templates by width (7 tiles for small craft, 9 for the rest). In a
 * template, 'A' marks where an airlock may be cut through the hull and 'C'
 * a cargo door: the deck program decides whether they are (otherwise
 * they are hull wall). 'P' (a PDC turret well) and 'T' (the launcher bay)
 * follow the class's fit, as 'W' (fire control) does.
 */
const TEMPLATES = {
  7: {
    command: [' ##^## ', '#RH.OX#', 'A.....#', '#eW|ce#'],
    quarters: ['#bb|bb#', '#.....#', '#gt|rh#'],
    passengers: ['#pp|pp#', '#.....#', '#c.|.e#'],
    utility: ['#L.|.w#', 'A.....#', '#Bc|cM#'],
    cargo: ['#Ts|ss#', 'A.....C', '#e.|.e#'],
    engineering: ['#Ec|ce#', 'P.....P', '#D.|.D#'],
    reactor: [' #.|.# ', ' #eNe# ', '  ###  '],
  },
  9: {
    command: [' ###^### ', '#ROH.WcX#', 'A.......#', '#ec.|.ce#'],
    quarters: ['#bb.|.bb#', '#.......#', '#hc.|.ce#'],
    'quarters-6': ['#bbb|bbb#', '#.......#', '#he.|.ce#'],
    'crew-mess': ['#bb.|.gt#', '#.......#', '#hM.|.cr#'],
    passengers: ['#pp.|.pp#', '#.......#', '#h..|..e#'],
    'passengers-8': ['#ppp|ppp#', '#.......#', '#pph|.pe#'],
    brig: ['#ppp|ppp#', '#+.....+#', '#e..|..e#'],
    mess: ['#g.t|t.r#', '#.......#', '#ec.|.cM#'],
    utility: ['#L..|..w#', 'A.......#', '#Bc.|.ce#'],
    cargo: ['#Ts.|.ss#', 'A.......C', '#ee.|.ss#'],
    'cargo-tall': ['#Ts.|.ss#', '#.......#', 'A.......C', '#ss.|.ss#'],
    engineering: ['#E.c|c.e#', 'P.......P', '#eD.|.D.#'],
    reactor: [' ##.|.## ', ' #e.N.e# ', '  #####  '],
  },
};

/** How each deck looks and what zone of the ship it is. */
const DECK_INFO = {
  bridge: { name: 'Bridge', zone: 'command', glow: { color: 'rgba(91, 192, 235, 0.06)', accent: '#5BC0EB' } },
  quarters: { name: 'Quarters', zone: 'crew', glow: { color: 'rgba(192, 132, 252, 0.04)', accent: '#C084FC' } },
  passengers: { name: 'Passengers', zone: 'pax', glow: { color: 'rgba(217, 178, 106, 0.05)', accent: '#D9B26A' } },
  passengers2: { name: 'Passengers', zone: 'pax', glow: { color: 'rgba(217, 178, 106, 0.05)', accent: '#D9B26A' } },
  brig: { name: 'Brig', zone: 'pax', glow: { color: 'rgba(226, 85, 85, 0.04)', accent: '#C05050' } },
  mess: { name: 'Mess', zone: 'crew', glow: { color: 'rgba(107, 203, 119, 0.04)', accent: '#6BCB77' } },
  utility: { name: 'Utility', zone: 'crew', glow: { color: 'rgba(91, 192, 235, 0.03)', accent: '#7EC8E3' } },
  cargo: { name: 'Cargo', zone: 'cargo', glow: { color: 'rgba(79, 209, 197, 0.03)', accent: '#4FD1C5' } },
  cargo2: { name: 'Cargo', zone: 'cargo', glow: { color: 'rgba(79, 209, 197, 0.03)', accent: '#4FD1C5' } },
  engineering: { name: 'Engine', zone: 'machinery', glow: { color: 'rgba(226, 163, 85, 0.06)', accent: '#E2A355' } },
  reactor: { name: 'Reactor', zone: 'reactor', glow: { color: 'rgba(226, 85, 85, 0.06)', accent: '#E25555' } },
};

// ---- DECK PROGRAMS ----
// Every class a small crew can fly has its own deck program: which decks,
// in what order from the bow, the template each uses, and where the hull
// is cut for airlocks (a port: the face, the collar size, what it is
// for) and cargo doors. The hull model (hulls.js) is built from the same
// program, so the collars on the hull open onto these airlocks.
//
// Crew live forward (command, quarters, mess, utility); passengers have a
// deck of their own between the crew and the hold, with their own head;
// police cutters carry a brig there instead, and warships a brig as well
// (its holding cells are the class's `brig`). Bunks are shared between
// watches (two to a rack); couches seat the whole crew, passengers ride
// out burns in their own acceleration berths.

const port = (face, size, use = 'crew', label) => ({ id: face === 'x+' ? 'nose' : use === 'cargo' ? 'cargo' : 'crew', face, size, use, label });

function program(c) {
  const k = c.kind;
  const small = c.size === 'S' && k !== 'shuttle';
  const w = small ? 7 : 9;
  const pax = c.berths || 0;
  const bunks = Math.ceil(c.crew[1] / 2);
  const decks = [];
  const add = (id, template, o = {}) => decks.push({ id, template, ...o });
  const nose = (k === 'courier' || k === 'raider') ? port('x+', 'S') : (k === 'light-freighter' || k === 'gunship') ? port('x+', 'M')
    : (k === 'cutter' || k === 'corvette') ? port('x+', 'M', 'crew', 'Boarding collar') : null;
  add('bridge', 'command', { ports: [nose, k === 'prospector' ? port('y-', 'S') : k === 'shuttle' ? port('y-', 'M') : null] });
  if (small || k === 'shuttle') add('quarters', small ? 'quarters' : 'crew-mess');
  else add('quarters', bunks > 4 ? 'quarters-6' : 'quarters');
  if (!small && k !== 'shuttle') add('mess', 'mess');
  const flankS = small && k !== 'prospector';
  add('utility', 'utility', { ports: [flankS && k !== 'raider' ? port('y-', 'S') : null] });
  // A brig (a cutter's berths are its cells), then passengers, aft of the crew's decks and forward of the hold
  if (k === 'cutter' || c.brig) add('brig', 'brig');
  const paxDecks = k === 'cutter' ? 0 : pax;
  if (paxDecks > 8 && !small) { add('passengers', 'passengers-8'); add('passengers2', pax - 8 > 4 ? 'passengers-8' : 'passengers'); }
  else if (paxDecks > 4 && !small) add('passengers', 'passengers-8');
  else if (paxDecks > 0) add('passengers', 'passengers');
  const holdPort = k === 'shuttle' ? port('y+', 'L', 'cargo') : null;
  const crewPort = (k === 'light-freighter' || k === 'gunship' || k === 'corvette') ? port('y-', 'M') : k === 'cutter' || k === 'raider' ? port('y-', 'S') : null;
  add('cargo', k === 'shuttle' ? 'cargo-tall' : 'cargo', { ports: [crewPort, holdPort], cargoDoor: k === 'shuttle' ? null : 'y+' });
  if (k === 'gunship') add('cargo2', 'cargo-tall', { cargoDoor: 'y+' });
  add('engineering', 'engineering');
  add('reactor', 'reactor');
  for (const d of decks) d.ports = (d.ports || []).filter(Boolean);
  return { width: w, decks };
}

/** Classes with an interior (the ones a small crew can fly): classId → program. */
export const DECK_PROGRAMS = {};
for (const [id, c] of Object.entries(CLASSES)) {
  if (!c.carried && c.crew[0] <= 8 && (c.size === 'S' || c.size === 'M')) DECK_PROGRAMS[id] = program(c);
}

/** The drive bell takes the last stretch of the hull; the decks fill the rest. */
const TOWER_FRAC = 0.9;

/**
 * Where each deck sits along the hull, as bow fractions (0 bow, 1 stern),
 * its width as a fraction of the beam, its zone, and its ports.
 */
export function deckSpans(classId) {
  const prog = DECK_PROGRAMS[classId];
  if (!prog) return [];
  const rows = prog.decks.map(d => TEMPLATES[prog.width][d.template].length);
  const total = rows.reduce((a, b) => a + b, 0) + DECK_GAP * (rows.length - 1);
  let y = 0;
  return prog.decks.map((d, i) => {
    const art = TEMPLATES[prog.width][d.template];
    const span = Math.max(...art.map(r => r.trimEnd().length - (r.length - r.trimStart().length)));
    const out = { id: d.id, f0: y / total * TOWER_FRAC, f1: (y + rows[i]) / total * TOWER_FRAC, width: span / prog.width, zone: DECK_INFO[d.id]?.zone || 'crew', ports: d.ports, cargoDoor: d.cargoDoor || null };
    y += rows[i] + DECK_GAP;
    return out;
  });
}

/**
 * Our ship's interior: the class's deck program, drawn tile by tile and
 * fitted to the class. Without point defense the turret wells are plated
 * over, without tubes the launcher bay is hold space, a ship with nothing
 * to fire has a couch where fire control would be, and the hull is cut
 * for airlocks and cargo doors only where the program puts them.
 */
export function createLayout(classId = PLAYER_CLASS) {
  const c = CLASSES[classId] || CLASSES[PLAYER_CLASS];
  const prog = DECK_PROGRAMS[classId] || DECK_PROGRAMS[PLAYER_CLASS];
  const decks = prog.decks.map(d => {
    const art = TEMPLATES[prog.width][d.template];
    const info = DECK_INFO[d.id] || DECK_INFO.utility;
    const flank = { 'y-': 0, 'y+': art[0].length - 1 };
    const portCols = new Set(d.ports.filter(p => p.face[0] === 'y').map(p => flank[p.face]));
    const doorCol = d.cargoDoor ? flank[d.cargoDoor] : null;
    const nose = d.ports.some(p => p.face === 'x+');
    const tiles = art.map(row => [...row].map((ch, x) => {
      if (ch === '^') return nose ? T.AIRLOCK : T.HULL_WALL;
      if (ch === 'A') return portCols.has(x) ? T.AIRLOCK : T.HULL_WALL;
      if (ch === 'C') return portCols.has(x) ? T.AIRLOCK : doorCol === x ? T.CARGO_DOOR : T.HULL_WALL;
      if (ch === 'P') return c.pdc > 0 ? T.PDC_MOUNT : T.HULL_WALL;
      if (ch === 'T') return c.tubes > 0 ? T.TORPEDO_LAUNCHER : T.STORAGE;
      if (ch === 'W') return isArmed(c) ? T.WEAPONS_CONSOLE : T.CRASH_COUCH;
      return LEGEND[ch];
    }));
    const deck = { name: info.name, id: d.id, zone: info.zone, glow: info.glow, tiles };
    const ports = d.ports.map(p => p.id);
    if (ports.length) deck.ports = ports;
    return deck;
  });
  // As many passenger berths as the class is licensed for (a cutter's are its
  // brig), a warship's brig its cells, and a rack for every two of the crew:
  // the rest of the template's racks are lockers
  const cells = c.brig ? decks.filter(d => d.id === 'brig') : [];
  trimTiles(decks.filter(d => !cells.includes(d)), T.PAX_BERTH, c.berths || 0);
  trimTiles(cells, T.PAX_BERTH, c.brig);
  trimTiles(decks, T.BUNK, Math.max(2, Math.ceil(c.crew[1] / 2)));
  // A couch for every hand but the pilot (who has the helm), whatever the
  // watch: a full crew's couches come out of storage space, on the crew's
  // own decks first (near the racks, where the off watch is), then the hold
  const want = Math.min(PLAYER_MAX_CREW, c.crew[1]) - 1;
  let have = decks.reduce((n, d) => n + d.tiles.flat().filter(t => t === T.CRASH_COUCH).length, 0);
  const order = [...decks].sort((a, b) => COUCH_ROOM.indexOf(a.zone) - COUCH_ROOM.indexOf(b.zone));
  for (const d of order) {
    if (!COUCH_ROOM.includes(d.zone)) continue;
    for (const row of d.tiles) for (let x = 0; x < row.length && have < want; x++) {
      if (row[x] === T.STORAGE) { row[x] = T.CRASH_COUCH; have++; }
    }
  }
  return decks;
}

/** Where extra couches may go, best first (not the reactor deck). */
const COUCH_ROOM = ['crew', 'command', 'cargo', 'machinery'];

/** Keep the first `keep` tiles of a type (bow first), the rest become storage. */
function trimTiles(decks, type, keep) {
  let n = 0;
  for (const d of decks) for (const row of d.tiles) for (let x = 0; x < row.length; x++) {
    if (row[x] !== type) continue;
    if (++n > keep) row[x] = T.STORAGE;
  }
}

/** (kept for older callers) */
export const createDefaultLayout = createLayout;

/** Deck index by layout id (decks can be reordered without breaking callers). */
export function deckIndex(ship, id) {
  return ship.decks.findIndex(d => d.id === id);
}

// ---- SEATS ----
// Fixtures a crew member occupies (moves onto). Secure seats protect
// against sustained G (couch gel, juice); restraints only against being
// thrown around (a sleeper in a bunk is strapped in, but not juiced).

export const SEAT_KINDS = new Set(['couch', 'helm', 'ops', 'weapons', 'engStation', 'medbay', 'bunk', 'head', 'rec', 'paxBerth']);
const SECURE_SEATS = new Set(['couch', 'helm', 'ops', 'weapons', 'engStation', 'medbay']);
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
// ---- FURNITURE: WHICH WAY IT FACES, WHERE PEOPLE GO AT A TABLE ----

/** Tiles nobody is in and nothing faces into: the hull, walls, the void outside (the room cameras' too). */
export const SOLID_TILES = new Set([T.EMPTY, T.HULL_WALL, T.INTERIOR_WALL, T.PDC_MOUNT, T.CARGO_DOOR]);
export const FACE_DIRS = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] };

/** Is a deck tile solid (outside the room)? An airlock on the hull is. */
export function solidAt(tiles, x, y) {
  const t = tiles[y]?.[x];
  if (t === undefined || SOLID_TILES.has(t)) return true;
  if (t === T.AIRLOCK) return Object.values(FACE_DIRS).some(([dx, dy]) => (tiles[y + dy]?.[x + dx] ?? T.EMPTY) === T.EMPTY);
  return false;
}

/** Which way furniture at (x, y) faces: 'S' | 'N' | 'E' | 'W', toward open floor, its back to a wall if it has one. */
export function fixtureFacing(tiles, x, y) {
  const open = (dx, dy) => !solidAt(tiles, x + dx, y + dy) && WALKABLE.has(tiles[y + dy]?.[x + dx]);
  for (const k of ['S', 'N', 'E', 'W']) { const [dx, dy] = FACE_DIRS[k]; if (open(dx, dy) && solidAt(tiles, x - dx, y - dy)) return k; }
  for (const k of ['S', 'N', 'E', 'W']) { const [dx, dy] = FACE_DIRS[k]; if (open(dx, dy)) return k; }
  return 'S';
}

/**
 * A table's frame: out (from its back to its front, the way it faces),
 * along (its u axis, as the cameras draw it: from one end to the other),
 * and which of its sides open onto floor (the ends: low is along −1).
 */
export function tableFrame(tiles, x, y) {
  const [ox, oy] = FACE_DIRS[fixtureFacing(tiles, x, y)];
  const ax = oy, ay = -ox;
  // (open floor, and not where anyone stands to use the furniture beside it: a stool there would be in their way)
  const floor = (dx, dy) => tiles[y + dy]?.[x + dx] === T.FLOOR && !usedFrom(tiles, x + dx, y + dy, x, y);
  return { ox, oy, ax, ay, low: floor(-ax, -ay), high: floor(ax, ay), back: floor(-ox, -oy) };
}

/** The mess's furniture is used from its front (where the cameras draw its stools, its counter, the rig's deck). */
const FRONT_ACCESS = new Set([T.GALLEY, T.TABLE, T.REC]);

/**
 * Which floor tile beside furniture at (x, y) it is used from, as [dx, dy]:
 * the front for the mess's furniture, else the first open floor east, west,
 * south, north (shipGeometry falls back to a doorway or the ladder after).
 */
export function accessFrom(tiles, x, y) {
  const floor = (dx, dy) => tiles[y + dy]?.[x + dx] === T.FLOOR;
  if (FRONT_ACCESS.has(tiles[y]?.[x])) { const d = FACE_DIRS[fixtureFacing(tiles, x, y)]; if (floor(...d)) return d; }
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (floor(...d)) return d;
  return null;
}

/** Is floor tile (x, y) where someone stands to use a piece of furniture next to it, other than the one at (ex, ey)? */
function usedFrom(tiles, x, y, ex, ey) {
  for (const [dx, dy] of Object.values(FACE_DIRS)) {
    const fx = x + dx, fy = y + dy;
    if (fx === ex && fy === ey) continue;
    const t = tiles[fy]?.[fx];
    if (t === undefined || !FIXTURE_KIND[t] || WALKABLE.has(t)) continue;
    const d = accessFrom(tiles, fx, fy);
    if (d && fx + d[0] === x && fy + d[1] === y) return true;
  }
  return false;
}

const COUNTER_OUT = 0.78, COUNTER_ALONG = 0.24;     // two at a counter (the galley), side by side in front of it
const QUEUE_PER_TILE = 0.22;                        // waiting their turn: two to a tile of open floor, this far either side of its middle

/**
 * Places at a counter (the galley): two side by side in front of it, then
 * waiting room on the open floor nearest it, two to a tile (never a tile
 * holding a table's places; the walk up to a table's stools last); each
 * { sx, sy, a }, facing the counter. Cached on the fixture.
 */
export function counterSpots(ship, f) {
  if (f.$spots) return f.$spots;
  const tiles = ship.decks[f.deck].tiles;
  const geo = shipGeometry(ship);
  const [ox, oy] = FACE_DIRS[fixtureFacing(tiles, f.x, f.y)];
  const ax = oy, ay = -ox;
  const face = (x, y) => Math.atan2(f.sy - y, f.sx - x);
  const spots = [-COUNTER_ALONG, COUNTER_ALONG].map(l => { const sx = f.sx + ox * COUNTER_OUT + ax * l, sy = f.sy + oy * COUNTER_OUT + ay * l; return { sx, sy, a: Math.atan2(-oy, -ox) }; });
  // (the tiles taken: the counter's own front, a table's places; a table's front, where its diners walk up, last)
  const busy = new Set([`${f.x + ox},${f.y + oy}`]), fronts = new Set();
  for (const g of geo.fixtures.table || []) if (g.deck === f.deck) {
    for (const p of tableSpots(ship, g)) busy.add(`${Math.round(p.sx)},${Math.round(p.sy - geo.deckStart[f.deck])}`);
    const d = accessFrom(tiles, g.x, g.y);
    if (d) fronts.add(`${g.x + d[0]},${g.y + d[1]}`);
  }
  const far = (n) => (fronts.has(`${n.x},${n.y}`) ? 100 : 0) + Math.hypot(n.sx - f.sx, n.sy - f.sy);
  const open = geo.nodes.filter(n => n.deck === f.deck && n.tile === T.FLOOR && !busy.has(`${n.x},${n.y}`)).sort((a, b) => far(a) - far(b));
  for (const n of open) for (const s of [-1, 1]) {
    const sx = n.sx + s * QUEUE_PER_TILE, sy = n.sy;
    spots.push({ sx, sy, a: face(sx, sy) });
  }
  f.$spots = spots;
  return spots;
}

/** Place `i` at a counter (past them all, round the waiting room again a little aside: a deck crowded past what it holds). */
export function counterSpot(ship, f, i) {
  const s = counterSpots(ship, f);
  if (i < s.length) return s[i];
  const k = i - s.length, p = s[2 + k % Math.max(1, s.length - 2)] || s[s.length - 1], lap = 1 + Math.floor(k / Math.max(1, s.length - 2));
  return { ...p, sy: p.sy + 0.18 * lap * (lap % 2 ? 1 : -1) };
}

const SEAT_OUT = 0.48, SEAT_ALONG = 0.24;   // the front stools, from the table's centre (tiles): where the cameras draw them
const END_ALONG = 0.62, END_OUT = -0.04;    // an end's stool
const OVERFLOW_OUT = 1.15;                  // past every place: standing about in front of it

/**
 * The places at a table: [{ kind: 'seat' | 'stand', sx, sy, a (rad: the
 * way they face, at the table) }], seats first. Cached on the fixture.
 */
export function tableSpots(ship, f) {
  if (f.$spots) return f.$spots;
  const fr = tableFrame(ship.decks[f.deck].tiles, f.x, f.y);
  const at = (kind, o, l, fx, fy) => ({ kind, sx: f.sx + fr.ox * o + fr.ax * l, sy: f.sy + fr.oy * o + fr.ay * l, a: Math.atan2(fy, fx) });
  const spots = [at('seat', SEAT_OUT, -SEAT_ALONG, -fr.ox, -fr.oy), at('seat', SEAT_OUT, SEAT_ALONG, -fr.ox, -fr.oy)];
  if (fr.low) spots.push(at('seat', END_OUT, -END_ALONG, fr.ax, fr.ay));
  if (fr.high) spots.push(at('seat', END_OUT, END_ALONG, -fr.ax, -fr.ay));
  if (fr.back) spots.push(at('stand', -0.68, -0.22, fr.ox, fr.oy), at('stand', -0.68, 0.22, fr.ox, fr.oy));
  // (the front corners, beside the stools: leaning on the table)
  spots.push(at('stand', 0.92, -0.62, -fr.ox * 0.8 + fr.ax * 0.6, -fr.oy * 0.8 + fr.ay * 0.6), at('stand', 0.92, 0.62, -fr.ox * 0.8 - fr.ax * 0.6, -fr.oy * 0.8 - fr.ay * 0.6));
  f.$spots = spots;
  return spots;
}

/** Place `i` at a table: one of its spots, or past them all, standing about in front of it (each a place of its own). */
export function tableSpot(ship, f, i) {
  const spots = tableSpots(ship, f);
  if (i < spots.length) return spots[i];
  const fr = tableFrame(ship.decks[f.deck].tiles, f.x, f.y);
  const k = i - spots.length, r = 0.18 + 0.12 * Math.sqrt(k), th = k * 2.39996;
  const o = OVERFLOW_OUT + Math.cos(th) * r * 0.6, l = Math.sin(th) * r * 1.6;
  return { kind: 'stand', sx: f.sx + fr.ox * o + fr.ax * l, sy: f.sy + fr.oy * o + fr.ay * l, a: Math.atan2(-fr.oy, -fr.ox) };
}

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
    // Access: where a crew member stands to use it: open floor preferred
    // over the ladder shaft or a doorway (the mess's furniture from its
    // front, as the cameras draw it: accessFrom)
    let access = self, fallback;
    if (access === undefined) {
      const d = accessFrom(deck.tiles, rx, ry);
      if (d) access = index.get(key(di, rx + d[0], ry + d[1]));
    }
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
  [T.PDC_MOUNT]: 'pdc', [T.TORPEDO_LAUNCHER]: 'launcher', [T.WEAPONS_CONSOLE]: 'weapons',
  [T.PAX_BERTH]: 'paxBerth', [T.CARGO_DOOR]: 'cargoDoor',
};

/** Deck index of the deck that holds a fixture kind (first found), or -1. */
export function deckWith(ship, kind) {
  const f = shipGeometry(ship).fixtures[kind]?.[0];
  return f ? f.deck : -1;
}

/** Decks of a zone ('command', 'crew', 'pax', 'cargo', 'machinery', 'reactor'). */
export const decksOfZone = (ship, zone) => ship.decks.map((d, i) => d.zone === zone ? i : -1).filter(i => i >= 0);

/** The airlock fixture that opens onto a port (by port id), or the nearest airlock. */
export function airlockFor(ship, portId = null) {
  const geo = shipGeometry(ship);
  const locks = geo.fixtures.airlock || [];
  if (portId) {
    const di = ship.decks.findIndex(d => d.ports?.includes(portId));
    const onDeck = locks.filter(f => f.deck === di);
    if (onDeck.length) {
      // the nose collar is the hatch in the bow plating; flank collars are cut in the side walls
      if (portId === 'nose') return onDeck.find(f => f.y === 0) || onDeck[0];
      return onDeck.find(f => f.y !== 0) || onDeck[0];
    }
  }
  return locks[0] || null;
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
