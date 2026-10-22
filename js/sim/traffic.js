// ============================================================
// LONGHAUL — Ambient traffic
// NPC ships live at stations and fly between them. Ships in port ride on
// rails (a berth turns with its station; a holding slot is an orbit);
// ships under way follow the analytic transit model (world.js). Neither
// needs numerical integration, and schedules are serviced by the world's
// budgeted background pass, so the population can scale to hundreds of
// thousands. A game starts with DEFAULT_TRAFFIC ships: the thousands a
// settled system would have, most of them out of sight and known only
// from the traffic digests (intel.js).
//
// Trade runs along lanes: a ship picks its next port by distance and by
// flag (its own power's ports first, independents next), so the Belt
// trades mostly with itself and Earth–Mars is a busy lane.
//
// Ships are lost (to pirates, to wars, to blockades). Each is replaced in
// time by a new hull launched at its power's yards (TRAFFIC_YARDS), a day
// to a few days later, which takes up the trade from there.
//
// A PORT CALL is decided on arrival, by what the ship is (CALLS): the work
// that needs a berth (cargo across the collar, passengers through the
// lock, ore sold to the smelter) and how long it takes, and the layover
// after (a crew's rest, waiting on a charter). A berth costs and there are
// ships waiting for it, so a ship holds one only for the work, then moves
// out to the holding pattern (holding.js) for its layover, or leaves:
//
//   arrive at the gate ─┬─ work needs a berth, one free ── BERTH (work) ─┬─ layover ── SLOT ── depart
//                       │                                                └─ depart
//                       ├─ no berth free ── SLOT (waiting; asks again) ── berth, or the work by tender
//                       └─ nothing to do in a berth ── SLOT (layover) ── depart
//
// A ship too big for any berth (the ice haulers) works by tender from its
// slot. A pattern that is full sends the overflow to the anchorage, a
// parking orbit further out. Every move inside a port is a short leg
// through the station's approach gate, so nothing climbs out of a port
// through the rock it is built on.
// ============================================================

import { AU_M, G0, MIN_S } from '../core/constants.js';
import { random, randInt, pick, weightedPick } from '../core/rng.js';
import { getWorld, WORLD_VISITORS, orbitStateAt } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity, CLASSES } from './ship-classes.js';
import { berthInto, releaseHull, gateId, berthSizesFor, freeBerth, anchorageOrbit } from './stations.js';
import { freeSlot, claimSlot, slotOrbit } from './holding.js';

export const DEFAULT_TRAFFIC = 3000;

const H = 60;
/**
 * What a ship comes into port for, by its kind: berth work in minutes
 * ([min, max]: null when it never needs a berth), the chance a call has
 * berth work at all, and the layover after ([min, max], in a slot).
 */
export const CALLS = {
  prospector: { work: [1 * H, 3 * H], p: 0.7, lay: [6 * H, 48 * H] },     // sell the haul and the claim data; rest the crew
  courier: { work: [0.5 * H, 1.5 * H], p: 0.95, lay: [0, 4 * H] },        // mail and a few passengers: in and out
  shuttle: { work: [1 * H, 3 * H], p: 0.9, lay: [0, 3 * H] },             // a lighter: load, go
  'light-freighter': { work: [2 * H, 6 * H], p: 0.85, lay: [0, 24 * H] }, // cargo and passengers; waits on the next charter
  freighter: { work: [6 * H, 16 * H], p: 0.5, lay: [0, 12 * H] },         // bulk across a cargo cradle (else by lighters from the slot)
  tanker: { work: [4 * H, 10 * H], p: 0.5, lay: [0, 6 * H] },             // reaction mass into the port's tanks (else by tender)
  liner: { work: [3 * H, 8 * H], p: 0.5, lay: [0, 0] },                   // passengers off and on, then away on schedule (else by shuttle)
  miner: { work: [6 * H, 12 * H], p: 0.5, lay: [12 * H, 72 * H] },        // ore to the smelter; a long rest between claims
  hauler: { work: null, tender: [12 * H, 36 * H], p: 1, lay: [0, 6 * H] },// too big for any berth: ice by tender from the slot
  default: { work: [1 * H, 4 * H], p: 0.5, lay: [2 * H, 24 * H] },
};
const RETRY_MIN = [30, 90];          // a ship waiting for a berth asks again
const GIVE_UP_MIN = 4 * H;           // …and after this does the work by tender, slowly
const TENDER_SLOWER = 1.6;
const IN_FLIGHT = 0.9;               // share of a new game's traffic under way (about the steady state)

