// ============================================================
// LONGHAUL — Room cameras: a fixed camera in every compartment
//
// Each deck is a compartment, and each has one security camera, high on
// the after bulkhead toward its right-hand corner, looking forward and
// down across the deck at the far bulkhead (the bow side). The deck's
// tile grid is read as the compartment's floor plan: columns run across
// the picture, rows run away from the camera (row 0 at the far wall),
// and the room is built in three dimensions from it: deck plating on the
// floor cells, a bulkhead along every edge where the floor meets hull
// (airlock hatches, the cargo door and PDC wells cut into it), fixtures
// stood on their tiles as simple solids (a couch, a rack, a reactor
// housing) with their backs to the nearest wall and their fronts to the
// open deck. A ladder in the far row climbs the far bulkhead to a hatch
// in the deckhead (forward is up in a ship under thrust); one in the
// near row drops through a well in the plating. A tile is about 1.5 m;
// the deckhead is CEIL above the deck, a person about 1.15 tiles tall.
//
// The camera: a pinhole at a fixed pitch and yaw (PITCH, YAW) on the
// room's centre, at a distance proportional to the room (LENS_K: a
// moderate perspective, verticals converging a little as through a
// real lens), then scaled and centred so the whole compartment fits the
// canvas with a small margin at any size. The bulkhead the camera hangs
// on and the deckhead are behind the lens and not drawn (their edges
// are: the deckhead's in section along the top of the walls), nor any
// wall whose face turns away from it. Nothing here is a screen effect:
// no scan lines, noise, vignette or colour fringes. The overlay is what
// a real camera's display carries: its id and compartment, an alert
// when the compartment's air is bad, its pressure and oxygen, the
// ship's clock (on a feed under 260 px wide: id and clock, or the alert).
//
// Light: the plating and bulkheads are painted flat (their albedo), then
// multiplied by a light map computed per texel from the room's lights
// (ceiling panels and their spill, the red battle strips, amber
// emergency lamps and floor strips, the glow of screens, of the autodoc
// and of a running reactor) with soft occlusion where the deck meets
// walls and fixtures, and a faint sheen where the semi-gloss deck
// mirrors a panel to the lens; the faces of fixtures are shaded by the
// same lights, top to bottom. Lighting states, worst first: vacuum (main
// lights dead, a panel flickering now and then, cold, rime along the
// bulkheads), blackout (only the floor strips), emergency (reactor not
// online: amber lamps, panels at a tenth), battle stations (panels
// dimmed, red strips), normal (cool white). A fire is laid over any of
// them each frame: a flickering warm light and flames at the deck's
// machinery, smoke rising off them and hanging under the deckhead.
//
// People are a handful of joints posed from what the sim says they are
// doing (on their feet or walking, at a station, back in a couch, asleep
// on their side under a blanket, knees drawn up to fit the rack, on the
// autodoc knees raised under the sheet, at the mess table, on the
// treadmill, adrift in free fall, braced against a hard burn, pinned flat
// by a crushing one, thrown along the deck or tumbling when the ship moves
// under them, down where they fell, each their own way, in their blood if
// they are badly hurt), interpolated between sim
// minutes by `alpha`, and given bodies on the GPU (gl/figures.js): a
// rigged human body posed to those joints, in a jumpsuit of their
// department's colour with its details, skin and hair, or a white vac suit
// with its helmet and pack, lit by the room's own lights through the same
// lens. Without WebGL2 (or while the bodies load) they are drawn as limbs
// of a body's width. The selected one is outlined and named. Someone in the
// head is behind its door; a warship's brig is a row of closed cells,
// a cell holding someone shut and locked behind a red lamp, a free one
// open on its bunk under a green one (the prisoners are not drawn).
//
// Cost: the room (floor, walls, fixtures, light) is rendered once per
// deck, canvas size and lighting state into offscreen layers, one per
// tile row, so people are drawn between them and hidden by what stands
// nearer (their bodies rendered in one GPU pass per camera first, then
// copied in, each in its place among the rows; within a row the furniture
// round each person is drawn into that pass's depth, so the back of the
// seat they sit in hides them where it stands between them and the lens). A frame draws those layers, the people, the faint changing
// content of screens, status lamps (machines by their system's state,
// the hatch over a docked collar, the head's door) and the overlay: a
// few hundredths of a millisecond of script. Rebuilding a layer set is
// limited to one per animation frame across all cameras once each has a
// picture (a picture from before a resize is stretched meanwhile), so a
// change every camera sees at once is spread over a few frames.
// ============================================================

import { TileType, INTERACTIVE_TILES, WALKABLE } from '../sim/tiles.js';
import { shipGeometry, seatKind, FIXTURE_KIND, airlockFor } from '../sim/ship-layout.js';
import { SYSTEM_BY_FIXTURE, Status } from '../sim/systems.js';
import { ATMO } from '../sim/life-support.js';
import { isConscious } from '../sim/crew.js';
import { formatDate, formatTime } from '../core/clock.js';
import { renderFigures } from './gl/figures.js';

const T = TileType;

// ---- THE CAMERA AND THE ROOM ----

const CEIL = 1.6;                    // deck to deckhead, in tiles (a tile is about 1.5 m)
const WALL_T = 0.1;                  // bulkhead thickness shown where the view cuts it
const PITCH = 50 * Math.PI / 180;    // the camera looks down this much…
const YAW = 16 * Math.PI / 180;      // …and across the room from its right-hand after corner
const LENS_K = 1.3;                  // camera distance / room diagonal (longer: flatter perspective)
const RED_Y = 1.3;                   // height of the battle-stations strip on the bulkheads
const LIGHT_PPU = 10;                // light-map texels per tile (smooth; scaled up bilinearly)

// Fonts the console loads (css); the canvas falls back cleanly before they arrive
const F_DATA = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const F_UI = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

const SOLID = new Set([T.EMPTY, T.HULL_WALL, T.INTERIOR_WALL, T.PDC_MOUNT, T.CARGO_DOOR]);
const DIRS = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] };

// ---- COLOUR ----
// Albedos (the colour fully lit); the light map and face shading darken them.

const ALB = {
  floor: '#6E7782', floorAlt: '#68717C', seam: '#3A424B', mat: '#59616B', matEdge: '#7F8892',
  wall: '#8A939D', wallLow: '#6E7781', wallSeam: '#56606A', conduit: '#9AA3AC', conduitDk: '#4B535C', rail: '#B5BDC4',
  section: '#0C1015', sectionEdge: '#1A2129',
  metal: '#8E979F', metalDk: '#5A626C', frame: '#717A84', console: '#4A535E', screenFrame: '#2A3139',
  gel: '#55708F', gelDk: '#45607E', mattress: '#AEB8C2', pillow: '#D3D9DE', blanket: '#647A92',
  tableTop: '#A2AAB1', stool: '#68717B', cabinet: '#737C87', steel: '#B9C0C6', appliance: '#48515A',
  pod: '#8E98A1', podDoor: '#7A848E', mat2: '#3C434B', rack: '#4A535D', machine: '#7B858F', tank: '#A3ACB4',
  pipeBlue: '#5C80A2', pipeGreen: '#668C6F', locker: '#7C8691', glass: '#141B22',
  drive: '#959EA6', driveDk: '#5C646D', reactor: '#87909A', reactorRing: '#5D6570',
  launcher: '#6E7780', tube: '#1A1F25', pdc: '#707881', crateA: '#80835F', crateB: '#A57D4D', crateC: '#6B7580', strap: '#33373D',
  medBase: '#D2D8DE', medPad: '#9CC2B4', medHood: '#DDE2E7',
  hazard: '#C99B30', hazardDk: '#1D1B17', toolboard: '#5C6570', benchTop: '#929BA3', extinguisher: '#B0443A',
};

// Crew: a jumpsuit by department (muted: this is a camera, not a roster)
const ROLE_SUIT = {
  Captain: '#4A6E96', Pilot: '#4D86A3', Engineer: '#B07A3C', Medic: '#4E9470', Gunner: '#A04A40',
  Mechanic: '#A08A48', Scientist: '#7566A3', Cook: '#B3AEA3', Security: '#5C626B', Deckhand: '#737C87',
};
const SKIN = ['#C99A78', '#A97A56', '#7A5238', '#E0B896', '#8C6046', '#B98863', '#D4A784'];
const HAIR = ['#2A2320', '#5A3B26', '#1B1A1A', '#8A6A44', '#6E6A66', '#3A2A20', '#4A3A30'];
const VAC_SUIT = '#C3C9D0';

// Meaning colours (the console's tokens)
const C_SEL = '#3EC7E6', C_OWN = '#5FD38D', C_CAUTION = '#F0A93A', C_WARN = '#EF5350';
const C_TEXT = '#D8E1EA', C_TEXT2 = '#94A3B2';

// Screen content colours by station (the console's own conventions)
const SCREEN_INK = {
  helm: ['#7FCBEA', '#D46BE0'], ops: ['#7FCBEA', '#5FD38D'], weapons: ['#7FCBEA', '#EF5350'],
  eng: ['#7FCBEA', '#F0A93A'], med: ['#9FE0C4', '#5FD38D'], rec: ['#8FB8E8', '#C9D6E8'],
  rack: ['#7FCBEA', '#5FD38D'], amber: ['#F0A93A', '#F0A93A'],
};

const _rgb = new Map();
function rgb(hex) {
  let c = _rgb.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    _rgb.set(hex, c);
  }
  return c;
}
const css = (r, g, b, a = 1) => a >= 1
  ? `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
  : `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a.toFixed(3)})`;
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** Exposure, with a soft shoulder instead of a hard clip. */
function tone(v) {
  return v < 0.82 ? v : 0.82 + 0.18 * (1 - Math.exp(-(v - 0.82) * 5.5));
}

// A stable hash, for the variety a real room has (panel tones, crate colours) without noise
function hash(a, b = 0, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- ROOM MODEL (per deck layout) ----

const tileAt = (tiles, x, z) => (z < 0 || z >= tiles.length || x < 0 || x >= tiles[z].length) ? T.EMPTY : tiles[z][x];

/** Hull, or a hatch cut in it (an airlock on the boundary is a door in the wall, not a room). */
function isSolid(tiles, x, z) {
  const t = tileAt(tiles, x, z);
  if (SOLID.has(t)) return true;
  if (t === T.AIRLOCK) return Object.values(DIRS).some(([dx, dz]) => tileAt(tiles, x + dx, z + dz) === T.EMPTY);
  return false;
}

const _rooms = new WeakMap();

/** The compartment as geometry: floor cells, walls, fixtures, lights. Cached on the deck's tile array. */
export function roomFor(ship, di) {
  const deck = ship.decks[di];
  let room = _rooms.get(deck.tiles);
  if (!room) { room = buildRoom(ship, di); _rooms.set(deck.tiles, room); }
  return room;
}

function buildRoom(ship, di) {
  const deck = ship.decks[di];
  const tiles = deck.tiles;
  const rows = tiles.length, cols = Math.max(...tiles.map(r => r.length));
  const inside = (x, z) => x >= 0 && z >= 0 && z < rows && x < cols && !isSolid(tiles, x, z);
  const cells = [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (!inside(x, z)) continue;
    cells.push([x, z]);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); z0 = Math.min(z0, z); z1 = Math.max(z1, z + 1);
  }
  if (!cells.length) { x0 = 0; x1 = cols; z0 = 0; z1 = rows; }

  // Walls: every cell edge that meets something solid, merged into runs.
  // A wall's u runs left to right as seen from inside, facing it.
  const units = [];
  for (const [x, z] of cells) {
    for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      // (nx, nz) is the inward normal; the solid neighbour is on the other side
      const sx = x - nx, sz = z - nz;
      if (inside(sx, sz)) continue;
      const line = nz ? (nz > 0 ? z : z + 1) : (nx > 0 ? x : x + 1);
      const along = nz ? x : z;
      units.push({ nx, nz, line, along, t: tileAt(tiles, sx, sz), sx, sz, front: tileAt(tiles, x, z), cx: x, cz: z });
    }
  }
  const walls = [];
  const groups = new Map();
  for (const u of units) {
    const k = `${u.nx},${u.nz},${u.line}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.along - b.along);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const { nx, nz, line } = run[0];
      const lo = run[0].along, hi = run[run.length - 1].along + 1;
      // right-hand direction seen facing the wall from inside: (nz, -nx)
      const rx = nz, rz = -nx;
      const pa = nz ? [lo, line] : [line, lo], pb = nz ? [hi, line] : [line, hi];
      const forward = (pb[0] - pa[0]) * rx + (pb[1] - pa[1]) * rz > 0;
      const a = forward ? pa : pb, b = forward ? pb : pa;
      const ordered = forward ? run : [...run].reverse();
      walls.push({ n: [nx, nz], a, b, len: hi - lo, units: ordered.map((u, k) => ({ ...u, k })) });
      run = [];
    };
    for (const u of list) {
      if (run.length && u.along !== run[run.length - 1].along + 1) flush();
      run.push(u);
    }
    flush();
  }

  // Fixtures: what stands on a floor cell, and what a wall carries into the room
  const geo = shipGeometry(ship);
  const fixtures = [];
  const wallFx = [];
  // (a warship's brig: its berths are holding cells, numbered in the order prisoners fill them)
  const brig = deck.id === 'brig';
  let cellNo = 0;
  for (const [x, z] of cells) {
    const t = tiles[z][x];
    const cell = brig && t === T.PAX_BERTH;
    const model = cell ? cellParts : MODELS[t];
    if (!model) continue;
    const facing = facingOf(tiles, inside, x, z);
    const kind = FIXTURE_KIND[t];
    fixtures.push({ t, x, z, facing, row: z, tile: { x, y: z, t }, model, kind, sys: SYSTEM_BY_FIXTURE[kind] || null, id: kind ? `${kind}:${di}:${x}:${z}` : null, cell: cell ? cellNo++ : null });
  }
  for (const w of walls) for (const u of w.units) {
    if (u.t !== T.AIRLOCK && u.t !== T.CARGO_DOOR && u.t !== T.PDC_MOUNT) continue;
    wallFx.push({ wall: w, unit: u, tile: { x: u.sx, y: u.sz, t: u.t } });
    if (u.t === T.PDC_MOUNT) {
      // the gun's breech and feed stand out of the bulkhead into the room
      const facing = Object.keys(DIRS).find(k => DIRS[k][0] === u.nx && DIRS[k][1] === u.nz);
      fixtures.push({ t: u.t, x: u.cx, z: u.cz, facing, row: u.cz, tile: { x: u.sx, y: u.sz, t: u.t }, model: MODEL_PDC, kind: 'pdc', sys: SYSTEM_BY_FIXTURE.pdc || null, id: null });
    }
  }

  // Ladders: far row climbs to a deckhead hatch, near row drops through a well
  const ladders = cells.filter(([x, z]) => tiles[z][x] === T.LADDER).map(([x, z]) => ({ x, z, up: z === z0 || !inside(x, z - 1) }));
  for (const l of ladders) if (!l.up) fixtures.push({ t: T.LADDER, x: l.x, z: l.z, facing: 'S', row: l.z, tile: null, model: MODEL_WELL, kind: null, sys: null, id: null });

  // Ceiling panels: a line down the middle of the room, about two tiles apart
  const ceil = [];
  const w = x1 - x0, d = z1 - z0;
  const lines = d >= 4 ? [z0 + d * 0.3, z0 + d * 0.72] : [z0 + d * 0.5];
  const n = Math.max(1, Math.round(w / 2.3));
  for (const lz of lines) for (let k = 0; k < n; k++) {
    const lx = x0 + (k + 0.5) * w / n;
    if (inside(Math.floor(lx), Math.floor(lz)) || inside(Math.floor(lx), Math.floor(lz - 0.5))) ceil.push([lx, lz]);
  }
  if (!ceil.length) ceil.push([(x0 + x1) / 2, (z0 + z1) / 2]);

  // Where a fire shows: on the deck in front of its machinery (one not in
  // the row nearest the lens, where the machine itself would hide it), else mid-room
  const machines = fixtures.filter(f => f.sys && f.t !== T.PDC_MOUNT);
  const hot = machines.find(f => f.z < z1 - 1) || machines[0] || null;
  const fire = hot ? [hot.x + 0.5 + DIRS[hot.facing][0] * 0.6, hot.z + 0.5 + DIRS[hot.facing][1] * 0.6] : [(x0 + x1) / 2, (z0 + z1) / 2];

  const deckStart = geo.deckStart[di];
  return { di, tiles, rows, cols, inside, cells, x0, x1, z0, z1, walls, fixtures, wallFx, ladders, ceil, fire, deckStart, zone: deck.zone, name: deck.name };
}

/** A fixture's front faces the open deck; its back is to the wall it stands against. */
function facingOf(tiles, inside, x, z) {
  const open = (dx, dz) => inside(x + dx, z + dz) && WALKABLE.has(tileAt(tiles, x + dx, z + dz));
  const solid = (dx, dz) => !inside(x + dx, z + dz);
  for (const k of ['S', 'N', 'E', 'W']) { const [dx, dz] = DIRS[k]; if (open(dx, dz) && solid(-dx, -dz)) return k; }
  for (const k of ['S', 'N', 'E', 'W']) { const [dx, dz] = DIRS[k]; if (open(dx, dz)) return k; }
  return 'S';
}

// ---- FIXTURE MODELS ----
// In a fixture's own frame: u across it (0 left … 1 right, seen from the
// front), w from its back (0, against the wall) to its front (1), y up.
// Parts are convex prisms: a profile extruded along one axis. B() is a box.

const B = (u0, u1, w0, w1, y0, y1, col, o = {}) => ({ ax: 'u', prof: [[w0, y0], [w1, y0], [w1, y1], [w0, y1]], t0: u0, t1: u1, col, ...o });
const PU = (prof, u0, u1, col, o = {}) => ({ ax: 'u', prof, t0: u0, t1: u1, col, ...o });
function CYL(cu, cw, r, y0, y1, col, o = {}) {
  const n = o.n || 18, prof = [];
  for (let i = 0; i < n; i++) { const a = (i + 0.5) / n * Math.PI * 2; prof.push([cu + Math.cos(a) * r, cw + Math.sin(a) * r]); }
  return { ax: 'y', prof, t0: y0, t1: y1, col, cyl: true, ...o };
}

/** Acceleration couch, facing the room (we see it from the front). */
function couchParts(o = {}) {
  return [
    B(0.32, 0.68, 0.32, 0.72, 0, 0.3, 'metalDk'),
    PU([[0.40, 0.30], [0.97, 0.38], [0.97, 0.47], [0.40, 0.40]], 0.15, 0.85, 'gel'),
    PU([[0.30, 0.31], [0.44, 0.36], [0.16, 1.0], [0.05, 0.95]], 0.15, 0.85, 'gel'),
    B(0.3, 0.7, 0.02, 0.15, 0.92, 1.08, 'gelDk'),
    B(0.09, 0.15, 0.34, 0.8, 0.3, 0.52, 'metal'),
    B(0.85, 0.91, 0.34, 0.8, 0.3, 0.52, 'metal'),
    ...(o.extra || []),
  ];
}

/** A watch station: console at the wall, a couch in front of it facing the console. */
function stationParts(ink, o = {}) {
  return [
    B(0.06, 0.94, 0, 0.3, 0, 0.7, 'console', { lamp: o.lamp ? [0.86, 0.6] : null }),
    PU([[0, 0.7], [0.3, 0.7], [0.3, 0.74], [0, 0.82]], 0.06, 0.94, 'console'),
    B(0.12, 0.88, 0.03, 0.09, 0.82, 1.28, 'screenFrame', { screen: { ink, u0: 0.16, u1: 0.84, y0: 0.86, y1: 1.24 } }),
    B(0.36, 0.64, 0.42, 0.78, 0, 0.3, 'metalDk'),
    PU([[0.28, 0.4], [0.68, 0.33], [0.68, 0.41], [0.28, 0.48]], 0.18, 0.82, 'gel'),
    PU([[0.62, 0.34], [0.95, 0.94], [0.86, 0.98], [0.54, 0.4]], 0.18, 0.82, 'gel'),
    B(0.3, 0.7, 0.86, 0.98, 0.9, 1.06, 'gelDk'),
    B(0.1, 0.16, 0.34, 0.8, 0.3, 0.55, 'metal'),
    B(0.84, 0.9, 0.34, 0.8, 0.3, 0.55, 'metal'),
  ];
}

