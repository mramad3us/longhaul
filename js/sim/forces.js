// ============================================================
// LONGHAUL — The background forces: police, navies, pirates
//
// Thousands of traffic ships trade between the stations (traffic.js).
// Alongside them every power keeps hulls in space, and they are real
// entities on rails, not dice rolls:
//
//   POLICE fly a beat around each station of a power that polices
//     (Star Helix, UN Security, Martian Security): a few cutters on
//     orbits within a couple of million km of it.
//   NAVIES berth at their yards (UNN at Luna, MCRN at Phobos, OPA at
//     Tycho and Ceres) until a hot zone calls for them. Then a squadron
//     flies out on a filed course and holds station at the zone, and
//     flies home when the zone is over.
//   PIRATES lie up cold in lawless space, near rocks nobody holds. A
//     pirate zone gathers a pack.
//
// THE LIVE WINDOW. Away from us these hulls stay on rails, and what
// they do is settled by outcomes: each hour, warships of both sides on
// station at a zone may cost one of them, and pirates in a zone may
// take a passing hauler (conflict.js). Within WAKE_AU of us (about our
// long sensor reach, 50 light-seconds) they come alive as agents
// (agents.js) and fly, fight and talk for themselves. The skirmish we
// fly into is the one the newsfeed reported, fought by the ships that
// were sent to it. Beyond SLEEP_AU, with no business left with us, they
// go back on rails: a course from where they are to where they were
// going, or lying up where they are. Traffic woken for a fight (a
// pirate's prey) goes back on its route the same way.
//
// Cost: the force list is a few hundred hulls, whatever the size of the
// traffic population. The wake check walks it once a minute, and the
// census that keeps every power at strength runs once a day.
// ============================================================

import { AU_M, G0, MIN_S, DAY_MIN, TWO_PI } from '../core/constants.js';
import { random, randRange, pick } from '../core/rng.js';
import { BODIES, bodyPos, getBody } from './ephemeris.js';
import { getWorld, WORLD_VISITORS } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity } from './ship-classes.js';
import { FACTIONS, controlAt } from './factions.js';
import { ensureHull } from './combatants.js';
import { wake } from './agents.js';

export const WAKE_AU = 0.1;            // hulls this close come alive (≈ long sensor reach)
export const SLEEP_AU = 0.25;          // …and go back on rails past this (agents.js DESPAWN_AU)
const REST_MIN = 12 * 60;              // a hull just put back on rails isn't woken by proximity again for this long
export const DISPATCH_AU = 0.05;       // the encounter director calls on hulls within this (conflict.js)
const MAX_AWAKE = { police: 3, navy: 10, pirate: 2 };

export const POLICE_PER_STATION = 3;
// Hulls in commission. Earth and Mars are matched in total strength, not in
// numbers: the UNN is a big fleet of TL2 corvettes and frigates a generation
// old, the MCRN a small one of TL4 hulls each worth about five of them
// (classStrength: UN mean ≈ 1,200, MCR ≈ 5,900, so 56 × 1,200 ≈ 12 × 5,900).
// The OPA's few refits are a militia, not a navy.
export const NAVY_STRENGTH = { UN: 56, MCR: 12, OPA: 8 };
export const NAVY_YARDS = { UN: ['luna-yards'], MCR: ['phobos-yard'], OPA: ['tycho-station', 'ceres-station'] };
export const PIRATES_AT_LARGE = 24;    // raiders lying up in lawless space between zones
// The share of its navy each side commits to a zone (factions in the zone's
// order), at least one hull: a skirmish draws 14 UNN hulls against 3 MCRN.
export const ZONE_FORCES = { standoff: [0.15, 0.15], blockade: [0.25, 0.08], skirmish: [0.25, 0.25], insurgency: [0.1] };
export const PIRATE_PACK = 5;          // raiders a pirate zone gathers
const NAVY_KINDS = ['corvette', 'corvette', 'frigate', 'frigate', 'destroyer'];
const CRUISE_G = 1;                    // forces fly their courses at 1G
const REINFORCE_SHARE = 0.05;         // yards make good this share of a navy's strength a day, at most

const distAU = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/** Are the forces running in this game? (Test suites that aren't about them leave them off.) */
export const forcesOn = (state) => !!state.traffic?.forces;

// ---- PLACING HULLS ON RAILS ----

