// ============================================================
// LONGHAUL — Worlds: the space a planet or a big moon holds
//
// Out in the system a planet is a dot, and a ship flies past it as past
// anything else. Close in it is the biggest thing there is. A world (a
// planet, or a moon WORLD_MIN_RADIUS_KM across or more: the rocks are the
// stations' business) holds a space of its own round it, nested:
//
//   PLANETARY SPACE  out to where its pull falls to WELL_G (0.01 G: half
//     what an RCS pushes, flight.js RCS_MAX_G), held to half its Hill
//     sphere (beyond that its parent's tide pulls a ship away from it)
//     and to at least MIN_WELL_R of its radius. Inside it a ship can't
//     hold a place on its thrusters: it orbits, or it holds on the drive.
//     There the nav computer flies planetary flight, and the world's
//     ground control (GROUND_CONTROL), where it has one, will watch it.
//     Earth's reaches 63,750 km, Mars' 20,900, Jupiter's 1.14 million.
//   HIGH ORBIT       from the top of low orbit out to its edge
//   STATIONARY ORBIT where an orbit keeps pace with the ground (a third
//     of the way round the sky for Earth: 42,164 km from its centre), if
//     it lies inside planetary space. A world that turns too slowly for
//     one (Venus, the moons, which keep one face to their planet) can
//     still be held over a ground point, on the drive.
//   LOW ORBIT        from just over the air (or the ground) to a third of
//     its radius up
//   ATMOSPHERE       from the entry interface down: an exponential column
//     of air (its surface pressure and scale height: ephemeris.js), the
//     density, pressure and drag of it, and the heat of going through it
//     at speed (atmosphere(), dragAccel(), entryHeat()). A gas giant has
//     no ground: its radius is its 1-bar level, and the air goes on down.
//
// THE GROUND is shared out. A world with ground has AIRSPACES: arcs of its
// equator (the plane cuts each world round its equator), one for every
// AIRSPACE_KM of it (Earth eleven, Mars six, Luna three), each with its
// authority and its controller, reaching from the ground up through low
// orbit: a low orbit over it, and later a landing in it, is that
// controller's to clear. They turn with the world (a body-frame angle, as
// a surface target's: gravity.js surfacePoint). The giants have no ground
// and no airspaces. Each airspace has its spaceport now; procedural sites
// (camps, mines, wrecks, the places missions will send us) come from a
// seed (proceduralSite), hundreds to a world in time.
//
// The routes don't go into the air yet (no final approach: the nav
// computer's floor is the entry interface, terrain.js). A route to a world
// itself ends in a high orbit: its parking orbit, at the edge of planetary
// space, or, where the world has one, the stationary orbit over one of its
// airspaces (nav.js 'orbit' targets: parkingTarget, stationaryTarget). Low
// orbits wait for ground control's clearances. What a ship falls into
// anyway it feels: the air drags it (flight.js).
//
// Per minute (worldsTick) the nav computer knows which world's space we are
// in and in which layer (flight.world, saved), and says so as we cross from
// one to the next: into planetary space (whose ground control it is, and the
// parking orbit), down into low orbit, onto the stationary orbit, into the
// air. In the air (airDrag), our ship is slowed by it: the drag of our speed
// through the air (which turns with the world), the dynamic pressure and the
// heat of it kept for the displays (state.$air). Hull damage from entry heat
// waits for atmospheric flight; an entry-rated hull (ship-classes.js atmo)
// will be what takes it.
//
// Cost: a world's numbers are worked out once. Where we are among them
// (worldAt) is a pass over the dozen worlds, once a minute for us.
// ============================================================

import { AU_M, G0 } from '../core/constants.js';
import { BODIES, SUN, bodyPos, bodyVel, getBody } from './ephemeris.js';
import { FACTIONS } from './factions.js';
import { hullOf } from './hulls.js';
import { PLAYER_CLASS } from './ship-classes.js';

