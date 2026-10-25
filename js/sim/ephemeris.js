// ============================================================
// LONGHAUL — Ephemeris
// Planets, moons and major asteroids on analytic circular orbits.
// This is the ONLY place body positions/velocities are computed.
// Heliocentric periods follow Kepler's third law from GM_SUN, so a
// free-flying object at a body's radius co-orbits with it exactly.
//
// Each body also carries its physical data: mean radius, rotation
// period (a station built on an asteroid's surface rides round with
// it: sim/stations.js), GM (every body pulls: gravity.js), and for the
// bodies that have one, the atmosphere (surface pressure, scale height,
// the entry interface: worlds.js makes it air). What else is known of a
// body, for its sheet, is in bodyfacts.js.
// ============================================================

import { AU_M, GM_SUN, TWO_PI } from '../core/constants.js';

const AU_KM = AU_M / 1000;

function keplerPeriodDays(aAU) {
  const a = aAU * AU_M;
  return TWO_PI * Math.sqrt(a * a * a / GM_SUN) / 86400;
}

// Raw data — distances in AU (moons: km), mean radii in km, rotation
// periods in hours (negative: retrograde; moons are tidally locked: they
// turn once per orbit), GM in km³/s², atmospheres: surface pressure kPa
// (null for gas giants), scale height km, entry interface altitude km.
const PLANET_DATA = [
  { name: 'Mercury', a: 0.387, radius: 2_440, color: '#A0926E', rotH: 1407.5, gm: 22_032, initAngle: 1.2, moons: [] },
  { name: 'Venus', a: 0.723, radius: 6_052, color: '#E8CDA0', rotH: -5832.5, gm: 324_859, atmo: { surfaceKPa: 9_200, scaleKm: 15.9, interfaceKm: 250 }, initAngle: 3.8, moons: [] },
  { name: 'Earth', a: 1.0, radius: 6_371, color: '#4A90D9', rotH: 23.934, gm: 398_600, atmo: { surfaceKPa: 101.3, scaleKm: 8.5, interfaceKm: 120 }, initAngle: 0.0, moons: [
    { name: 'Luna', aKm: 384_400, period: 27.32, radius: 1737.4, gm: 4904.9, color: '#AAAAAA', initAngle: 0 },
  ] },
  // (Mars two centuries into its terraforming: half an Earth's air, nitrogen and oxygen, breathable on the low ground: bodyfacts.js)
  { name: 'Mars', a: 1.524, radius: 3_390, color: '#B8634A', rotH: 24.623, gm: 42_828, atmo: { surfaceKPa: 52, scaleKm: 19, interfaceKm: 160 }, initAngle: 4.5, moons: [
    { name: 'Phobos', aKm: 9_377, period: 0.319, radius: 11.1, gm: 0.000711, color: '#888877', initAngle: 0.5 },
    { name: 'Deimos', aKm: 23_460, period: 1.263, radius: 6.2, gm: 9.8e-05, color: '#777766', initAngle: 2.1 },
  ] },
  { name: 'Jupiter', a: 5.203, radius: 69_911, color: '#C4A882', rotH: 9.925, gm: 126_686_534, atmo: { surfaceKPa: null, scaleKm: 27, interfaceKm: 1_000 }, initAngle: 2.1, moons: [
    { name: 'Io', aKm: 421_800, period: 1.769, radius: 1821.6, gm: 5959.9, color: '#DDAA55', initAngle: 0 },
    { name: 'Europa', aKm: 671_100, period: 3.551, radius: 1560.8, gm: 3202.7, color: '#AACCDD', initAngle: 1.5 },
    { name: 'Ganymede', aKm: 1_070_400, period: 7.155, radius: 2634.1, gm: 9887.8, color: '#999988', initAngle: 3.0 },
    { name: 'Callisto', aKm: 1_882_700, period: 16.69, radius: 2410.3, gm: 7179.3, color: '#666655', initAngle: 4.5 },
  ] },
  { name: 'Saturn', a: 9.537, radius: 58_232, color: '#E8D5A3', rotH: 10.656, gm: 37_931_187, atmo: { surfaceKPa: null, scaleKm: 59.5, interfaceKm: 1_000 }, initAngle: 5.2, rings: true, moons: [
    { name: 'Mimas', aKm: 185_539, period: 0.942, radius: 198.2, gm: 2.503, color: '#BBBBBB', initAngle: 0 },
    { name: 'Enceladus', aKm: 238_042, period: 1.370, radius: 252.1, gm: 7.211, color: '#CCEEEE', initAngle: 1.0 },
    { name: 'Tethys', aKm: 294_619, period: 1.888, radius: 531.1, gm: 41.21, color: '#AAAAAA', initAngle: 2.0 },
    { name: 'Dione', aKm: 377_396, period: 2.737, radius: 561.4, gm: 73.12, color: '#999999', initAngle: 3.0 },
    { name: 'Rhea', aKm: 527_108, period: 4.518, radius: 763.8, gm: 153.9, color: '#AAAAAA', initAngle: 4.0 },
    { name: 'Titan', aKm: 1_221_870, period: 15.95, radius: 2574.7, gm: 8978.1, atmo: { surfaceKPa: 146.7, scaleKm: 40, interfaceKm: 600 }, color: '#D9A54A', initAngle: 5.0 },
    { name: 'Iapetus', aKm: 3_560_820, period: 79.32, radius: 734.5, gm: 120.5, color: '#777766', initAngle: 0.5 },
  ] },
  { name: 'Uranus', a: 19.19, radius: 25_362, color: '#7EC8D9', rotH: -17.24, gm: 5_793_939, atmo: { surfaceKPa: null, scaleKm: 27.7, interfaceKm: 1_000 }, initAngle: 0.8, moons: [] },
  { name: 'Neptune', a: 30.07, radius: 24_622, color: '#4B6EAF', rotH: 16.11, gm: 6_836_529, atmo: { surfaceKPa: null, scaleKm: 19.7, interfaceKm: 1_000 }, initAngle: 4.0, moons: [] },
];