export function createTraffic(population = DEFAULT_TRAFFIC) {
  return { population, spawned: 0, v: 3 };
}

/** A port for the next leg: near and friendly ports are likelier. */
function nextPort(all, from, faction) {
  return weightedPick(all.filter(s => s !== from), s => {
    const d = Math.hypot(s.pos.x - from.pos.x, s.pos.y - from.pos.y);
    const kin = s.faction === faction ? 3 : (s.faction === 'independent' || faction === 'independent') ? 1.5 : 1;
    return kin / (0.5 + d);
  });
}

const span = ([a, b]) => randInt(Math.round(a), Math.round(b));

/** Decide what this call is: { work (min in a berth, 0 if none), lay (min in a slot), tender (min, work from the slot) }. */
export function planCall(e) {
  const c = CALLS[CLASSES[e.cls]?.kind] || CALLS.default;
  const canBerth = berthSizesFor(e.cls).length > 0;
  const lay = span(c.lay);
  if (c.work && canBerth && random() < c.p) return { work: span(c.work), lay, tender: 0 };
  if (c.tender || c.work) return { work: 0, lay, tender: Math.round(span(c.tender || c.work) * (c.tender ? 1 : TENDER_SLOWER)) };
  return { work: 0, lay: Math.max(lay, 60), tender: 0 };
}

/** Local legs (berth, gate, slot) are flown gently. */
const LOCAL_G = 0.2;

/** Where a leg ends: an entity id, or { orbit } (a holding slot). */
const endOf = (world, spec) => typeof spec === 'string' ? world.get(spec) : spec;

/**
 * Start one leg of a passage: from where the ship is (a fix, when
 * `from` is null), from a rails entity, or from a slot's orbit; to an
 * entity or an orbit. `port` names the station the leg belongs to.
 */
function flyLeg(world, e, minute, from, to, g, port = e.tags.to || e.tags.at) {
  const A = from ? endOf(world, from) : null, B = endOf(world, to);
  if (!B || (from && !A)) return false;
  world.refresh(e, minute);
  const posOf = (x) => {
    if (!x.id) { const p = { x: 0, y: 0 }; orbitStateAt(x.orbit, minute, p, { vx: 0, vy: 0 }); return p; }
    world.refresh(x, minute); return x.pos;
  };
  const origin = A ? posOf(A) : e.pos, dest = posOf(B);
  const L = Math.hypot(dest.x - origin.x, dest.y - origin.y) * AU_M;
  const T = Math.max(10, Math.round(2 * Math.sqrt(L / (g * G0)) / MIN_S));
  e.orbit = null;
  const tr = { t0: minute, t1: minute + T, g, port };
  if (!A) tr.fix = { x: e.pos.x, y: e.pos.y, vx: e.vel.vx, vy: e.vel.vy, t: minute };
  else if (A.id) tr.from = A.id; else tr.fromOrbit = A.orbit;
  if (B.id) tr.to = B.id; else tr.toOrbit = B.orbit;
  e.transit = tr;
  e.tags.until = minute + T;
  return true;
}

// ---- IN PORT ----

/** Into a berth for the work (stations.js berthInto); false if none is free. */
function takeBerth(world, e, st, minute, work) {
  if (!berthInto(world.state, e, st)) return false;
  e.tags.call.phase = 'work';
  e.tags.until = minute + work;
  return true;
}

