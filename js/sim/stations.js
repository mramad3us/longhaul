// ============================================================
// LONGHAUL — Stations: where they are, what they are, who docks
//
// There are two kinds of station, as there would be:
//   SURFACE PORTS, built on an asteroid (Ceres, Pallas, Vesta) or a
//     small moon (Phobos). They sit on the rock at its true radius and
//     ride round with its rotation: Ceres turns in nine hours, so its
//     port moves at 90 m/s and pulls 0.0017 G toward the rock's centre
//     to stay on it. Their berths are arms on gantry towers above the
//     field; a ship hangs nose-up beside a tower, latched by a flank
//     collar, or lies in a cargo cradle.
//   ORBITAL STATIONS (Hygiea Ring, Tycho, Luna's yards, Ganymede) on
//     Keplerian orbits round their body: Luna's yards circle the Moon at
//     3,000 km every four hours. Berths are arms on a docking spine.
//
// Each station has a frame that turns with it: x is local up (away from
// the body's centre), y is along its motion, z out of the plane. Its
// parts (the same primitives as ship hulls, hulls.js) and berths are
// laid out in that frame and turned into the solar frame by the angle of
// the station round its body (stationAngle).
//
// Around every station:
//   the APPROACH GATE, a point straight up from it (gateKm): where long
//     routes end, outside the keep-out zone (traffic-control.js). Ships
//     come down from it to their berth on a controlled approach.
//   the ANCHORAGE, a parking orbit round the body (anchorKm up) where
//     traffic waits for a berth.
//   its BERTHS: each a collar of a size class (with adaptors, a berth
//     takes a smaller collar too). Traffic takes berths as it arrives and
//     waits at the anchorage when they are full; traffic control keeps a
//     share of berths free for arrivals it has cleared (RESERVE). A berth
//     found free is held for the ship it is given to while it comes down
//     (holdBerth), so one berth isn't sent every ship waiting; how many
//     are taken is kept at runtime ($bh), counted again hourly. A berth
//     let go calls down a ship from the port's queue (BERTH_FREED: traffic.js).
//
// Stations defend themselves (defense: PDC emplacements, torpedo silos,
// railguns at the naval yards) and can be attacked: combatants.js gives
// them a combat profile, damage.js takes hits on their sections.
// ============================================================

import { AU_KM, TWO_PI, DAY_MIN, AU_M } from '../core/constants.js';
import { random } from '../core/rng.js';
import { getBody } from './ephemeris.js';
import { getWorld, orbitStateAt } from './world.js';
import { CLASSES, PLAYER_CLASS } from './ship-classes.js';
import { hullOf, partExtent } from './hulls.js';
import { mateOffset, mateRotation, turn } from './mating.js';
import { releaseSlot } from './holding.js';

/** Share of a station's berths traffic control keeps free for the arrivals it clears. */
export const RESERVE = 0.25;

/** A berth's corridor, the straight run in along its collar's axis (m): this long, or what is clear of it, and never under the hold point backing out of it. */
export const CORRIDOR_M = 1_000;
const CORRIDOR_MIN_M = 170;

/** How high and low of the plane a station's structure stands in a hull's way (m); and what a hull keeps from it flying round it, past its own length. */
const WAY_Z_M = 20;
const WAY_CLEAR_M = 40;

/** Hulls and parts this close (m) are touching, not through each other: a collar flush on its arm. */
const TOUCH_M = 0.05;

const KEPLER = (body, rKm) => TWO_PI * Math.sqrt(rKm ** 3 / getBody(body).gm) / 86400;   // days

// ---- PARTS ----
// The same primitives as ship hulls, in the station frame (metres).

const box = (x0, x1, y0, y1, role, o = {}) => ({ k: 'box', x0, x1, y0, y1, z0: o.z0 ?? -(o.h ?? 60) / 2, z1: o.z1 ?? (o.h ?? 60) / 2, role, ...(o.tag ? { tag: o.tag } : {}) });
const cyl = (x0, x1, r, y, role) => ({ k: 'cyl', x0, x1, r, y, z: 0, role });
// (a ring turns about the docking spine, y: it lies across the spine and the arms, in x and z, and nothing that docks flies through it)
const ring = (x, r, w, d, n, y = 0) => ({ k: 'ring', x, y, r, w, d, n, role: 'hab', plane: 'xz' });

/** A gantry tower on a surface field at y, `h` tall, with arms both sides every `step` metres. */
function gantry(parts, berths, tag, y, h, levels, accepts) {
  parts.push(box(0, h, y - 12, y + 12, 'truss', { h: 24, tag }));
  for (let i = 0; i < levels; i++) {
    const x = h * (0.45 + 0.5 * i / Math.max(1, levels - 1));
    for (const s of [-1, 1]) {
      parts.push(box(x - 4, x + 4, s > 0 ? y + 12 : y - 42, s > 0 ? y + 42 : y - 12, 'dock', { h: 6, tag }));
      berths.push({ id: `${tag}${i * 2 + (s > 0 ? 2 : 1)}`, label: `Tower ${tag}, arm ${i * 2 + (s > 0 ? 2 : 1)}`, x, y: y + s * 42, z: 0, face: s > 0 ? 'y+' : 'y-', accepts, up: 'x+', kind: 'arm' });
    }
  }
}

