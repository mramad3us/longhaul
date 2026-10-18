// ============================================================
// LONGHAUL — Ephemeris
// Planets, moons and major asteroids on analytic circular orbits.
// This is the ONLY place body positions/velocities are computed.
// Heliocentric periods follow Kepler's third law from GM_SUN, so a
// free-flying object at a body's radius co-orbits with it exactly.
// ============================================================

import { AU_M, GM_SUN, TWO_PI } from '../core/constants.js';

const AU_KM = AU_M / 1000;

function keplerPeriodDays(aAU) {
  const a = aAU * AU_M;
  return TWO_PI * Math.sqrt(a * a * a / GM_SUN) / 86400;
}

// Raw data — distances in AU (moons: km), radii in km.
const PLANET_DATA = [
  { name: 'Mercury', a: 0.387, radius: 2_440, color: '#A0926E', initAngle: 1.2, moons: [] },
  { name: 'Venus', a: 0.723, radius: 6_052, color: '#E8CDA0', initAngle: 3.8, moons: [] },
  { name: 'Earth', a: 1.0, radius: 6_371, color: '#4A90D9', initAngle: 0.0, moons: [
    { name: 'Luna', aKm: 384_400, period: 27.32, color: '#AAAAAA', initAngle: 0 },
  ] },
  { name: 'Mars', a: 1.524, radius: 3_390, color: '#C1553B', initAngle: 4.5, moons: [
    { name: 'Phobos', aKm: 9_377, period: 0.319, color: '#888877', initAngle: 0.5 },
    { name: 'Deimos', aKm: 23_460, period: 1.263, color: '#777766', initAngle: 2.1 },
  ] },
  { name: 'Jupiter', a: 5.203, radius: 69_911, color: '#C4A882', initAngle: 2.1, moons: [
    { name: 'Io', aKm: 421_800, period: 1.769, color: '#DDAA55', initAngle: 0 },
    { name: 'Europa', aKm: 671_100, period: 3.551, color: '#AACCDD', initAngle: 1.5 },
    { name: 'Ganymede', aKm: 1_070_400, period: 7.155, color: '#999988', initAngle: 3.0 },
    { name: 'Callisto', aKm: 1_882_700, period: 16.69, color: '#666655', initAngle: 4.5 },
  ] },
  { name: 'Saturn', a: 9.537, radius: 58_232, color: '#E8D5A3', initAngle: 5.2, rings: true, moons: [
    { name: 'Mimas', aKm: 185_539, period: 0.942, color: '#BBBBBB', initAngle: 0 },
    { name: 'Enceladus', aKm: 238_042, period: 1.370, color: '#CCEEEE', initAngle: 1.0 },
    { name: 'Tethys', aKm: 294_619, period: 1.888, color: '#AAAAAA', initAngle: 2.0 },
    { name: 'Dione', aKm: 377_396, period: 2.737, color: '#999999', initAngle: 3.0 },
    { name: 'Rhea', aKm: 527_108, period: 4.518, color: '#AAAAAA', initAngle: 4.0 },
    { name: 'Titan', aKm: 1_221_870, period: 15.95, color: '#D9A54A', initAngle: 5.0 },
    { name: 'Iapetus', aKm: 3_560_820, period: 79.32, color: '#777766', initAngle: 0.5 },
  ] },
  { name: 'Uranus', a: 19.19, radius: 25_362, color: '#7EC8D9', initAngle: 0.8, moons: [] },
  { name: 'Neptune', a: 30.07, radius: 24_622, color: '#4B6EAF', initAngle: 4.0, moons: [] },
];

const ASTEROID_DATA = [
  { name: 'Ceres', a: 2.77, radius: 470, color: '#8A8A7A', initAngle: 1.0 },
  { name: 'Vesta', a: 2.36, radius: 263, color: '#9A8A6A', initAngle: 3.5 },
  { name: 'Pallas', a: 2.77, radius: 256, color: '#7A7A6A', initAngle: 5.8 },
  { name: 'Hygiea', a: 3.14, radius: 217, color: '#6A6A5A', initAngle: 0.3 },
  { name: 'Juno', a: 2.67, radius: 123, color: '#8A7A6A', initAngle: 2.2 },
  { name: 'Interamnia', a: 3.06, radius: 166, color: '#7A6A5A', initAngle: 4.1 },
];