/** Into a holding slot (or the anchorage when the pattern is full), on rails, until `until`. */
function takeSlot(world, e, st, minute, phase, until) {
  releaseHull(world, e);
  e.transit = null; e.thrust = 0;
  e.tags.at = st.id;
  const s = freeSlot(world.state, st);
  if (s) {
    claimSlot(st, s.id, e.id);
    e.tags.slot = s.id;
    e.orbit = slotOrbit(st.id, s.id);
  } else {
    e.tags.slot = null;
    e.orbit = anchorageOrbit(st.id, random() * 2 * Math.PI);
  }
  e.tags.call.phase = phase;
  e.tags.until = until;
}

/** Leave a slot or a berth: free it (the ship is under way after this). */
function leavePort(world, e) {
  releaseHull(world, e);
  e.tags.at = null;
}

/** A ship at the gate of its destination: decide the call and go in. */
function arrive(world, e, st, minute) {
  const call = e.tags.call = { ...planCall(e), since: minute, port: st.id };
  if (call.work > 0) {
    const sizes = berthSizesFor(e.cls);
    if (freeBerth(world.state, st, sizes, { reserve: true })) { e.tags.ends = 'berth'; return flyLeg(world, e, minute, gateId(st.id), st.id, LOCAL_G, st.id); }
    call.giveUp = minute + GIVE_UP_MIN;
    return toSlot(world, e, st, minute, 'wait');
  }
  return toSlot(world, e, st, minute, call.tender ? 'tender' : 'lay');
}

/** Down from the gate to a slot: a short leg, then the slot. */
function toSlot(world, e, st, minute, phase) {
  const s = freeSlot(world.state, st);
  e.tags.ends = phase;
  if (!s) return flyLeg(world, e, minute, gateId(st.id), st.id, LOCAL_G, st.id);   // (no slot: the anchorage, from the station)
  claimSlot(st, s.id, e.id);                                     // (held for it while it comes in)
  e.tags.slot = s.id;
  e.tags.at = st.id;
  return flyLeg(world, e, minute, world.get(gateId(st.id)) ? gateId(st.id) : null, { orbit: slotOrbit(st.id, s.id) }, LOCAL_G, st.id);
}

/** A leg is over: what the ship does where it has come to. */
function landed(world, e, minute) {
  const ends = e.tags.ends;
  e.tags.ends = null;
  const st = world.get(e.tags.to || e.tags.at || e.transit?.port);
  if (st && ends === 'gate') { arrive(world, e, st, minute); return; }
  const call = e.tags.call;
  if (!st || !call) { e.transit = null; return; }
  if (ends === 'berth') {
    if (takeBerth(world, e, st, minute, call.work)) return;
    // the berth went while we came down: wait in the pattern
    call.giveUp = minute + GIVE_UP_MIN;
    takeSlot(world, e, st, minute, 'wait', minute + span(RETRY_MIN));
    return;
  }
  const until = ends === 'wait' ? minute + span(RETRY_MIN) : ends === 'tender' ? minute + call.tender + call.lay : minute + call.lay;
  const slotId = e.tags.slot;
  if (slotId && slotOrbit(st.id, slotId)) {
    // into the slot held for it on the way in
    claimSlot(st, slotId, e.id);
    e.tags.at = st.id;
    e.transit = null; e.thrust = 0;
    e.orbit = slotOrbit(st.id, slotId);
    call.phase = ends;
    e.tags.until = until;
  } else takeSlot(world, e, st, minute, ends, until);
}