/** A cargo cradle on the field at y: a bulk hull lies in it, latched by its cargo collar. */
function cradle(parts, berths, id, y, len) {
  parts.push(box(0, 30, y - len / 2, y + len / 2, 'dock', { h: 70 }));
  parts.push(box(30, 34, y - len / 2, y - len / 2 + 20, 'dock', { h: 20 }));
  berths.push({ id, label: `Cargo cradle ${id}`, x: 80, y, z: 0, face: 'x+', accepts: ['L'], up: 'y+', kind: 'cradle' });
}

/** A docking spine along y from y0 to y1 at height x, with arms out to ±x every `step`. */
function spine(parts, berths, tag, x, y0, y1, step, accepts, armLen = 60) {
  parts.push(box(x - 15, x + 15, y0, y1, 'truss', { h: 30, tag }));
  let k = 1;
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (const s of [-1, 1]) {
      parts.push(box(s > 0 ? x + 15 : x - 15 - armLen, s > 0 ? x + 15 + armLen : x - 15, y - 4, y + 4, 'dock', { h: 6, tag }));
      berths.push({ id: `${tag}${k}`, label: `Spine ${tag}, arm ${k}`, x: x + s * (15 + armLen), y, z: 0, face: s > 0 ? 'x+' : 'x-', accepts, up: 'y+', kind: 'arm' });
      k++;
    }
  }
}

// ---- THE STATIONS ----

/**
 * Builders: each lays out one station's parts and berths. Sizes are real
 * sizes: a busy port is a few kilometres across, a yard a few more.
 */