/**
 * A holding cell in a warship's brig: a closed box round its bunk, side
 * walls and a roof, its door shut and locked (a red lamp) while someone is
 * held in it, slid open (a green lamp, the bunk seen through the doorway)
 * while it stands empty. Nobody inside is drawn: the door is what shows.
 */
function cellParts(c) {
  const parts = [
    B(0.08, 0.92, 0.04, 0.8, 0, 0.22, 'frame'),
    B(0.1, 0.9, 0.06, 0.78, 0.22, 0.32, 'gel'),
    B(0.0, 0.06, 0, 0.92, 0, 1.32, 'wallLow'),
    B(0.94, 1.0, 0, 0.92, 0, 1.32, 'wallLow'),
    B(0.0, 1.0, 0, 0.92, 1.32, 1.38, 'metalDk'),
  ];
  if (c.held) parts.push(B(0.06, 0.94, 0.86, 0.92, 0, 1.32, 'podDoor', { deco: 'cellShut', occupancy: [0.86, 0.98] }));
  else parts.push(
    B(0.06, 0.34, 0.86, 0.92, 0, 1.32, 'podDoor', { deco: 'cellLeaf', occupancy: [0.2, 0.98] }),
    B(0.34, 0.94, 0.86, 0.92, 1.1, 1.32, 'podDoor'),
    B(0.9, 0.94, 0.86, 0.92, 0, 1.1, 'metalDk'),
  );
  return parts;
}

const MODELS = {
  [T.CRASH_COUCH]: () => couchParts(),
  [T.NAV_CONSOLE]: () => stationParts('helm', { lamp: true }),
  [T.OPS_CONSOLE]: () => stationParts('ops', { lamp: true }),
  [T.WEAPONS_CONSOLE]: () => stationParts('weapons'),
  [T.ENG_CONSOLE]: () => stationParts('eng', { lamp: true }),
  [T.CONSOLE]: () => [
    B(0.08, 0.92, 0, 0.5, 0, 0.72, 'console'),
    B(0.16, 0.84, 0.04, 0.1, 0.8, 1.22, 'screenFrame', { screen: { ink: 'ops', u0: 0.2, u1: 0.8, y0: 0.84, y1: 1.18 } }),
  ],
  [T.TERMINAL]: () => [
    B(0.12, 0.88, 0, 0.45, 0, 0.72, 'console'),
    B(0.2, 0.8, 0.04, 0.1, 0.8, 1.15, 'screenFrame', { screen: { ink: 'rack', u0: 0.24, u1: 0.76, y0: 0.84, y1: 1.11 } }),
  ],
  [T.RADIO]: () => [
    B(0.08, 0.92, 0, 0.46, 0, 1.4, 'rack', { lamp: [0.82, 1.3], deco: 'rack', screen: { ink: 'rack', u0: 0.18, u1: 0.62, y0: 1.02, y1: 1.26 } }),
    B(0.38, 0.62, 0, 0.14, 1.4, 1.6, 'metalDk'),
  ],
  [T.TRANSPONDER]: () => [
    B(0.16, 0.84, 0, 0.38, 0, 0.98, 'rack', { deco: 'rack', screen: { ink: 'amber', u0: 0.24, u1: 0.76, y0: 0.74, y1: 0.88 } }),
  ],
  [T.BUNK]: (c) => [
    B(0.02, 0.98, 0, 0.84, 0, 0.22, 'frame'),
    B(0.04, 0.96, 0.03, 0.81, 0.22, 0.33, 'mattress'),
    B(0.02, 0.98, 0, 0.05, 0.22, 1.12, 'frame', { deco: 'bunkLamp' }),
    B(0.0, 0.05, 0, 0.84, 0.22, 0.62, 'frame'),
    B(0.95, 1.0, 0, 0.84, 0.22, 0.62, 'frame'),
    B(0.07, 0.27, 0.12, 0.72, 0.33, 0.39, 'pillow'),
    B(0.68, 0.93, 0.05, 0.8, 0.33, 0.37, c.h < 0.5 ? 'blanket' : 'gelDk'),
  ],
  [T.PAX_BERTH]: () => [
    B(0.02, 0.98, 0, 0.86, 0, 0.24, 'frame'),
    B(0.05, 0.95, 0.04, 0.82, 0.24, 0.36, 'gel'),
    B(0.02, 0.98, 0, 0.06, 0.24, 0.95, 'frame', { lamp: [0.5, 0.86] }),
    B(0.0, 0.05, 0, 0.86, 0.24, 0.6, 'frame'),
    B(0.95, 1.0, 0, 0.86, 0.24, 0.6, 'frame'),
  ],
  [T.TABLE]: () => [
    B(0.4, 0.6, 0.36, 0.58, 0, 0.04, 'metalDk'),
    B(0.45, 0.55, 0.42, 0.52, 0.04, 0.7, 'metalDk'),
    B(0.04, 0.96, 0.08, 0.84, 0.7, 0.76, 'tableTop'),
    CYL(0.26, 0.98, 0.09, 0, 0.44, 'stool', { n: 10 }),
    CYL(0.74, 0.98, 0.09, 0, 0.44, 'stool', { n: 10 }),
  ],
  [T.GALLEY]: () => [
    B(0, 1, 0, 0.62, 0, 0.86, 'cabinet', { deco: 'doors' }),
    B(0, 1, 0, 0.66, 0.86, 0.92, 'steel'),
    B(0, 1, 0, 0.04, 0.92, 1.2, 'steel'),
    B(0.52, 0.94, 0.04, 0.42, 0.92, 1.16, 'appliance', { screen: { ink: 'amber', u0: 0.58, u1: 0.74, y0: 1.04, y1: 1.12 }, lamp: [0.86, 1.1] }),
    B(0, 1, 0, 0.34, 1.2, 1.56, 'cabinet', { deco: 'doors' }),
  ],
  [T.HEAD]: () => [
    B(0.04, 0.96, 0.02, 0.96, 0, 1.5, 'pod', { deco: 'headDoor', occupancy: [0.5, 1.36] }),
    B(0.35, 0.65, 0.3, 0.6, 1.5, 1.56, 'metalDk'),
  ],
  [T.REC]: () => [
    B(0.06, 0.94, 0.16, 0.94, 0, 0.07, 'mat2'),
    B(0.2, 0.8, 0.3, 0.88, 0.07, 0.15, 'metalDk'),
    B(0.22, 0.28, 0.3, 0.38, 0.07, 1.0, 'metal'),
    B(0.72, 0.78, 0.3, 0.38, 0.07, 1.0, 'metal'),
    B(0.22, 0.78, 0.3, 0.38, 0.92, 1.0, 'metal'),
    B(0.16, 0.84, 0, 0.04, 0.86, 1.32, 'screenFrame', { screen: { ink: 'rec', u0: 0.2, u1: 0.8, y0: 0.9, y1: 1.28 } }),
  ],
  [T.MEDBAY]: () => [
    B(0.06, 0.94, 0.24, 0.78, 0, 0.48, 'medBase', { lamp: [0.88, 0.4] }),
    B(0.08, 0.92, 0.27, 0.75, 0.48, 0.57, 'medPad'),
    B(0.04, 0.12, 0.02, 0.12, 0, 1.44, 'metal'),
    B(0.04, 0.62, 0.02, 0.12, 1.36, 1.44, 'metal'),
    B(0.32, 0.68, 0.06, 0.3, 1.2, 1.36, 'medHood'),
    B(0.76, 0.98, 0.0, 0.06, 0.86, 1.24, 'screenFrame', { screen: { ink: 'med', u0: 0.79, u1: 0.95, y0: 0.9, y1: 1.2 } }),
  ],
  [T.LIFE_SUPPORT]: () => [
    B(0.02, 0.98, 0, 0.66, 0, 1.42, 'machine', { deco: 'vents', lamp: [0.9, 1.3], screen: { ink: 'rack', u0: 0.62, u1: 0.88, y0: 1.04, y1: 1.24 } }),
    CYL(0.2, 0.16, 0.06, 1.42, 1.6, 'pipeBlue', { n: 8 }),
    CYL(0.8, 0.16, 0.06, 1.42, 1.6, 'pipeGreen', { n: 8 }),
    CYL(0.5, 0.18, 0.08, 1.42, 1.6, 'metalDk', { n: 8 }),
  ],
  [T.WATER_RECYCLER]: () => [
    B(0.04, 0.96, 0.04, 0.62, 0, 0.08, 'metalDk'),
    CYL(0.28, 0.3, 0.2, 0.08, 1.25, 'tank'),
    CYL(0.72, 0.3, 0.2, 0.08, 1.25, 'tank'),
    CYL(0.28, 0.3, 0.05, 1.25, 1.6, 'pipeBlue', { n: 8 }),
    CYL(0.72, 0.3, 0.05, 1.25, 1.6, 'pipeBlue', { n: 8 }),
    B(0.36, 0.64, 0.56, 0.86, 0, 0.42, 'machine', { lamp: [0.58, 0.34] }),
  ],
  [T.WORKBENCH]: () => [
    B(0.02, 0.98, 0.02, 0.58, 0, 0.78, 'cabinet', { deco: 'drawers' }),
    B(0, 1, 0, 0.62, 0.78, 0.84, 'benchTop'),
    B(0.04, 0.96, 0, 0.03, 0.94, 1.46, 'toolboard', { deco: 'tools' }),
    B(0.14, 0.3, 0.34, 0.54, 0.84, 0.97, 'metal'),
    B(0.6, 0.86, 0.12, 0.42, 0.84, 1.02, 'machine', { lamp: [0.82, 0.96] }),
  ],
  [T.STORAGE]: (c) => c.zone === 'cargo' ? crateStack(c) : shelving(c),
  [T.EVA_LOCKER]: (c) => [
    B(0.1, 0.9, 0, 0.56, 0, 1.48, 'locker', { deco: c.suit ? 'lockerSuit' : 'lockerEmpty' }),
  ],
  // the top of the drive: its ribbed casing coming up through the deck, feed lines to the deckhead
  [T.ENGINE]: () => [
    CYL(0.5, 0.5, 0.47, 0, 0.1, 'driveDk', { n: 24 }),
    CYL(0.5, 0.5, 0.42, 0.1, 0.52, 'drive', { n: 24, ribs: true }),
    CYL(0.5, 0.5, 0.425, 0.52, 0.6, 'hazard', { n: 24 }),
    CYL(0.5, 0.5, 0.42, 0.6, 1.08, 'drive', { n: 24, ribs: true, lamp: [0.5, 0.96] }),
    CYL(0.5, 0.5, 0.46, 1.08, 1.17, 'driveDk', { n: 24 }),
    CYL(0.5, 0.5, 0.3, 1.17, 1.27, 'metal', { n: 18 }),
    CYL(0.32, 0.5, 0.05, 1.27, 1.6, 'pipeBlue', { n: 8 }),
    CYL(0.68, 0.5, 0.05, 1.27, 1.6, 'pipeBlue', { n: 8 }),
    CYL(0.5, 0.36, 0.06, 1.27, 1.6, 'metalDk', { n: 8 }),
  ],
  [T.REACTOR]: (c) => [
    CYL(0.5, 0.5, 0.48, 0, 0.16, 'reactorRing', { n: 24 }),
    CYL(0.5, 0.5, 0.44, 0.16, 0.6, 'reactor', { n: 24 }),
    CYL(0.5, 0.5, 0.42, 0.6, 0.84, c.glow ? 'glow' : 'glass', { n: 24, emit: c.glow }),
    CYL(0.5, 0.5, 0.44, 0.84, 1.36, 'reactor', { n: 24, lamp: [0.5, 1.2] }),
    CYL(0.5, 0.5, 0.48, 1.3, 1.42, 'reactorRing', { n: 24 }),
    CYL(0.5, 0.5, 0.2, 1.42, 1.6, 'metalDk', { n: 12 }),
  ],
  [T.TORPEDO_LAUNCHER]: () => [
    B(0, 1, 0, 0.8, 0, 1.46, 'launcher', { deco: 'tubes', lamp: [0.9, 1.34], screen: { ink: 'weapons', u0: 0.66, u1: 0.9, y0: 1.04, y1: 1.24 } }),
  ],
  [T.AIRLOCK]: () => [B(0.05, 0.95, 0.05, 0.95, 0, 1.5, 'pod')],
  [T.DOOR]: () => [],
};

const MODEL_PDC = () => [
  B(0.12, 0.88, 0, 0.12, 0.18, 1.32, 'metalDk'),
  CYL(0.5, 0.2, 0.17, 0.3, 1.12, 'pdc', { n: 14, lamp: [0.5, 1.04] }),
  B(0.62, 0.92, 0.1, 0.42, 0.3, 0.72, 'launcher'),
];
const MODEL_WELL = () => [
  B(0.15, 0.19, 0.17, 0.21, 0, 0.7, 'metal'),
  B(0.81, 0.85, 0.17, 0.21, 0, 0.7, 'metal'),
  B(0.15, 0.85, 0.17, 0.21, 0.66, 0.7, 'hazard'),
];

function shelving(c) {
  const p = [B(0.02, 0.07, 0, 0.7, 0, 1.46, 'metal'), B(0.93, 0.98, 0, 0.7, 0, 1.46, 'metal')];
  const levels = [0.04, 0.52, 1.0];
  levels.forEach((y, i) => {
    p.push(B(0.02, 0.98, 0, 0.7, y, y + 0.04, 'metalDk'));
    const n = 1 + Math.floor(hash(c.x, c.z, i) * 3);
    let u = 0.1;
    for (let k = 0; k < n && u < 0.86; k++) {
      const wdt = 0.2 + hash(c.x, i, k) * 0.24, hgt = 0.18 + hash(i, c.z, k) * 0.2;
      const col = ['crateA', 'crateC', 'crateB'][Math.floor(hash(k, c.x + i, c.z) * 3)];
      p.push(B(u, Math.min(0.9, u + wdt), 0.06, 0.62, y + 0.04, y + 0.04 + Math.min(hgt, 0.42), col));
      u += wdt + 0.04;
    }
  });
  return p;
}

function crateStack(c) {
  const a = ['crateA', 'crateB', 'crateC'][Math.floor(hash(c.x, c.z) * 3)];
  const b = ['crateC', 'crateA', 'crateB'][Math.floor(hash(c.z, c.x, 7) * 3)];
  const p = [B(0.04, 0.96, 0.04, 0.92, 0, 0.06, 'metalDk'), B(0.06, 0.94, 0.06, 0.9, 0.06, 0.66, a, { deco: 'straps' })];
  if (hash(c.x, c.z, 3) > 0.25) p.push(B(0.12, 0.86, 0.1, 0.8, 0.66, 1.12 + hash(c.x, 2, c.z) * 0.2, b, { deco: 'straps' }));
  return p;
}

// Canonical (u, w) → world (x, z) for a fixture facing each way
function placer(fx) {
  const { x, z, facing } = fx;
  switch (facing) {
    case 'N': return { p: (u, w) => [x + 1 - u, z + 1 - w], n: (nu, nw) => [-nu, -nw] };
    case 'E': return { p: (u, w) => [x + w, z + 1 - u], n: (nu, nw) => [nw, -nu] };
    case 'W': return { p: (u, w) => [x + 1 - w, z + u], n: (nu, nw) => [-nw, nu] };
    default: return { p: (u, w) => [x + u, z + w], n: (nu, nw) => [nu, nw] };
  }
}

// ---- LENS ----

export class Lens {
  constructor(room, W, H, pad) {
    const w = room.x1 - room.x0, d = room.z1 - room.z0;
    const tgt = [(room.x0 + room.x1) / 2 + w * 0.03, 0.5, (room.z0 + room.z1) / 2 + d * 0.04];
    const D = Math.hypot(w, d, CEIL) * LENS_K;
    const cp = Math.cos(PITCH), sp = Math.sin(PITCH), cy = Math.cos(YAW), sy = Math.sin(YAW);
    this.f = [-sy * cp, -sp, -cy * cp];
    this.r = [cy, 0, -sy];
    this.u = [-sy * sp, cp, -cy * sp];
    this.eye = [tgt[0] - this.f[0] * D, tgt[1] - this.f[1] * D, tgt[2] - this.f[2] * D];
    this.s = 1; this.ox = 0; this.oy = 0;
    // Frame the floor, the far and side bulkheads up to the deckhead
    const pts = [];
    for (const [x, z] of room.cells) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pts.push([x + dx, 0, z + dz]);
    // (only the far ends of the side walls: their near tops run off the frame, as through a real lens)
    for (const wl of room.walls) if (this.facing(wl)) {
      for (const [x, z] of [wl.a, wl.b]) if (wl.n[1] > 0 || z <= room.z0 + 0.01) pts.push([x, CEIL, z]);
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y, z] of pts) {
      const q = this.p(x, y, z);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const s = Math.min((W - pad.l - pad.r) / (x1 - x0), (H - pad.t - pad.b) / (y1 - y0));
    this.s = s;
    this.ox = pad.l + (W - pad.l - pad.r) / 2 - s * (x0 + x1) / 2;
    this.oy = pad.t + (H - pad.t - pad.b) / 2 - s * (y0 + y1) / 2;
  }

  /** World (tiles; y up) → canvas pixels, and the depth along the lens axis. */
  p(x, y, z) {
    const dx = x - this.eye[0], dy = y - this.eye[1], dz = z - this.eye[2];
    const xc = dx * this.r[0] + dy * this.r[1] + dz * this.r[2];
    const yc = dx * this.u[0] + dy * this.u[1] + dz * this.u[2];
    const zc = dx * this.f[0] + dy * this.f[1] + dz * this.f[2];
    return [this.ox + this.s * xc / zc, this.oy - this.s * yc / zc, zc];
  }

  /** Pixels per tile at a depth. */
  k(zc) { return this.s / zc; }

  dist(x, y, z) { return Math.hypot(x - this.eye[0], y - this.eye[1], z - this.eye[2]); }

  /** Does a wall's inner face turn toward the lens? */
  facing(wl) { return wl.n[0] * (this.eye[0] - wl.a[0]) + wl.n[1] * (this.eye[2] - wl.a[1]) > 0.01; }
}

// ---- LIGHT ----

function light(x, y, z, r, g, b, i, rad, cone = 0) { return { x, y, z, r, g, b, i, rad2: rad * rad, cone }; }

/** Irradiance at a point with a normal: ambient plus every light (soft inverse square, cosine, downlight cone). */
function irr(env, px, py, pz, nx, ny, nz, out) {
  let r = env.amb[0], g = env.amb[1], b = env.amb[2];
  for (const l of env.lights) {
    const dx = l.x - px, dy = l.y - py, dz = l.z - pz;
    const d2 = dx * dx + dy * dy + dz * dz + 1e-4;
    const d = Math.sqrt(d2);
    let c = (dx * nx + dy * ny + dz * nz) / d;
    if (c <= 0) continue;
    // (half-wrapped, so a face edge-on to a light is not black)
    c = c * 0.8 + 0.2;
    if (l.cone) { const dn = -dy / d; if (dn <= 0) continue; c *= Math.pow(dn, l.cone); }
    const f = l.i * c / (1 + d2 / l.rad2);
    r += l.r * f; g += l.g * f; b += l.b * f;
  }
  out[0] = r * env.exp; out[1] = g * env.exp; out[2] = b * env.exp;
  return out;
}

/** The room's lighting state, worst first. */
function lightMode(state, deck) {
  const a = deck.atmosphere || {};
  if ((a.pressure ?? 101) < ATMO.PRESSURE_LETHAL) return 'vacuum';
  if (state.reactor?.blackout) return 'blackout';
  if (state.reactor && state.reactor.status !== 'online') return 'emergency';
  if (state.combatStations) return 'battle';
  return 'normal';
}