const ASTEROID_DATA = [
  { name: 'Ceres', a: 2.77, radius: 470, rotH: 9.074, gm: 62.63, color: '#8A8A7A', initAngle: 1.0 },
  { name: 'Vesta', a: 2.36, radius: 263, rotH: 5.342, gm: 17.29, color: '#9A8A6A', initAngle: 3.5 },
  { name: 'Pallas', a: 2.77, radius: 256, rotH: 7.813, gm: 13.63, color: '#7A7A6A', initAngle: 5.8 },
  { name: 'Hygiea', a: 3.14, radius: 217, rotH: 13.83, gm: 5.78, color: '#6A6A5A', initAngle: 0.3 },
  { name: 'Juno', a: 2.67, radius: 123, rotH: 7.21, gm: 1.82, color: '#8A7A6A', initAngle: 2.2 },
  { name: 'Interamnia', a: 3.06, radius: 166, rotH: 8.73, gm: 2.5, color: '#7A6A5A', initAngle: 4.1 },
];

export const SUN = { name: 'Sol', type: 'star', a: 0, period: Infinity, initAngle: 0, radius: 696_000, rotH: 609.1, gm: 132_712_440_018, atmo: null, color: '#FDB813', parent: null, moons: [] };

/** All bodies, parents before children. */
export const BODIES = [SUN];
const BY_NAME = new Map([[SUN.name, SUN]]);

for (const p of PLANET_DATA) {
  const planet = {
    name: p.name, type: 'planet', a: p.a, period: keplerPeriodDays(p.a), initAngle: p.initAngle,
    radius: p.radius, rotH: p.rotH, gm: p.gm, atmo: p.atmo || null, color: p.color, rings: !!p.rings, parent: null, moons: [],
  };
  BODIES.push(planet); BY_NAME.set(planet.name, planet);
  for (const m of p.moons) {
    const moon = {
      name: m.name, type: 'moon', a: m.aKm / AU_KM, period: m.period, initAngle: m.initAngle,
      radius: m.radius, rotH: m.period * 24, gm: m.gm, atmo: m.atmo || null, color: m.color, parent: planet, moons: [],
    };
    planet.moons.push(moon);
    BODIES.push(moon); BY_NAME.set(moon.name, moon);
  }
}
for (const a of ASTEROID_DATA) {
  const ast = {
    name: a.name, type: 'asteroid', a: a.a, period: keplerPeriodDays(a.a), initAngle: a.initAngle,
    radius: a.radius, rotH: a.rotH, gm: a.gm, atmo: null, color: a.color, parent: null, moons: [],
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

/**
 * Heliocentric position in AU. Writes into `out` if given. (The last answer
 * is kept on the body: a minute asks where Mars is for every ship round it,
 * at the same moment, thousands of times at a crowded port.)
 */
export function bodyPos(body, days, out = { x: 0, y: 0 }) {
  if (body.$pd === days) { out.x = body.$px; out.y = body.$py; return out; }
  if (!body.parent) {
    if (body.a === 0) { out.x = 0; out.y = 0; return out; }
    const th = angleAt(body, days);
    out.x = body.a * Math.cos(th);
    out.y = body.a * Math.sin(th);
  } else {
    bodyPos(body.parent, days, out);
    const th = angleAt(body, days);
    out.x += body.a * Math.cos(th);
    out.y += body.a * Math.sin(th);
  }
  body.$pd = days; body.$px = out.x; body.$py = out.y;
  return out;
}

/** Heliocentric velocity in m/s. Writes into `out` if given. (Kept as bodyPos keeps its answer.) */
export function bodyVel(body, days, out = { vx: 0, vy: 0 }) {
  if (body.$vd === days) { out.vx = body.$vx; out.vy = body.$vy; return out; }
  bodyVelOf(body, days, out);
  body.$vd = days; body.$vx = out.vx; body.$vy = out.vy;
  return out;
}
function bodyVelOf(body, days, out) {
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

// ---- PHYSICAL ----

/** Surface gravity of a body, m/s². */
export const surfaceGravity = (b) => b.gm * 1e9 / (b.radius * 1000) ** 2;

/** A body's rotation period in days (positive: prograde). */
export const rotationDays = (b) => b.rotH / 24;

/** Surface area, km² (a mean sphere: Ceres is 2.8 million km², about Argentina). */
export const surfaceAreaKm2 = (b) => 4 * Math.PI * b.radius * b.radius;