const LAYOUTS = {
  // The Belt's biggest port: a landing field on Ceres' equator, a tank farm,
  // radiator fields, and the hatches down into the rock where people live
  'ceres-station'() {
    const parts = [], berths = [];
    parts.push(box(-40, 0, -2200, 2200, 'ground-works', { h: 1600 }));
    parts.push(box(0, 25, -1900, -1300, 'hab', { h: 400 }));
    parts.push(box(0, 18, 1300, 1900, 'hab', { h: 300 }));
    for (let i = 0; i < 6; i++) parts.push(cyl(0, 60, 22, -1270 + i * 50, 'tank'));
    parts.push(box(0, 80, 2000, 2150, 'radiator', { h: 20 }));
    parts.push(box(0, 80, -2150, -2000, 'radiator', { h: 20 }));
    parts.push(box(0, 40, -260, 260, 'command', { h: 200, tag: 'control' }));
    const towers = [-900, -500, 500, 900];
    towers.forEach((y, i) => gantry(parts, berths, 'ABCD'[i], y, 220, 3, ['S', 'M']));
    cradle(parts, berths, 'L1', 1130, 320);
    cradle(parts, berths, 'L2', -700, 300);
    return { parts, berths };
  },
  'pallas-station'() {
    const parts = [], berths = [];
    parts.push(box(-30, 0, -1500, 1500, 'ground-works', { h: 1000 }));
    parts.push(box(0, 120, -300, 300, 'machinery', { h: 260, tag: 'smelter' }));
    parts.push(box(0, 160, 320, 420, 'radiator', { h: 16 }));
    parts.push(box(0, 160, -420, -320, 'radiator', { h: 16 }));
    parts.push(box(0, 30, -1300, -1000, 'hab', { h: 200 }));
    gantry(parts, berths, 'A', -800, 180, 2, ['S', 'M']);
    gantry(parts, berths, 'B', 700, 180, 2, ['S', 'M']);
    cradle(parts, berths, 'L1', 1100, 300);
    cradle(parts, berths, 'L2', -590, 280);
    return { parts, berths };
  },
  'vesta-depot'() {
    const parts = [], berths = [];
    parts.push(box(-20, 0, -800, 800, 'ground-works', { h: 600 }));
    parts.push(box(0, 22, -200, 200, 'hab', { h: 160 }));
    for (let i = 0; i < 4; i++) parts.push(cyl(0, 40, 16, 660 + i * 40, 'tank'));
    gantry(parts, berths, 'A', -450, 150, 2, ['S', 'M']);
    gantry(parts, berths, 'B', 400, 150, 1, ['S', 'M']);
    cradle(parts, berths, 'L1', -700, 220);
    return { parts, berths };
  },
  // A spin ring 900 m across on a despun hub; the docking spine runs along the hub
  'hygiea-ring'() {
    const parts = [], berths = [];
    parts.push(ring(0, 450, 60, 40, 24));
    parts.push(box(-60, 60, -60, 60, 'hab', { h: 120 }));
    spine(parts, berths, 'H', 0, 80, 560, 96, ['S', 'M']);
    return { parts, berths };
  },
  // Tycho builds the Belt's ships: two long construction bays either side of the works
  'tycho-station'() {
    const parts = [], berths = [];
    parts.push(box(-300, 300, -300, 300, 'hab', { h: 500 }));
    // (the ring turns behind the hub, out of the way of the trusses to the bays)
    parts.push(box(-70, 70, -420, -300, 'hab', { h: 140 }));
    parts.push(ring(0, 700, 80, 50, 28, -380));
    for (const s of [-1, 1]) {
      parts.push(box(s > 0 ? 300 : -2100, s > 0 ? 2100 : -300, -20, 20, 'truss', { h: 40 }));
      parts.push(box(s > 0 ? 900 : -1900, s > 0 ? 1900 : -900, -260, 260, 'yard', { h: 400 }));
    }
    spine(parts, berths, 'T', 0, 320, 1500, 130, ['S', 'M']);
    cradle(parts, berths, 'L1', -1200, 300);
    berths[berths.length - 1].x = -45; berths[berths.length - 1].face = 'x-';
    return { parts, berths };
  },
  // Earth's yards: a 5 km truss with dry docks, the UNN berths at the far end
  'luna-yards'() {
    const parts = [], berths = [];
    parts.push(box(-30, 30, -2600, 2600, 'truss', { h: 60 }));
    for (let i = 0; i < 4; i++) parts.push(box(-320, -40, -2200 + i * 1100, -1500 + i * 1100, 'yard', { h: 360 }));
    parts.push(box(40, 260, -400, 400, 'hab', { h: 300 }));
    parts.push(box(40, 120, 600, 1000, 'machinery', { h: 160 }));
    for (const s of [-1, 1]) parts.push(box(260, 420, s * 320 - 80, s * 320 + 80, 'radiator', { h: 12 }));
    // (the berths stand a kilometre off the truss on a boom, so both sides of the spine have a way in)
    parts.push(box(30, 1185, 1060, 1100, 'truss', { h: 40 }));
    spine(parts, berths, 'Y', 1200, 1100, 2500, 140, ['S', 'M']);
    berths.push({ id: 'N1', label: 'Naval cradle N1', x: -330, y: 2400, z: 0, face: 'x-', accepts: ['L', 'M'], up: 'y+', kind: 'cradle' });
    berths.push({ id: 'N2', label: 'Naval cradle N2', x: -330, y: -2450, z: 0, face: 'x-', accepts: ['L', 'M'], up: 'y+', kind: 'cradle' });
    return { parts, berths };
  },
  // The MCRN's yard, dug into Phobos: cradles on the field, strangers watched
  'phobos-yard'() {
    const parts = [], berths = [];
    parts.push(box(-60, 0, -1800, 1800, 'ground-works', { h: 1200 }));
    for (let i = 0; i < 3; i++) parts.push(box(0, 140, -1500 + i * 1100, -900 + i * 1100, 'yard', { h: 300 }));
    parts.push(box(0, 50, -200, 200, 'command', { h: 240, tag: 'control' }));
    gantry(parts, berths, 'A', -650, 200, 2, ['S', 'M']);
    gantry(parts, berths, 'B', 1550, 200, 2, ['S', 'M']);
    cradle(parts, berths, 'N1', 450, 260);
    cradle(parts, berths, 'N2', -1660, 260);
    return { parts, berths };
  },
  // Ganymede's transfer station: everything grown below comes up through here
  'ganymede-station'() {
    const parts = [], berths = [];
    parts.push(box(-200, 200, -200, 200, 'hab', { h: 300 }));
    parts.push(ring(0, 550, 70, 45, 24));
    parts.push(box(-20, 20, -1600, 1600, 'truss', { h: 40 }));
    for (const s of [-1, 1]) parts.push(box(-500, 500, s * 1500 - 50, s * 1500 + 50, 'cargo', { h: 200 }));
    spine(parts, berths, 'G', 0, 220, 1400, 120, ['S', 'M']);
    cradle(parts, berths, 'L1', -1500, 300);
    berths[berths.length - 1].x = -545; berths[berths.length - 1].face = 'x-';
    return { parts, berths };
  },
};

/**
 * What each station is. site: 'surface' (on the body at its radius, turning
 * with it) or 'orbit' (rKm from the body's centre, Keplerian). defense: the
 * station's guns (combatants.js); structure in damage points; population
 * (the people a crime against it endangers).
 */