function newHull(state, role, faction) {
  const world = getWorld(state);
  const id = role === 'police' ? rollIdentity({ kind: 'cutter', category: 'authority', faction })
    : role === 'navy' ? rollIdentity({ kind: pick(NAVY_KINDS), category: 'military', faction })
    : rollIdentity({ category: 'irregular', faction: 'pirate' });
  const e = createEntity({
    id: world.newId(role === 'pirate' ? 'raider' : role), name: id.name, type: 'ship', faction: id.faction, cls: id.cls, tl: id.tl,
    shipClass: id.shipClass, mass: id.mass, transponder: role !== 'pirate', orbit: { body: 'Sol', r: 1, phase: 0, period: 0 },
    t: state.clock.minute, tags: { force: { role, faction: id.faction, home: null, zone: null, post: null, state: 'post' } },
  });
  return e;
}

/** Berthed beside a station (navies between deployments). */
function berthAt(e, st) {
  const o = st.orbit;
  e.transit = null;
  e.orbit = { body: o.body, r: o.r * (1 + randRange(-0.01, 0.01)), phase: o.phase + randRange(-0.002, 0.002), period: o.period };
  e.thrust = 0;
  e.tags.force.state = 'berth';
}

/** A police beat: an orbit around the station's body, a few hundred thousand to two million km out. */
function onBeat(e, st) {
  e.transit = null;
  e.orbit = { body: st.orbit.body, r: randRange(0.002, 0.012), phase: random() * TWO_PI, period: randRange(2, 6) };
  e.thrust = 0;
  e.tags.force.state = 'post';
}

/** On station at a zone (or a pirate's lair): spread about the anchor, holding with the body. */
function onPost(e, anchor) {
  const o = anchor.orbit;
  e.transit = null;
  e.orbit = { body: o.body, r: Math.max(0.0008, o.r + randRange(-0.003, 0.003)), phase: o.phase + randRange(-0.25, 0.25), period: 0 };
  e.thrust = 0;
  e.tags.force.state = 'post';
}

/** Lie up where it is: held with the nearest body, or on a circular orbit of the Sun. */
function lieUp(e, minute) {
  const days = minute / DAY_MIN;
  let best = null, bd = 0.3;
  for (const b of BODIES) {
    if (!b.a) continue;
    const p = bodyPos(b, days);
    const d = distAU(p, e.pos);
    if (d < bd) { bd = d; best = { b, p }; }
  }
  e.transit = null;
  e.thrust = 0;
  if (best) {
    e.orbit = { body: best.b.name, r: Math.max(0.0005, bd), phase: Math.atan2(e.pos.y - best.p.y, e.pos.x - best.p.x), period: 0 };
  } else {
    const r = Math.hypot(e.pos.x, e.pos.y);
    const period = 365.25 * r ** 1.5;
    e.orbit = { body: 'Sol', r, phase: Math.atan2(e.pos.y, e.pos.x) - TWO_PI * days / period, period };
  }
}

/** A filed course from where the hull is now to `dest` (a rails entity), flown at `g`. */
export function railTo(world, e, dest, minute, g = CRUISE_G) {
  world.refresh(e, minute);
  world.refresh(dest, minute);
  const L = distAU(e.pos, dest.pos) * AU_M;
  const T = Math.max(30, Math.round(2 * Math.sqrt(L / (g * G0)) / MIN_S));
  e.orbit = null;
  e.transit = { fix: { x: e.pos.x, y: e.pos.y, vx: e.vel.vx, vy: e.vel.vy, t: minute }, from: null, to: dest.id, t0: minute, t1: minute + T, g };
  return T;
}

function sendTo(state, e, dest) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const f = e.tags.force;
  const T = railTo(world, e, dest, now);
  f.state = 'transit';
  f.dest = dest.id;
  f.until = now + T;
  world.refresh(e, now);
  world.hash.update(e);
}

/** Background visitor: a hull arriving at the end of its course takes up its berth, beat or post. */
function serviceForce(e, minute, world) {
  const f = e.tags?.force;
  if (!f || e.agent || e.driven || f.state !== 'transit' || minute < f.until) return;
  const dest = world.get(f.dest);
  if (!dest) { world.refresh(e, minute); lieUp(e, minute); f.state = 'post'; }
  else if (dest.type === 'station') { if (f.role === 'police') onBeat(e, dest); else berthAt(e, dest); }
  else onPost(e, dest);
  world.refresh(e, minute);
  world.hash.update(e);
}
WORLD_VISITORS.push(serviceForce);