export const WORLD_MIN_RADIUS_KM = 1000;
export const WELL_G = 0.01;                 // planetary space ends where the pull falls to this
const HILL_SHARE = 0.5;                     // …held inside this share of the Hill sphere
const MIN_WELL_R = 1.5;                     // …and at least this many radii out
const LOW_TOP_R = 1.33;                     // low orbit up to a third of a radius up (Earth's to 2,100 km)
const LOW_CLEAR_M = 20_000;                 // low orbit begins this far over the air or the ground
export const PARKING_SHARE = 0.92;          // a route to a world ends in orbit this far out of its planetary space
const STATIONARY_BAND = 0.02;               // within this share of the stationary orbit's radius we are on it
const SUTTON_GRAVES_K = 1.7415e-4;          // convective heating, Earth air (W/m² from kg/m³, m, m/s)
const BAR_PA = 100_000;

/**
 * Who answers for a world's planetary space: the power whose ground control
 * will clear low orbits and landings there. The giants and Io have no ground
 * to control.
 */
export const GROUND_CONTROL = {
  Mercury: 'UN', Venus: 'UN', Earth: 'UN', Luna: 'UN',
  Mars: 'MCR', Callisto: 'MCR',
  Ganymede: 'independent', Europa: 'OPA', Titan: 'OPA',
};

/** The layers of a world's space, outermost first, as the displays name them. */
export const LAYERS = {
  space: 'PLANETARY SPACE', high: 'HIGH ORBIT', stationary: 'STATIONARY ORBIT', low: 'LOW ORBIT',
  atmosphere: 'ATMOSPHERE', surface: 'SURFACE',
};

const _worlds = new Map();

/** A world's numbers (null for a body too small to be one). */
export function worldOf(body) {
  if (typeof body === 'string') body = getBody(body);
  if (!body || body.type === 'star' || body.radius < WORLD_MIN_RADIUS_KM) return null;
  let w = _worlds.get(body.name);
  if (w) return w;
  const R = body.radius * 1000, GM = body.gm * 1e9;
  const g = GM / (R * R);
  const parentGM = (body.parent ? body.parent.gm : SUN.gm) * 1e9;
  const hillM = body.a * AU_M * Math.cbrt(GM / (3 * parentGM));
  const wellM = Math.max(MIN_WELL_R * R, Math.min(Math.sqrt(GM / (WELL_G * G0)), HILL_SHARE * hillM));
  const atmo = body.atmo ? airOf(body, R, g) : null;
  const floorM = R + (atmo ? atmo.interfaceM : 0);
  const low = [floorM + LOW_CLEAR_M, Math.max(floorM + 2 * LOW_CLEAR_M, LOW_TOP_R * R)];
  // the stationary orbit: an orbit as long as the ground's turn (sidereal), if it lies inside planetary space
  const rotS = Math.abs(body.rotH) * 3600;
  const syncM = Math.cbrt(GM * rotS * rotS / (4 * Math.PI * Math.PI));
  const sync = syncM > low[1] && syncM < wellM ? syncM : null;
  const syncWhy = sync ? null : body.parent && Math.abs(body.rotH - body.period * 24) < 1 ? 'it keeps one face to its planet: an orbit keeping pace with its ground would lie outside its planetary space'
    : syncM >= wellM ? 'it turns too slowly: an orbit keeping pace with its ground would lie outside its planetary space' : 'it turns too fast: an orbit keeping pace with its ground would be inside it';
  w = {
    body, name: body.name, kind: body.type, R, GM, g, gG: g / G0, escapeMS: Math.sqrt(2 * GM / R),
    hillM, wellM, low, sync, syncWhy, floorM, atmo, parkM: PARKING_SHARE * wellM,
    authority: GROUND_CONTROL[body.name] || null,
    rotS: body.rotH * 3600,                  // (negative: retrograde)
  };
  _worlds.set(body.name, w);
  return w;
}

/** Every world, planets before their moons. */
export const WORLDS = BODIES.map(b => worldOf(b)).filter(Boolean);

/**
 * A world's air: the surface pressure (a gas giant's 1-bar level at its
 * radius), the scale height, the entry interface, and the density at the
 * bottom from them (hydrostatic: P = ρ g H).
 */