export const STATIONS = {
  'ceres-station': {
    site: 'surface', body: 'Ceres', phase: 0.6, kind: 'Surface port', gateKm: 100, anchorKm: 400,
    population: 1_800_000, services: ['fuel', 'market', 'repair', 'arms', 'hiring', 'leave'],
    defense: { tl: 2, pdc: 16, tubes: 4, magazine: { he: 24, nuke: 0 }, railgun: 0, armor: 4, hp: 24_000 },
  },
  'pallas-station': {
    site: 'surface', body: 'Pallas', phase: 0.4, kind: 'Refinery port', gateKm: 60, anchorKm: 250,
    population: 240_000, services: ['fuel', 'market', 'repair', 'arms', 'hiring', 'leave'],
    defense: { tl: 1, pdc: 8, tubes: 2, magazine: { he: 10, nuke: 0 }, railgun: 0, armor: 3, hp: 12_000 },
  },
  'vesta-depot': {
    site: 'surface', body: 'Vesta', phase: 2.6, kind: 'Mining depot', gateKm: 50, anchorKm: 250,
    population: 30_000, services: ['fuel', 'market', 'repair', 'arms', 'hiring', 'leave'],
    defense: { tl: 2, pdc: 6, tubes: 0, magazine: null, railgun: 0, armor: 2, hp: 6_000 },
  },
  'hygiea-ring': {
    site: 'orbit', body: 'Hygiea', rKm: 2_000, phase: 5.7, kind: 'Ring station', gateKm: 50, anchorKm: 300,
    population: 45_000, services: ['fuel', 'market', 'repair', 'arms', 'hiring', 'leave'],
    defense: { tl: 1, pdc: 6, tubes: 2, magazine: { he: 8, nuke: 0 }, railgun: 0, armor: 2, hp: 8_000 },
  },
  'tycho-station': {
    site: 'orbit', body: 'Juno', rKm: 1_500, phase: 1.1, kind: 'Construction platform', gateKm: 80, anchorKm: 300,
    population: 130_000, services: ['fuel', 'market', 'repair', 'yard', 'arms', 'hiring', 'leave'],
    defense: { tl: 2, pdc: 12, tubes: 4, magazine: { he: 16, nuke: 4 }, railgun: 0, armor: 3, hp: 18_000 },
  },
  'luna-yards': {
    site: 'orbit', body: 'Luna', rKm: 6_000, phase: 0.2, kind: 'Orbital shipyard', gateKm: 100, anchorKm: 600,
    population: 300_000, services: ['fuel', 'market', 'repair', 'yard', 'arms', 'hiring', 'leave'],
    defense: { tl: 3, pdc: 30, tubes: 8, magazine: { he: 40, nuke: 16 }, railgun: 2, armor: 5, hp: 40_000 },
  },
  'phobos-yard': {
    site: 'surface', body: 'Phobos', phase: 3.0, kind: 'Naval yard', gateKm: 60, anchorKm: 40, military: true,
    population: 60_000, services: ['fuel', 'repair', 'yard', 'arms'],
    defense: { tl: 4, pdc: 24, tubes: 8, magazine: { he: 24, nuke: 24 }, railgun: 4, armor: 6, hp: 30_000 },
  },
  'ganymede-station': {
    site: 'orbit', body: 'Ganymede', rKm: 10_000, phase: 4.2, kind: 'Transfer station', gateKm: 80, anchorKm: 500,
    population: 210_000, services: ['fuel', 'market', 'repair', 'arms', 'hiring', 'leave'],
    defense: { tl: 2, pdc: 10, tubes: 2, magazine: { he: 10, nuke: 0 }, railgun: 0, armor: 3, hp: 16_000 },
  },
};

const _models = new Map();

/** A station's physical model (cached): parts, berths, size. */
export function stationModel(id) {
  let m = _models.get(id);
  if (m) return m;
  const spec = STATIONS[id];
  if (!spec) return null;
  const { parts, berths } = LAYOUTS[id]();
  const ext = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const p of parts) {
    const e = p.k === 'ring' ? { x0: p.x - p.r - p.d, x1: p.x + p.r + p.d, y0: p.y - p.w / 2, y1: p.y + p.w / 2 } : p.k === 'cyl' ? { x0: p.x0, x1: p.x1, y0: p.y - p.r, y1: p.y + p.r } : p;
    ext.x0 = Math.min(ext.x0, e.x0); ext.x1 = Math.max(ext.x1, e.x1); ext.y0 = Math.min(ext.y0, e.y0); ext.y1 = Math.max(ext.y1, e.y1);
  }
  m = { id, ...spec, parts, berths, bounds: ext, sizeM: Math.max(ext.x1 - ext.x0, ext.y1 - ext.y0) };
  _models.set(id, m);
  return m;
}

/** The rails orbit a station rides: on the surface at the body's radius, or on its Keplerian orbit. */
export function stationOrbit(id) {
  const s = STATIONS[id];
  const b = getBody(s.body);
  if (s.site === 'surface') return { body: s.body, r: b.radius / AU_KM, phase: s.phase, period: b.rotH / 24 };
  return { body: s.body, r: s.rKm / AU_KM, phase: s.phase, period: KEPLER(s.body, s.rKm) };
}

/** The approach gate rides straight up from the station, turning with it. */
export function gateOrbit(id) {
  const o = stationOrbit(id);
  return { ...o, r: o.r + STATIONS[id].gateKm / AU_KM };
}

/** A parking orbit at the anchorage, round the station's body (Keplerian: anchored ships drift round). */
export function anchorageOrbit(id, phase) {
  const s = STATIONS[id];
  const b = getBody(s.body);
  const rKm = (s.site === 'surface' ? b.radius : s.rKm) + s.anchorKm;
  return { body: s.body, r: rKm / AU_KM, phase, period: KEPLER(s.body, rKm) };
}