const MODE = {
  normal: { amb: [0.22, 0.24, 0.27], panel: [0.93, 0.97, 1.0], pi: 1.25, exp: 1.0, screens: true, cove: true },
  battle: { amb: [0.08, 0.065, 0.07], panel: [0.9, 0.93, 1.0], pi: 0.45, exp: 1.25, screens: true, red: true },
  emergency: { amb: [0.06, 0.05, 0.045], panel: [1.0, 0.86, 0.7], pi: 0.1, exp: 1.45, screens: true, amber: true, strips: true },
  blackout: { amb: [0.03, 0.03, 0.035], panel: [0, 0, 0], pi: 0, exp: 1.9, screens: false, strips: true },
  vacuum: { amb: [0.06, 0.075, 0.095], panel: [0, 0, 0], pi: 0, exp: 1.45, screens: false, strips: true, frost: true },
};

function buildEnv(room, mode, fixtures, glow) {
  const m = MODE[mode];
  const lights = [];
  // each panel: a downlight (the pool on the deck) and the spill that lights the bulkheads
  if (m.pi > 0) for (const [lx, lz] of room.ceil) {
    lights.push(light(lx, CEIL - 0.03, lz, ...m.panel, m.pi, 1.6, 2.4));
    lights.push(light(lx, CEIL - 0.1, lz, ...m.panel, m.pi * 0.3, 2.2));
  }
  const along = (wl, y, inset, step, col, i, rad, cone = 0) => {
    const n = Math.max(1, Math.round(wl.len / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      lights.push(light(wl.a[0] + (wl.b[0] - wl.a[0]) * t + wl.n[0] * inset, y, wl.a[1] + (wl.b[1] - wl.a[1]) * t + wl.n[1] * inset, ...col, i, rad, cone));
    }
  };
  for (const wl of room.walls) {
    if (wl.n[1] < 0) continue;   // the bulkhead behind the camera
    if (m.red) along(wl, RED_Y, 0.06, 0.6, [1, 0.12, 0.09], 0.24, 0.7);
    if (m.cove && wl.n[1] > 0) along(wl, CEIL - 0.05, 0.05, 0.9, [0.9, 0.95, 1.0], 0.1, 0.8, 0.5);
    if (m.strips) along(wl, 0.04, 0.05, 0.8, mode === 'vacuum' ? [0.7, 0.85, 1.0] : [1, 0.62, 0.22], mode === 'blackout' ? 0.06 : 0.08, 0.45);
    if (m.amber && wl.n[1] > 0) {
      const ux = (wl.b[0] - wl.a[0]) / wl.len, uz = (wl.b[1] - wl.a[1]) / wl.len;
      for (const u of lampSpots(wl)) lights.push(light(wl.a[0] + ux * u + wl.n[0] * 0.12, 1.3, wl.a[1] + uz * u + wl.n[1] * 0.12, 1, 0.6, 0.2, 0.55, 1.1));
    }
  }
  for (const f of fixtures) {
    for (const s of f.screens || []) if (m.screens) lights.push(light(s.wx, s.wy, s.wz, 0.55, 0.78, 1.0, mode === 'normal' ? 0.1 : 0.16, 0.5));
    if (f.t === T.REACTOR && glow) lights.push(light(f.x + 0.5, 0.72, f.z + 0.5, 0.45, 0.66, 1.0, 0.9, 0.85));
    if (f.t === T.MEDBAY && m.screens) lights.push(light(f.x + 0.5, 1.16, f.z + 0.5, 0.85, 1.0, 0.95, 0.35, 0.5, 1));
  }
  return { mode, m, lights, amb: m.amb, exp: m.exp };
}

// ---- TEXTURED PLANES ----
// Canvas 2D has no perspective mapping: a plane is split into small quads,
// each drawn as two affine triangles (clipped a hair wider than exact, so
// no seam shows between them).

function texTri(g, img, s0x, s0y, s1x, s1y, s2x, s2y, d0x, d0y, d1x, d1y, d2x, d2y) {
  const cx = (d0x + d1x + d2x) / 3, cy = (d0y + d1y + d2y) / 3;
  const grow = (x, y) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + dx / l * 0.8, y + dy / l * 0.8]; };
  const a0 = grow(d0x, d0y), a1 = grow(d1x, d1y), a2 = grow(d2x, d2y);
  g.save();
  g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.lineTo(a2[0], a2[1]); g.closePath(); g.clip();
  const S11 = s1x - s0x, S12 = s2x - s0x, S21 = s1y - s0y, S22 = s2y - s0y;
  const D11 = d1x - d0x, D12 = d2x - d0x, D21 = d1y - d0y, D22 = d2y - d0y;
  const det = S11 * S22 - S12 * S21;
  if (Math.abs(det) > 1e-9) {
    const a = (D11 * S22 - D12 * S21) / det, c = (-D11 * S12 + D12 * S11) / det;
    const b = (D21 * S22 - D22 * S21) / det, d = (-D21 * S12 + D22 * S11) / det;
    g.transform(a, b, c, d, d0x - a * s0x - c * s0y, d0y - b * s0x - d * s0y);
    g.drawImage(img, 0, 0);
  }
  g.restore();
}

/**
 * Map a texture onto a plane quad. `at(fu, fv)` gives the world point at a
 * fraction of the quad; (u0..u1, v0..v1) its texels.
 */
function mapQuad(g, lens, img, at, u0, v0, u1, v1, nu, nv) {
  const P = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const w = at(i / nu, j / nv); P.push(lens.p(w[0], w[1], w[2])); }
  const S = (i, j) => [u0 + (u1 - u0) * i / nu, v0 + (v1 - v0) * j / nv];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const p00 = P[j * (nu + 1) + i], p10 = P[j * (nu + 1) + i + 1], p01 = P[(j + 1) * (nu + 1) + i], p11 = P[(j + 1) * (nu + 1) + i + 1];
    const s00 = S(i, j), s10 = S(i + 1, j), s01 = S(i, j + 1), s11 = S(i + 1, j + 1);
    texTri(g, img, s00[0], s00[1], s10[0], s10[1], s11[0], s11[1], p00[0], p00[1], p10[0], p10[1], p11[0], p11[1]);
    texTri(g, img, s00[0], s00[1], s11[0], s11[1], s01[0], s01[1], p00[0], p00[1], p11[0], p11[1], p01[0], p01[1]);
  }
}

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };

/** Multiply a texture by a light map computed per texel by `fn(tx, ty, out)` (texel centres in tiles). */
function applyLight(g, W, H, wT, hT, fn) {
  const lw = Math.max(2, Math.ceil(wT * LIGHT_PPU)), lh = Math.max(2, Math.ceil(hT * LIGHT_PPU));
  const lm = canvasOf(lw, lh);
  const lg = lm.getContext('2d');
  const img = lg.createImageData(lw, lh);
  const out = [0, 0, 0];
  for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
    fn((i + 0.5) / LIGHT_PPU, (j + 0.5) / LIGHT_PPU, out);
    const o = (j * lw + i) * 4;
    img.data[o] = Math.min(255, tone(out[0]) * 255);
    img.data[o + 1] = Math.min(255, tone(out[1]) * 255);
    img.data[o + 2] = Math.min(255, tone(out[2]) * 255);
    img.data[o + 3] = 255;
  }
  lg.putImageData(img, 0, 0);
  g.save();
  g.globalCompositeOperation = 'multiply';
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(lm, 0, 0, lw / LIGHT_PPU / wT * W, lh / LIGHT_PPU / hT * H);
  g.restore();
}

function hazardBand(g, x, y, w, h, stripe) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = ALB.hazardDk; g.fillRect(x, y, w, h);
  g.fillStyle = ALB.hazard;
  const s = stripe;
  for (let k = -h; k < w + h; k += s * 2) {
    g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + s, y + h); g.lineTo(x + k + s + h, y); g.lineTo(x + k + h, y); g.closePath(); g.fill();
  }
  g.restore();
}

// ---- FLOOR ----

function paintFloor(room, env, ppu) {
  const w = room.x1 - room.x0, d = room.z1 - room.z0;
  const W = Math.ceil(w * ppu), H = Math.ceil(d * ppu);
  const c = canvasOf(W, H), g = c.getContext('2d');
  const X = (x) => (x - room.x0) * ppu, Z = (z) => (z - room.z0) * ppu;
  g.fillStyle = ALB.floor; g.fillRect(0, 0, W, H);
  const lw = Math.max(1, ppu * 0.018);
  const tiles = room.tiles;
  for (const [x, z] of room.cells) {
    const t = tiles[z][x];
    // plates, a hair different from each other, as plating is
    const base = rgb(hash(x, z, room.di) < 0.5 ? ALB.floor : ALB.floorAlt);
    const k = 0.97 + hash(z, x, 5) * 0.06;
    g.fillStyle = css(base[0] * k, base[1] * k, base[2] * k);
    g.fillRect(X(x), Z(z), ppu, ppu);
    // the open deck between the furniture: a ribbed mat
    const walk = (t === T.FLOOR || t === T.DOOR) && [[1, 0], [-1, 0]].every(([dx]) => !room.inside(x + dx, z) || WALKABLE.has(tileAt(tiles, x + dx, z)));
    if (walk) {
      g.fillStyle = ALB.mat; g.fillRect(X(x), Z(z) + ppu * 0.16, ppu, ppu * 0.68);
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = lw;
      for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(X(x) + i * ppu / 8, Z(z) + ppu * 0.18); g.lineTo(X(x) + i * ppu / 8, Z(z) + ppu * 0.82); g.stroke(); }
      g.fillStyle = ALB.matEdge; g.fillRect(X(x), Z(z) + ppu * 0.16, ppu, lw); g.fillRect(X(x), Z(z) + ppu * 0.84 - lw, ppu, lw);
    }
    g.strokeStyle = ALB.seam; g.lineWidth = lw;
    g.strokeRect(X(x) + lw / 2, Z(z) + lw / 2, ppu - lw, ppu - lw);
    g.fillStyle = ALB.seam;
    for (const [fx, fz] of [[0.07, 0.07], [0.93, 0.07], [0.07, 0.93], [0.93, 0.93]]) { g.beginPath(); g.arc(X(x + fx), Z(z + fz), ppu * 0.014, 0, Math.PI * 2); g.fill(); }
    if (t === T.DOOR) { g.fillStyle = ALB.metalDk; g.fillRect(X(x) + ppu * 0.44, Z(z), ppu * 0.12, ppu); hazardBand(g, X(x) + ppu * 0.4, Z(z), ppu * 0.04, ppu, ppu * 0.06); }
  }
  // Marked floor: around the reactor and the drive housings, before hatches and the gun
  for (const f of room.fixtures) {
    if (f.t === T.REACTOR || f.t === T.ENGINE) {
      const m = 0.02;
      hazardBand(g, X(f.x) + ppu * m, Z(f.z) + ppu * m, ppu * (1 - 2 * m), ppu * 0.07, ppu * 0.07);
      hazardBand(g, X(f.x) + ppu * m, Z(f.z + 1) - ppu * (m + 0.07), ppu * (1 - 2 * m), ppu * 0.07, ppu * 0.07);
      hazardBand(g, X(f.x) + ppu * m, Z(f.z) + ppu * m, ppu * 0.07, ppu * (1 - 2 * m), ppu * 0.07);
      hazardBand(g, X(f.x + 1) - ppu * (m + 0.07), Z(f.z) + ppu * m, ppu * 0.07, ppu * (1 - 2 * m), ppu * 0.07);
    }
  }
  for (const { wall: wl, unit: u } of room.wallFx) {
    // an apron of stripes where a hatch or the cargo door opens
    const [ax, az] = [u.cx, u.cz];
    const dpt = u.t === T.CARGO_DOOR ? 0.28 : 0.12;
    if (wl.n[0] > 0) hazardBand(g, X(ax), Z(az) + ppu * 0.08, ppu * dpt, ppu * 0.84, ppu * 0.07);
    else if (wl.n[0] < 0) hazardBand(g, X(ax + 1) - ppu * dpt, Z(az) + ppu * 0.08, ppu * dpt, ppu * 0.84, ppu * 0.07);
    else if (wl.n[1] > 0) hazardBand(g, X(ax) + ppu * 0.08, Z(az), ppu * 0.84, ppu * dpt, ppu * 0.07);
  }
  for (const l of room.ladders) {
    if (l.up) { hazardBand(g, X(l.x) + ppu * 0.12, Z(l.z) + ppu * 0.02, ppu * 0.76, ppu * 0.06, ppu * 0.06); continue; }
    // the well: a hole in the plating, the ladder's rungs going down into the dark
    const x = X(l.x), z = Z(l.z);
    hazardBand(g, x + ppu * 0.08, z + ppu * 0.12, ppu * 0.84, ppu * 0.8, ppu * 0.07);
    g.fillStyle = '#06080B'; g.fillRect(x + ppu * 0.16, z + ppu * 0.2, ppu * 0.68, ppu * 0.64);
    const grd = g.createLinearGradient(0, z + ppu * 0.2, 0, z + ppu * 0.84);
    grd.addColorStop(0, 'rgba(120,130,140,0.55)'); grd.addColorStop(1, 'rgba(120,130,140,0)');
    g.strokeStyle = grd; g.lineWidth = ppu * 0.03;
    g.beginPath(); g.moveTo(x + ppu * 0.3, z + ppu * 0.2); g.lineTo(x + ppu * 0.3, z + ppu * 0.84); g.moveTo(x + ppu * 0.7, z + ppu * 0.2); g.lineTo(x + ppu * 0.7, z + ppu * 0.84);
    for (let k = 0; k < 4; k++) { const y = z + ppu * (0.28 + k * 0.15); g.moveTo(x + ppu * 0.3, y); g.lineTo(x + ppu * 0.7, y); }
    g.stroke();
  }
  // Light: the panels' pools, darker into the corners and under the furniture
  const foot = [];
  for (const f of room.fixtures) if (f.foot) foot.push(f.foot);
  const edges = [];
  for (const wl of room.walls) edges.push(wl);
  applyLight(g, W, H, w, d, (tx, tz, out) => {
    const x = room.x0 + tx, z = room.z0 + tz;
    irr(env, x, 0, z, 0, 1, 0, out);
    let ao = 1;
    for (const wl of edges) {
      const dd = segDist(x, z, wl.a[0], wl.a[1], wl.b[0], wl.b[1]);
      ao *= 1 - 0.38 * Math.exp(-dd / 0.16);
    }
    for (const [fx0, fz0, fx1, fz1] of foot) {
      const dx = Math.max(fx0 - x, 0, x - fx1), dz = Math.max(fz0 - z, 0, z - fz1);
      ao *= 1 - 0.5 * Math.exp(-Math.hypot(dx, dz) / 0.12);
    }
    out[0] *= ao; out[1] *= ao; out[2] *= ao;
  });
  if (env.m.frost) {
    frost(g, W, H);
    g.save(); g.globalCompositeOperation = 'screen';
    for (const wl of room.walls) {
      // rime along every bulkhead, where the cold hull meets the deck
      const [ax, az] = [X(wl.a[0]), Z(wl.a[1])], [bx, bz] = [X(wl.b[0]), Z(wl.b[1])];
      const nx = wl.n[0] * ppu * 0.45, nz = wl.n[1] * ppu * 0.45;
      const gr = g.createLinearGradient(ax, az, ax + nx, az + nz);
      gr.addColorStop(0, 'rgba(205,225,245,0.32)'); gr.addColorStop(1, 'rgba(205,225,245,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(ax, az); g.lineTo(bx, bz); g.lineTo(bx + nx, bz + nz); g.lineTo(ax + nx, az + nz); g.closePath(); g.fill();
    }
    g.restore();
  }
  return c;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function frost(g, W, H) {
  g.save();
  g.globalCompositeOperation = 'screen';
  g.fillStyle = 'rgba(120,150,180,0.16)';
  g.fillRect(0, 0, W, H);
  g.restore();
}

// ---- WALLS ----

function paintWall(room, wl, env, ppu, deckLabel) {
  const W = Math.ceil(wl.len * ppu), H = Math.ceil(CEIL * ppu);
  const c = canvasOf(W, H), g = c.getContext('2d');
  const V = (y) => (CEIL - y) * ppu;
  const lw = Math.max(1, ppu * 0.016);
  g.fillStyle = ALB.wall; g.fillRect(0, 0, W, H);
  g.fillStyle = ALB.wallLow; g.fillRect(0, V(0.34), W, H - V(0.34));
  g.fillStyle = ALB.wallSeam;
  for (let u = 0; u <= wl.len + 0.01; u += 0.5) g.fillRect(u * ppu - lw / 2, V(1.24), lw, V(0.34) - V(1.24));
  for (let u = 0; u <= wl.len + 0.01; u += 1) g.fillRect(u * ppu - lw / 2, V(0.34), lw, H - V(0.34));
  g.fillRect(0, V(0.34), W, lw); g.fillRect(0, V(1.24), W, lw);
  // conduit along the deckhead, a handrail at waist height (handholds for free fall)
  const pipe = (y, r, col) => {
    g.fillStyle = col; g.fillRect(0, V(y + r), W, r * 2 * ppu);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, V(y + r * 0.6), W, Math.max(1, r * 0.5 * ppu));
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, V(y - r * 0.4), W, Math.max(1, r * 0.6 * ppu));
  };
  pipe(1.44, 0.035, ALB.conduit); pipe(1.52, 0.025, ALB.pipeBlue); pipe(1.36, 0.02, ALB.conduitDk);
  g.fillStyle = ALB.conduitDk;
  for (let u = 0.5; u < wl.len; u += 1) g.fillRect(u * ppu - ppu * 0.02, V(1.56), ppu * 0.04, ppu * 0.24);
  const rail = (u0, u1) => {
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(u0 * ppu, V(0.95), (u1 - u0) * ppu, ppu * 0.03);
    g.fillStyle = ALB.rail; g.fillRect(u0 * ppu, V(1.0), (u1 - u0) * ppu, ppu * 0.035);
    g.fillStyle = ALB.metalDk;
    for (let u = Math.ceil(u0 + 0.25); u < u1; u += 1) g.fillRect((u - 0.02) * ppu, V(1.0), ppu * 0.04, ppu * 0.06);
  };
  // what is cut in the bulkhead, unit by unit
  let railFrom = 0;
  const units = wl.units;
  for (const u of units) {
    const x = u.k * ppu;
    const busy = u.t === T.AIRLOCK || u.t === T.CARGO_DOOR || u.t === T.PDC_MOUNT || (u.front === T.LADDER && wl.n[1] > 0);
    if (busy) { if (u.k > railFrom) rail(railFrom, u.k); railFrom = u.k + 1; }
    if (u.t === T.AIRLOCK) {
      g.fillStyle = ALB.metalDk; roundRect(g, x + ppu * 0.1, V(1.42), ppu * 0.8, V(0) - V(1.42), ppu * 0.1); g.fill();
      g.fillStyle = ALB.frame; roundRect(g, x + ppu * 0.16, V(1.34), ppu * 0.68, V(0.04) - V(1.34), ppu * 0.08); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x + ppu * 0.49, V(1.3), ppu * 0.02, V(0.08) - V(1.3));
      g.fillStyle = ALB.glass; g.beginPath(); g.arc(x + ppu * 0.5, V(1.04), ppu * 0.09, 0, Math.PI * 2); g.fill();
      g.strokeStyle = ALB.rail; g.lineWidth = lw * 1.5; g.beginPath(); g.arc(x + ppu * 0.5, V(1.04), ppu * 0.1, 0, Math.PI * 2); g.stroke();
      g.fillStyle = ALB.metalDk; g.fillRect(x + ppu * 0.68, V(0.66), ppu * 0.06, ppu * 0.14);
      hazardBand(g, x + ppu * 0.1, V(1.5), ppu * 0.8, ppu * 0.06, ppu * 0.05);
    } else if (u.t === T.CARGO_DOOR) {
      g.fillStyle = ALB.metalDk; g.fillRect(x + ppu * 0.02, V(1.46), ppu * 0.96, V(0) - V(1.46));
      g.fillStyle = ALB.frame; g.fillRect(x + ppu * 0.08, V(1.38), ppu * 0.84, V(0.02) - V(1.38));
      g.fillStyle = 'rgba(0,0,0,0.3)';
      for (let k = 1; k < 6; k++) g.fillRect(x + ppu * 0.08, V(0.02 + k * 0.226), ppu * 0.84, lw);
      hazardBand(g, x + ppu * 0.02, V(1.46), ppu * 0.96, ppu * 0.08, ppu * 0.07);
      hazardBand(g, x + ppu * 0.02, V(0.1), ppu * 0.96, ppu * 0.08, ppu * 0.07);
    } else if (u.t === T.PDC_MOUNT) {
      g.fillStyle = '#20262D'; g.fillRect(x + ppu * 0.08, V(1.4), ppu * 0.84, V(0.1) - V(1.4));
      hazardBand(g, x + ppu * 0.04, V(1.46), ppu * 0.92, ppu * 0.06, ppu * 0.05);
      hazardBand(g, x + ppu * 0.04, V(0.1), ppu * 0.92, ppu * 0.06, ppu * 0.05);
    } else if (u.front === T.LADDER && wl.n[1] > 0) {
      // the ladder up the bulkhead to the hatch in the deckhead
      g.fillStyle = '#0A0D11'; g.fillRect(x + ppu * 0.16, 0, ppu * 0.68, ppu * 0.1);
      hazardBand(g, x + ppu * 0.12, ppu * 0.1, ppu * 0.76, ppu * 0.05, ppu * 0.05);
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + ppu * 0.27, 0, ppu * 0.03, H); g.fillRect(x + ppu * 0.73, 0, ppu * 0.03, H);
      g.fillStyle = ALB.rail; g.fillRect(x + ppu * 0.25, ppu * 0.15, ppu * 0.03, H); g.fillRect(x + ppu * 0.72, ppu * 0.15, ppu * 0.03, H);
      for (let y = 0.18; y < CEIL - 0.15; y += 0.2) {
        g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + ppu * 0.28, V(y) + ppu * 0.02, ppu * 0.44, ppu * 0.02);
        g.fillStyle = ALB.rail; g.fillRect(x + ppu * 0.28, V(y), ppu * 0.44, ppu * 0.025);
      }
    }
  }
  if (units.length > railFrom) rail(railFrom, units.length);
  // a fire extinguisher by the first plain stretch of the far bulkhead; emergency lamp housings
  if (wl.n[1] > 0) {
    const plain = units.find(u => plainHull(u) && u.front !== T.LADDER && u.k > 0);
    if (plain && wl === room.mainWall) {
      const x = plain.k * ppu + ppu * 0.06;
      g.fillStyle = ALB.metalDk; g.fillRect(x - ppu * 0.01, V(0.92), ppu * 0.14, ppu * 0.04);
      g.fillStyle = ALB.extinguisher; roundRect(g, x + ppu * 0.015, V(0.9), ppu * 0.09, ppu * 0.42, ppu * 0.03); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x + ppu * 0.03, V(0.86), ppu * 0.015, ppu * 0.34);
    }
    for (const x of lampSpots(wl)) {
      g.fillStyle = ALB.metalDk; g.fillRect((x - 0.09) * ppu, V(1.34), ppu * 0.18, ppu * 0.09);
      g.fillStyle = '#4A3A20'; g.fillRect((x - 0.07) * ppu, V(1.32), ppu * 0.14, ppu * 0.05);
    }
  }
  // the compartment's stencil on the far bulkhead
  if (deckLabel && wl === room.mainWall) {
    // (over open deck, where nothing stands in front of it)
    const plain = units.find(u => plainHull(u) && u.front === T.FLOOR && u.k + 1 < units.length);
    if (plain) {
      g.save();
      g.font = `600 ${Math.round(ppu * 0.15)}px ${F_UI}`;
      g.fillStyle = 'rgba(25,30,36,0.55)';
      g.textBaseline = 'alphabetic';
      g.fillText(deckLabel, plain.k * ppu + ppu * 0.12, V(1.07));
      g.restore();
    }
  }
  // light, then what glows by itself
  const [nx, nz] = wl.n;
  const ax = wl.a[0], az = wl.a[1], ux = (wl.b[0] - wl.a[0]) / wl.len, uz = (wl.b[1] - wl.a[1]) / wl.len;
  applyLight(g, W, H, wl.len, CEIL, (tu, tv, out) => {
    const x = ax + ux * tu + nx * 0.01, z = az + uz * tu + nz * 0.01, y = CEIL - tv;
    irr(env, x, y, z, nx, 0, nz, out);
    const ao = (1 - 0.35 * Math.exp(-y / 0.12)) * (1 - 0.3 * Math.exp(-tu / 0.14)) * (1 - 0.3 * Math.exp(-(wl.len - tu) / 0.14)) * (1 - 0.25 * Math.exp(-(CEIL - y) / 0.1));
    out[0] *= ao; out[1] *= ao; out[2] *= ao;
  });
  if (env.m.frost) {
    frost(g, W, H);
    const gr = g.createLinearGradient(0, H, 0, V(0.7));
    gr.addColorStop(0, 'rgba(205,225,245,0.34)'); gr.addColorStop(1, 'rgba(205,225,245,0)');
    g.save(); g.globalCompositeOperation = 'screen'; g.fillStyle = gr; g.fillRect(0, V(0.7), W, H - V(0.7)); g.restore();
  }
  // emissive: battle strip, floor strips, emergency lamps
  const m = env.m;
  g.save();
  if (m.red) {
    // the battle strip: a red bar under the conduit, its glow on the bulkhead around it
    const gr = g.createLinearGradient(0, V(RED_Y + 0.22), 0, V(RED_Y - 0.4));
    gr.addColorStop(0, 'rgba(255,40,30,0)'); gr.addColorStop(0.35, 'rgba(255,40,30,0.28)'); gr.addColorStop(1, 'rgba(255,40,30,0)');
    g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(0, V(RED_Y + 0.22), W, ppu * 0.62);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#FF4A3A'; g.fillRect(0, V(RED_Y), W, Math.max(1.5, ppu * 0.022));
  }
  if (m.strips) {
    const col = env.mode === 'vacuum' ? '#9FC4E8' : '#FFA23A';
    const glowC = env.mode === 'vacuum' ? '150,190,230' : '255,150,50';
    const gr = g.createLinearGradient(0, V(0.3), 0, H);
    gr.addColorStop(0, `rgba(${glowC},0)`); gr.addColorStop(0.75, `rgba(${glowC},0.22)`); gr.addColorStop(1, `rgba(${glowC},0.05)`);
    g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(0, V(0.3), W, H - V(0.3));
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = col; g.globalAlpha = env.mode === 'blackout' ? 0.75 : 0.9;
    g.fillRect(0, V(0.05), W, Math.max(1.5, ppu * 0.022));
    g.globalAlpha = 1;
  }
  if (m.amber && wl.n[1] > 0) for (const x of lampSpots(wl)) {
    g.fillStyle = '#FFB347'; g.fillRect((x - 0.07) * ppu, V(1.32), ppu * 0.14, ppu * 0.05);
    const gr = g.createRadialGradient(x * ppu, V(1.3), 0, x * ppu, V(1.3), ppu * 0.5);
    gr.addColorStop(0, 'rgba(255,170,70,0.45)'); gr.addColorStop(1, 'rgba(255,170,70,0)');
    g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect((x - 0.5) * ppu, V(1.8), ppu, ppu);
    g.globalCompositeOperation = 'source-over';
  }
  g.restore();
  return c;
}