function airOf(body, R, g) {
  const a = body.atmo;
  const giant = a.surfaceKPa == null;
  const surfacePa = giant ? BAR_PA : a.surfaceKPa * 1000;
  const scaleM = a.scaleKm * 1000;
  return { giant, surfacePa, scaleM, interfaceM: a.interfaceKm * 1000, rho0: surfacePa / (g * scaleM) };
}

/** The air at `altM` over a world's ground (its 1-bar level for a giant): { rho kg/m³, pa }; nothing over the entry interface. */
export function atmosphere(w, altM) {
  const a = w?.atmo;
  if (!a || altM > a.interfaceM) return { rho: 0, pa: 0 };
  const k = Math.exp(-Math.max(altM, 0) / a.scaleM);
  return { rho: a.rho0 * k, pa: a.surfacePa * k };
}

/** The pull at `rM` from a world's centre, m/s². */
export const pullAtM = (w, rM) => w.GM / (rM * rM);
/** A circular orbit at `rM`: its speed (m/s) and period (s). */
export const orbitSpeed = (w, rM) => Math.sqrt(w.GM / rM);
export const orbitPeriodS = (w, rM) => 2 * Math.PI * Math.sqrt(rM * rM * rM / w.GM);
/** The parking orbit a route to the world ends in (m from its centre). */
export const parkingOrbit = (w) => w.parkM;

/** Which layer of a world's space a distance from its centre is in. */
export function layerOf(w, rM) {
  if (rM > w.wellM) return null;
  if (rM <= w.R) return 'surface';
  if (w.atmo && rM <= w.R + w.atmo.interfaceM) return 'atmosphere';
  if (rM <= w.low[1]) return 'low';
  if (w.sync && Math.abs(rM - w.sync) <= STATIONARY_BAND * w.sync) return 'stationary';
  if (rM <= w.wellM) return 'high';
  return 'space';
}

/**
 * Where a point is among the worlds: the innermost planetary space it is in
 * (a moon's, inside its planet's), { w, rM, altM, layer, pos, vel } (the
 * world's centre in AU and its velocity, m/s), or null out in open space.
 */
const _p = { x: 0, y: 0 }, _v = { vx: 0, vy: 0 };
export function worldAt(x, y, minute) {
  const days = minute / 1440;
  let best = null;
  for (const w of WORLDS) {
    bodyPos(w.body, days, _p);
    const rM = Math.hypot(x - _p.x, y - _p.y) * AU_M;
    if (rM > w.wellM) continue;
    if (!best || w.wellM < best.w.wellM) {
      bodyVel(w.body, days, _v);
      best = { w, rM, altM: rM - w.R, layer: layerOf(w, rM), pos: { x: _p.x, y: _p.y }, vel: { vx: _v.vx, vy: _v.vy } };
    }
  }
  return best;
}

/**
 * The air's own motion at a point (m/s): it turns with the world (a world's
 * day), so what drags on a ship is its speed through the air, not over the
 * world's centre. `here` is worldAt's result for the point.
 */
export function airVelocity(here, x, y) {
  const w = here.w, om = 2 * Math.PI / w.rotS;          // (retrograde: negative)
  const dx = (x - here.pos.x) * AU_M, dy = (y - here.pos.y) * AU_M;
  return { vx: here.vel.vx - om * dy, vy: here.vel.vy + om * dx };
}

/**
 * Drag through the air: 0.5 ρ v² Cd A / m, along −v (the speed through the
 * air). `ballistic` is m / (Cd A), kg/m² (ballisticOf). Returns the
 * deceleration, m/s².
 */
export const dragAccel = (rho, vMS, ballistic) => rho > 0 && ballistic > 0 ? 0.5 * rho * vMS * vMS / ballistic : 0;

/** A hull's ballistic coefficient (kg/m²): its mass over its drag area (broadside to the flow, as an unshaped hull tumbles in), Cd ~1. */
export const ballisticOf = (hull, massKg) => massKg / Math.max(1, 1.0 * hull.L * Math.max(hull.W, hull.H) * 0.6);