export const gateId = (stationId) => `${stationId}-gate`;

// ---- FRAME ----

/** The angle of a station round its body at `minute` (its frame's x axis in the solar frame). */
export function stationAngle(orbit, minute) {
  return orbit.phase + (orbit.period > 0 ? TWO_PI * (minute / DAY_MIN) / orbit.period : 0);
}

const FACE2 = { 'x+': [1, 0], 'x-': [-1, 0], 'y+': [0, 1], 'y-': [0, -1] };

/**
 * Where a berth is at `minute`, in the solar frame: pos (AU), vel (m/s),
 * the outward normal of its collar and its up (unit vectors), and the
 * station's angle. The velocity includes the frame's turn (ω × r).
 */
export function berthPose(state, station, berth, minute = state.clock.minute) {
  const o = station.orbit;
  const pos = { x: 0, y: 0 }, vel = { vx: 0, vy: 0 };
  orbitStateAt(o, minute, pos, vel);
  const th = stationAngle(o, minute);
  const c = Math.cos(th), s = Math.sin(th);
  const rx = berth.x * c - berth.y * s, ry = berth.x * s + berth.y * c;     // metres, solar frame
  const w = o.period > 0 ? TWO_PI / (o.period * 86400) : 0;
  const n = FACE2[berth.face], u = FACE2[berth.up];
  return {
    pos: { x: pos.x + rx / AU_M, y: pos.y + ry / AU_M },
    vel: { vx: vel.vx - w * ry, vy: vel.vy + w * rx },
    normal: { x: n[0] * c - n[1] * s, y: n[0] * s + n[1] * c },
    up: { x: u[0] * c - u[1] * s, y: u[0] * s + u[1] * c },
    angle: th, omega: w,
  };
}

// ---- BERTHS ----

/** Berth table for a station entity (lazily created; plain data in the save). */
function berthTable(e) {
  return (e.berths ||= {});
}

/** Who is in a berth right now (null if free; a stale claim is cleared). */
export function berthOccupant(world, st, berthId) {
  const t = berthTable(st);
  const id = t[berthId];
  if (!id) return null;
  if (id === 'player') return id;
  const o = world.get(id);
  if (o && o.tags?.berth === berthId && o.tags?.at === st.id) return id;
  delete t[berthId];
  if (st.$bh) st.$bh.used--;
  return null;
}

// A busy port is asked for a berth by every ship waiting its turn, and is
// full more often than not: how many of its berths are taken is kept at
// runtime (st.$bh), counted as claims come and go, counted afresh (stale
// claims cleared) once a game hour.
const BERTH_CHECK_MIN = 60;
function berthsUsed(world, st, m, now) {
  let h = st.$bh;
  if (!h || now - h.at >= BERTH_CHECK_MIN || now < h.at) {
    let used = 0;
    for (const b of m.berths) if (berthOccupant(world, st, b.id)) used++;
    h = st.$bh = { used, at: now };
  }
  return h.used;
}

/** Does a berth take this collar size? */
export const berthFits = (berth, size) => berth.accepts.includes(size);

// ---- WHAT FITS WHERE ----
// A hull in a berth lies where its collar puts it: along the berth's `up`,
// its collar on the arm's tip. A berth takes a collar by its size, but a
// long hull at the foot of a tower is in the ground, and one by the hub is
// in the hub; so a berth only ever takes a hull that clears the station
// there (berthClear: its parts against the station's, once per hull and
// berth, and kept), and none is given a berth its neighbour's hull is lying
// across (berthsClash). Every berth lies square to the station's frame, so
// these are plain boxes in it. A hull with no clear berth at a port rides the
// anchorage and works by tender, as a capital ship does.

const _solids = new Map(), _docked = new WeakMap(), _clear = new WeakMap();

/** What is solid of a station, as boxes [x0, x1, y0, y1, z0, z1] in its frame (a ring and its spokes: the slab they turn in). */
function solidsOf(id) {
  let list = _solids.get(id);
  if (list) return list;
  list = stationModel(id).parts.map(p => {
    if (p.k === 'ring') { const R = p.r + p.d; return [p.x - R, p.x + R, p.y - p.w / 2, p.y + p.w / 2, -R, R]; }
    if (p.k === 'cyl') return [p.x0, p.x1, p.y - p.r, p.y + p.r, -p.r, p.r];
    return [p.x0, p.x1, p.y0, p.y1, p.z0, p.z1];
  });
  _solids.set(id, list);
  return list;
}