/** A stretch of bulkhead with nothing cut in it (beyond the grid's edge is hull too). */
const plainHull = (u) => u.t === T.HULL_WALL || u.t === T.INTERIOR_WALL || u.t === T.EMPTY;

/** Emergency lamp housings along a far bulkhead (not on the ladder or a hatch). */
function lampSpots(wl) {
  const out = [];
  for (const u of wl.units) {
    if (u.k % 3 !== 1 || !plainHull(u) || u.front === T.LADDER) continue;
    out.push(u.k + 0.5);
  }
  if (!out.length && wl.len >= 2) out.push(wl.len / 2);
  return out;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// ---- FIXTURES (solids) ----

/** World-space faces of one part, with canonical normals for its decorations. */
function partFaces(part, pl) {
  const { ax, prof, t0, t1 } = part;
  const toC = (t, a, b) => ax === 'u' ? [t, a, b] : ax === 'w' ? [a, t, b] : [a, b, t];   // → (u, w, y)
  const n = prof.length;
  const v0 = prof.map(([a, b]) => toC(t0, a, b)), v1 = prof.map(([a, b]) => toC(t1, a, b));
  let cu = 0, cw = 0, cy = 0;
  for (const v of [...v0, ...v1]) { cu += v[0]; cw += v[1]; cy += v[2]; }
  cu /= 2 * n; cw /= 2 * n; cy /= 2 * n;
  const faces = [];
  const add = (vs) => {
    // canonical normal from the polygon, turned outward
    let nu = 0, nw = 0, ny = 0;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      nu += (a[2] - b[2]) * (a[1] + b[1]);
      ny += (a[1] - b[1]) * (a[0] + b[0]);
      nw += (a[0] - b[0]) * (a[2] + b[2]);
    }
    const l = Math.hypot(nu, nw, ny) || 1;
    nu /= l; nw /= l; ny /= l;
    let mu = 0, mw = 0, my = 0;
    for (const v of vs) { mu += v[0]; mw += v[1]; my += v[2]; }
    mu /= vs.length; mw /= vs.length; my /= vs.length;
    if ((mu - cu) * nu + (mw - cw) * nw + (my - cy) * ny < 0) { nu = -nu; nw = -nw; ny = -ny; }
    const world = vs.map(([u, w, y]) => { const [x, z] = pl.p(u, w); return [x, y, z]; });
    const [wx, wz] = pl.n(nu, nw);
    faces.push({ world, n: [wx, ny, wz], cn: [nu, nw, ny], c: [mu, mw, my], cv: vs });
  };
  add(v0); add(v1);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; add([v0[i], v0[j], v1[j], v1[i]]); }
  const [wx, wz] = pl.p(cu, cw);
  return { faces, center: [wx, cy, wz] };
}

function shadeHex(env, hex, frostK) {
  let c = rgb(ALB[hex] || hex);
  if (frostK) c = mix(c, [0.78, 0.84, 0.9], frostK);
  return c;
}

const _o = [0, 0, 0];

function faceColor(env, alb, p, n) {
  irr(env, p[0], p[1], p[2], n[0], n[1], n[2], _o);
  return css(alb[0] * tone(_o[0]), alb[1] * tone(_o[1]), alb[2] * tone(_o[2]));
}

/**
 * Draw a fixture's solids into `g`, far parts first; note its screens and
 * lamps for the frame, and its outline for picking.
 */
function drawFixture(g, lens, env, fx, ctx2) {
  const pl = placer(fx);
  const parts = fx.parts.map(p => ({ p, ...partFaces(p, pl) }));
  parts.sort((a, b) => lens.dist(...b.center) - lens.dist(...a.center));
  const hull = [];
  const eye = lens.eye;
  for (const { p, faces } of parts) {
    const alb = p.col === 'glow' ? null : shadeHex(env, p.col, env.m.frost ? 0.22 : 0);
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      const q = f.world.map(v => lens.p(v[0], v[1], v[2]));
      for (const v of q) hull.push(v);
      const w0 = f.world[0];
      if (f.n[0] * (eye[0] - w0[0]) + f.n[1] * (eye[1] - w0[1]) + f.n[2] * (eye[2] - w0[2]) <= 0) continue;
      let fill;
      if (p.col === 'glow' || p.emit) {
        // the reactor's sight band: lit from inside, brightest where it faces us
        const k = 0.55 + 0.45 * Math.max(0, f.n[0] * lens.f[0] * -1 + f.n[2] * lens.f[2] * -1);
        fill = css(0.42 * k + 0.1, 0.62 * k + 0.12, 0.95 * k + 0.05);
      } else if (Math.abs(f.n[1]) < 0.35) {
        // a vertical face: lit more at the top (the lights are overhead); a ribbed casing alternates
        const a0 = alb;
        const alb2 = p.ribs && fi % 2 ? [a0[0] * 0.8, a0[1] * 0.8, a0[2] * 0.8] : a0;
        const top = [0, 0, 0], bot = [0, 0, 0];
        let ty = -Infinity, by = Infinity;
        for (const v of f.world) { ty = Math.max(ty, v[1]); by = Math.min(by, v[1]); }
        const cx = f.world.reduce((s, v) => s + v[0], 0) / f.world.length, cz = f.world.reduce((s, v) => s + v[2], 0) / f.world.length;
        const pT = lens.p(cx, ty, cz), pB = lens.p(cx, by, cz);
        const gr = g.createLinearGradient(pT[0], pT[1], pB[0], pB[1]);
        irr(env, cx + f.n[0] * 0.02, ty - (ty - by) * 0.1, cz + f.n[2] * 0.02, f.n[0], f.n[1], f.n[2], top);
        irr(env, cx + f.n[0] * 0.02, by + (ty - by) * 0.1, cz + f.n[2] * 0.02, f.n[0], f.n[1], f.n[2], bot);
        const ao = by < 0.05 ? 0.78 : 1;
        gr.addColorStop(0, css(alb2[0] * tone(top[0]), alb2[1] * tone(top[1]), alb2[2] * tone(top[2])));
        gr.addColorStop(1, css(alb2[0] * tone(bot[0]) * ao, alb2[1] * tone(bot[1]) * ao, alb2[2] * tone(bot[2]) * ao));
        fill = gr;
      } else {
        const cx = f.world.reduce((s, v) => s + v[0], 0) / f.world.length, cy = f.world.reduce((s, v) => s + v[1], 0) / f.world.length, cz = f.world.reduce((s, v) => s + v[2], 0) / f.world.length;
        fill = faceColor(env, alb, [cx, cy + 0.01, cz], f.n);
      }
      g.fillStyle = fill; g.strokeStyle = fill; g.lineWidth = 0.6; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(q[0][0], q[0][1]);
      for (let i = 1; i < q.length; i++) g.lineTo(q[i][0], q[i][1]);
      g.closePath(); g.fill(); g.stroke();
      // the top edge nearest us catches the light
      if (f.cn[2] > 0.9 && !p.cyl && !p.emit) {
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
        g.stroke();
      }
      if (f.cn[1] > 0.9 && p.ax !== 'y') decorate(g, lens, env, fx, pl, p, f, ctx2);
      else if (f.cn[1] < -0.9 && p.ax === 'u') backPanel(g, lens, pl, p);
    }
    // lamps and screens are registered whether or not they face us now
    // a status lamp on the front face, if the front is toward us: (u, y) on that face
    const onFront = ([lu, ly]) => {
      const [x, z] = pl.p(lu, frontW(p) + 0.01), [nx, nz] = pl.n(0, 1);
      return nx * (eye[0] - x) + nz * (eye[2] - z) > 0 ? { x, y: ly, z } : null;
    };
    const lampAt = p.lamp && fx.sys ? onFront(p.lamp) : null;
    if (lampAt) ctx2.lamps.push({ ...lampAt, sys: fx.sys });
    const occAt = p.occupancy ? onFront(p.occupancy) : null;
    if (occAt) ctx2.occupancy.push({ ...occAt, tx: fx.x, tz: fx.z, cell: fx.cell ?? null });
  }
  return convexHull(hull);
}

/** How far out from the wall a part's front face stands (w), whatever its axis. */
function frontW(p) {
  return p.prof.reduce((m, v) => Math.max(m, p.ax === 'y' ? v[1] : v[0]), 0);
}