export const SUN = { name: 'Sol', type: 'star', a: 0, period: Infinity, initAngle: 0, radius: 696_000, color: '#FDB813', parent: null, moons: [] };

/** All bodies, parents before children. */
export const BODIES = [SUN];
const BY_NAME = new Map([[SUN.name, SUN]]);

for (const p of PLANET_DATA) {
  const planet = {
    name: p.name, type: 'planet', a: p.a, period: keplerPeriodDays(p.a), initAngle: p.initAngle,
    radius: p.radius, color: p.color, rings: !!p.rings, parent: null, moons: [],
  };
  BODIES.push(planet); BY_NAME.set(planet.name, planet);
  for (const m of p.moons) {
    const moon = {
      name: m.name, type: 'moon', a: m.aKm / AU_KM, period: m.period, initAngle: m.initAngle,
      radius: 0, color: m.color, parent: planet, moons: [],
    };
    planet.moons.push(moon);
    BODIES.push(moon); BY_NAME.set(moon.name, moon);
  }
}
for (const a of ASTEROID_DATA) {
  const ast = {
    name: a.name, type: 'asteroid', a: a.a, period: keplerPeriodDays(a.a), initAngle: a.initAngle,
    radius: a.radius, color: a.color, parent: null, moons: [],
  };
  BODIES.push(ast); BY_NAME.set(ast.name, ast);
}

export const PLANETS = BODIES.filter(b => b.type === 'planet');
export const ASTEROIDS = BODIES.filter(b => b.type === 'asteroid');

export function getBody(name) {
  return BY_NAME.get(name) || null;
}

// ---- STATE VECTORS ----
// days: simulation days since game start (clock.minute / 1440)

function angleAt(body, days) {
  return body.initAngle + TWO_PI * days / body.period;
}

/** Heliocentric position in AU. Writes into `out` if given. */
export function bodyPos(body, days, out = { x: 0, y: 0 }) {
  if (!body.parent) {
    if (body.a === 0) { out.x = 0; out.y = 0; return out; }
    const th = angleAt(body, days);
    out.x = body.a * Math.cos(th);
    out.y = body.a * Math.sin(th);
    return out;
  }
  bodyPos(body.parent, days, out);
  const th = angleAt(body, days);
  out.x += body.a * Math.cos(th);
  out.y += body.a * Math.sin(th);
  return out;
}

/** Heliocentric velocity in m/s. Writes into `out` if given. */
export function bodyVel(body, days, out = { vx: 0, vy: 0 }) {
  if (body.a === 0) { out.vx = 0; out.vy = 0; return out; }
  if (body.parent) bodyVel(body.parent, days, out);
  else { out.vx = 0; out.vy = 0; }
  const th = angleAt(body, days);
  const speed = TWO_PI * body.a * AU_M / (body.period * 86400);
  out.vx += -speed * Math.sin(th);
  out.vy += speed * Math.cos(th);
  return out;
}

/** Circular orbital speed around the Sun at radius r (AU), m/s. */
export function circularSpeed(rAU) {
  return Math.sqrt(GM_SUN / (rAU * AU_M));
}

/** Solar gravitational acceleration at position (AU) → m/s² vector. */
export function solarGravity(x, y, out = { ax: 0, ay: 0 }) {
  const r2 = x * x + y * y;
  if (r2 < 1e-12) { out.ax = 0; out.ay = 0; return out; }
  const r = Math.sqrt(r2);
  const rm = r * AU_M;
  const g = GM_SUN / (rm * rm);
  out.ax = -g * x / r;
  out.ay = -g * y / r;
  return out;
}