/** A class's hull lying in a berth: { parts, all } as boxes in the station's frame, or null if no collar of it fits. */
function dockedBoxes(classId, berth) {
  let byClass = _docked.get(berth);
  if (!byClass) _docked.set(berth, byClass = new Map());
  if (byClass.has(classId)) return byClass.get(classId);
  const port = collarFor(classId, berth);
  let out = null;
  if (port) {
    const n = FACE2[berth.face], u = FACE2[berth.up];
    const R = mateRotation(port.face, { x: n[0], y: n[1] }, { x: u[0], y: u[1] });
    const c = turn(R, [port.x, port.y, port.z]);
    const parts = hullOf(classId).parts.map(q => {
      const e = partExtent(q), a = turn(R, [e.x0, e.y0, e.z0]), b = turn(R, [e.x1, e.y1, e.z1]);
      return [Math.min(a[0], b[0]) + berth.x - c[0], Math.max(a[0], b[0]) + berth.x - c[0], Math.min(a[1], b[1]) + berth.y - c[1], Math.max(a[1], b[1]) + berth.y - c[1], Math.min(a[2], b[2]) + berth.z - c[2], Math.max(a[2], b[2]) + berth.z - c[2]];
    });
    const all = parts.reduce((s, b) => [Math.min(s[0], b[0]), Math.max(s[1], b[1]), Math.min(s[2], b[2]), Math.max(s[3], b[3]), Math.min(s[4], b[4]), Math.max(s[5], b[5])], [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]);
    out = { parts, all };
  }
  byClass.set(classId, out);
  return out;
}

const boxesMeet = (a, b) => a[0] < b[1] - TOUCH_M && b[0] < a[1] - TOUCH_M && a[2] < b[3] - TOUCH_M && b[2] < a[3] - TOUCH_M && a[4] < b[5] - TOUCH_M && b[4] < a[5] - TOUCH_M;

/** Does a class's hull, lying in this berth of station `id`, clear the station? */
export function berthClear(id, berth, classId) {
  let byClass = _clear.get(berth);
  if (!byClass) _clear.set(berth, byClass = new Map());
  let ok = byClass.get(classId);
  if (ok === undefined) {
    const h = dockedBoxes(classId, berth);
    ok = !!h && !solidsOf(id).some(s => boxesMeet(h.all, s) && h.parts.some(q => boxesMeet(q, s))) && corridorRun(id, berth, h) >= CORRIDOR_MIN_M;
    byClass.set(classId, ok);
  }
  return ok;
}

/** Would two hulls lying in two berths of a station lie across each other? */
export function berthsClash(berthA, classA, berthB, classB) {
  const a = dockedBoxes(classA, berthA), b = dockedBoxes(classB, berthB);
  return !!a && !!b && boxesMeet(a.all, b.all);
}

/** How far a hull lying as `h` lies could back straight out along its collar's axis before it met anything (m). */
function corridorRun(id, berth, h) {
  const n = FACE2[berth.face], na = n[0] ? 0 : 2, ua = n[0] ? 2 : 0, out = n[0] || n[1];
  const tip = n[0] ? berth.x : berth.y;
  let run = Infinity;
  for (const s of solidsOf(id)) {
    // (ahead of the collar, across the hull's own width and height)
    const n0 = out > 0 ? s[na] - tip : tip - s[na + 1], n1 = out > 0 ? s[na + 1] - tip : tip - s[na];
    if (n1 <= 1 || s[ua] > h.all[ua + 1] + 10 || s[ua + 1] < h.all[ua] - 10 || s[4] > h.all[5] || s[5] < h.all[4]) continue;
    run = Math.min(run, Math.max(0, n0));
  }
  return run;
}

/**
 * How far out a class's corridor to a berth starts (m): a kilometre if its
 * collar's axis is clear that far, else half what is clear (the mouth
 * stands off what it ran up against, and a hull can come down to it).
 */
export function corridorOf(id, berth, classId) {
  const h = dockedBoxes(classId, berth);
  if (!h) return CORRIDOR_M;
  const run = corridorRun(id, berth, h);
  return run >= CORRIDOR_M + 60 ? CORRIDOR_M : Math.max(CORRIDOR_MIN_M, run / 2);
}

/** Does the line from p to q cross a rectangle [x0, x1, y0, y1]? */
function lineMeets(p, q, r) {
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[p.x, q.x - p.x, r[0], r[1]], [p.y, q.y - p.y, r[2], r[3]]]) {
    if (Math.abs(d) < 1e-9) { if (o <= lo || o >= hi) return false; continue; }
    const a = (lo - o) / d, b = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    if (t0 >= t1) return false;
  }
  return true;
}

/** How far a point lies outside a rectangle (0 inside it). */
const offBox = (p, r) => Math.hypot(Math.max(r[0] - p.x, 0, p.x - r[1]), Math.max(r[2] - p.y, 0, p.y - r[3]));

/**
 * The way from `a` to `b` in a station's frame round what stands in the
 * plane, for a hull `lengthM` long: the points to fly by, b last. Each
 * solid is grown by half the hull and a margin (less, if that would take in
 * `a` or `b`; one they are in can only be left, and isn't counted), and
 * the shortest way runs from corner to corner of them. With no way, the
 * straight line. A flight's work, once, not a minute's.
 */