/** Front-face decorations: screens, vents, doors, a suit in its locker. */
function decorate(g, lens, env, fx, pl, p, f, ctx2) {
  const w1 = frontW(p) + 0.004;
  const u0 = p.t0, u1 = p.t1;
  let y0 = Infinity, y1 = -Infinity;
  for (const v of p.prof) { y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
  const P = (u, y) => { const [x, z] = pl.p(u, w1); return lens.p(x, y, z); };
  const quad = (ua, ya, ub, yb, fill) => {
    const a = P(ua, ya), b = P(ub, ya), c = P(ub, yb), d = P(ua, yb);
    g.fillStyle = fill; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.closePath(); g.fill();
    return [a, b, c, d];
  };
  const line = (ua, ya, ub, yb, col, wpx) => { const a = P(ua, ya), b = P(ub, yb); g.strokeStyle = col; g.lineWidth = wpx; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); };
  const k = lens.k(P((u0 + u1) / 2, (y0 + y1) / 2)[2]);
  const thin = Math.max(0.75, k * 0.012);
  const shade = 'rgba(0,0,0,0.3)';
  switch (p.deco) {
    case 'rack': {
      for (let r = 0; r < 4; r++) {
        const y = y0 + 0.12 + r * 0.17;
        if (y > y1 - 0.45) break;
        line(u0 + 0.06, y, u1 - 0.06, y, shade, thin);
        for (let i = 0; i < 5; i++) {
          const on = hash(fx.x, fx.z, r * 7 + i) > 0.35;
          if (!env.m.screens) continue;
          const c = P(u0 + 0.12 + i * 0.07, y + 0.07);
          g.fillStyle = on ? (hash(i, r, fx.x) > 0.8 ? 'rgba(240,169,58,0.9)' : 'rgba(95,211,141,0.85)') : 'rgba(30,40,45,0.9)';
          g.fillRect(c[0] - k * 0.012, c[1] - k * 0.012, Math.max(1, k * 0.024), Math.max(1, k * 0.024));
        }
      }
      break;
    }
    case 'vents': {
      for (const cu of [u0 + 0.22, u0 + 0.52]) {
        const c = P(cu, y0 + 0.5), r = k * 0.13;
        g.fillStyle = '#1B2026'; g.beginPath(); g.ellipse(c[0], c[1], r, r * 0.92, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(160,170,180,0.25)'; g.lineWidth = thin;
        for (let i = 1; i < 4; i++) { g.beginPath(); g.ellipse(c[0], c[1], r * i / 4, r * i / 4 * 0.92, 0, 0, Math.PI * 2); g.stroke(); }
      }
      for (let i = 0; i < 5; i++) line(u0 + 0.06, y0 + 0.86 + i * 0.05, u0 + 0.5, y0 + 0.86 + i * 0.05, shade, thin);
      break;
    }
    case 'doors': {
      const n = Math.max(2, Math.round((u1 - u0) / 0.34));
      for (let i = 1; i < n; i++) line(u0 + (u1 - u0) * i / n, y0 + 0.04, u0 + (u1 - u0) * i / n, y1 - 0.04, shade, thin);
      for (let i = 0; i < n; i++) { const cu = u0 + (u1 - u0) * (i + 0.5) / n; line(cu - 0.05, y1 - 0.08, cu + 0.05, y1 - 0.08, 'rgba(220,225,230,0.35)', thin * 1.5); }
      break;
    }
    case 'drawers': {
      for (let i = 1; i < 4; i++) line(u0 + 0.04, y0 + (y1 - y0) * i / 4, u1 - 0.04, y0 + (y1 - y0) * i / 4, shade, thin);
      for (let i = 0; i < 4; i++) line(u0 + 0.42, y0 + (y1 - y0) * (i + 0.6) / 4, u0 + 0.58, y0 + (y1 - y0) * (i + 0.6) / 4, 'rgba(220,225,230,0.3)', thin * 1.4);
      break;
    }
    case 'tools': {
      for (let i = 0; i < 6; i++) {
        const u = u0 + 0.08 + i * 0.13, h = 0.12 + hash(i, fx.x) * 0.16;
        quad(u, y1 - 0.08, u + 0.04, y1 - 0.08 - h, 'rgba(25,28,32,0.75)');
      }
      break;
    }
    case 'cellShut': {
      // a locked cell door: its frame, a slot of a window with bars, the lock under the lamp
      quad(u0 + 0.06, y0 + 0.04, u1 - 0.06, y1 - 0.06, rgbaHex(ALB.podDoor, 0.85));
      line(u0 + 0.06, y0 + 0.04, u0 + 0.06, y1 - 0.06, shade, thin);
      line(u1 - 0.06, y0 + 0.04, u1 - 0.06, y1 - 0.06, shade, thin);
      quad(u0 + 0.3, y1 - 0.42, u1 - 0.3, y1 - 0.24, ALB.glass);
      for (let i = 1; i < 4; i++) { const u = u0 + 0.3 + (u1 - u0 - 0.6) * i / 4; line(u, y1 - 0.42, u, y1 - 0.24, 'rgba(150,158,166,0.9)', thin); }
      quad(u1 - 0.14, y0 + 0.78, u1 - 0.08, y0 + 0.9, 'rgba(30,34,38,0.9)');
      break;
    }
    case 'cellLeaf': {
      line(u1 - 0.02, y0 + 0.02, u1 - 0.02, y1 - 0.24, shade, thin * 1.5);
      break;
    }
    case 'headDoor': {
      quad(u0 + 0.14, y0 + 0.04, u1 - 0.14, y1 - 0.22, rgbaHex(ALB.podDoor, 0.8));
      line(u0 + 0.14, y0 + 0.04, u0 + 0.14, y1 - 0.22, shade, thin);
      line(u1 - 0.14, y0 + 0.04, u1 - 0.14, y1 - 0.22, shade, thin);
      line(u1 - 0.24, y0 + 0.7, u1 - 0.24, y0 + 0.82, 'rgba(220,225,230,0.4)', thin * 1.5);
      break;
    }
    case 'lockerEmpty':
    case 'lockerSuit': {
      line((u0 + u1) / 2, y0 + 0.04, (u0 + u1) / 2, y1 - 0.04, shade, thin);
      quad(u0 + 0.1, y1 - 0.1, u1 - 0.1, y1 - 0.68, ALB.glass);
      if (p.deco === 'lockerSuit') {
        // the suit hanging behind the glass: helmet and shoulders
        const lit = env.m.screens ? 0.5 : 0.26;
        const cu = (u0 + u1) / 2;
        // shoulders and chest, then the helmet with its visor
        const sh = [P(cu - 0.2, y1 - 0.36), P(cu + 0.2, y1 - 0.36), P(cu + 0.15, y1 - 0.68), P(cu - 0.15, y1 - 0.68)];
        g.fillStyle = css(0.7 * lit, 0.72 * lit, 0.76 * lit);
        g.beginPath(); sh.forEach((v, i) => i ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1])); g.closePath(); g.fill();
        const hc = P(cu, y1 - 0.24), r = k * 0.075;
        g.fillStyle = css(0.78 * lit, 0.8 * lit, 0.84 * lit);
        g.beginPath(); g.arc(hc[0], hc[1], r, 0, Math.PI * 2); g.fill();
        g.fillStyle = css(0.1, 0.15, 0.2); g.beginPath(); g.ellipse(hc[0], hc[1] + r * 0.12, r * 0.62, r * 0.44, 0, 0, Math.PI * 2); g.fill();
      }
      line(u1 - 0.2, y0 + 0.62, u1 - 0.2, y0 + 0.76, 'rgba(220,225,230,0.4)', thin * 1.5);
      break;
    }
    case 'tubes': {
      for (const cu of [u0 + 0.25, u0 + 0.6]) {
        const c = P(cu, y0 + 0.62), r = k * 0.16;
        g.fillStyle = ALB.tube; g.beginPath(); g.ellipse(c[0], c[1], r, r * 0.95, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(190,200,210,0.35)'; g.lineWidth = thin * 2; g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = thin; g.beginPath(); g.moveTo(c[0] - r * 0.7, c[1]); g.lineTo(c[0] + r * 0.7, c[1]); g.stroke();
      }
      const a = P(u0, y0 + 0.1), b = P(u1, y0 + 0.1), c2 = P(u1, y0), d = P(u0, y0);
      g.save(); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c2[0], c2[1]); g.lineTo(d[0], d[1]); g.closePath(); g.clip();
      hazardBand(g, Math.min(a[0], d[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]) + 4, Math.abs(d[1] - a[1]) + 4, Math.max(2, k * 0.06));
      g.restore();
      break;
    }
    case 'straps': {
      line(u0 + (u1 - u0) * 0.3, y0, u0 + (u1 - u0) * 0.3, y1, ALB.strap, thin * 2);
      line(u0 + (u1 - u0) * 0.7, y0, u0 + (u1 - u0) * 0.7, y1, ALB.strap, thin * 2);
      break;
    }
    case 'bunkLamp': {
      if (!env.m.screens) break;
      const c = P(u0 + 0.12, y0 + 0.66);
      g.fillStyle = 'rgba(255,214,150,0.9)'; g.fillRect(c[0] - k * 0.03, c[1] - k * 0.01, k * 0.06, Math.max(1, k * 0.02));
      break;
    }
  }
  if (p.screen) {
    const s = p.screen;
    const on = env.m.screens;
    const q = quad(s.u0, s.y1, s.u1, s.y0, on ? '#0F2A36' : '#0A0E12');
    if (on) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(70,150,190,0.22)'; g.fill();
      g.restore();
      ctx2.screens.push({ q, ink: SCREEN_INK[s.ink] || SCREEN_INK.rack, seed: hash(fx.x, fx.z, Math.round(s.u0 * 100)) });
    }
  }
}

/** The back of a cabinet or locker (seen where the bulkhead behind it is out of the picture): a service panel. */
function backPanel(g, lens, pl, p) {
  let y0 = Infinity, y1 = -Infinity, w0 = Infinity;
  for (const v of p.prof) { y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); w0 = Math.min(w0, v[0]); }
  if (y1 - y0 < 0.7 || p.t1 - p.t0 < 0.4) return;
  const P = (u, y) => { const [x, z] = pl.p(u, w0 - 0.004); return lens.p(x, y, z); };
  const u0 = p.t0 + 0.08, u1 = p.t1 - 0.08;
  const k = lens.k(P((u0 + u1) / 2, (y0 + y1) / 2)[2]);
  g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = Math.max(0.75, k * 0.012);
  const a = P(u0, y1 - 0.08), b = P(u1, y1 - 0.08), c = P(u1, y0 + 0.08), d = P(u0, y0 + 0.08);
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.closePath(); g.stroke();
  for (let i = 0; i < 5; i++) {
    const y = y1 - 0.2 - i * 0.06;
    const l = P(u0 + 0.1, y), r = P(u1 - 0.1, y);
    g.beginPath(); g.moveTo(l[0], l[1]); g.lineTo(r[0], r[1]); g.stroke();
  }
}

function rgbaHex(hex, a) { const c = rgb(hex); return css(c[0], c[1], c[2], a); }

function convexHull(pts) {
  const p = pts.map(v => [v[0], v[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const v of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop(); lo.push(v); }
  for (let i = p.length - 1; i >= 0; i--) { const v = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], v) <= 0) up.pop(); up.push(v); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- STATIC BUILD ----

let _fontEpoch = 0;
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => { _fontEpoch++; });
}

// One rebuild per animation frame across all cameras (once each has a picture)
let _budgetT = -1, _budgetUsed = 0;

/** Everything about a room that doesn't move, for one canvas size and lighting state. */
function buildStatic(state, room, Wd, Hd, dpr, mode) {
  // (the overlay has its own backing: the room may run under it)
  const pad = { l: Wd * 0.025, r: Wd * 0.025, t: Math.max(Hd * 0.06, 6 * dpr), b: Math.max(Hd * 0.05, 6 * dpr) };
  const lens = new Lens(room, Wd, Hd, pad);
  const lockers = state.lifeSupport?.lockers || {};
  const glow = state.reactor?.status === 'online' && mode !== 'blackout' && mode !== 'vacuum';
  // Fixtures in this lighting (their models can depend on state: a suit in the locker)
  const fixtures = room.fixtures.map(f => {
    const parts = f.model({ x: f.x, z: f.z, h: hash(f.x, f.z, room.di), zone: room.zone, suit: f.kind === 'locker' ? lockers[f.id]?.hasSuit !== false : false, glow, held: f.cell != null && f.cell < heldInCells(state) });
    // the footprint on the floor (for the soft shadow under it)
    const pl = placer(f);
    let fx0 = Infinity, fz0 = Infinity, fx1 = -Infinity, fz1 = -Infinity;
    for (const p of parts) {
      const yMin = p.ax === 'y' ? p.t0 : Math.min(...p.prof.map(v => v[1]));
      if (yMin > 0.05) continue;
      const pts = p.ax === 'y' ? p.prof : p.ax === 'u' ? p.prof.flatMap(([w]) => [[p.t0, w], [p.t1, w]]) : p.prof.flatMap(([u]) => [[u, p.t0], [u, p.t1]]);
      for (const [u, w] of pts) { const [x, z] = pl.p(u, w); fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z); }
    }
    // screens' positions (for their light on the room)
    const screens = [];
    for (const p of parts) if (p.screen) {
      const [x, z] = pl.p((p.screen.u0 + p.screen.u1) / 2, frontW(p) + 0.15);
      screens.push({ wx: x, wy: (p.screen.y0 + p.screen.y1) / 2, wz: z });
    }
    return { ...f, parts, foot: fx0 < Infinity ? [fx0, fz0, fx1, fz1] : null, screens };
  });
  const env = buildEnv(room, mode, fixtures, glow);
  const roomL = { ...room, fixtures };
  roomL.mainWall = room.walls.filter(w => w.n[1] > 0).sort((a, b) => b.len - a.len)[0] || null;

  // Texture density from how big a tile is on screen
  const tilePx = lens.k(lens.p((room.x0 + room.x1) / 2, 0, (room.z0 + room.z1) / 2)[2]);
  const ppu = Math.max(24, Math.min(160, Math.round(tilePx * 1.1)));
  const sub = (len) => Math.max(1, Math.ceil(len * tilePx / 56));

  const layers = [];
  const rowsDyn = [];
  const picks = [];
  const base = canvasOf(Wd, Hd);
  const g = base.getContext('2d');
  g.fillStyle = '#05070A'; g.fillRect(0, 0, Wd, Hd);

  // Floor
  const floorTex = paintFloor(roomL, env, ppu);
  for (const [x, z] of room.cells) {
    const n = sub(1);
    mapQuad(g, lens, floorTex, (fu, fv) => [x + fu, 0, z + fv], (x - room.x0) * ppu, (z - room.z0) * ppu, (x + 1 - room.x0) * ppu, (z + 1 - room.z0) * ppu, n, n);
  }
  // The deck's sheen: each panel's reflection where the plating would mirror it to the lens
  if (env.m.pi > 0) {
    g.save();
    g.beginPath();
    for (const [x, z] of room.cells) { const q = [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]].map(([a, b]) => lens.p(a, 0, b)); q.forEach((v, i) => i ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1])); g.closePath(); }
    g.clip();
    g.globalCompositeOperation = 'lighter';
    const e = lens.eye;
    for (const [lx, lz] of room.ceil) {
      const t = e[1] / (e[1] + CEIL);
      const px = e[0] + (lx - e[0]) * t, pz = e[2] + (lz - e[2]) * t;
      const c = lens.p(px, 0, pz), k = lens.k(c[2]);
      g.save(); g.translate(c[0], c[1]); g.scale(1.1, 0.5);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, k * 0.7);
      gr.addColorStop(0, `rgba(215,228,245,${(0.11 * env.m.pi).toFixed(3)})`); gr.addColorStop(1, 'rgba(215,228,245,0)');
      g.fillStyle = gr; g.fillRect(-k, -k, k * 2, k * 2);
      g.restore();
    }
    g.restore();
  }
  // The deck plating's cut edge nearest us (the bulkhead there is behind the lens)
  for (const wl of room.walls) {
    if (lens.facing(wl)) continue;
    const a = lens.p(wl.a[0], 0, wl.a[1]), b = lens.p(wl.b[0], 0, wl.b[1]);
    const a2 = lens.p(wl.a[0] - wl.n[0] * WALL_T, -0.1, wl.a[1] - wl.n[1] * WALL_T), b2 = lens.p(wl.b[0] - wl.n[0] * WALL_T, -0.1, wl.b[1] - wl.n[1] * WALL_T);
    g.fillStyle = ALB.section;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(b2[0], b2[1]); g.lineTo(a2[0], a2[1]); g.closePath(); g.fill();
    g.strokeStyle = ALB.sectionEdge; g.lineWidth = 1; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  }
  // Walls, far first; their cut tops (the deckhead's edge) and open ends
  const label = `${String(room.di + 1).padStart(2, '0')}  ${room.name.toUpperCase()}`;
  const vis = room.walls.filter(w => lens.facing(w)).sort((a, b) => lens.dist((b.a[0] + b.b[0]) / 2, 0.8, (b.a[1] + b.b[1]) / 2) - lens.dist((a.a[0] + a.b[0]) / 2, 0.8, (a.a[1] + a.b[1]) / 2));
  for (const wl of vis) {
    const tex = paintWall(roomL, wl, env, ppu, label);
    const [ax, az] = wl.a, [bx, bz] = wl.b;
    mapQuad(g, lens, tex, (fu, fv) => [ax + (bx - ax) * fu, CEIL * (1 - fv), az + (bz - az) * fu], 0, 0, tex.width, tex.height, sub(wl.len), sub(CEIL));
  }
  for (const wl of vis) {
    const [ax, az] = wl.a, [bx, bz] = wl.b, [nx, nz] = wl.n;
    const q = [[ax, az], [bx, bz], [bx - nx * WALL_T, bz - nz * WALL_T], [ax - nx * WALL_T, az - nz * WALL_T]].map(([x, z]) => lens.p(x, CEIL, z));
    g.fillStyle = ALB.section;
    g.beginPath(); q.forEach((v, i) => i ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1])); g.closePath(); g.fill();
    g.strokeStyle = ALB.sectionEdge; g.lineWidth = 1; g.beginPath(); g.moveTo(q[0][0], q[0][1]); g.lineTo(q[1][0], q[1][1]); g.stroke();
    // open ends toward the lens: the bulkhead seen in section
    for (const [px, pz] of [[ax, az], [bx, bz]]) {
      const towardLens = (px - (ax + bx) / 2) * (lens.eye[0] - (ax + bx) / 2) + (pz - (az + bz) / 2) * (lens.eye[2] - (az + bz) / 2) > 0;
      if (!towardLens || wl.n[1] > 0) continue;
      const e = [[px, 0, pz], [px, CEIL, pz], [px - nx * WALL_T, CEIL, pz - nz * WALL_T], [px - nx * WALL_T, 0, pz - nz * WALL_T]].map(v => lens.p(...v));
      g.fillStyle = ALB.section;
      g.beginPath(); e.forEach((v, i) => i ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1])); g.closePath(); g.fill();
    }
  }
  // Hatches and doors in the walls: what a click on them picks
  for (const wf of room.wallFx) {
    const { wall: wl, unit: u } = wf;
    if (!lens.facing(wl)) continue;
    const ux = (wl.b[0] - wl.a[0]) / wl.len, uz = (wl.b[1] - wl.a[1]) / wl.len;
    const at = (t, y) => lens.p(wl.a[0] + ux * (u.k + t), y, wl.a[1] + uz * (u.k + t));
    picks.push({ poly: [at(0.05, 1.48), at(0.95, 1.48), at(0.95, 0), at(0.05, 0)], tile: wf.tile, z: -1 });
  }

  // Fixtures by row: row 0 on the base layer, each later row its own layer
  const byRow = new Map();
  for (const f of fixtures) { if (!byRow.has(f.row)) byRow.set(f.row, []); byRow.get(f.row).push(f); }
  for (let r = 0; r < room.rows; r++) {
    const list = (byRow.get(r) || []).sort((a, b) => lens.dist(b.x + 0.5, 0.5, b.z + 0.5) - lens.dist(a.x + 0.5, 0.5, a.z + 0.5));
    const dyn = { screens: [], lamps: [], occupancy: [] };
    let lc = g, layer = null;
    if (r > 0) {
      // a later row's layer is only as big as what stands in it
      const b = rowBounds(lens, list, Wd, Hd);
      if (b) { layer = { c: canvasOf(b[2] - b[0], b[3] - b[1]), x: b[0], y: b[1] }; lc = layer.c.getContext('2d'); lc.translate(-b[0], -b[1]); }
    }
    if (r === 0 || layer) for (const f of list) {
      const hull = drawFixture(lc, lens, env, f, dyn);
      if (f.tile && INTERACTIVE_TILES.has(f.tile.t)) picks.push({ poly: hull, tile: f.tile, z: r });
    }
    rowsDyn[r] = dyn;
    layers[r] = layer;
  }
  layers[0] = { c: base, x: 0, y: 0 };
  // picks: nearest first
  picks.sort((a, b) => b.z - a.z);
  return { lens, layers, rowsDyn, picks, env, mode, dpr, Wd, Hd, fixtures };
}

/** Pixel bounds of a row's fixtures (with room for their edges), clipped to the canvas. */
function rowBounds(lens, list, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of list) {
    const pl = placer(f);
    for (const p of f.parts) for (const face of partFaces(p, pl).faces) for (const v of face.world) {
      const q = lens.p(v[0], v[1], v[2]);
      if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
    }
  }
  if (x1 < x0) return null;
  x0 = Math.max(0, Math.floor(x0 - 4)); y0 = Math.max(0, Math.floor(y0 - 4));
  x1 = Math.min(W, Math.ceil(x1 + 4)); y1 = Math.min(H, Math.ceil(y1 + 4));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

// ---- CREW ----
// A figure is a handful of joints in the room (feet, knees, hips,
// shoulders, elbows, hands, neck, head), posed from what the sim says the
// person is doing, projected, and drawn as limbs of a body's width: a
// person seen from above at an angle, standing, walking, sat at a
// station, back in a couch, asleep under a blanket, adrift in free fall.

const BODY = { leg: 0.085, arm: 0.06, head: 0.075, helmet: 0.098, shoulder: 0.15 };

/** Seat id → the fixture on this deck it belongs to. */
function seatFixture(room, seat) {
  if (!seat) return null;
  const [, , sx, sy] = seat.split(':');
  const x = +sx, z = +sy;
  return room.fixtures.find(f => f.x === x && f.z === z && f.tile && f.tile.x === x) || null;
}

const SIDES = ['L', 'R'];

/**
 * The figure's joints in world space, its face direction and posture.
 * fig: { m, x, z (tile top-left, continuous), moving, heading }
 */