// ---- RAISING THE FORCES ----

const policedStations = (world) => world.stations.filter(st => FACTIONS[st.faction]?.police);

function addPolice(state, st) {
  const e = newHull(state, 'police', st.faction);
  e.tags.force.home = st.id;
  onBeat(e, st);
  return getWorld(state).add(e);
}

function addNavy(state, faction) {
  const world = getWorld(state);
  const yards = (NAVY_YARDS[faction] || []).map(id => world.get(id)).filter(Boolean);
  if (!yards.length) return null;
  const yard = pick(yards);
  const e = newHull(state, 'navy', faction);
  e.tags.force.home = yard.id;
  berthAt(e, yard);
  return world.add(e);
}

/** Bodies where nobody's writ runs: in the Belt or beyond, held by no one firmly. */
function lairBodies(minute) {
  const days = minute / DAY_MIN;
  const out = [];
  for (const b of BODIES) {
    if (!b.a || b.type === 'star') continue;
    const p = bodyPos(b, days);
    const r = Math.hypot(p.x, p.y);
    if (r < 2) continue;
    const ctl = controlAt(p.x, p.y, minute);
    if (ctl.level < 0.45) out.push(b.name);
  }
  return out;
}

function addPirate(state, body) {
  const e = newHull(state, 'pirate', 'pirate');
  e.orbit = { body, r: randRange(0.004, 0.03), phase: random() * TWO_PI, period: 0 };
  return getWorld(state).add(e);
}

/** A new game (or an old save): police on their beats, navies at their yards, pirates in the dark. */
export function seedForces(state) {
  if (!state.traffic) return;
  state.traffic.forces = true;
  const world = getWorld(state);
  for (const st of policedStations(world)) for (let i = 0; i < POLICE_PER_STATION; i++) addPolice(state, st);
  for (const [fac, n] of Object.entries(NAVY_STRENGTH)) for (let i = 0; i < n; i++) addNavy(state, fac);
  const lairs = lairBodies(state.clock.minute);
  if (lairs.length) for (let i = 0; i < PIRATES_AT_LARGE; i++) addPirate(state, pick(lairs));
  for (const z of state.politics.zones) deployToZone(state, z);
}

// ---- ZONES CALL FOR SHIPS ----

/** A zone's anchor: a hidden mark on the zone's orbit that courses can be filed to. */
function zoneAnchor(state, z) {
  const world = getWorld(state);
  const id = `anchor-${z.id}`;
  return world.get(id) || world.add(createEntity({
    id, name: `${z.kind} · ${z.body}`, type: 'nav', transponder: false,
    orbit: { body: z.body, r: z.r, phase: z.phase, period: 0 }, tags: { anchor: z.id },
  }));
}

/**
 * A hot zone was born: the powers in it send ships. Navies take hulls
 * berthed at their yards (commissioning more if none are in), which fly
 * out on a filed course; a pirate zone draws a pack straight away.
 */
export function deployToZone(state, z) {
  if (!forcesOn(state)) return;
  const world = getWorld(state);
  const plan = ZONE_FORCES[z.kind] || [];
  const anchor = zoneAnchor(state, z);
  if (z.kind === 'pirates') {
    for (let i = 0; i < PIRATE_PACK; i++) {
      const e = addPirate(state, z.body);
      e.tags.force.zone = z.id; e.tags.force.post = anchor.id;
      onPost(e, anchor);
      world.refresh(e, state.clock.minute); world.hash.update(e);
    }
    return;
  }
  z.factions.forEach((fac, i) => {
    if (!plan[i] || !NAVY_STRENGTH[fac]) return;
    const want = Math.max(1, Math.round(plan[i] * NAVY_STRENGTH[fac]));
    const pool = [];
    for (const e of world.forces) {
      const f = e.tags.force;
      if (f.role === 'navy' && e.faction === fac && f.state === 'berth' && !e.agent) pool.push(e);
    }
    for (let k = 0; k < want; k++) {
      const e = pool[k] || addNavy(state, fac);
      if (!e) break;
      e.tags.force.zone = z.id;
      e.tags.force.post = anchor.id;
      sendTo(state, e, anchor);
    }
  });
}