/** The heat of going through the air at speed (Sutton–Graves, a nose `noseM` across): W/m². */
export const entryHeat = (rho, vMS, noseM = 2) => rho > 0 ? SUTTON_GRAVES_K * Math.sqrt(rho / Math.max(0.1, noseM)) * vMS * vMS * vMS : 0;

// ---- THE GROUND: AIRSPACES AND SITES ----

const AIRSPACE_KM = 3500;                   // one airspace for this much of a world's equator
/** The airspaces round each world's equator, eastward from its prime meridian (body-frame angle 0). */
export const AIRSPACE_NAMES = {
  Mercury: ['Caloris', 'Tolstoj', 'Beethoven', 'Rachmaninoff'],
  Venus: ['Eistla', 'Bell', 'Ovda', 'Thetis', 'Atla', 'Ulfrun', 'Beta', 'Phoebe', 'Themis', 'Lada', 'Alpha'],
  Earth: ['Gulf of Guinea', 'East African', 'Indian Ocean', 'Sunda', 'Melanesian', 'Central Pacific', 'Polynesian', 'Galápagos', 'Andean', 'Amazonian', 'Mid-Atlantic'],
  Luna: ['Tranquillity', 'Far Side', 'Imbrium'],
  Mars: ['Meridiani', 'Syrtis', 'Elysium', 'Amazonis', 'Tharsis', 'Mariner Valley'],
  Io: ['Loki', 'Pele', 'Prometheus'],
  Europa: ['Conamara', 'Pwyll', 'Thera'],
  Ganymede: ['Galileo', 'Uruk', 'Osiris', 'Memphis', 'Nicholson'],
  Callisto: ['Valhalla', 'Asgard', 'Adlinda', 'Heimdall'],
  Titan: ['Xanadu', 'Shangri-La', 'Belet', 'Adiri', 'Senkyo'],
};
/** How a world's controllers style themselves. */
const CONTROLLER_WORD = { Earth: 'Air Traffic Control', Mars: 'Planetary Traffic', Luna: 'Lunar Control', Venus: 'Research Authority', Mercury: 'Collector Authority', Titan: 'Flight Service', Europa: 'Ice Control', Ganymede: 'Agricultural Authority', Callisto: 'Naval Air Control', Io: 'Monitoring Station' };

const TWO_PI = 2 * Math.PI;
const wrap = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * A world's airspaces: [{ id, world, index, name, a0, a1 (body-frame rad,
 * eastward), authority (a faction id, or null: unclaimed), controller,
 * ceilingM (from the centre: the top of low orbit), port: its spaceport
 * { id, name, ang } }]. None on a world with no ground.
 */
const _air = new Map();
export function airspacesOf(w) {
  if (!w || w.atmo?.giant) return [];
  let list = _air.get(w.name);
  if (list) return list;
  const n = Math.max(2, Math.round(TWO_PI * w.R / 1000 / AIRSPACE_KM));
  const names = AIRSPACE_NAMES[w.name] || [];
  const word = CONTROLLER_WORD[w.name] || 'Control';
  list = Array.from({ length: n }, (_, i) => {
    const name = names[i] || `Sector ${i + 1}`;
    const a0 = TWO_PI * i / n, a1 = TWO_PI * (i + 1) / n;
    return {
      id: `${w.name}:${i}`, world: w.name, index: i, name, a0, a1,
      authority: w.authority, controller: w.authority ? `${name} ${word}` : `${name} (unclaimed)`,
      ceilingM: w.low[1],
      port: { id: `${w.name}:${i}:port`, name: `${name} Spaceport`, ang: a0 + (a1 - a0) * (0.35 + 0.3 * frac(i * 0.618 + w.R * 1e-7)), kind: 'spaceport' },
    };
  });
  _air.set(w.name, list);
  return list;
}
const frac = (x) => x - Math.floor(x);

/** An airspace by id ('Mars:4'), or null. */
export function airspaceById(id) {
  const [name] = String(id).split(':');
  return airspacesOf(worldOf(name)).find(a => a.id === id) || null;
}