export function posture(room, fig, t, floating) {
  const m = fig.m;
  const sk = seatKind(m.seat);
  const fx = sk ? seatFixture(room, m.seat) : null;
  const down = m.dead || !isConscious(m) || m.task?.type === 'carried';
  const J = {};
  let face = null, kind = 'stand', blanket = null, sheet = null, stool = null;

  // In a fixture: joints in its own frame (u across, w out from the wall, y up)
  const inFixture = (def) => {
    const pl = placer(fx);
    for (const [k, [u, w, y]] of Object.entries(def)) { const [x, z] = pl.p(u, w); J[k] = [x, y, z]; }
    return pl;
  };
  if (fx && (sk === 'couch')) {
    const pl = inFixture({
      ftL: [0.43, 0.95, 0.5], ftR: [0.57, 0.95, 0.5], knL: [0.42, 0.75, 0.55], knR: [0.58, 0.75, 0.55],
      hpL: [0.42, 0.45, 0.48], hpR: [0.58, 0.45, 0.48], shL: [0.35, 0.27, 0.86], shR: [0.65, 0.27, 0.86],
      elL: [0.3, 0.38, 0.64], elR: [0.7, 0.38, 0.64], haL: [0.34, 0.56, 0.54], haR: [0.66, 0.56, 0.54],
      nk: [0.5, 0.25, 0.9], hd: [0.5, 0.23, 0.99],
    });
    const n = pl.n(0, 1); face = [n[0], 0.5, n[1]]; kind = 'couch';
  } else if (fx && (sk === 'helm' || sk === 'ops' || sk === 'weapons' || sk === 'engStation')) {
    const pl = inFixture({
      // (sat up to the console, hands on its edge, elbows bent at the sides)
      ftL: [0.42, 0.28, 0.02], ftR: [0.58, 0.28, 0.02], knL: [0.42, 0.32, 0.5], knR: [0.58, 0.32, 0.5],
      hpL: [0.42, 0.55, 0.49], hpR: [0.58, 0.55, 0.49], shL: [0.36, 0.55, 0.86], shR: [0.64, 0.55, 0.86],
      elL: [0.31, 0.5, 0.66], elR: [0.69, 0.5, 0.66], haL: [0.4, 0.33, 0.73], haR: [0.6, 0.33, 0.73],
      nk: [0.5, 0.58, 0.9], hd: [0.5, 0.56, 0.99],
    });
    const n = pl.n(0, -1); face = [n[0], 0, n[1]]; kind = 'seat';
  } else if (fx && (sk === 'bunk' || sk === 'paxBerth')) {
    // asleep on their side, knees drawn up, facing out of the rack: how a body fits a bunk a tile long
    const M = sk === 'paxBerth' ? 0.36 : 0.33;           // (the mattress's top)
    const pl = inFixture({
      hd: [0.17, 0.42, M + 0.11], nk: [0.24, 0.43, M + 0.1],
      shR: [0.29, 0.43, M + 0.05], shL: [0.3, 0.46, M + 0.26], hpR: [0.55, 0.42, M + 0.06], hpL: [0.55, 0.44, M + 0.21],
      knR: [0.66, 0.7, M + 0.05], knL: [0.64, 0.72, M + 0.15], ftR: [0.88, 0.52, M + 0.03], ftL: [0.86, 0.56, M + 0.11],
      elR: [0.33, 0.67, M + 0.04], haR: [0.21, 0.62, M + 0.06], elL: [0.43, 0.57, M + 0.24], haL: [0.47, 0.72, M + 0.14],
    });
    const n = pl.n(0, 1); face = [n[0], 0, n[1]]; kind = 'side';
    const cover = (u0, u1, w0, w1, yy) => [[u0, w0], [u1, w0], [u1, w1], [u0, w1]].map(([u, w]) => { const [x, z] = pl.p(u, w); return [x, yy, z]; });
    blanket = cover(0.25, 0.96, 0.12, 0.84, M + 0.06);
  } else if (fx && sk === 'medbay') {
    // on the autodoc: on their back, knees raised, the sheet over them
    const y = 0.6;
    const pl = inFixture({
      hd: [0.15, 0.42, y + 0.05], nk: [0.22, 0.42, y + 0.04], shL: [0.27, 0.27, y + 0.03], shR: [0.27, 0.57, y + 0.03],
      hpL: [0.55, 0.35, y + 0.02], hpR: [0.55, 0.49, y + 0.02], knL: [0.72, 0.36, y + 0.26], knR: [0.72, 0.48, y + 0.26],
      ftL: [0.86, 0.37, y + 0.02], ftR: [0.86, 0.47, y + 0.02], elL: [0.4, 0.22, y + 0.02], elR: [0.4, 0.62, y + 0.02],
      haL: [0.53, 0.25, y + 0.03], haR: [0.53, 0.59, y + 0.03],
    });
    face = [0, 1, 0]; kind = 'lying';
    const cover = (u0, u1, w0, w1, yy) => [[u0, w0], [u1, w0], [u1, w1], [u0, w1]].map(([u, w]) => { const [x, z] = pl.p(u, w); return [x, yy, z]; });
    sheet = cover(0.4, 0.95, 0.2, 0.64, y + 0.05);
  } else if (fx && sk === 'rec') {
    const run = Math.sin(t * 0.011 + m.id);
    const pl = inFixture({
      ftL: [0.42, 0.6 - run * 0.12, 0.17], ftR: [0.58, 0.6 + run * 0.12, 0.17], knL: [0.42, 0.56 - run * 0.08, 0.46], knR: [0.58, 0.56 + run * 0.08, 0.46],
      hpL: [0.42, 0.62, 0.71], hpR: [0.58, 0.62, 0.71], shL: [0.35, 0.6, 1.08], shR: [0.65, 0.6, 1.08],
      elL: [0.32, 0.58 + run * 0.06, 0.88], elR: [0.68, 0.58 - run * 0.06, 0.88], haL: [0.36, 0.48 + run * 0.08, 0.84], haR: [0.64, 0.48 - run * 0.08, 0.84],
      nk: [0.5, 0.6, 1.12], hd: [0.5, 0.58, 1.21],
    });
    const n = pl.n(0, -1); face = [n[0], 0, n[1]]; kind = 'stand';
  } else {
    // On the deck: standing, walking, sat at a table, down, or adrift
    const ox = fig.x + 0.5, oz = fig.z + 0.5;
    let a = fig.heading;
    const f = [Math.cos(a), Math.sin(a)], l = [-Math.sin(a), Math.cos(a)];
    let lift = 0, tilt = 0;
    const W = (fw, lat, up) => [ox + f[0] * fw + l[0] * lat, up, oz + f[1] * fw + l[1] * lat];
    const pc = 0.56;
    /** A standing-frame posture (forward, lateral, up), leaned by `tilt` about a pivot `pc` high, lifted. */
    const lean = (def, tiltA, pivot, up0 = 0) => {
      for (const [k, [fw, lat, up]] of Object.entries(def)) {
        const r = up - pivot, fw2 = fw * Math.cos(tiltA) + r * Math.sin(tiltA), up2 = pivot + r * Math.cos(tiltA) - fw * Math.sin(tiltA);
        J[k] = W(fw2, lat, up2 + up0);
      }
    };
    if (fig.thrown && !down) {
      // thrown by the ship moving under them: along the way they go, reaching out to break it; on the deck they fall
      // forward and slide, in free fall they tumble
      const th = fig.thrown, sp = Math.hypot(th.vx, th.vy);
      if (sp > 1e-3) { a = Math.atan2(th.vy, th.vx); f[0] = Math.cos(a); f[1] = Math.sin(a); l[0] = -Math.sin(a); l[1] = Math.cos(a); }
      const flail = Math.sin(t * 0.02 + m.id), kick = Math.sin(t * 0.017 + m.id * 2);
      const def = {
        ftL: [-0.05, 0.09, 0.04], ftR: [-0.12 + 0.06 * kick, -0.09, 0.12], knL: [0.02, 0.08, 0.31], knR: [0.04, -0.09, 0.33],
        hpL: [0, 0.075, 0.56], hpR: [0, -0.075, 0.56], shL: [0, 0.15, 0.93], shR: [0, -0.15, 0.93],
        elL: [0.2, 0.24, 0.96 + 0.05 * flail], elR: [0.22, -0.24, 0.98 - 0.05 * flail], haL: [0.38, 0.26, 0.98 + 0.08 * flail], haR: [0.4, -0.25, 1.02 - 0.08 * flail],
        nk: [0.02, 0, 0.97], hd: [0.05, 0, 1.06],
      };
      let tiltA;
      if (th.grounded) {
        tiltA = Math.min(1.3, 0.45 + sp * 0.4); lean(def, tiltA, 0.02);
        // (going down onto the deck, not through it: the hands and knees that reach it stop on it)
        const FLOOR = { ha: 0.03, el: 0.05, kn: 0.05, ft: 0.04, sh: 0.1, hp: 0.09, nk: 0.1, hd: 0.09 };
        for (const k in J) J[k][1] = Math.max(J[k][1], FLOOR[k.slice(0, 2)] ?? 0.06);
      }
      else { tiltA = t * 0.0045 + m.id; lean(def, tiltA, pc, 0.3 + 0.08 * Math.sin(t * 0.003 + m.id)); }
      face = [f[0] * Math.cos(tiltA), -Math.sin(tiltA), f[1] * Math.cos(tiltA)]; kind = th.grounded ? 'fall' : 'float';
    } else if (down) {
      // (carried: over a shipmate's shoulder; adrift: limp, off the deck; else where they fell, each their own way)
      const carried = m.task?.type === 'carried';
      // (y: the joints' line; the body's own thickness lifts it off the deck: figures.js)
      const y = carried ? 0.92 : floating ? 0.35 + 0.05 * Math.sin(t * 0.0013 + m.id) : 0;
      const v = carried || floating ? 0 : Math.floor(hash(m.id, 41) * 3);
      const j = (n, s2) => (hash(m.id, n) - 0.5) * s2;
      const def = v === 1 ? {
        // on their side, one knee drawn up
        hd: [0.42, 0.05, y + 0.07], nk: [0.33, 0.04, y + 0.06], shR: [0.3, 0.02, y + 0.01], shL: [0.3, 0.06, y + 0.21],
        hpR: [-0.05, 0.02, y + 0.01], hpL: [-0.05, 0.04, y + 0.14], knR: [-0.3, 0.06, y], knL: [-0.18, 0.24 + j(43, 0.1), y + 0.06],
        ftR: [-0.55, 0.04, y - 0.01], ftL: [-0.42, 0.18, y + 0.02], elR: [0.38, 0.2, y], haR: [0.52, 0.12 + j(44, 0.1), y],
        elL: [0.12, 0.22, y + 0.16], haL: [0.0, 0.32, y + 0.01],
      } : v === 2 ? {
        // face down, an arm under them (the chest deeper than the back: a little higher)
        hd: [0.43, 0.02, y + 0.08], nk: [0.33, 0, y + 0.045], shL: [0.3, 0.15, y + 0.035], shR: [0.3, -0.15, y + 0.035],
        hpL: [-0.05, 0.08, y + 0.025], hpR: [-0.05, -0.08, y + 0.025], knL: [-0.3, 0.14 + j(45, 0.08), y + 0.025], knR: [-0.29, -0.12, y + 0.035],
        ftL: [-0.55, 0.2 + j(46, 0.1), y + 0.065], ftR: [-0.55, -0.12, y + 0.065], elL: [0.42, 0.32, y + 0.025], elR: [0.15, -0.12, y + 0.005],
        haL: [0.58, 0.22 + j(47, 0.1), y + 0.025], haR: [0.02, -0.04, y + 0.005],
      } : {
        // on their back, limbs where they fell
        hd: [0.42, j(48, 0.06), y + 0.02], nk: [0.33, 0, y + 0.01], shL: [0.3, 0.15, y], shR: [0.3, -0.15, y],
        hpL: [-0.05, 0.08, y], hpR: [-0.05, -0.08, y], knL: [-0.3, 0.1 + j(49, 0.1), y], knR: [-0.3, -0.09 - j(50, 0.08), y],
        ftL: [-0.55, 0.12 + j(51, 0.16), y], ftR: [-0.54, -0.1 - j(52, 0.12), y], elL: [0.14 + j(53, 0.2), 0.25, y], elR: [0.14 + j(54, 0.2), -0.25, y],
        haL: [-0.02 + j(55, 0.5), 0.32 + j(56, 0.1), y], haR: [j(57, 0.5), -0.31, y],
      };
      for (const [k, w] of Object.entries(def)) J[k] = W(...w);
      face = v === 1 ? [l[0], 0, l[1]] : v === 2 ? [0, -1, 0] : [0, 1, 0]; kind = 'down';
    } else if (m.gState === 'prone' && !floating) {
      // pinned flat to the deck by the G, face down, arms out, unable to rise (y: face down, the chest is deeper than the back)
      const y = 0.025;
      const def = {
        hd: [0.43, 0, y + 0.04], nk: [0.33, 0, y + 0.03], shL: [0.3, 0.15, y + 0.02], shR: [0.3, -0.15, y + 0.02],
        hpL: [-0.05, 0.08, y], hpR: [-0.05, -0.08, y], knL: [-0.3, 0.13, y], knR: [-0.3, -0.13, y],
        ftL: [-0.55, 0.16, y + 0.03], ftR: [-0.55, -0.16, y + 0.03], elL: [0.4, 0.33, y], elR: [0.4, -0.33, y],
        haL: [0.56, 0.24, y], haR: [0.56, -0.24, y],
      };
      for (const [k, w] of Object.entries(def)) J[k] = W(...w);
      face = [0, -1, 0]; kind = 'pinned';
    } else if (m.gState === 'strained' && !floating) {
      // bracing under a hard burn: knees bent, hands on them, leaning into it
      const def = {
        ftL: [0.02, 0.1, 0.02], ftR: [0.02, -0.1, 0.02], knL: [0.16, 0.11, 0.25], knR: [0.16, -0.11, 0.25],
        hpL: [-0.06, 0.08, 0.4], hpR: [-0.06, -0.08, 0.4], shL: [0.1, 0.15, 0.74], shR: [0.1, -0.15, 0.74],
        elL: [0.06, 0.21, 0.5], elR: [0.06, -0.21, 0.5], haL: [0.16, 0.12, 0.3], haR: [0.16, -0.12, 0.3],
        nk: [0.13, 0, 0.78], hd: [0.2, 0, 0.85],
      };
      for (const [k, w] of Object.entries(def)) J[k] = W(...w);
      face = [f[0], -0.25, f[1]]; kind = 'brace';
    } else {
      const sitAt = (m.activity === 'eating' || m.activity === 'socializing') && !floating ? tableBeside(room, fig) : null;
      if (sitAt) {
        a = sitAt.a; f[0] = Math.cos(a); f[1] = Math.sin(a); l[0] = -Math.sin(a); l[1] = Math.cos(a);
        const def = {
          ftL: [0.32, 0.08, 0.02], ftR: [0.32, -0.08, 0.02], knL: [0.28, 0.08, 0.48], knR: [0.28, -0.08, 0.48],
          hpL: [0.02, 0.08, 0.45], hpR: [0.02, -0.08, 0.45], shL: [0.06, 0.15, 0.84], shR: [0.06, -0.15, 0.84],
          elL: [0.2, 0.19, 0.66], elR: [0.2, -0.19, 0.66], haL: [0.38, 0.12, 0.74], haR: [0.38, -0.12, 0.74],
          nk: [0.07, 0, 0.88], hd: [0.09, 0, 0.97],
        };
        const o = [ox + f[0] * 0.2, oz + f[1] * 0.2];
        for (const [k, [fw, lat, up]] of Object.entries(def)) J[k] = [o[0] + f[0] * fw + l[0] * lat, up, o[1] + f[1] * fw + l[1] * lat];
        face = [f[0], 0, f[1]]; kind = 'seat';
        stool = [o[0] - f[0] * 0.02, o[1] - f[1] * 0.02];
      } else {
        const s = fig.moving ? Math.sin(t * 0.0105 + m.id * 1.3) : 0;
        if (floating) { lift = 0.26 + 0.05 * Math.sin(t * 0.0012 + m.id * 2.1); tilt = 0.12 + 0.05 * Math.sin(t * 0.0007 + m.id); }
        const work = fig.moving ? 0 : (fig.work ? 0.16 : 0);
        const def = floating ? {
          ftL: [-0.06, 0.09, 0.05], ftR: [0.0, -0.08, 0.1], knL: [0.05, 0.08, 0.31], knR: [0.08, -0.08, 0.34],
          hpL: [0, 0.075, 0.56], hpR: [0, -0.075, 0.56], shL: [0, 0.15, 0.93], shR: [0, -0.15, 0.93],
          elL: [0.04, 0.24, 0.8], elR: [0.06, -0.24, 0.84], haL: [0.1, 0.28, 0.92], haR: [0.14, -0.27, 0.98],
          nk: [0, 0, 0.97], hd: [0.02, 0, 1.065],
        } : {
          ftL: [s * 0.13, 0.065, 0.02], ftR: [-s * 0.13, -0.065, 0.02], knL: [s * 0.07 + 0.02, 0.07, 0.31], knR: [-s * 0.07 + 0.02, -0.07, 0.31],
          hpL: [0, 0.075, 0.56], hpR: [0, -0.075, 0.56], shL: [0, 0.15, 0.93], shR: [0, -0.15, 0.93],
          elL: [-s * 0.06 + work * 0.4, 0.18, 0.73], elR: [s * 0.06 + work * 0.4, -0.18, 0.73],
          haL: [-s * 0.1 + work, 0.16, 0.55 + work * 1.2], haR: [s * 0.1 + work, -0.16, 0.55 + work * 1.2],
          nk: [0, 0, 0.97], hd: [0.01, 0, 1.065],
        };
        for (const [k, [fw, lat, up]] of Object.entries(def)) {
          // free fall: the body leans, pivoting at the hips
          const r = up - pc, fw2 = fw * Math.cos(tilt) + r * Math.sin(tilt), up2 = pc + r * Math.cos(tilt) - fw * Math.sin(tilt);
          J[k] = W(fw2, lat, up2 + lift);
        }
        face = [f[0], 0, f[1]]; kind = floating ? 'float' : 'stand';
      }
    }
  }
  return { J, face, kind, blanket, sheet, stool };
}

/** A mess table next to someone eating: which way it is. */
function tableBeside(room, fig) {
  const x = Math.round(fig.x), z = Math.round(fig.z);
  for (const [k, [dx, dz]] of Object.entries(DIRS)) {
    if (tileAt(room.tiles, x + dx, z + dz) === T.TABLE) return { a: Math.atan2(dz, dx), k };
  }
  return null;
}

/** Which way a person stands still: toward the machine or furniture beside them, else as they were. */
function workHeading(room, fig) {
  const x = Math.round(fig.x), z = Math.round(fig.z);
  for (const [dx, dz] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
    const t = tileAt(room.tiles, x + dx, z + dz);
    if (INTERACTIVE_TILES.has(t) && t !== T.BUNK && t !== T.PAX_BERTH && t !== T.CRASH_COUCH && !WALKABLE.has(t)) return Math.atan2(dz, dx);
  }
  return null;
}

/** Light on a figure: the room's light at chest height, kept readable (a camera's gain). */
function crewLight(env, x, z, out) {
  irr(env, x, 0.85, z, 0, 0.72, 0.7, out);
  const floor = env.mode === 'normal' ? 0.5 : env.mode === 'battle' ? 0.34 : env.mode === 'blackout' ? 0.15 : 0.24;
  for (let i = 0; i < 3; i++) out[i] = Math.max(floor, Math.min(1, tone(out[i])));
  return out;
}

const _L = [0, 0, 0];