/** Leave port: up to the gate (from a berth), then the long leg to the next port's gate. */
function depart(world, e, minute) {
  const all = world.stations;
  const from = world.get(e.tags.at);
  if (!from || all.length < 2) { e.tags.until = minute + 720; return; }
  const to = nextPort(all, from, e.faction);
  const g = e.tags.g;
  const fromGate = gateId(from.id), toGate = gateId(to.id);
  const inSlot = !!e.tags.slot;
  const slot = inSlot ? { orbit: e.orbit } : null;
  leavePort(world, e);
  e.tags.call = null;
  e.tags.to = to.id;
  e.tags.from = from.id;
  e.tags.ends = 'gate';
  // out through the gate, from a berth or a slot (a slot's line to the gate clears the rock:
  // holding.js; straight from the slot onto the long leg might not), then the long leg
  e.tags.legs = [[fromGate, toGate, g]];
  if (!flyLeg(world, e, minute, slot, world.get(fromGate) ? fromGate : to.id, LOCAL_G, from.id)) e.tags.until = minute + 720;
}

/** In port, time's up for what it was doing: the next step of the call. */
function nextInPort(world, e, minute) {
  const st = world.get(e.tags.at);
  const call = e.tags.call;
  if (!st || !call) { depart(world, e, minute); return; }
  if (call.phase === 'work') {
    // the work is done: out of the berth, a layover in the pattern or away
    if (call.lay > 0) {
      releaseHull(world, e);
      const s = freeSlot(world.state, st);
      e.tags.ends = 'lay';
      if (s) { claimSlot(st, s.id, e.id); e.tags.slot = s.id; }
      flyLeg(world, e, minute, null, world.get(gateId(st.id)) ? gateId(st.id) : st.id, LOCAL_G, st.id);
      e.tags.legs = s ? [[gateId(st.id), { orbit: slotOrbit(st.id, s.id) }, LOCAL_G]] : null;
      return;
    }
    depart(world, e, minute);
    return;
  }
  if (call.phase === 'wait') {
    const sizes = berthSizesFor(e.cls);
    if (freeBerth(world.state, st, sizes, { reserve: true })) {
      // a berth: out of the slot to the gate, down to it
      const slot = { orbit: e.orbit };
      leavePort(world, e);
      e.tags.at = st.id;
      e.tags.ends = 'berth';
      flyLeg(world, e, minute, slot, world.get(gateId(st.id)) ? gateId(st.id) : st.id, LOCAL_G, st.id);
      e.tags.legs = [[gateId(st.id), st.id, LOCAL_G]];
      return;
    }
    if (minute >= (call.giveUp ?? 0)) {
      // no berth today: the work by tender from here, slowly, then the layover
      call.phase = 'tender';
      e.tags.until = minute + Math.round(call.work * TENDER_SLOWER) + call.lay;
      return;
    }
    e.tags.until = minute + span(RETRY_MIN);
    return;
  }
  depart(world, e, minute);
}

/** Background visitor: the next step of a ship's passage or its port call. */
function serviceShip(e, minute, world) {
  if (!e.tags?.traffic || minute < e.tags.until) return;
  if (e.transit) {
    const next = e.tags.legs?.shift();
    if (next && endOf(world, next[1]) && (!next[0] || endOf(world, next[0]))) flyLeg(world, e, minute, next[0], next[1], next[2]);
    else { e.tags.legs = null; landed(world, e, minute); }
  } else if (e.orbit && e.tags.at) {
    nextInPort(world, e, minute);
  } else return;
  world.refresh(e, minute);
  world.hash.update(e);
}
WORLD_VISITORS.push(serviceShip);

