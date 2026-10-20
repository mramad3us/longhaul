// ============================================================
// LONGHAUL — Multispectrum sensors
//
// One detection model for everybody — the player's ops board, NPC
// ships, torpedo seekers. A target has a *signature range*: how far
// away a standard sensor suite can hold it.
//
//   broadcasting (transponder, distress beacon) — heard at long range
//   drive lit — the plume is the brightest thing for millions of km
//   cold and silent — radar/thermal only, by hull size, cut by stealth
//   ordnance — a coasting torpedo is a few meters of cold metal
//
// An observer sees a target when it is inside the signature range
// times the observer's sensor quality (tech level, damage, a watch
// stander at ops). The player's display band caps how far the board
// looks. Tracking a contact over time reveals more about it; a
// ranging-laser lock is 3× faster.
//
// Everything on the board is under a light-minute away (long range is
// 50 light-seconds), so the picture is live to within one sim step;
// each contact carries its light time. Beyond the board, what we know
// is reported and aged: intel.js.
// ============================================================

import { RANGE, AU_M } from '../core/constants.js';
import { getWorld } from './world.js';
import { sensorRangeFactor } from './systems.js';
import { CLASSES, SIZES, TECH, classOf, classLabel, PLAYER_CLASS } from './ship-classes.js';

export const SENSOR_RANGES = [
  { name: 'SHORT', au: RANGE.SHORT, label: '~150k km', description: 'All sensors — thermal, EM, lidar' },
  { name: 'MED', au: RANGE.MEDIUM, label: '~1.5M km', description: 'Multi-band radar' },
  { name: 'LONG', au: RANGE.LONG, label: '~15M km', description: 'Telescopes — drive plumes & beacons' },
];

export const REVEAL = { VELOCITY: 5, HEADING: 10, THRUST: 15, MASS: 30, PROFILE: 60 };

export const TORPEDO_RADAR_AU = 0.0002;    // a coasting torpedo: ~30,000 km
export const SLUG_RADAR_AU = 0.00003;      // a railgun slug: ~4,500 km
export const SEEKER_QUALITY = 0.3;         // a torpedo's own seeker vs a ship's sensor suite

export function createSensors() {
  return { range: 0, selected: null, locked: null, scan: {}, contacts: [] };
}

/** Size class of a hull with no catalog class (old saves, contract hulks). */
export function sizeForMass(massT = 0) {
  return massT < 1500 ? 'S' : massT < 20_000 ? 'M' : massT < 100_000 ? 'L' : 'XL';
}

/** How far (AU) a quality-1 sensor holds this entity. */
export function signatureRange(e) {
  if (e.type === 'nav') return 0;
  if (e.type === 'station') return RANGE.LONG * 2;
  if (e.type === 'ordnance') {
    if (e.thrust > 0) return RANGE.LONG * 0.5;
    return e.ord?.kind === 'slug' ? SLUG_RADAR_AU : TORPEDO_RADAR_AU;
  }
  if (e.sos || e.transponder || e.thrust > 0) return RANGE.LONG;
  const size = SIZES[classOf(e)?.size || sizeForMass(e.mass)];
  return size.radarAU * TECH[e.tl || 2].stealth;
}

/** The player's own signature range (what NPCs and seekers can see of us). */
export function playerSignatureRange(state) {
  const f = state.flight;
  if (state.comms.transponder || state.comms.sos) return RANGE.LONG;
  if (f.thrustG > 0.01 || state.$jinkG > 0) return RANGE.LONG;
  const c = CLASSES[state.ship.classId || PLAYER_CLASS];
  return SIZES[c.size].radarAU * TECH[state.ship.tl || 2].stealth;
}

/** The player's sensor quality right now (condition, an ops watch, tech level). */
export function playerSensorQuality(state) {
  const ops = state.$watch?.ops != null;
  return sensorRangeFactor(state) * (ops ? 1.25 : 1) * TECH[state.ship.tl || 2].sensors;
}

/** Can an observer of `quality` see something with signature `sigAU` at `distAU`? */
export const canSee = (distAU, sigAU, quality) => distAU <= sigAU * quality;

const _q = [];

export function sensorsTick(state) {
  const s = state.sensors;
  const world = getWorld(state);
  const pos = state.flight.pos;
  const quality = playerSensorQuality(state);
  const rate = state.$watch?.ops != null ? 2 : 1;
  _q.length = 0;
  world.query(pos, SENSOR_RANGES[s.range].au, _q);

  const contacts = [];
  const seen = new Set();
  for (const e of _q) {
    const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (!canSee(dist, signatureRange(e), quality)) continue;
    seen.add(e.id);
    s.scan[e.id] = (s.scan[e.id] || 0) + (s.locked === e.id ? 3 : 1) * rate;
    contacts.push(describe(e, dist, Math.atan2(dy, dx), s.scan[e.id]));
  }
  for (const id of Object.keys(s.scan)) {
    if (seen.has(id)) continue;
    s.scan[id] -= 2;
    if (s.scan[id] <= 0) delete s.scan[id];
  }
  // Contacts that just dropped off the board (intel.js keeps their last fix)
  const lost = [];
  for (const c of s.contacts) if (!seen.has(c.id)) lost.push(c);
  s.$lost = lost;
  s.contacts = contacts;
  s.$seen = seen;
  if (s.locked && !seen.has(s.locked)) s.locked = null;
  if (s.selected && !seen.has(s.selected)) s.selected = null;
}

/** Is this entity on our sensors right now? */
export const isTracked = (state, id) => !!state.sensors.$seen?.has(id) || state.sensors.contacts.some(c => c.id === id);

/** What the crew knows about an entity after `scan` minutes of observation. */
export function describe(e, dist, bearing, scan) {
  const ordnance = e.type === 'ordnance';
  const known = !ordnance && (e.transponder || scan >= REVEAL.PROFILE);
  return {
    id: e.id,
    dist,                      // AU
    lagS: dist * AU_M / 299_792_458,   // light time: how old the picture of it is, seconds
    bearing,                   // rad, solar frame
    name: ordnance ? (e.ord?.kind === 'slug' ? 'SLUG' : 'TORPEDO') : known ? e.name : null,
    type: ordnance ? 'ordnance' : known ? e.type : null,
    ordnance,
    faction: known ? e.faction : null,
    shipClass: known ? classLabel(e) : null,
    tl: known && e.tl ? e.tl : null,
    signature: e.thrust > 0 ? e.signature : null,
    plume: e.thrust > 0,
    sos: e.sos,
    station: e.type === 'station',
    wreck: !!e.tags?.wreck,
    scan,
    velocityKnown: scan >= REVEAL.VELOCITY,
    headingKnown: scan >= REVEAL.HEADING,
    thrust: scan >= REVEAL.THRUST ? (e.thrust > 0 ? `${e.thrust.toFixed(1)}G` : 'COASTING') : null,
    mass: scan >= REVEAL.MASS ? e.mass : null,
  };
}

export function setSensorRange(state, level) {
  state.sensors.range = Math.max(0, Math.min(SENSOR_RANGES.length - 1, level));
  sensorsTick(state);
}

export function selectContact(state, id) {
  state.sensors.selected = id;
}

export function toggleLock(state, id) {
  const s = state.sensors;
  if (s.locked === id) { s.locked = null; return false; }
  s.locked = id;
  s.selected = id;
  return true;
}

export function contactById(state, id) {
  return state.sensors.contacts.find(c => c.id === id) || null;
}