/** A zone is over: its warships go home, its pirates stay at large, its anchor goes. */
export function standDown(state, z) {
  const world = getWorld(state);
  for (const e of [...world.forces]) {
    const f = e.tags.force;
    if (f.zone !== z.id) continue;
    f.zone = null; f.post = null;
    if (e.agent) {
      // Awake: it finishes what it is doing and goes home when it next sleeps
      e.agent.zone = null; e.agent.enemies = [];
      if (e.agent.role === 'navy') e.agent.home = f.home ? { kind: 'entity', id: f.home } : null;
      continue;
    }
    const home = world.get(f.home);
    if (f.role === 'navy' && home) sendTo(state, e, home);
    else if (f.state === 'transit') { world.refresh(e, state.clock.minute); lieUp(e, state.clock.minute); f.state = 'post'; }
  }
  world.remove(`anchor-${z.id}`);
}

/** Hulls on station at a zone and on rails, by faction: who is there to fight it out unseen. */
export function forcesAt(state, z) {
  const out = {};
  for (const e of getWorld(state).forces) {
    const f = e.tags.force;
    if (f.zone !== z.id || f.state !== 'post' || e.agent) continue;
    (out[e.faction] ||= []).push(e);
  }
  return out;
}

/**
 * A ship lost away from us: it becomes a wreck where it was, held with
 * the zone's body (salvage). Traffic it was is replaced in time.
 */
export function wreckInPlace(state, e, body) {
  const world = getWorld(state);
  const now = state.clock.minute;
  world.refresh(e, now);
  if (e.tags.force) world.setForce(e, null);
  if (e.tags.traffic) { e.tags.traffic = false; if (state.traffic) state.traffic.spawned = Math.max(0, state.traffic.spawned - 1); }
  const b = getBody(body);
  const bp = b ? bodyPos(b, now / DAY_MIN) : { x: 0, y: 0 };
  e.transit = null;
  e.orbit = { body: b ? body : 'Sol', r: Math.max(0.0005, distAU(e.pos, bp)), phase: Math.atan2(e.pos.y - bp.y, e.pos.x - bp.x), period: 0 };
  e.thrust = 0;
  e.transponder = false;
  const h = ensureHull(e);
  h.status = 'wreck'; h.hp = 0; h.drive = 0; h.reactor = 0; h.weapons = 0; h.containment = null; h.scrammed = true;
  e.tags.wreck = true;
  e.tags.despawnAt = now + 8 * DAY_MIN;
  e.name = `${e.name} (wreck)`;
  world.refresh(e, now);
  world.hash.update(e);
  return e;
}

// ---- THE LIVE WINDOW ----

/** Per minute (not on lite warp minutes): wake hulls that came within reach. Daily: the census. */
export function forcesTick(state, { lite = false } = {}) {
  if (!forcesOn(state)) return;
  const now = state.clock.minute;
  if (!lite && !state.lost) wakeNear(state);
  if (now % DAY_MIN === 420) census(state);
}

function wakeNear(state) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const us = state.flight.pos;
  const awake = { police: 0, navy: 0, pirate: 0 };
  const near = [];
  for (const e of world.forces) {
    const f = e.tags.force;
    if (e.agent) { awake[f.role]++; continue; }
    if (f.state === 'berth' || (f.rest && now < f.rest)) continue;
    // far hulls' positions may be an hour stale: a cheap filter first, then exact
    if (distAU(e.pos, us) > WAKE_AU * 1.5) continue;
    world.refresh(e, now);
    world.hash.update(e);
    const d = distAU(e.pos, us);
    if (d < WAKE_AU) near.push([d, e]);
  }
  if (!near.length) return;
  near.sort((a, b) => a[0] - b[0]);
  for (const [, e] of near) {
    const role = e.tags.force.role;
    if (awake[role] >= MAX_AWAKE[role]) continue;
    rouse(state, e);
    awake[role]++;
  }
}

/** Put a background hull under its own command (opts go to the agent: a director's errand). */
export function rouse(state, e, opts = {}) {
  const f = e.tags.force;
  const zone = f.zone ? state.politics.zones.find(z => z.id === f.zone) : null;
  const station = (id) => (id ? { kind: 'entity', id } : null);
  if (f.role === 'police') wake(state, e, 'patrol', { home: station(f.home), routine: true, ...opts });
  else if (f.role === 'navy') {
    const enemies = zone?.kind === 'skirmish' ? zone.factions.filter(x => x !== e.faction) : [];
    wake(state, e, 'navy', { zone: f.zone, home: station(f.post || f.home), enemies, ...opts });
  } else wake(state, e, 'pirate', { zone: f.zone, ...opts });
  f.state = 'awake';
  return e;
}