/** The body-frame angle under a world angle (rad) at `minute`: the world has turned since minute 0 (gravity.js surfacePoint). */
export function groundAngle(w, worldAng, minute) {
  return wrap(worldAng - 2 * Math.PI / w.rotS * minute * 60);
}
/** …and back: where a body-frame angle points in the plane at `minute`. */
export function worldAngle(w, ang, minute) {
  return ang + 2 * Math.PI / w.rotS * minute * 60;
}

/** The airspace under a body-frame angle, or null on a world without them. */
export function airspaceAt(w, ang) {
  const list = airspacesOf(w);
  if (!list.length) return null;
  const a = wrap(ang);
  return list.find(s => a >= s.a0 && a < s.a1) || list[list.length - 1];
}

/** Where a body-frame angle on a world is (AU) at `minute`, `upM` over its ground. */
export function groundPoint(w, ang, minute, upM = 0) {
  const c = bodyPos(w.body, minute / 1440);
  const a = worldAngle(w, ang, minute), r = (w.R + upM) / AU_M;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

const SITE_KINDS = ['camp', 'mine', 'outpost', 'research station', 'settlement', 'crash site', 'relay mast', 'depot'];
const SYL_A = ['Ash', 'Bel', 'Cor', 'Dun', 'Ery', 'Fal', 'Gar', 'Hol', 'Ira', 'Kes', 'Lor', 'Mar', 'Nor', 'Ost', 'Pel', 'Quin', 'Ros', 'Sal', 'Tor', 'Ula', 'Ven', 'Wyl'];
const SYL_B = ['ford', 'gate', 'holm', 'mere', 'point', 'reach', 'ridge', 'rock', 'stead', 'vale', 'wick', 'field', 'crag', 'hollow'];
/** A repeatable 0–1 from a seed and a salt (the site generator's own: it reads a seed, it draws none). */
function hashSeed(seed, salt) {
  let h = Math.imul((seed | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(salt + 1, 0xC2B2AE35);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A procedural landing site on a world, made from `seed` (the seed comes from
 * whoever wants one, core/rng.js for a mission's: the same seed, the same
 * site): { id, name, kind, ang (body-frame rad), airspace (its id) }. Null on a
 * world with no ground.
 */
export function proceduralSite(w, seed) {
  if (!airspacesOf(w).length) return null;
  const ang = TWO_PI * hashSeed(seed, 1);
  const kind = SITE_KINDS[Math.floor(hashSeed(seed, 2) * SITE_KINDS.length)];
  const name = SYL_A[Math.floor(hashSeed(seed, 3) * SYL_A.length)] + SYL_B[Math.floor(hashSeed(seed, 4) * SYL_B.length)];
  return { id: `${w.name}:site:${seed >>> 0}`, name, kind, ang, airspace: airspaceAt(w, ang).id };
}

/** The length of a world's day, sun to sun (h), from its turn and its year (a moon's year is its planet's). */
export function solarDayH(body) {
  const year = (body.parent ? body.parent.period : body.period) * 24;
  const turn = body.rotH;
  if (!isFinite(year) || !year) return Math.abs(turn);
  const f = 1 / turn - 1 / year;                         // (retrograde turns add to the year's)
  return Math.abs(1 / f);
}

// ---- PER MINUTE ----

/** Whose ground control a world has, in words. */
export function controlWords(w) {
  if (!w.authority) return 'no ground control';
  const f = FACTIONS[w.authority];
  return f ? `${f.navy === 'OPA' ? 'OPA' : f.short} ground control` : 'independent ground control';
}

const km = (m) => `${Math.round(m / 1000).toLocaleString()} km`;

/**
 * Once a minute: where we are among the worlds (flight.world: { name, layer },
 * or null in open space), and what the nav computer says as that changes.
 */
export function worldsTick(state, emit = () => {}) {
  const f = state.flight;
  const here = worldAt(f.pos.x, f.pos.y, state.clock.minute);
  const was = f.world || null;
  // (under the top of low orbit, over a world's ground, we are in one of its airspaces)
  const under = here && here.rM <= here.w.low[1] ? airspaceAt(here.w, groundAngle(here.w, Math.atan2(f.pos.y - here.pos.y, f.pos.x - here.pos.x), state.clock.minute)) : null;
  const cur = here ? { name: here.w.name, layer: here.layer, airspace: under?.id || null } : null;
  f.world = cur;
  if (!cur && !was) return;
  if (!cur) { emit('nav-callout', { level: 'info', key: 'world', text: `Out of ${was.name}'s planetary space: open space, flight as before.` }); return; }
  const w = here.w;
  if (!was || was.name !== cur.name) {
    emit('nav-callout', { level: 'info', key: 'world', text: `Into ${w.name}'s planetary space, ${km(here.altM)} up (${controlWords(w)}): planetary flight. Its pull here is ${(pullAtM(w, here.rM) / G0).toFixed(3)} G; its parking orbit ${km(w.parkM)} out.` });
    return;
  }
  if (cur.airspace && cur.airspace !== was.airspace) {
    const a = airspaceById(cur.airspace);
    emit('nav-callout', { level: 'info', key: 'airspace', text: `Over the ${a.name} airspace: ${a.controller}${a.authority ? ` (${FACTIONS[a.authority]?.short || a.authority})` : ''}.` });
  }
  if (was.layer === cur.layer) return;
  const order = ['high', 'stationary', 'low', 'atmosphere', 'surface'];
  const deeper = order.indexOf(cur.layer) > order.indexOf(was.layer);
  if (cur.layer === 'low' && deeper) emit('nav-callout', { level: 'info', key: 'world', text: `${w.name} low orbit, ${km(w.low[0] - w.R)} to ${km(w.low[1] - w.R)} up: a circular orbit here goes round in ${Math.round(orbitPeriodS(w, here.rM) / 60)} min at ${(orbitSpeed(w, here.rM) / 1000).toFixed(1)} km/s.` });
  else if (cur.layer === 'stationary') emit('nav-callout', { level: 'info', key: 'world', text: `On ${w.name}'s stationary orbit, ${km(w.sync)} out: an orbit here keeps pace with the ground below.` });
  else if (cur.layer === 'atmosphere') emit('nav-callout', { level: 'danger', key: 'world', text: `In ${w.name}'s air, ${km(here.altM)} up: it drags on us, and the nav computer won't fly in it (no atmospheric flight yet).` });
  else if (was.layer === 'atmosphere' && !deeper) emit('nav-callout', { level: 'info', key: 'world', text: `Out of ${w.name}'s air.` });
}

/**
 * Our ship in a world's air, after the minute's flight: its speed through the
 * air (which turns with the world) slowed as drag slows it over `dtS`
 * seconds (dv/dt = −ρv²/2β, solved exactly: a dense layer can't overshoot),
 * and what it felt kept for the displays (state.$air: the density, the
 * pressure, the speed through the air, the dynamic pressure, the heat).
 */
export function airDrag(state, dtS = 60) {
  const f = state.flight;
  const here = worldAt(f.pos.x, f.pos.y, state.clock.minute);
  if (!here || (here.layer !== 'atmosphere' && here.layer !== 'surface')) { state.$air = null; return; }
  const air = atmosphere(here.w, here.altM);
  if (!air.rho) { state.$air = null; return; }
  const av = airVelocity(here, f.pos.x, f.pos.y);
  const rvx = f.vel.vx - av.vx, rvy = f.vel.vy - av.vy, v = Math.hypot(rvx, rvy);
  const hull = hullOf(state.ship.classId || PLAYER_CLASS);
  const massKg = (state.shipMass || 1e5) + (state.resources?.fuel?.current || 0);
  const beta = ballisticOf(hull, massKg);
  const k = air.rho / (2 * beta);
  const v1 = v > 0 ? v / (1 + k * v * dtS) : 0;
  if (v > 0) { f.vel.vx = av.vx + rvx * v1 / v; f.vel.vy = av.vy + rvy * v1 / v; }
  state.$air = { body: here.w.name, altM: here.altM, rho: air.rho, pa: air.pa, v: v1, q: 0.5 * air.rho * v1 * v1, heat: entryHeat(air.rho, v1), dragG: dragAccel(air.rho, v1, beta) / G0 };
}