export function wayRound(id, a, b, lengthM) {
  const grow = lengthM / 2 + WAY_CLEAR_M, boxes = [];
  for (const s of solidsOf(id)) {
    if (s[4] > WAY_Z_M || s[5] < -WAY_Z_M) continue;
    const r = [s[0], s[1], s[2], s[3]], g = Math.min(grow, offBox(a, r) - 1, offBox(b, r) - 1);
    if (g > 0) boxes.push([r[0] - g, r[1] + g, r[2] - g, r[3] + g]);
  }
  const clear = (p, q) => !boxes.some(r => lineMeets(p, q, r));
  if (clear(a, b)) return [b];
  const nodes = [a, b];
  for (const r of boxes) for (const x of [r[0], r[1]]) for (const y of [r[2], r[3]]) {
    const p = { x, y };
    if (!boxes.some(q => offBox(p, q) === 0 && !(x === q[0] || x === q[1] || y === q[2] || y === q[3]))) nodes.push(p);
  }
  // Dijkstra over who sees whom, from a
  const dist = nodes.map((_, i) => (i ? Infinity : 0)), from = nodes.map(() => -1), done = nodes.map(() => false);
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v]) continue;
      const w = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
      if (w < dist[v] && clear(nodes[u], nodes[v])) { dist[v] = w; from[v] = u; }
    }
  }
  if (from[1] < 0) return [b];
  const way = [];
  for (let i = 1; i > 0; i = from[i]) way.unshift(nodes[i]);
  return way;
}

/** Our hull's class, or a hull's, from who holds a berth. */
const occupantClass = (world, who) => who === 'player' ? world.state.ship?.classId || PLAYER_CLASS : world.get(who)?.cls;

/**
 * A free berth for a hull of class `classId`, its collars of `sizes`, or
 * null: one that takes its collar, that it clears (berthClear), with no
 * neighbour's hull across it. Traffic can't take the reserved share
 * (`reserve`): those are for arrivals traffic control has cleared.
 */
export function freeBerth(state, st, classId, { reserve = false, sizes = berthSizesFor(classId) } = {}) {
  const m = stationModel(st.id);
  if (!m || st.combat?.docks === 0) return null;
  const world = getWorld(state);
  // (the reserve is a share of the whole port: a lone cargo cradle isn't held back from bulk traffic)
  if (reserve && berthsUsed(world, st, m, state.clock.minute) >= Math.floor(m.berths.length * (1 - RESERVE))) return null;
  const taken = [];
  for (const b of m.berths) { const who = berthOccupant(world, st, b.id); if (who) taken.push({ b, cls: occupantClass(world, who) }); }
  // the smallest berth that fits, so a cradle stays free for a bulk hull
  return m.berths.filter(b => sizes.some(sz => berthFits(b, sz)) && !taken.some(t => t.b === b) && berthClear(st.id, b, classId))
    .sort((a, b) => a.accepts.length - b.accepts.length || (a.accepts.includes('L') ? 1 : 0) - (b.accepts.includes('L') ? 1 : 0))
    .find(b => !taken.some(t => berthsClash(b, classId, t.b, t.cls))) || null;
}

export function claimBerth(st, berthId, who) {
  const t = berthTable(st);
  if (!t[berthId] && st.$bh) st.$bh.used++;
  t[berthId] = who;
}

/** A berth come free at a station: traffic.js calls down a ship waiting for one (set when it loads). */
export const BERTH_FREED = { fn: null };

/** Let a berth go (`world` given: the port calls down whoever is waiting for one). */
export function releaseBerth(st, berthId, who = null, world = null) {
  const t = berthTable(st);
  if (t[berthId] && (who == null || t[berthId] === who)) {
    delete t[berthId];
    if (st.$bh) st.$bh.used--;
    if (world) BERTH_FREED.fn?.(world, st);
  }
}

/**
 * Hold a berth for a hull coming down to it from the gate or the pattern
 * (its claim, kept while it flies in: one free berth isn't sent every ship
 * waiting for one, all but the first to turn back at its collar).
 */
export function holdBerth(st, berthId, e) {
  claimBerth(st, berthId, e.id);
  e.tags.berth = berthId;
  e.tags.at = st.id;
}

/** How many berths are taken, of how many (for traffic control and the UI). */
export function berthCounts(state, st) {
  const m = stationModel(st.id);
  if (!m) return { used: 0, total: 0 };
  const world = getWorld(state);
  return { used: m.berths.filter(b => berthOccupant(world, st, b.id)).length, total: m.berths.length };
}

/** A berth of a station by id. */
export const berthOf = (stationId, berthId) => stationModel(stationId)?.berths.find(b => b.id === berthId) || null;

/**
 * The rails orbit for a hull lying in a berth: the station's own orbit,
 * offset by where the berth is (and, for a ship latched there, where its
 * centre sits off the collar: `offM`, along the berth's normal and up).
 */
export function berthOrbit(st, berth, offM = { n: 30, u: 0 }) {
  const o = st.orbit;
  const n = FACE2[berth.face], u = FACE2[berth.up];
  const lx = berth.x + n[0] * offM.n + u[0] * offM.u, ly = berth.y + n[1] * offM.n + u[1] * offM.u;
  const rM = o.r * AU_M;
  // polar offset in the station frame: x is radial, y along the turn
  return { body: o.body, r: Math.hypot(rM + lx, ly) / AU_M, phase: o.phase + Math.atan2(ly, rM + lx), period: o.period };
}

