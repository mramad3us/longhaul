// ============================================================
// LONGHAUL — Ambient traffic
// NPC ships live at stations and fly between them. Docked ships ride
// on rails beside their station; ships in transit follow the analytic
// transit model (world.js). Neither needs numerical integration, and
// schedules are serviced by the world's budgeted background pass, so
// the population can scale to hundreds of thousands. A game starts
// with DEFAULT_TRAFFIC ships: the thousands a settled system would
// have, most of them out of sight and known only from the traffic
// digests (intel.js).
//
// Trade runs along lanes: a ship picks its next port by distance and
// by flag (its own power's ports first, independents next), so the
// Belt trades mostly with itself and Earth–Mars is a busy lane.
// ============================================================

import { AU_M, G0, MIN_S } from '../core/constants.js';
import { random, randRange, randInt, pick, weightedPick } from '../core/rng.js';
import { getWorld, WORLD_VISITORS } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity, CLASSES } from './ship-classes.js';

export const DEFAULT_TRAFFIC = 3000;

export function createTraffic(population = DEFAULT_TRAFFIC) {
  return { population, spawned: 0, v: 2 };
}

/** A port for the next leg: near and friendly ports are likelier. */
function nextPort(all, from, faction) {
  return weightedPick(all.filter(s => s !== from), s => {
    const d = Math.hypot(s.pos.x - from.pos.x, s.pos.y - from.pos.y);
    const kin = s.faction === faction ? 3 : (s.faction === 'independent' || faction === 'independent') ? 1.5 : 1;
    return kin / (0.5 + d);
  });
}

function dockBeside(e, station, minute, stayMin) {
  e.transit = null;
  e.thrust = 0;
  const o = station.orbit;
  e.orbit = { body: o.body, r: o.r * (1 + randRange(-0.01, 0.01)), phase: o.phase + randRange(-0.002, 0.002), period: o.period };
  e.tags.at = station.id;
  e.tags.until = minute + stayMin;
}

function depart(world, e, minute) {
  const all = world.stations;
  const from = world.get(e.tags.at);
  if (!from || all.length < 2) { e.tags.until = minute + 720; return; }
  const to = nextPort(all, from, e.faction);
  world.refresh(from, minute); world.refresh(to, minute);
  const L = Math.hypot(to.pos.x - from.pos.x, to.pos.y - from.pos.y) * AU_M;
  const g = e.tags.g;
  const T = Math.max(30, Math.round(2 * Math.sqrt(L / (g * G0)) / MIN_S));
  e.orbit = null;
  e.transit = { from: from.id, to: to.id, t0: minute, t1: minute + T, g };
  e.tags.at = null;
  e.tags.to = to.id;
  e.tags.until = minute + T;
}

/** Background visitor: dock arrivals, launch departures. */
function serviceShip(e, minute, world) {
  if (!e.tags?.traffic || minute < e.tags.until) return;
  if (e.transit) {
    const dest = world.get(e.transit.to);
    if (dest) dockBeside(e, dest, minute, randInt(4 * 60, 4 * 1440));
    else e.transit = null;
  } else if (e.orbit && e.tags.at) {
    depart(world, e, minute);
  } else return;
  world.refresh(e, minute);
  world.hash.update(e);
}
WORLD_VISITORS.push(serviceShip);

/** Create one NPC ship docked at a random station. */
export function spawnTrafficShip(state, minute = state.clock.minute) {
  const world = getWorld(state);
  const all = world.stations;
  if (!all.length) return null;
  const home = pick(all);
  const id = rollIdentity({ category: 'civilian', near: home.faction });
  const e = createEntity({
    id: world.newId('npc'), name: id.name, type: 'ship', faction: id.faction, cls: id.cls, tl: id.tl, shipClass: id.shipClass, mass: id.mass,
    orbit: { ...home.orbit }, t: minute, tags: { traffic: true, g: Math.min(CLASSES[id.cls].drive.maxG, pick([0.3, 0.3, 0.5, 1, 1, 1.5])) },
  });
  e.transponder = random() > 0.1;
  dockBeside(e, home, minute, randInt(60, 3 * 1440));
  if (state.traffic) state.traffic.spawned++;
  return world.add(e);
}

/** Hourly: keep the population topped up. */
export function trafficTick(state) {
  const T = state.traffic;
  if (!T || state.clock.minute % 60 !== 13) return;
  if (T.spawned < T.population) spawnTrafficShip(state);
}

/**
 * A save from before the background population (v0.10): bring the traffic
 * up to the thousands of a new game, already spread across their schedules.
 */
export function ensurePopulation(state) {
  const T = state.traffic;
  if (!T || T.v >= 2) return 0;
  T.v = 2;
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
    if (random() < 0.5) {
      // half are mid-flight at game start
      depart(world, e, state.clock.minute);
      const shift = Math.floor(random() * (e.transit.t1 - e.transit.t0) * 0.9);
      e.transit.t0 -= shift; e.transit.t1 -= shift; e.tags.until -= shift;
      world.refresh(e, state.clock.minute);
      world.hash.update(e);
    }
  }
}
