// ============================================================
// LONGHAUL — Multispectrum sensors
// Three range bands with different physics: short range sees
// everything; radar sees big or loud things; telescopes at long range
// only see drive plumes and active transmitters. Tracking a contact
// over time reveals more about it; a ranging-laser lock is 3× faster.
// ============================================================

import { RANGE } from '../core/constants.js';
import { getWorld } from './world.js';

export const SENSOR_RANGES = [
  { name: 'SHORT', au: RANGE.SHORT, label: '~150k km', description: 'All sensors — thermal, EM, lidar' },
  { name: 'MED', au: RANGE.MEDIUM, label: '~1.5M km', description: 'Multi-band radar' },
  { name: 'LONG', au: RANGE.LONG, label: '~15M km', description: 'Telescopes — drive plumes & beacons' },
];

export const REVEAL = { VELOCITY: 5, HEADING: 10, THRUST: 15, MASS: 30, PROFILE: 60 };

export function createSensors() {
  return { range: 0, selected: null, locked: null, scan: {}, contacts: [] };
}

function detectable(e, distAU) {
  if (e.type === 'nav') return false;
  if (distAU <= RANGE.SHORT) return true;
  if (distAU <= RANGE.MEDIUM) return e.transponder || e.type === 'station' || e.thrust > 0 || e.sos || e.mass > 50_000;
  return e.thrust > 0 || e.transponder || e.sos;
}

const _q = [];

export function sensorsTick(state) {
  const s = state.sensors;
  const world = getWorld(state);
  const pos = state.flight.pos;
  const rangeAU = SENSOR_RANGES[s.range].au;
  _q.length = 0;
  world.query(pos, rangeAU, _q);

  const contacts = [];
  const seen = new Set();
  for (const e of _q) {
    const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (!detectable(e, dist)) continue;
    seen.add(e.id);
    s.scan[e.id] = (s.scan[e.id] || 0) + (s.locked === e.id ? 3 : 1);
    contacts.push(describe(e, dist, Math.atan2(dy, dx), s.scan[e.id]));
  }
  for (const id of Object.keys(s.scan)) {
    if (seen.has(id)) continue;
    s.scan[id] -= 2;
    if (s.scan[id] <= 0) delete s.scan[id];
  }
  s.contacts = contacts;
  if (s.locked && !seen.has(s.locked)) s.locked = null;
  if (s.selected && !seen.has(s.selected)) s.selected = null;
}

/** What the crew knows about an entity after `scan` minutes of observation. */
export function describe(e, dist, bearing, scan) {
  const known = e.transponder || scan >= REVEAL.PROFILE;
  return {
    id: e.id,
    dist,                      // AU
    bearing,                   // rad, solar frame
    name: known ? e.name : null,
    type: known ? e.type : null,
    faction: known ? e.faction : null,
    shipClass: known ? e.shipClass : null,
    signature: e.thrust > 0 ? e.signature : null,
    plume: e.thrust > 0,
    sos: e.sos,
    station: e.type === 'station',
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