/** Create one NPC ship in port (at a random station, or `home`), somewhere in a call. */
export function spawnTrafficShip(state, minute = state.clock.minute, home = null) {
  const world = getWorld(state);
  const all = world.stations;
  if (!all.length) return null;
  home ||= pick(all);
  const id = rollIdentity({ category: 'civilian', near: home.faction, state });
  const e = createEntity({
    id: world.newId('npc'), name: id.name, type: 'ship', faction: id.faction, cls: id.cls, tl: id.tl, shipClass: id.shipClass, mass: id.mass,
    orbit: { ...home.orbit }, t: minute, tags: { traffic: true, g: Math.min(CLASSES[id.cls].drive.maxG, pick([0.3, 0.3, 0.5, 1, 1, 1.5])) },
  });
  e.transponder = random() > 0.1;
  if (id.sub) e.sub = id.sub;
  world.add(e);
  // part-way through a call: at work in a berth if it has work and one is free, else in the pattern
  const call = e.tags.call = { ...planCall(e), since: minute, port: home.id };
  const left = (n) => Math.max(1, Math.round(n * random()));
  if (call.work > 0 && takeBerth(world, e, home, minute, left(call.work))) { /* working */ }
  else if (call.tender) takeSlot(world, e, home, minute, 'tender', minute + left(call.tender + call.lay));
  else takeSlot(world, e, home, minute, 'lay', minute + left(Math.max(60, call.lay)));
  world.refresh(e, minute);
  world.hash.update(e);
  if (state.traffic) state.traffic.spawned++;
  return e;
}

/**
 * Where new hulls are launched, by flag: a ship lost is replaced in time
 * (REPLACE_DAYS), by a new one out of its power's yards.
 */
export const TRAFFIC_YARDS = { UN: ['luna-yards'], MCR: ['phobos-yard'], OPA: ['tycho-station', 'ceres-station'], independent: ['ganymede-station', 'vesta-depot'] };
const REPLACE_DAYS = [1, 4];

/** Hourly: lay down replacements for ships lost, and launch those that are built. */
export function trafficTick(state) {
  const T = state.traffic;
  const now = state.clock.minute;
  if (!T || now % 60 !== 13) return;
  T.queue ??= [];
  const world = getWorld(state);
  if (T.spawned + T.queue.length < T.population && world.stations.length) {
    const flag = pick(world.stations).faction;
    T.queue.push({ at: now + Math.round(randInt(REPLACE_DAYS[0] * 24, REPLACE_DAYS[1] * 24) * 60), faction: flag });
  }
  for (let i = T.queue.length - 1; i >= 0; i--) {
    const b = T.queue[i];
    if (b.at > now) continue;
    T.queue.splice(i, 1);
    const yards = (TRAFFIC_YARDS[b.faction] || TRAFFIC_YARDS.independent).map(id => world.get(id)).filter(Boolean);
    spawnTrafficShip(state, now, yards.length ? pick(yards) : null);
  }
}

/**
 * A save from before the background population (v0.10): bring the traffic
 * up to the thousands of a new game, already spread across their schedules.
 */
export function ensurePopulation(state) {
  const T = state.traffic;
  if (!T || T.v >= 2) return 0;
  T.v = 3;
  if (T.population <= 0 || T.population >= DEFAULT_TRAFFIC) return 0;
  const add = DEFAULT_TRAFFIC - T.spawned;
  T.population = DEFAULT_TRAFFIC;
  seedTraffic(state, add);
  return add;
}

/** Seed the starting population, already spread across their schedules. */
export function seedTraffic(state, count = state.traffic.population) {
  const world = getWorld(state);
  for (let i = 0; i < count; i++) {
    const e = spawnTrafficShip(state);
    if (!e) break;
    if (random() < IN_FLIGHT) {
      // most are under way at game start, on the long leg (passages take days, calls hours)
      const from = e.tags.at;
      e.tags.slot ||= null;
      depart(world, e, state.clock.minute);
      const leg = e.tags.legs?.shift();
      if (leg) flyLeg(world, e, state.clock.minute, leg[0], leg[1], leg[2]);
      if (!e.transit) continue;
      const shift = Math.floor(random() * (e.transit.t1 - e.transit.t0) * 0.9);
      e.transit.t0 -= shift; e.transit.t1 -= shift; e.tags.until -= shift;
      e.tags.from = from;
      world.refresh(e, state.clock.minute);
      world.hash.update(e);
    }
  }
}