function drawFigure(g, lens, env, fig, P, selected, t) {
  const m = fig.m;
  const { J, face, kind, blanket, sheet } = P;
  const pr = {};
  for (const k in J) pr[k] = lens.p(J[k][0], J[k][1], J[k][2]);
  const k = lens.k(pr.hp ? pr.hp[2] : pr.hpL[2]);
  crewLight(env, (J.hpL[0] + J.hpR[0]) / 2, (J.hpL[2] + J.hpR[2]) / 2, _L);
  let lit = _L;
  if (env.mode === 'battle') lit = [lit[0] * 1.05, lit[1] * 0.92, lit[2] * 0.92];
  const suit = m.suit?.wearing;
  const roleC = rgb(ROLE_SUIT[m.role] || ROLE_SUIT.Deckhand);
  let body = suit ? rgb(VAC_SUIT) : roleC;
  let skin = rgb(SKIN[m.id % SKIN.length]), hair = rgb(HAIR[(m.id * 3 + 1) % HAIR.length]);
  if (m.dead) { body = mix(body, [0.35, 0.37, 0.4], 0.6); skin = mix(skin, [0.55, 0.55, 0.55], 0.5); }
  const C = (c, kk = 1) => css(c[0] * lit[0] * kk, c[1] * lit[1] * kk, c[2] * lit[2] * kk);
  const cBody = C(body), cBodyDk = C(body, 0.72), cLeg = suit ? C(body, 0.85) : C(mix(body, [0.12, 0.13, 0.15], 0.45)), cSkin = C(skin), cHair = C(hair);
  const wLeg = (suit ? 0.105 : BODY.leg) * k, wArm = (suit ? 0.08 : BODY.arm) * k;
  const toEye = [lens.eye[0] - J.nk[0], lens.eye[1] - J.nk[1], lens.eye[2] - J.nk[2]];
  const facingUs = face[0] * toEye[0] + face[1] * toEye[1] * 0.2 + face[2] * toEye[2] > 0;

  // which side is further from the lens: drawn first
  const farL = pr.shL[2] > pr.shR[2];
  const far = farL ? 'L' : 'R', near = farL ? 'R' : 'L';
  const limb = (a, b, c, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.stroke(); };
  const torso = (col, grow = 0) => {
    g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 0.07 * k + grow;
    g.beginPath(); g.moveTo(pr.shL[0], pr.shL[1]); g.lineTo(pr.shR[0], pr.shR[1]); g.lineTo(pr.hpR[0], pr.hpR[1]); g.lineTo(pr.hpL[0], pr.hpL[1]); g.closePath(); g.fill(); g.stroke();
  };
  const headR = (suit ? BODY.helmet : BODY.head) * lens.k(pr.hd[2]);
  g.lineCap = 'round'; g.lineJoin = 'round';

  drawStool(g, lens, P, C, k);
  // a dark edge that keeps a figure apart from the plating behind it; the
  // selected one outlined in the selection colour instead
  const outline = (col, o) => {
    for (const s of SIDES) { limb(pr['hp' + s], pr['kn' + s], pr['ft' + s], wLeg + o * 2, col); limb(pr['sh' + s], pr['el' + s], pr['ha' + s], wArm + o * 2, col); }
    torso(col, o * 2);
    g.fillStyle = col; g.beginPath(); g.arc(pr.hd[0], pr.hd[1], headR + o, 0, Math.PI * 2); g.fill();
  };
  if (selected) outline(C_SEL, Math.max(1.5, k * 0.022));
  else if (!blanket) outline('rgba(4,6,9,0.45)', Math.max(1, k * 0.016));

  const pack = () => {
    // the suit's life-support pack, on the back
    const bx = (pr.shL[0] + pr.shR[0] + pr.hpL[0] + pr.hpR[0]) / 4, by = (pr.shL[1] + pr.shR[1] + pr.hpL[1] + pr.hpR[1]) / 4;
    const back = lens.p((J.shL[0] + J.shR[0]) / 2 - face[0] * 0.1, (J.shL[1] + J.hpL[1]) / 2, (J.shL[2] + J.shR[2]) / 2 - face[2] * 0.1);
    g.fillStyle = C([0.55, 0.58, 0.62]);
    const w = 0.13 * k, h = 0.2 * k;
    g.save(); g.translate(back[0] * 0.6 + bx * 0.4, back[1] * 0.6 + by * 0.4);
    roundRect(g, -w, -h, w * 2, h * 2, w * 0.4); g.fill(); g.restore();
  };

  if (kind === 'lying' || kind === 'down') {
    for (const s of SIDES) limb(pr['hp' + s], pr['kn' + s], pr['ft' + s], wLeg, cLeg);
    torso(cBody);
    for (const s of SIDES) limb(pr['sh' + s], pr['el' + s], pr['ha' + s], wArm, cBodyDk);
  } else {
    if (suit && facingUs) pack();
    limb(pr['hp' + far], pr['kn' + far], pr['ft' + far], wLeg, cLeg);
    limb(pr['sh' + far], pr['el' + far], pr['ha' + far], wArm, cBodyDk);
    torso(cBody);
    if (suit) {
      // a band of department colour across the chest
      const a = pr.shL, b = pr.shR, c2 = pr.hpR, d = pr.hpL;
      const lerp = (p, q, s) => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
      const p1 = lerp(a, d, 0.25), p2 = lerp(b, c2, 0.25);
      g.strokeStyle = C(roleC, 1.1); g.lineWidth = Math.max(1, 0.05 * k); g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke();
    }
    if (suit && !facingUs) pack();
    limb(pr['hp' + near], pr['kn' + near], pr['ft' + near], wLeg, cLeg);
    limb(pr['sh' + near], pr['el' + near], pr['ha' + near], wArm, cBody);
  }
  // neck and head: hair seen from above, the face when it turns our way
  if (!suit) { g.strokeStyle = cSkin; g.lineWidth = 0.05 * k; g.beginPath(); g.moveTo(pr.nk[0], pr.nk[1]); g.lineTo(pr.hd[0], pr.hd[1]); g.stroke(); }
  const fd = lens.p(J.hd[0] + face[0] * 0.06, J.hd[1] + face[1] * 0.06, J.hd[2] + face[2] * 0.06);
  const ox = fd[0] - pr.hd[0], oy = fd[1] - pr.hd[1];
  if (suit) {
    g.fillStyle = C(body, 1.05); g.beginPath(); g.arc(pr.hd[0], pr.hd[1], headR, 0, Math.PI * 2); g.fill();
    if (facingUs || kind === 'lying' || kind === 'down') {
      g.fillStyle = css(0.08 * lit[0] + 0.04, 0.12 * lit[1] + 0.05, 0.16 * lit[2] + 0.06);
      g.beginPath(); g.ellipse(pr.hd[0] + ox * 0.55, pr.hd[1] + oy * 0.55, headR * 0.72, headR * 0.55, Math.atan2(oy, ox) + Math.PI / 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(160,215,240,0.35)';
      g.beginPath(); g.arc(pr.hd[0] + ox * 0.55 - headR * 0.25, pr.hd[1] + oy * 0.55 - headR * 0.2, headR * 0.16, 0, Math.PI * 2); g.fill();
    }
  } else {
    g.fillStyle = cSkin; g.beginPath(); g.arc(pr.hd[0], pr.hd[1], headR, 0, Math.PI * 2); g.fill();
    // hair: the crown and the back of the head, away from the face
    g.fillStyle = cHair;
    g.beginPath(); g.arc(pr.hd[0] - ox * 0.45, pr.hd[1] - oy * 0.45 - headR * 0.18, headR * 0.9, 0, Math.PI * 2); g.fill();
    if (!facingUs && kind !== 'lying' && kind !== 'down') { g.beginPath(); g.arc(pr.hd[0], pr.hd[1], headR, 0, Math.PI * 2); g.fill(); }
  }
  // asleep under a blanket, or a sheet on the autodoc
  const cover = blanket || sheet;
  if (cover) {
    const q = cover.map(v => lens.p(v[0], v[1], v[2]));
    const c = blanket ? mix(rgb(ALB.blanket), rgb(ROLE_SUIT[m.role] || ALB.blanket), 0.3) : [0.82, 0.86, 0.88];
    g.fillStyle = C(c); g.strokeStyle = C(c); g.lineWidth = 0.06 * k;
    g.beginPath(); q.forEach((v, i) => i ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1])); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = C(c, 0.8); g.lineWidth = Math.max(1, 0.015 * k);
    g.beginPath(); g.moveTo((q[0][0] + q[3][0]) / 2 * 0.7 + (q[1][0] + q[2][0]) / 2 * 0.3, (q[0][1] + q[3][1]) / 2 * 0.7 + (q[1][1] + q[2][1]) / 2 * 0.3);
    g.lineTo((q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2); g.stroke();
  }
  // where a click finds them
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const kk in pr) { const v = pr[kk]; x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
  const pad = Math.max(headR, 3);
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad, hx: pr.hd[0], hy: pr.hd[1] - headR };
}

/** A mess stool under someone sat at a table (C: a colour in the room's light). */
function drawStool(g, lens, P, C, k) {
  if (!P.stool) return;
  const [sx, sz] = P.stool;
  const top = lens.p(sx, 0.43, sz), foot = lens.p(sx, 0, sz), r = 0.12 * lens.k(top[2]);
  g.lineCap = 'round';
  g.fillStyle = C(rgb(ALB.metalDk)); g.beginPath(); g.ellipse(foot[0], foot[1], r * 0.8, r * 0.5, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = C(rgb(ALB.metalDk)); g.lineWidth = Math.max(1.5, 0.06 * k);
  g.beginPath(); g.moveTo(top[0], top[1]); g.lineTo(foot[0], foot[1]); g.stroke();
  g.fillStyle = C(rgb(ALB.stool)); g.beginPath(); g.ellipse(top[0], top[1], r, r * 0.62, 0, 0, Math.PI * 2); g.fill();
}

/**
 * A figure for the GPU (gl/figures.js): its joints and posture, its
 * colours, and the box on the camera's canvas its picture fills.
 */
function figureSpec(lens, env, fig, P, selected, W, H) {
  const m = fig.m;
  const vac = !!m.suit?.wearing;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (v) => { const q = lens.p(v[0], v[1], v[2]); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); return q; };
  for (const kk in P.J) take(P.J[kk]);
  const cover = P.blanket || P.sheet;
  if (cover) cover.forEach(take);
  const hp = lens.p((P.J.hpL[0] + P.J.hpR[0]) / 2, (P.J.hpL[1] + P.J.hpR[1]) / 2, (P.J.hpL[2] + P.J.hpR[2]) / 2);
  const k = lens.k(hp[2]);
  const pad = (vac ? 0.3 : 0.22) * k + 4;
  const box = { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(W, x1 + pad), y1: Math.min(H, y1 + pad) };
  const roleC = rgb(ROLE_SUIT[m.role] || ROLE_SUIT.Deckhand);
  const suit = roleC, skin = rgb(SKIN[m.id % SKIN.length]), hair = rgb(HAIR[(m.id * 3 + 1) % HAIR.length]);
  const blanketC = mix(rgb(ALB.blanket), roleC, 0.3);
  const h = hash(m.id, 5);
  return {
    J: P.J, face: P.face, kind: P.kind, box, vac, suit, accent: mix(roleC, [1, 1, 1], 0.35), skin, hair,
    hairStyle: h < 0.45 ? 0 : h < 0.62 ? 1 : h < 0.74 ? 2 : h < 0.86 ? 3 : 4, build: hash(m.id, 9), seed: m.id, wound: woundsOf(m),
    cover: cover || null, coverKind: P.sheet ? 'sheet' : 'blanket', coverCol: blanketC,
    outline: selected ? [...rgb(C_SEL), 1] : cover ? [0, 0, 0, 0] : [4 / 255 * 0.45, 6 / 255 * 0.45, 9 / 255 * 0.45, 0.45],
    outlineW: selected ? Math.max(1.5, k * 0.022) : Math.max(1, k * 0.016),
    hit: { x0: x0 - 3, y0: y0 - 3, x1: x1 + 3, y1: y1 + 3 }, head: lens.p(P.J.hd[0], P.J.hd[1], P.J.hd[2]), headR: (vac ? BODY.helmet : BODY.head) * k,
  };
}

/** How hurt each part of someone is, 0–1 (head, torso, left arm, right arm, left leg, right leg), burns, dead. */
function woundsOf(m) {
  const b = m.body || {};
  const d = (k) => Math.max(0, Math.min(1, 1 - (b[k] ?? 100) / 100));
  return [d('head'), d('torso'), d('leftArm'), d('rightArm'), d('leftLeg'), d('rightLeg'), m.conditions?.includes('burned') ? 0.7 : 0, m.dead ? 1 : 0];
}

/**
 * Blood pooled on the deck under someone down and badly hurt (or dead of it):
 * as wide as the wound is bad, its edge uneven, dark in the room's light.
 */
function drawPool(g, lens, env, m, x, z) {
  const w = woundsOf(m);
  const hurt = Math.max(w[0], w[1]) * 0.8 + (w[2] + w[3] + w[4] + w[5]) * 0.08;
  if (hurt < 0.35) return;
  const r = 0.16 + 0.32 * Math.min(1, (hurt - 0.35) / 0.5);
  crewLight(env, x, z, _L);
  const n = 18;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2, rr = r * (0.75 + 0.35 * hash(m.id, i % n + 70));
    const p = lens.p(x + Math.cos(a) * rr * 1.2, 0.003, z + Math.sin(a) * rr);
    if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]);
  }
  g.closePath();
  g.fillStyle = css(0.3 * _L[0], 0.025 * _L[1], 0.025 * _L[2], 0.85);
  g.fill();
}

/**
 * A fixture's solid as triangles (world tiles): the furniture a person can be
 * behind (the back of the chair they sit in, the table their legs are under,
 * a bunk's boards). The GPU draws these into the depth before each person
 * (gl/figures.js), so what stands nearer the lens hides them pixel by pixel.
 */
const _solids = new WeakMap();
export function solidOf(f) {
  let tri = _solids.get(f);
  if (tri) return tri;
  const pl = placer(f), out = [];
  for (const p of f.parts) for (const face of partFaces(p, pl).faces) {
    const w = face.world;
    for (let i = 1; i < w.length - 1; i++) out.push(...w[0], ...w[i], ...w[i + 1]);
  }
  tri = new Float32Array(out);
  _solids.set(f, tri);
  return tri;
}

/** The furniture near someone at (x, z): what could stand between them and the lens. */
export function occludersNear(fixtures, x, z) {
  const out = [];
  for (const f of fixtures) {
    if (!f.parts) continue;
    const dx = f.x + 0.5 - x, dz = f.z + 0.5 - z;
    if (dx * dx + dz * dz < 2.6) out.push(solidOf(f));
  }
  return out;
}

/** How many of the brig's cells hold someone (prisoners fill the cells first: sim/manifest.js). */
function heldInCells(state) {
  const n = (state.passengers || []).reduce((s, p) => s + (p.kind === 'prisoners' ? p.count : 0), 0);
  return Math.min(state.brig || 0, n);
}

/** A soft shadow on the deck under someone standing (fainter as they float off it). */
function drawShadow(g, lens, x, z, lift, k) {
  const c = lens.p(x, 0, z);
  const a = Math.max(0, 0.32 - lift * 0.5);
  if (a <= 0.01) return;
  const r = (0.24 + lift * 0.3) * k;
  g.save();
  g.translate(c[0], c[1]); g.scale(1, 0.62);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
  gr.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ---- THE CAMERA ----

export class RoomCam {
  /**
   * opts: { onCrew(id), onTile(tile, deck, x, y), selectedCrew() → id,
   *         overlay: 'auto' | 'full' | 'compact' | 'none' }
   */
  constructor(canvas, deckIndex, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.deck = deckIndex;
    this.opts = opts;
    this.cache = null;
    this.hits = [];
    this.facing = new Map();
    this.last = new Map();
    this.t = 0;
    this._room = null;
    this._dpr = 0;
    if (opts.onCrew || opts.onTile) {
      canvas.addEventListener('click', (e) => {
        const hit = this.pick(e.clientX, e.clientY);
        if (!hit) return;
        e.stopPropagation();
        if (hit.kind === 'crew') opts.onCrew?.(hit.id);
        else opts.onTile?.(hit.tile, hit.deck, hit.x, hit.y);
      });
    }
    canvas.addEventListener('pointermove', (e) => {
      const hot = !!this.pick(e.clientX, e.clientY);
      if (hot !== this._hot) { this._hot = hot; canvas.style.cursor = hot ? 'var(--cur-hand, pointer)' : ''; }
    });
    canvas.addEventListener('pointerleave', () => { if (this._hot) { this._hot = false; canvas.style.cursor = ''; } });
  }

  setDeck(i) {
    if (i === this.deck) return;
    this.deck = i;
    this.cache = null;
    this.hits = [];
  }

  /** Hit test at a client point: the crew member or the fixture there, nearest first. */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return { kind: 'crew', id: h.id };
    }
    const c = this.cache;
    if (!c) return null;
    const d = c.dpr;
    for (const p of c.picks) {
      if (p.poly.length > 2 && inPoly(p.poly, x * d, y * d)) return { kind: 'tile', deck: this.deck, x: p.tile.x, y: p.tile.y, tile: p.tile.t };
    }
    return null;
  }

  draw(state, alpha = 1, now = performance.now()) {
    drawCam(this, state, alpha, now);
  }
}

/** The cameras: one per compartment, bow to stern. */
export function camerasFor(state) {
  return state.ship.decks.map((d, i) => {
    const id = `CAM-${String(i + 1).padStart(2, '0')}`, label = camLabel(state.ship, i);
    return { deck: i, id, label, name: d.name, title: `${id} · ${label}` };
  });
}

/** A compartment's name on its camera: numbered where two decks share one (PASSENGERS 1, 2). */
function camLabel(ship, i) {
  const name = ship.decks[i].name;
  const same = ship.decks.filter(d => d.name === name).length;
  const n = ship.decks.slice(0, i + 1).filter(d => d.name === name).length;
  return name.toUpperCase() + (same > 1 ? ` ${n}` : '');
}

// ---- A FRAME ----

const LAMP = { ok: '#5FD38D', warn: '#F0A93A', fail: '#EF5350', off: '#2A3138' };

function sysLamp(u) {
  if (!u) return null;
  if (!u.enabled) return 'off';
  if (u.status === Status.FAILED) return 'fail';
  if (u.status !== Status.NOMINAL) return 'warn';
  return 'ok';
}

/** What a camera's display says about its compartment (worst first): text, colour. */
function alertOf(a) {
  if (!a) return null;
  if (a.fire) return ['FIRE', C_WARN];
  if (a.breached) return ['BREACH', C_WARN];
  if (a.pressure < ATMO.PRESSURE_LETHAL) return ['VACUUM', C_WARN];
  if (a.vented) return ['VENTING', C_CAUTION];
  if (a.pressure < ATMO.PRESSURE_DANGER) return ['LOW PRESS', C_WARN];
  if (a.o2Pct < ATMO.HYPOXIA_SEVERE) return ['LOW O₂', C_WARN];
  if (a.co2Pct > ATMO.CO2_SEVERE) return ['HIGH CO₂', C_WARN];
  if (a.pressure < ATMO.PRESSURE_LOW || a.o2Pct < ATMO.HYPOXIA_MILD || a.co2Pct > ATMO.CO2_MILD) return [a.o2Pct < ATMO.HYPOXIA_MILD ? 'LOW O₂' : a.co2Pct > ATMO.CO2_MILD ? 'HIGH CO₂' : 'LOW PRESS', C_CAUTION];
  return null;
}