// ---- PARKING HULLS ON RAILS ----
// Traffic and the navies berth on rails: a hull in a berth rides the
// station's orbit at the berth (its centre where its collar meets the
// arm), a hull that found none rides the anchorage.

/**
 * Collar sizes a hull can berth by: small and medium hulls at the arms, a
 * large one in a cargo cradle by its L collar. Capital ships (and bulk
 * hulls without an L collar) ride at the anchorage and work cargo by tender.
 */
export function berthSizesFor(classId) {
  const c = CLASSES[classId];
  if (!c || c.size === 'XL') return [];
  const sizes = [...new Set((hullOf(classId)?.ports || []).map(p => p.size))];
  return c.size === 'L' ? sizes.filter(z => z === 'L') : sizes.filter(z => z !== 'L');
}

/** The collar of a class that mates with a berth: a flank crew collar if one fits (ships hang by their flanks), else a flank one, else any that fits. */
export function collarFor(classId, berth) {
  const ports = (hullOf(classId)?.ports || []).filter(p => berthFits(berth, p.size));
  return ports.find(p => p.use === 'crew' && p.face !== 'x+') || ports.find(p => p.face !== 'x+') || ports[0] || null;
}

/**
 * Put a hull on rails at a station: into a free berth (traffic leaves the
 * reserve alone), else at the anchorage. Returns the berth id or null.
 */
export function parkHull(state, e, st, { reserve = true } = {}) {
  releaseHull(getWorld(state), e);
  const b = freeBerth(state, st, e.cls, { reserve });
  e.transit = null;
  e.thrust = 0;
  e.tags.at = st.id;
  const port = b && collarFor(e.cls, b);
  if (b && port) {
    claimBerth(st, b.id, e.id);
    e.tags.berth = b.id;
    const local = { pos: { x: 0, y: 0 }, normal: vec(b.face), up: vec(b.up) };
    e.orbit = berthOrbit(st, b, mateOffset(local, port));
    return b.id;
  }
  e.tags.berth = null;
  e.orbit = anchorageOrbit(st.id, random() * TWO_PI);
  return null;
}

/**
 * On load: hulls lying in berths where they were saved. A port's layout can
 * change under a save (1.12.12 moved Luna's berths and others): a hull is
 * put back on its berth as it now is, and one that no longer clears it
 * goes where it can.
 */
export function refitBerths(state) {
  const world = getWorld(state);
  for (const st of world.stations) {
    const m = stationModel(st.id);
    if (!m) continue;
    for (const b of m.berths) {
      const id = berthOccupant(world, st, b.id), e = id && id !== 'player' ? world.get(id) : null;
      if (!e?.orbit || e.transit) continue;                  // (one still coming down to it flies to where it is now)
      const port = collarFor(e.cls, b);
      if (!port || !berthClear(st.id, b, e.cls)) { parkHull(state, e, st); continue; }
      e.orbit = berthOrbit(st, b, mateOffset({ pos: { x: 0, y: 0 }, normal: vec(b.face), up: vec(b.up) }, port));
    }
  }
}

/** Into the berth held for it, or a free one (traffic leaves the reserve alone): the berth id, or null with nothing changed. */
export function berthInto(state, e, st) {
  const held = e.tags.berth && e.tags.at === st.id && berthTable(st)[e.tags.berth] === e.id ? berthOf(st.id, e.tags.berth) : null;
  const b = held || freeBerth(state, st, e.cls, { reserve: true });
  const port = b && collarFor(e.cls, b);
  if (!port) return null;
  if (!held) releaseHull(getWorld(state), e);      // (its own berth, held while it came down, is kept: nobody called down for it)
  e.transit = null;
  e.thrust = 0;
  e.tags.at = st.id;
  claimBerth(st, b.id, e.id);
  e.tags.berth = b.id;
  const local = { pos: { x: 0, y: 0 }, normal: vec(b.face), up: vec(b.up) };
  e.orbit = berthOrbit(st, b, mateOffset(local, port));
  return b.id;
}

/** A hull leaving: its berth (or holding slot) is free again. */
export function releaseHull(world, e) {
  const st = e.tags?.at && world.get(e.tags.at);
  if (st && e.tags.berth) releaseBerth(st, e.tags.berth, e.id, world);
  // …and a holding slot (holding.js) likewise
  if (st && e.tags.slot) releaseSlot(st, e.tags.slot, e.id);
  if (e.tags) { e.tags.berth = null; e.tags.slot = null; }
}

const vec = (face) => ({ x: FACE2[face][0], y: FACE2[face][1] });

/** A berth's collar frame in the solar frame at `minute` (mating.js). */
export function berthFrame(state, st, berth, minute = state.clock.minute) {
  const p = berthPose(state, st, berth, minute);
  return { pos: p.pos, normal: p.normal, up: p.up, vel: p.vel, angle: p.angle, omega: p.omega };
}