/**
 * An agent with nothing more to do with us, far away: back on rails
 * instead of out of the world. Returns false when it isn't ours to keep
 * (a director's walk-on, a crippled hulk): the caller removes it.
 */
export function putToSleep(state, e) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const h = e.combat;
  const crippled = h && (h.status !== 'ok' || h.drive < 0.3);
  const f = e.tags.force;
  if (!f && e.tags.woke !== 'traffic') return false;
  if (crippled) { if (f) world.setForce(e, null); return false; }
  e.agent = null;
  world.setDriven(e, false);
  e.thrust = 0;
  if (f) {
    f.rest = now + REST_MIN;
    const dest = world.get(f.post) || (f.role !== 'pirate' ? world.get(f.home) : null);
    if (dest) { sendTo(state, e, dest); return true; }
    lieUp(e, now);
    f.state = 'post';
  } else {
    // Traffic woken by a fight: back on its route (or a new one)
    delete e.tags.woke;
    const dest = world.get(e.tags.to) || pick(world.stations);
    if (!dest) return false;
    const T = railTo(world, e, dest, now, e.tags.g || 1);
    e.tags.traffic = true;
    e.tags.to = dest.id;
    e.tags.until = now + T;
    if (state.traffic) state.traffic.spawned++;
  }
  world.refresh(e, now);
  world.hash.update(e);
  return true;
}

/** The nearest hull of a role (and faction) on rails within reach of us, for the encounter director. */
export function nearestAsleep(state, role, faction = null, reachAU = DISPATCH_AU) {
  if (!forcesOn(state)) return null;
  const us = state.flight.pos;
  let best = null, bd = reachAU;
  for (const e of getWorld(state).forces) {
    const f = e.tags.force;
    if (f.role !== role || e.agent || f.state === 'berth' || (faction && e.faction !== faction)) continue;
    const d = distAU(e.pos, us);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Hulls of a role already awake around us (for the director: don't send what is already here). */
export function awakeNear(state, role, faction = null, reachAU = WAKE_AU) {
  const us = state.flight.pos;
  const out = [];
  for (const e of getWorld(state).forces) {
    if (!e.agent || e.tags.force.role !== role || (faction && e.faction !== faction)) continue;
    if (distAU(e.pos, us) < reachAU) out.push(e);
  }
  return out;
}

// ---- THE CENSUS ----

/** Daily: losses are made good (police per station, navies to strength), pirates kept to their number. */
function census(state) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const police = {}, navy = {}, loose = [];
  for (const e of [...world.forces]) {
    const f = e.tags.force;
    if (e.combat?.status === 'wreck') { world.setForce(e, null); continue; }
    if (f.role === 'police') police[f.home] = (police[f.home] || 0) + 1;
    else if (f.role === 'navy') navy[e.faction] = (navy[e.faction] || 0) + 1;
    else if (!f.zone) loose.push(e);
  }
  for (const st of policedStations(world)) {
    for (let n = police[st.id] || 0; n < POLICE_PER_STATION; n++) addPolice(state, st);
  }
  for (const [fac, want] of Object.entries(NAVY_STRENGTH)) {
    const short = Math.min(Math.max(1, Math.round(REINFORCE_SHARE * want)), want - (navy[fac] || 0));
    for (let i = 0; i < short; i++) addNavy(state, fac);
  }
  if (loose.length < PIRATES_AT_LARGE) {
    const lairs = lairBodies(now);
    for (let i = 0; i < Math.min(3, PIRATES_AT_LARGE - loose.length) && lairs.length; i++) addPirate(state, pick(lairs));
  } else if (loose.length > PIRATES_AT_LARGE * 1.5) {
    // Packs from ended zones disperse (never in front of us)
    const us = state.flight.pos;
    for (const e of loose.slice(0, loose.length - PIRATES_AT_LARGE)) {
      if (!e.agent && distAU(e.pos, us) > SLEEP_AU) world.remove(e);
    }
  }
}

/** For the dev panel and the tests: hulls by role and state. */
export function forcesSummary(state) {
  const out = { police: 0, navy: 0, pirate: 0, awake: 0, transit: 0, post: 0, berth: 0 };
  for (const e of getWorld(state).forces) {
    const f = e.tags.force;
    out[f.role]++;
    out[e.agent ? 'awake' : f.state] = (out[e.agent ? 'awake' : f.state] || 0) + 1;
  }
  return out;
}