function drawCam(cam, state, alpha, now) {
  const cv = cam.canvas;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (!cw || !ch) return;
  const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const Wd = Math.round(cw * dpr), Hd = Math.round(ch * dpr);
  if (cv.width !== Wd || cv.height !== Hd) { cv.width = Wd; cv.height = Hd; }
  const g = cam.ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const ship = state.ship;
  const deck = ship?.decks[cam.deck];
  if (!deck) { g.fillStyle = '#05070A'; g.fillRect(0, 0, Wd, Hd); cam.hits = []; return; }
  // the picture holds still while the game is paused
  if (state.speed !== 0 || !cam.t) cam.t = now;
  const t = cam.t;

  const room = roomFor(ship, cam.deck);
  const mode = lightMode(state, deck);
  const lockers = state.lifeSupport?.lockers || {};
  let suits = '';
  for (const f of room.fixtures) if (f.kind === 'locker') suits += lockers[f.id]?.hasSuit === false ? '0' : '1';
  const glow = state.reactor?.status === 'online' ? 1 : 0;
  // (the brig's doors: shut on the cells that hold someone)
  const held = heldInCells(state);
  const key = `${Wd}x${Hd}@${dpr}|${mode}|${suits}|${glow}|${room.fixtures.some(f => f.cell != null) ? held : 0}|${_fontEpoch}`;
  let c = cam.cache;
  if (!c || c.key !== key || c.room !== room) {
    if (_budgetT !== now) { _budgetT = now; _budgetUsed = 0; }
    if (!c || c.room !== room || _budgetUsed < 1) {
      _budgetUsed++;
      c = buildStatic(state, room, Wd, Hd, dpr, mode);
      c.key = key; c.room = room;
      cam.cache = c;
    }
  }
  // (a cache from before a resize, waiting its turn: stretched to fit)
  const sx = Wd / c.Wd, sy = Hd / c.Hd;
  if (sx !== 1 || sy !== 1) g.setTransform(sx, 0, 0, sy, 0, 0);
  const lens = c.lens, env = c.env;

  // Who is in here, where, doing what
  const geo = shipGeometry(ship);
  const start = geo.deckStart[cam.deck];
  const G = (state.flight?.thrustG || 0) + (state.flight?.rcsG || 0);
  const floating = G < 0.01;
  const byRow = [];
  for (let r = 0; r < room.rows; r++) byRow.push([]);
  const inertia = state.$inertia?.active ? state.$inertia : null;
  for (const m of ship.crew) {
    if (m.away) continue;
    const px = m.$px ?? m.pos.sx, py = m.$py ?? m.pos.sy;
    const x = px + (m.pos.sx - px) * alpha, y = py + (m.pos.sy - py) * alpha;
    if (geo.deckOfRow(y) !== cam.deck) continue;
    if (seatKind(m.seat) === 'head') continue;   // (the head's door is shut)
    let z = y - start;
    let climb = 0;
    if (z < -0.05) { climb = -z * 2; z = 0; }                         // up the ladder into the deckhead
    else if (z > room.rows - 1 + 0.05) { if (z > room.rows - 1 + 0.35) continue; z = room.rows - 1; }
    if (climb > 0.9) continue;
    const last = cam.last.get(m.id);
    const moving = !!last && (Math.abs(last[0] - x) + Math.abs(last[1] - z) > 0.0005);
    let heading = cam.facing.get(m.id);
    if (last && moving) { heading = Math.atan2(z - last[1], x - last[0]); cam.facing.set(m.id, heading); }
    cam.last.set(m.id, [x, z]);
    const work = !moving ? workHeading(room, { x, z }) : null;
    if (work != null) heading = work;
    if (heading == null) heading = Math.PI / 2 + 0.6 * (hash(m.id) - 0.5);
    const row = Math.max(0, Math.min(room.rows - 1, Math.floor(z + 0.5)));
    // thrown about by the ship moving under them (an inertial event, sim/inertia.js): how fast, which way
    const flung = inertia?.bodies.find(b => b.id === m.id && b.moving);
    const thrown = flung ? { vx: flung.vx, vy: flung.vy, grounded: inertia.grounded } : null;
    byRow[row].push({ m, x: x + (m.task?.type === 'carried' ? 0.3 : 0), z, moving, heading, work: work != null, climb, thrown });
  }
  const selId = cam.opts.selectedCrew?.();
  const hits = [];
  let tag = null;
  const docked = state.dock && (state.dock.phase === 'docked' || state.dock.phase === 'seal') ? airlockFor(ship, state.dock.port) : null;

  // Everyone posed, far first in each row; their bodies rendered on the GPU in one pass (gl/figures.js),
  // copied in below in their place among the rows (without one, drawn flat)
  const posed = [];
  for (let r = 0; r < room.rows; r++) {
    byRow[r].sort((a, b) => lens.dist(b.x + 0.5, 0.6, b.z + 0.5) - lens.dist(a.x + 0.5, 0.6, a.z + 0.5));
    for (const fig of byRow[r]) {
      const P = posture(room, fig, t, floating);
      if (fig.climb) for (const k in P.J) P.J[k][1] += fig.climb;
      fig.P = P;
      fig.sel = selId != null && selId === fig.m.id;
      fig.spec = figureSpec(lens, env, fig, P, fig.sel, c.Wd, c.Hd);
      fig.spec.occluders = occludersNear(c.fixtures, (P.J.hpL[0] + P.J.hpR[0]) / 2, (P.J.hpL[2] + P.J.hpR[2]) / 2);
      posed.push(fig);
    }
  }
  const floorK = env.mode === 'normal' ? 0.5 : env.mode === 'battle' ? 0.34 : env.mode === 'blackout' ? 0.15 : 0.24;
  const solid = posed.length ? renderFigures({ eye: lens.eye, r: lens.r, u: lens.u, f: lens.f, s: lens.s, ox: lens.ox, oy: lens.oy, lights: env.lights, amb: env.amb, exp: env.exp, floor: floorK,
    tint: env.mode === 'battle' ? [1.05, 0.92, 0.92] : [1, 1, 1] }, posed.map(f => f.spec)) : null;
  posed.forEach((f, i) => { f.img = solid?.[i] || null; });

  const fire = deck.atmosphere?.fire?.intensity > 0 ? deck.atmosphere.fire : null;
  const fireRow = Math.max(0, Math.min(room.rows - 1, Math.floor(room.fire[1])));
  for (let r = 0; r < room.rows; r++) {
    const L = c.layers[r];
    if (L) g.drawImage(L.c, L.x, L.y);
    const dyn = c.rowsDyn[r];
    if (r === 0) wallLamps(g, lens, room, docked, cam.deck);
    if (dyn) {
      for (const s of dyn.screens) screenContent(g, s, t);
      for (const l of dyn.lamps) {
        const st = sysLamp(state.systems?.units?.[l.sys]);
        if (st) lamp(g, lens, l, LAMP[st], st !== 'off');
      }
      for (const o of dyn.occupancy) {
        const busy = o.cell != null ? o.cell < held : ship.crew.some(m => !m.away && Math.round(m.pos.sx) === o.tx && Math.round(m.pos.sy - start) === o.tz);
        lamp(g, lens, o, busy ? C_WARN : C_OWN, true);
      }
    }
    // a fire in this row: before the people and what stands nearer
    if (fire && fireRow === r) drawFlames(g, lens, room, fire.intensity, t);
    // the people in this row, far first
    for (const fig of byRow[r]) {
      const P = fig.P, sel = fig.sel;
      if (P.kind === 'down' || P.kind === 'pinned') drawPool(g, lens, env, fig.m, (P.J.hpL[0] + P.J.hpR[0] + P.J.shL[0] + P.J.shR[0]) / 4, (P.J.hpL[2] + P.J.hpR[2] + P.J.shL[2] + P.J.shR[2]) / 4);
      if (P.kind === 'stand' || P.kind === 'float' || P.kind === 'down' || P.kind === 'brace' || P.kind === 'pinned' || P.kind === 'fall') {
        const lift = P.kind === 'float' ? P.J.ftL[1] : P.kind === 'down' && floating ? P.J.hpL[1] : 0;
        drawShadow(g, lens, (P.J.hpL[0] + P.J.hpR[0]) / 2, (P.J.hpL[2] + P.J.hpR[2]) / 2, lift, lens.k(lens.p(fig.x + 0.5, 0, fig.z + 0.5)[2]));
      }
      let box;
      if (fig.img) {
        const im = fig.img, sp = fig.spec;
        crewLight(env, (P.J.hpL[0] + P.J.hpR[0]) / 2, (P.J.hpL[2] + P.J.hpR[2]) / 2, _L);
        drawStool(g, lens, P, (cc) => css(cc[0] * _L[0], cc[1] * _L[1], cc[2] * _L[2]), lens.k(lens.p(fig.x + 0.5, 0, fig.z + 0.5)[2]));
        g.drawImage(im.canvas, im.sx, im.sy, im.w, im.h, im.x, im.y, im.w, im.h);
        box = { ...sp.hit, hx: sp.head[0], y0: Math.min(sp.hit.y0, sp.head[1] - sp.headR) };
      } else box = drawFigure(g, lens, env, fig, P, sel, t);
      hits.push({ id: fig.m.id, x0: box.x0 / dpr * sx, y0: box.y0 / dpr * sy, x1: box.x1 / dpr * sx, y1: box.y1 / dpr * sy });
      if (sel) tag = { name: fig.m.name, x: box.hx, y: box.y0 };
    }
  }
  cam.hits = hits;

  // Smoke from a fire, over everything
  if (fire) drawSmoke(g, lens, room, fire.intensity, t, mode);
  // A deck open to space: now and then a dying panel flickers
  if (mode === 'vacuum') {
    const n = Math.floor(t / 140);
    if (hash(n, room.di, 11) > 0.86) {
      const [lx, lz] = room.ceil[Math.floor(hash(n, 3) * room.ceil.length)];
      const p = lens.p(lx, 0, lz), k = lens.k(p[2]);
      g.save(); g.globalCompositeOperation = 'lighter';
      g.translate(p[0], p[1]); g.scale(1, 0.7);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, k * 1.6);
      gr.addColorStop(0, 'rgba(200,220,255,0.22)'); gr.addColorStop(1, 'rgba(200,220,255,0)');
      g.fillStyle = gr; g.fillRect(-k * 1.6, -k * 1.6, k * 3.2, k * 3.2);
      g.restore();
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  // (a small feed has no room for a name over its label: the outline marks them there)
  if (tag && cw >= 260) nameTag(g, tag.name, tag.x * sx, tag.y * sy, dpr, Wd);
  overlay(cam, g, state, deck, room, Wd, Hd, dpr, cw);
}

/** Status lamp over each hatch: green with a ship on the collar, red sealed against vacuum. */
function wallLamps(g, lens, room, docked, di) {
  for (const { wall: wl, unit: u, tile } of room.wallFx) {
    if (u.t !== T.AIRLOCK || !lens.facing(wl)) continue;
    const ux = (wl.b[0] - wl.a[0]) / wl.len, uz = (wl.b[1] - wl.a[1]) / wl.len;
    const x = wl.a[0] + ux * (u.k + 0.5) + wl.n[0] * 0.01, z = wl.a[1] + uz * (u.k + 0.5) + wl.n[1] * 0.01;
    const on = docked && docked.deck === di && docked.x === tile.x && docked.y === tile.y;
    lamp(g, lens, { x, y: 1.38, z }, on ? C_OWN : C_WARN, true);
  }
}

function lamp(g, lens, l, col, on) {
  const p = lens.p(l.x, l.y, l.z), k = lens.k(p[2]);
  const r = Math.max(1, k * 0.02);
  if (on) {
    g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.35;
    g.fillStyle = col; g.beginPath(); g.arc(p[0], p[1], r * 2.6, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.fillStyle = col; g.beginPath(); g.arc(p[0], p[1], r, 0, Math.PI * 2); g.fill();
}

/** A screen's faint content: a few lines that change now and then. */
function screenContent(g, s, t) {
  const [a, b, c, d] = s.q;
  const hpx = Math.hypot(d[0] - a[0], d[1] - a[1]);
  if (hpx < 5) return;
  const at = (u, v) => {
    const x0 = a[0] + (b[0] - a[0]) * u, y0 = a[1] + (b[1] - a[1]) * u, x1 = d[0] + (c[0] - d[0]) * u, y1 = d[1] + (c[1] - d[1]) * u;
    return [x0 + (x1 - x0) * v, y0 + (y1 - y0) * v];
  };
  const n = hpx > 14 ? 4 : 2;
  const epoch = Math.floor(t / 1700 + s.seed * 13);
  g.lineWidth = Math.max(0.8, hpx * 0.07);
  g.lineCap = 'butt';
  for (let i = 0; i < n; i++) {
    const v = 0.22 + i * (0.6 / Math.max(1, n - 1));
    const len = 0.2 + 0.62 * hash(Math.floor(s.seed * 1e6), i, epoch + i * (i === 1 ? 1 : 0));
    g.strokeStyle = i === 1 ? s.ink[1] : s.ink[0];
    g.globalAlpha = i === 1 ? 0.7 : 0.5;
    const p = at(0.1, v), q = at(0.1 + 0.8 * len, v);
    g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
  }
  g.globalAlpha = 1;
}

/** A soft round puff of smoke in a colour, drawn once and scaled. */
const _puffs = new Map();
function puff(col) {
  let c = _puffs.get(col);
  if (c) return c;
  c = canvasOf(64, 64);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(${col},0.9)`); gr.addColorStop(0.5, `rgba(${col},0.62)`); gr.addColorStop(0.8, `rgba(${col},0.2)`); gr.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  _puffs.set(col, c);
  return c;
}

// Smoke takes the colour of the light it hangs in
const SMOKE = { normal: '118,113,108', battle: '92,52,50', emergency: '96,76,56', blackout: '30,27,25', vacuum: '60,64,70' };
const SOOT = '44,40,38';

// Smooth, never-repeating-looking flicker from a few incommensurate waves
const wave = (t, a) => 0.5 + 0.25 * Math.sin(t * 0.0131 + a) + 0.15 * Math.sin(t * 0.0297 + a * 2.3) + 0.1 * Math.sin(t * 0.0611 + a * 4.1);

/** The fire itself: the light it throws and its flames (drawn in its row, so what stands nearer hides it). */
function drawFlames(g, lens, room, I, t) {
  const [fx, fz] = room.fire;
  const base = lens.p(fx, 0, fz), k = lens.k(base[2]);
  const flick = 0.8 + 0.4 * (wave(t, 0.7) - 0.5);
  g.save();
  g.globalCompositeOperation = 'lighter';
  const c = lens.p(fx, 0.35, fz);
  const R = k * (1.4 + 1.6 * I);
  let gr = g.createRadialGradient(c[0], c[1], 0, c[0], c[1], R);
  gr.addColorStop(0, `rgba(255,125,45,${(0.5 * I * flick).toFixed(3)})`);
  gr.addColorStop(0.4, `rgba(255,95,30,${(0.2 * I * flick).toFixed(3)})`);
  gr.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = gr; g.fillRect(c[0] - R, c[1] - R, R * 2, R * 2);
  // tongues of different heights licking up from a glowing bed
  const spread = k * (0.35 + 0.45 * I);
  g.save(); g.translate(base[0], base[1]); g.scale(1, 0.45);
  gr = g.createRadialGradient(0, 0, 0, 0, 0, spread * 1.1);
  gr.addColorStop(0, `rgba(255,190,90,${(0.8 * flick).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, spread * 1.1, 0, Math.PI * 2); g.fill();
  g.restore();
  const n = 7;
  for (let pass = 0; pass < 2; pass++) for (let j = 0; j < n; j++) {
    const off = ((j * 0.618) % 1 - 0.5) * 2;           // spread, not in a row
    const lift = 1 - Math.abs(off) * 0.55;
    const h = k * (0.3 + 0.75 * I) * lift * (0.45 + 0.75 * wave(t, j * 1.9)) * (pass ? 0.55 : 1);
    const w = k * (0.16 + 0.12 * I) * (pass ? 0.6 : 1) * (0.8 + 0.4 * wave(t * 0.7, j));
    const bx = base[0] + off * spread, by = base[1] + Math.abs(off) * k * 0.05 - (pass ? k * 0.02 : 0);
    const sway = (wave(t * 1.3, j * 3.1) - 0.5) * w * 0.9;
    const fg = g.createLinearGradient(bx, by, bx, by - h);
    if (pass) { fg.addColorStop(0, 'rgba(255,248,215,0.95)'); fg.addColorStop(0.5, 'rgba(255,215,120,0.7)'); fg.addColorStop(1, 'rgba(255,170,60,0)'); }
    else { fg.addColorStop(0, 'rgba(255,190,90,0.9)'); fg.addColorStop(0.45, 'rgba(250,110,35,0.75)'); fg.addColorStop(1, 'rgba(190,40,15,0)'); }
    g.fillStyle = fg;
    g.beginPath(); g.moveTo(bx - w / 2, by);
    g.bezierCurveTo(bx - w * 0.62, by - h * 0.35, bx - w * 0.18 + sway * 0.5, by - h * 0.72, bx + sway, by - h);
    g.bezierCurveTo(bx + w * 0.18 + sway * 0.5, by - h * 0.72, bx + w * 0.62, by - h * 0.35, bx + w / 2, by);
    g.closePath(); g.fill();
  }
  g.restore();
}

/** Smoke: a sooty column off the flames, a layer gathering under the deckhead, a thin haze. */
function drawSmoke(g, lens, room, I, t, mode) {
  const [fx, fz] = room.fire;
  const k = lens.k(lens.p(fx, 0, fz)[2]);
  const lit = puff(SMOKE[mode] || SMOKE.normal), soot = puff(SOOT);
  g.save();
  g.globalAlpha = 0.1 * I;
  g.fillStyle = `rgb(${SMOKE[mode] || SMOKE.normal})`; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  for (let j = 0; j < 8; j++) {
    const ph = (t * 0.00013 + j / 8) % 1;
    const p = lens.p(fx + Math.sin(ph * 5 + j * 1.7) * 0.18 * (1 + ph), 0.35 + ph * (CEIL - 0.25), fz - ph * 0.35);
    const r = k * (0.16 + ph * 0.5) * (0.7 + I * 0.5);
    g.globalAlpha = Math.min(1, 0.9 * I) * Math.sin(Math.min(1, ph * 1.4) * Math.PI) ** 0.6;
    g.drawImage(ph < 0.45 ? soot : lit, p[0] - r, p[1] - r, r * 2, r * 2);
  }
  const w = room.x1 - room.x0, d = room.z1 - room.z0;
  const n = Math.max(6, Math.round(w * 2.2));
  for (let j = 0; j < n; j++) {
    const drift = (t * 0.00004 + hash(j, room.di)) % 1;
    const x = room.x0 + ((j + 0.5) / n + Math.sin(drift * Math.PI * 2) * 0.04) * w;
    const z = room.z0 + 0.2 + hash(j, 7) * d * 0.7;
    if (!room.inside(Math.floor(x), Math.floor(z))) continue;
    const p = lens.p(x, CEIL - 0.12 - hash(j, 3) * 0.2, z);
    const r = k * (0.38 + hash(j, 5) * 0.3) * (0.6 + I * 0.6);
    g.globalAlpha = Math.min(0.85, (0.35 + 0.5 * I) * (0.7 + 0.3 * Math.sin(drift * 9 + j)));
    g.drawImage(lit, p[0] - r * 1.3, p[1] - r * 0.75, r * 2.6, r * 1.5);
  }
  g.restore();
}

function nameTag(g, name, x, y, dpr, W) {
  const fs = 11 * dpr;
  g.font = `500 ${fs}px ${F_DATA}`;
  const w = g.measureText(name).width + 10 * dpr, h = fs + 6 * dpr;
  let bx = Math.round(x - w / 2), by = Math.round(y - h - 5 * dpr);
  bx = Math.max(2 * dpr, Math.min(W - w - 2 * dpr, bx));
  by = Math.max(2 * dpr, by);
  g.fillStyle = 'rgba(10,14,19,0.86)'; g.fillRect(bx, by, w, h);
  g.fillStyle = C_SEL; g.fillRect(bx, by, 2 * dpr, h);
  g.fillStyle = C_TEXT; g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillText(name, bx + 6 * dpr, by + h / 2 + 0.5 * dpr);
}

/** The camera's own display: id and compartment, alert, pressure and oxygen, the clock. */
function overlay(cam, g, state, deck, room, W, H, dpr, cssW) {
  const mode = cam.opts.overlay || 'auto';
  if (mode === 'none') return;
  const full = mode === 'full' || (mode === 'auto' && cssW >= 260);
  const fs = 11 * dpr, pad = 6 * dpr, lh = fs + 5 * dpr;
  const id = `CAM ${String(cam.deck + 1).padStart(2, '0')}`;
  const a = deck.atmosphere;
  const alert = alertOf(a);
  const time = formatTime(state.clock);
  g.textBaseline = 'middle';
  const text = (s, x, y, col, font, align = 'left', bg = true) => {
    g.font = font;
    const w = g.measureText(s).width;
    const bx = align === 'right' ? x - w : x;
    if (bg) { g.fillStyle = 'rgba(5,7,10,0.55)'; g.fillRect(Math.round(bx - 3 * dpr), Math.round(y - lh / 2), Math.round(w + 6 * dpr), Math.round(lh)); }
    g.fillStyle = col; g.textAlign = 'left';
    g.fillText(s, bx, y + 0.5 * dpr);
    return w;
  };
  const uiFont = `500 ${fs}px ${F_UI}`, dataFont = `400 ${fs}px ${F_DATA}`;
  if ('letterSpacing' in g) g.letterSpacing = `${(0.06 * fs).toFixed(1)}px`;
  const y0 = pad + lh / 2;
  text(full ? `${id} · ${camLabel(state.ship, cam.deck)}` : id, pad, y0, C_TEXT2, uiFont);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  if (alert) {
    g.font = uiFont;
    const w = text(alert[0], W - pad, y0, alert[1], uiFont, 'right');
    g.fillStyle = alert[1]; g.fillRect(W - pad - w - 10 * dpr, y0 - 3 * dpr, 6 * dpr, 6 * dpr);
  } else if (!full) text(time, W - pad, y0, C_TEXT2, dataFont, 'right');
  if (!full) return;
  const yb = H - pad - lh / 2;
  if (a) {
    const st = alertOf(a);
    const col = st ? st[1] : C_TEXT2;
    text(`${Math.round(a.pressure)} kPa  O₂ ${a.o2Pct.toFixed(1)}%`, pad, yb, col, dataFont);
  }
  text(`${formatDate(state.clock)} ${time}`, W - pad, yb, C_TEXT2, dataFont, 'right');
}
