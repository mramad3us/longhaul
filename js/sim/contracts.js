// ============================================================
// LONGHAUL — Station contracts & services
//
// Stations in range post contracts on a schedule. Every contract is a
// physical errand with an entity to fly to:
//   CARGO / PASSENGERS / FUEL  — dock at the destination station, deliver
//   PLANETSIDE                 — take freight to a high orbit round a
//                                settled world, land it by shuttle
//   INVESTIGATE / MEDEVAC      — rendezvous with a ship, hail it, return
//                                (an investigation finds its crew alive, a
//                                dead hull, or debris: the ship blown apart
//                                when it dropped off comms, damage.js)
//   SALVAGE                    — hold formation with a derelict (the
//                                wreck of a ship dead for weeks) while the
//                                crew strips it (2h), return
//   SURVEY                     — loiter within 150k km of a survey mark
//                                for the required time, return
// Near hot zones (conflict.js) the boards also carry the dangerous work:
//   BOUNTY   — find a wanted pirate and put it out of action (destroyed,
//              wrecked, or its colours struck), return: the fee, and a
//              fixed sum a head for its crew brought back alive in our brig
//              (its captain worth CAPTAIN_HEADS of them), handed over with
//              the contract (bountyHeads). Graded PETTY to
//              MOST WANTED (BOUNTY_GRADES: its ship, its escorts, what it is
//              wanted for, how old and loose the last fix is, the pay). It
//              runs dark and is on no registry: it is named only by its
//              transponder or by its drive signature seen in its plume. The
//              brief says whether the signature is on file (c.sigKnown);
//              only the most wanted can be posted without one, and then
//              with the reason. Until it is named, the dark ships in the
//              search area of its last fix are possibles (hunts.js)
//   ESCORT   — fly formation with a convoy ship to its destination; it
//              waits for us just outside the station's approach gate
//              (inside it no ship comes uncleared: traffic-control.js),
//              departs when we join it there, flies to the destination's
//              gate and berths, and raiders will come
//   SMUGGLE  — carry contraband through a blockade or into inner-planet
//              space; an inspection that finds it ends the job
//   RECON    — get a navy picket inside radar range and hold a lock on it
//              without being identified, return
// A captain flying a power's flag gets that power's MILITARY work too
// (military.js): every slot of a command ship's board for as long as its
// fight lasts, and a share of the boards of stations near its fights.
// "Docked" = hard-docked at one of the station's berths (docking.js). The
// board can be read from anywhere in radio range; signing for work takes
// being in port (inside its port space, holding.js PORT_M: the approach,
// where its holding pattern is); loading, unloading, people and fuel across
// the collar take a hard seal. Work that ends in a report (a survey, an
// investigation, a bounty, recon, an escort brought in) is turned in from port.
//
// Every contract keeps what it said and what happened: the brief's facts
// stay on it (who posted it, the target, the last fix, the signature, the
// terms), and a timeline of what the nav computer called out about it
// (c.log, at most LOG_MAX lines, each stamped with its minute), signed to
// turned in or failed. The mission log shows both (ui/brief.js), for the
// work in hand and the last 40 finished.
//
// SERVICES: a ship's stores in port (PRICES: reaction mass, water, rations,
// air, med units, spares, PDC rounds; torpedoes, drones; a refit: refit.js) are
// priced by the station's market (market.js storeFactor: each store by the
// good it is made of: goods.js STORE_GOOD), and at a tenth at our command
// ship in a fight (service.js).
// ============================================================

import { AU_M, AU_KM, RANGE, DAY_MIN, G0, MIN_S } from '../core/constants.js';
import { random, randInt, randRange, pick, weightedPick, chance } from '../core/rng.js';
import { getWorld, restingOrbit } from './world.js';
import { inPortSpace, PORT_M } from './holding.js';
import { createEntity, newSignature } from './entities.js';
import { huntTick } from './hunts.js';
import { rollIdentity, CLASSES, TECH, hullPoints, PLAYER_CLASS } from './ship-classes.js';
import { FACTIONS, POWERS, SUBFACTIONS } from './factions.js';
import { zonePos } from './conflict.js';
import { spawnAgent, wake, makeHostile } from './agents.js';
import { PLAYER } from './combatants.js';
import { WARHEADS, AMMO_PRICES } from './weapons.js';
import { DRONE_PRICE } from './drones.js';
import { adjustStanding } from './law.js';
import { dockedStationEntity, dockedTo } from './docking.js';
import { gateOrbit } from './stations.js';
import { freeBerths } from './manifest.js';
import { MIL_TYPES, MIL_LABEL, milShare, milRefusal, generateMil, spawnMil, milProgress, milTurnIn } from './military.js';
import { blowApart, deadHull } from './damage.js';
import { WORLDS, airspacesOf, worldOf } from './worlds.js';
import { storeFactor } from './market.js';
import { STORE_GOOD } from './goods.js';
import { bodyPos } from './ephemeris.js';
import { entryProfile, ascentProfile } from './planetary.js';
import { licenseOf, ourCommandShip, supplyPriceFactor, creditMission, rankOf, RANK_FOR, flagOf } from './service.js';

export const ContractType = {
  CARGO: 'CARGO', PASSENGERS: 'PASSENGERS', FUEL: 'FUEL', PLANETSIDE: 'PLANETSIDE',
  INVESTIGATE: 'INVESTIGATE', SALVAGE: 'SALVAGE', SURVEY: 'SURVEY', MEDEVAC: 'MEDEVAC',
  BOUNTY: 'BOUNTY', ESCORT: 'ESCORT', SMUGGLE: 'SMUGGLE', RECON: 'RECON',
  INTEL: 'INTEL', HOLD: 'HOLD', STRIKE: 'STRIKE', COVERT: 'COVERT',
};

export const CONTRACT_LABEL = {
  CARGO: 'CARGO HAUL', PASSENGERS: 'PASSENGER TRANSPORT', FUEL: 'FUEL DELIVERY', PLANETSIDE: 'PLANETSIDE FREIGHT',
  INVESTIGATE: 'INVESTIGATE', SALVAGE: 'SALVAGE', SURVEY: 'SURVEY', MEDEVAC: 'MEDICAL EVAC',
  BOUNTY: 'BOUNTY', ESCORT: 'CONVOY ESCORT', SMUGGLE: 'BLOCKADE RUN', RECON: 'COVERT RECON',
  ...MIL_LABEL,
};

const CARGO = [
  ['mining equipment', 1000, 4000], ['water ice', 2000, 8000], ['reactor components', 500, 2000],
  ['medical supplies', 200, 800], ['food rations', 500, 2000], ['hull plating', 1500, 5000],
  ['electronic parts', 300, 1200], ['ore concentrate', 3000, 10000], ['atmosphere scrubbers', 400, 1500],
  ['fusion pellets', 100, 500],
];
const SURVEY_TARGETS = ['mineral deposits', 'debris density', 'anomalous readings', 'traffic patterns', 'radiation levels', 'micro-asteroid hazards', 'ice composition'];
const PASSENGER_KINDS = ['workers', 'miners', 'engineers', 'families', 'refugees', 'technicians', 'scientists', 'traders'];
const SECTORS = ['7-G', '12-K', '3-B', '9-F', '15-D', '22-A', '6-H', '18-C', '4-E', '11-J', '8-M', '14-L', '1-N', '20-P', '5-R'];

export const PRICES = { fuel: 2, water: 0.5, food: 3, o2Tank: 4, n2Tank: 1, medSupplies: 40, parts: 120, pdcRounds: AMMO_PRICES.pdcRounds };

/** Spares and yard time are priced by how the ship was built (TECH.price): Martian kit costs the most. */
const shipTech = (state) => TECH[state.ship.tl || CLASSES[state.ship.classId || PLAYER_CLASS].tl];

/**
 * Unit price of a resource for our ship where we are docked: what the
 * station's market makes of the good it is priced by (market.js
 * storeFactor: dear where it is short, cheap where it is plenty), and a
 * tenth of it at our command ship in a fight (service.js).
 */
export const priceOf = (state, key) => PRICES[key] * (key === 'parts' ? shipTech(state).price : 1) * supplyPriceFactor(state) * localFactor(state, STORE_GOOD[key]);
/** The market's say in a store's price where we are docked (none at a command ship, or away from a market). */
const localFactor = (state, good) => { const st = dockedStationEntity(state); return st && good ? storeFactor(state, st.id, good) : 1; };

export function createContracts() {
  return { active: [], history: [], nextId: 1 };
}

// ---- DOCKING ----

/** The station we're hard-docked at, or null. */
export function dockedStation(state) {
  return dockedStationEntity(state);
}

/** Where we can trade docked: a station, or our command ship in its fight (service.js). */
export function dockedPort(state) {
  return dockedStationEntity(state) || ourCommandShip(state);
}

// ---- GENERATION ----

const GEN = [
  { type: ContractType.CARGO, weight: 4, dest: true },
  { type: ContractType.PLANETSIDE, weight: 3 },
  { type: ContractType.PASSENGERS, weight: 3, dest: true },
  { type: ContractType.FUEL, weight: 2, dest: true },
  { type: ContractType.INVESTIGATE, weight: 2 },
  { type: ContractType.SALVAGE, weight: 3 },
  { type: ContractType.SURVEY, weight: 3 },
  { type: ContractType.MEDEVAC, weight: 2 },
];

function distAU(a, b) { return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y); }

/** What goes down to a world's ground in a shuttle: small, dear freight. */
const SURFACE_CARGO = [
  ['medical supplies', 300, 3000], ['seed stock', 500, 3500], ['pharmaceuticals', 200, 1500], ['electronic parts', 300, 2500],
  ['spare parts', 500, 3800], ['mail and personal effects', 100, 800], ['precision instruments', 200, 1200], ['water purifiers', 600, 3500],
];
/** A spaceport for freight from `station`: on a settled world near it (worlds.js), the nearer likelier. */
function surfaceSite(state, station) {
  const days = state.clock.minute / DAY_MIN;
  const near = WORLDS.filter(w => airspacesOf(w).length).map(w => { const p = bodyPos(w.body, days); return { w, d: Math.hypot(p.x - station.pos.x, p.y - station.pos.y) }; })
    .filter(x => x.d < 3.5).sort((a, b) => a.d - b.d).slice(0, 3);
  if (!near.length) return null;
  const pickW = weightedPick(near, x => 1 / (0.05 + x.d));
  return { w: pickW.w, a: pick(airspacesOf(pickW.w)), d: pickW.d };
}
/** Can our shuttles make a world's ground (and come back)? */
export const shuttleCanLand = (state, worldName) => (state.shuttles?.bay || []).some(s => entryProfile(worldName, s.cls) && ascentProfile(worldName, s.cls));

function generate(state, station, others) {
  // Military work, for a captain flying the flag of a power fighting near here (all of a command ship's board)
  const mil = milShare(state, station);
  if (mil >= 1 || (mil > 0 && chance(mil))) {
    const c = generateMil(state, station, `c-${state.contracts.nextId++}`);
    if (c || station.tags?.command) return c;
  }
  if (station.tags?.command) return null;
  if (chance(HOT_SHARE)) {
    const hot = generateHot(state, station, others);
    if (hot) return hot;
  }
  const gen = weightedPick(others.length ? GEN : GEN.filter(g => !g.dest));
  const id = `c-${state.contracts.nextId++}`;
  const now = state.clock.minute;
  const base = { id, type: gen.type, station: station.id, stationName: station.name, offeredAt: now, phase: 'offered' };
  switch (gen.type) {
    case ContractType.PLANETSIDE: {
      // freight to a world's ground: our shuttles take it down from a high orbit (shuttles.js)
      const site = surfaceSite(state, station);
      if (!site) return null;
      const [name, lo, hi] = pick(SURFACE_CARGO); const mass = Math.round(randInt(lo, hi) / 50) * 50;
      return { ...base, world: site.w.name, airspace: site.a.id, destName: `${site.a.port.name}, ${site.w.name}`, cargo: { name, mass },
        title: `Planetside: ${name} to ${site.a.port.name}`,
        description: `Land ${mass.toLocaleString()} kg of ${name} at ${site.a.port.name} on ${site.w.name}. Our own shuttle takes it down from a high orbit (a hull without a shuttle bay can't), the ${site.a.controller} clears the landing, and payment comes by radio when it is on the pad.`,
        reward: { credits: Math.round(mass * 0.9 + site.d * 1100 + 1800) }, deadline: randInt(5, 12) * DAY_MIN, expires: now + randInt(1, 3) * DAY_MIN };
    }
    case ContractType.CARGO: {
      const dest = pick(others); const [name, lo, hi] = pick(CARGO); const mass = randInt(lo, hi);
      const d = distAU(station, dest);
      return { ...base, dest: dest.id, destName: dest.name, cargo: { name, mass },
        title: `Cargo: ${name} to ${dest.name}`,
        description: `Deliver ${mass.toLocaleString()} kg of ${name} to ${dest.name}. Standard freight rates.`,
        reward: { credits: Math.round(mass * 0.3 + d * 900) }, deadline: randInt(4, 10) * DAY_MIN, expires: now + randInt(1, 3) * DAY_MIN };
    }
    case ContractType.PASSENGERS: {
      const dest = pick(others); const n = randInt(2, 14); const vip = random() < 0.15; const kind = pick(PASSENGER_KINDS);
      const d = distAU(station, dest);
      return { ...base, dest: dest.id, destName: dest.name, passengers: n, vip,
        title: `Transport: ${n} ${kind} to ${dest.name}${vip ? ' (VIP)' : ''}`,
        description: `Ferry ${n} ${kind} to ${dest.name}.${vip ? ' VIP passengers — bonus for a fast, comfortable transit.' : ''} They'll need air, water and food on the way.`,
        reward: { credits: Math.round(n * 120 + d * 700 + (vip ? 2500 : 0)) }, deadline: (vip ? randInt(3, 5) : randInt(5, 10)) * DAY_MIN, expires: now + randInt(12, 48) * 60 };
    }
    case ContractType.FUEL: {
      const dest = pick(others); const kg = randInt(5, 30) * 100;
      const d = distAU(station, dest);
      return { ...base, dest: dest.id, destName: dest.name, fuelKg: kg,
        title: `Resupply: ${kg} kg reaction mass to ${dest.name}`,
        description: `${dest.name} is running low on reaction mass. Deliver ${kg.toLocaleString()} kg from your own tanks; paid well above market.`,
        reward: { credits: Math.round(kg * PRICES.fuel * 2.2 + d * 500), water: randInt(100, 400), food: randInt(50, 200) }, deadline: randInt(3, 7) * DAY_MIN, expires: now + randInt(1, 3) * DAY_MIN };
    }
    case ContractType.INVESTIGATE: {
      const ship = rollIdentity({ category: 'civilian', near: station.faction, state }); const outcome = pick(['derelict', 'debris', 'alive']);
      const dist = randRange(0.004, 0.04), hours = randInt(2, 48);
      return { ...base, distAU: dist, ship, outcome, lostAt: now - hours * 60,
        title: `Investigate: ${ship.name} — contact lost`,
        description: `The ${ship.shipClass} "${ship.name}" dropped off comms ${hours} hours ago, ${Math.round(dist * AU_KM).toLocaleString()} km out. Find it, report what you see.`,
        reward: { credits: randInt(2000, 5000) }, deadline: randInt(4, 10) * DAY_MIN, expires: now + randInt(2, 4) * DAY_MIN };
    }
    case ContractType.SALVAGE: {
      const what = pick(['reactor components', 'drive assembly', 'hull plating', 'life support modules', 'nav computer', 'cargo containers', 'fuel cells']);
      const dist = randRange(0.003, 0.03);
      return { ...base, distAU: dist, salvage: what, workMin: 120,
        title: `Salvage: ${what}`,
        description: `A derelict sits ${Math.round(dist * AU_KM).toLocaleString()} km out. Hold formation while the crew strips the ${what} (≈2h), then bring it back.`,
        reward: { credits: randInt(1500, 4000), medSupplies: randInt(0, 5), fuel: randInt(0, 300) }, deadline: randInt(5, 10) * DAY_MIN, expires: now + randInt(2, 5) * DAY_MIN };
    }
    case ContractType.SURVEY: {
      const target = pick(SURVEY_TARGETS); const sector = pick(SECTORS); const scanMin = randInt(30, 240);
      const dist = randRange(0.003, 0.02);
      return { ...base, distAU: dist, scanMin, scanned: 0, sector, target,
        title: `Survey: sector ${sector} — ${target}`,
        description: `Loiter within 150,000 km of the sector ${sector} mark for ${Math.round(scanMin / 60 * 10) / 10}h of sensor time, then bring the data home.`,
        reward: { credits: randInt(900, 2600) }, deadline: randInt(5, 14) * DAY_MIN, expires: now + randInt(3, 7) * DAY_MIN };
    }
    case ContractType.MEDEVAC: {
      const ship = rollIdentity({ category: 'civilian', near: station.faction, state }); const n = randInt(1, 8);
      const dist = randRange(0.003, 0.02);
      return { ...base, distAU: dist, ship, casualties: n,
        title: `MedEvac: ${n} casualties aboard ${ship.name}`,
        description: `The ${ship.shipClass} "${ship.name}" reports ${n} injured after a ${pick(['reactor leak', 'decompression', 'collision', 'equipment failure'])}. Pick them up and bring them to ${station.name}.`,
        reward: { credits: randInt(1800, 4500), medSupplies: randInt(5, 15) }, deadline: randInt(1, 3) * DAY_MIN, expires: now + randInt(12, 36) * 60 };
    }
  }
  return null;
}

// ---- HOT-ZONE WORK ----

const STANDING_TO_TRADE = -20;        // below this a power's stations won't deal with us
const DERELICT_DAYS = [3, 60];     // how long ago a salvage job's derelict died

const HOT_TYPES = new Set([ContractType.BOUNTY, ContractType.ESCORT, ContractType.SMUGGLE, ContractType.RECON]);
const HOT_SHARE = 0.4;               // share of board slots offered to conflict work when any applies
const LOG_MAX = 30;                   // lines a contract's timeline keeps

/**
 * Who a wanted pirate is to the stations that post it. The grade sets its
 * ship (cls: weights), the raiders that run with it, how many counts it is
 * wanted on, how old the last fix is when posted (hours) and so how wide
 * its search area, the pay, the days given, the one chance a brief has no
 * drive signature on file (only the most wanted: about 3 bounties in 100),
 * and what each of its crew brought back alive is worth (perHead: always
 * more than the PIRATE_BOUNTY any pirate turned over earns, prisoners.js).
 */
export const BOUNTY_GRADES = [
  { grade: 1, label: 'PETTY', w: 0.35, cls: { 'pirate-runner': 2, 'pirate-raider': 1 }, escorts: [0, 0], counts: [1, 2], fixH: [3, 16], pay: [2000, 4000], perHead: 900, days: [5, 10], sigUnknown: 0 },
  { grade: 2, label: 'WANTED', w: 0.4, cls: { 'pirate-raider': 3, 'pirate-gunship': 1 }, escorts: [0, 0], counts: [2, 4], fixH: [6, 30], pay: [3500, 7500], perHead: 1000, days: [6, 12], sigUnknown: 0 },
  { grade: 3, label: 'NOTORIOUS', w: 0.18, cls: { 'pirate-gunship': 2, 'pirate-corvette': 1 }, escorts: [0, 1], counts: [3, 7], fixH: [12, 48], pay: [8000, 15000], perHead: 1200, days: [8, 16], sigUnknown: 0 },
  { grade: 4, label: 'MOST WANTED', w: 0.07, cls: { 'pirate-corvette': 1 }, escorts: [1, 2], counts: [5, 12], fixH: [24, 96], pay: [18000, 32000], perHead: 1500, days: [10, 20], sigUnknown: 0.4 },
];
export const CAPTAIN_HEADS = 4;       // a bounty's captain brought back alive is worth this many of its crew (a pirate captain turned over, three)

/**
 * What a bounty's crew in our brig is worth at its turn-in: { heads, captains,
 * pay, groups }. Only those taken off the bounty's own ship (prisoners.js
 * groups remember it), and only once the ship is out of action.
 */
export function bountyHeads(state, c) {
  const groups = c.type === ContractType.BOUNTY && c.perHead ? state.passengers.filter(p => p.kind === 'prisoners' && p.from === c.targetId) : [];
  let heads = 0, captains = 0;
  for (const g of groups) { heads += g.count; captains += g.notables || 0; }
  const pay = c.perHead ? c.perHead * (heads - captains) + (c.captainHead || c.perHead * CAPTAIN_HEADS) * captains : 0;
  return { heads, captains, pay, groups };
}
const SEARCH_KM = { base: 40_000, perHour: 5_000, min: 50_000, max: 500_000 };   // a fix's search area: older, wider

/** Why the most wanted can be posted with no drive signature on file: the authorities' own words. */
const SIG_UNKNOWN_WHY = [
  'Its reactor and drive were swapped out at a Belt yard that keeps no books, after its last confirmed sighting: the old signature is void, and nobody has logged the new one.',
  'A hull stolen out of a navy breakers\' yard and refitted off the record: its drive has never been catalogued anywhere.',
  'It has never burned where a station or navy sensor could see it and report: every ship that saw its plume was taken.',
  'Three sightings gave three different readings: whatever its engineer does to the plume, no signature on file can be trusted, so none is given.',
  'Built new in a yard that registers nothing, and it has only ever burned in deep space, far from any sensor that keeps a log.',
];

/** Who saw it last (a station's name goes in for {station}). */
const FIX_SOURCES = [
  'an ore hauler that got away from it', 'traffic control radar at {station}', 'a navy picket\'s track, passed on', 'a prospector\'s report',
  'the last position in a distress call, before it went silent', 'a tug crew who saw its plume',
];

/** What a pirate of a grade is wanted for, a line a count. */
function wantedFor(state, g, where) {
  const taken = randInt(g.counts[0], g.counts[1]);
  const out = [`${taken} ship${taken > 1 ? 's' : ''} boarded and stripped ${where}`];
  const dead = g.grade >= 2 ? randInt(0, taken * 3) : randInt(0, 1);
  if (dead) out.push(`${dead} dead among their crews`);
  if (g.grade >= 3) {
    const v = rollIdentity({ category: 'civilian', state });
    out.push(`the taking of the ${v.shipClass.toLowerCase()} ${v.name}: ${pick(['its crew spaced', 'its crew held for ransom', 'never seen again', 'its cargo sold on Ceres'])}`);
  }
  if (g.grade >= 4) out.push(pick(['firing on a police cutter', 'a torpedo through a passenger liner\'s drive section', 'selling stolen navy ordnance to the cells', 'the raid on a mining camp: every habitat holed']));
  return out;
}

/** Note what happened to a contract on its timeline (the mission log keeps it). */
export function logContract(state, c, text) {
  const L = c.log ||= [];
  L.push({ m: state.clock.minute, text });
  if (L.length > LOG_MAX) L.splice(0, L.length - LOG_MAX);
}
const HOT_REACH_AU = 0.6;             // zones this close to a station shape its board
const SMUGGLE_GOODS = ['unregistered weapons', 'medical supplies for the blockaded', 'protomolecule research samples', 'black-market fusion pellets', 'Belter militia ammunition', 'stolen navy parts'];

function zonesNear(state, station, reach) {
  const now = state.clock.minute;
  return state.politics.zones.filter(z => { const p = zonePos(z, now); return Math.hypot(p.x - station.pos.x, p.y - station.pos.y) <= reach; });
}

/** The station nearest a zone's body (the one a blockade strangles). */
function stationAt(state, z) {
  const p = zonePos(z, state.clock.minute);
  let best = null, bd = 0.05;
  for (const s of getWorld(state).stations) { const d = Math.hypot(s.pos.x - p.x, s.pos.y - p.y); if (d < bd) { bd = d; best = s; } }
  return best;
}

/**
 * A bounty for a station's board (its zone: the pirates' hot zone it is
 * near, or null). `base`: the board's common fields (generateHot), made
 * here when called alone.
 */
export function bountyOffer(state, station, zone = null, base = null) {
  const now = state.clock.minute;
  base ||= { id: `c-${state.contracts.nextId++}`, type: ContractType.BOUNTY, station: station.id, stationName: station.name, offeredAt: now, phase: 'offered', zone: zone?.id || null, zoneBody: zone?.body || null };
  // (the most wanted come where the pirates are)
  const g = weightedPick(BOUNTY_GRADES, x => x.w * (x.grade >= 3 && !zone ? 0.4 : 1));
  const ship = rollIdentity({ cls: weightedPick(Object.keys(g.cls), k => g.cls[k]), faction: 'pirate', state });
  const body = zone?.body || station.orbit.body;
  const where = zone ? `near ${zone.body}` : `out past ${station.orbit.body}`;
  const sigKnown = !chance(g.sigUnknown);
  const signature = sigKnown ? newSignature() : null;
  const sigWhy = sigKnown ? null : pick(SIG_UNKNOWN_WHY);
  const distAU = randRange(0.008, 0.03);
  const fixH = randRange(g.fixH[0], g.fixH[1]);
  const rKm = Math.round(Math.min(SEARCH_KM.max, Math.max(SEARCH_KM.min, (SEARCH_KM.base + fixH * SEARCH_KM.perHour) * randRange(0.7, 1.3))) / 1000) * 1000;
  const fix = { at: Math.round(now - fixH * 60), by: pick(FIX_SOURCES).replace('{station}', station.name), rKm, body, distKm: Math.round(distAU * AU_KM / 1000) * 1000 };
  const escorts = randInt(g.escorts[0], g.escorts[1]);
  const wanted = wantedFor(state, g, where);
  return { ...base, ship, grade: g.grade, gradeLabel: g.label, sigKnown, signature, sigWhy, wanted, fix, escorts, body, distAU,
    title: `Bounty: the ${ship.name}`,
    description: `${g.label}. The ${ship.shipClass} "${ship.name}" is wanted for ${wanted.length > 1 ? `${wanted.slice(0, -1).join(', ')} and ${wanted.at(-1)}` : wanted[0]}. ${station.name} pays for it put out of action (destroyed, or its colours struck), and ${g.perHead.toLocaleString()} MCR a head for its crew brought back alive (its captain ${(g.perHead * CAPTAIN_HEADS).toLocaleString()}): board it, take them prisoner, and hand them over here. Last fixed ${fix.distKm.toLocaleString()} km off ${body}, ${Math.round(fixH)} hours before this posting (${fix.by}): search within ${rKm.toLocaleString()} km of the fix. It runs cold and dark${escorts ? `, with ${escorts === 1 ? 'another raider' : `${escorts} more raiders`} running with it` : ''}. ${sigKnown
      ? `Its drive signature is on file (${signature}): we will know it when it burns.`
      : `No drive signature on file. ${sigWhy} Only its transponder will name it: every dark hull out there is a maybe.`}`,
    reward: { credits: Math.round(randInt(g.pay[0], g.pay[1]) / 100) * 100 }, perHead: g.perHead, captainHead: g.perHead * CAPTAIN_HEADS, deadline: randInt(g.days[0], g.days[1]) * DAY_MIN, expires: now + randInt(2, 4) * DAY_MIN };
}

/** Conflict contracts this station can offer right now (or null). */
function generateHot(state, station, others) {
  const zones = zonesNear(state, station, HOT_REACH_AU);
  const options = [];
  const pirates = zones.find(z => z.kind === 'pirates');
  options.push({ type: ContractType.BOUNTY, w: pirates ? 3 : 0.6, zone: pirates });
  if (others.length) options.push({ type: ContractType.ESCORT, w: pirates ? 2.5 : 0.5, zone: pirates });
  const blockade = state.politics.zones.find(z => z.kind === 'blockade' && stationAt(state, z) && stationAt(state, z).id !== station.id);
  if ((station.faction === 'OPA' || station.faction === 'independent') && others.length) options.push({ type: ContractType.SMUGGLE, w: blockade ? 2.5 : 0.7, zone: blockade });
  const watchable = zones.filter(z => ['standoff', 'skirmish', 'insurgency'].includes(z.kind) && z.factions.some(f => f !== station.faction && POWERS.includes(f)));
  if (watchable.length) options.push({ type: ContractType.RECON, w: 2, zone: pick(watchable) });
  const o = weightedPick(options, x => x.w);
  const id = `c-${state.contracts.nextId++}`;
  const now = state.clock.minute;
  const base = { id, type: o.type, station: station.id, stationName: station.name, offeredAt: now, phase: 'offered', zone: o.zone?.id || null, zoneBody: o.zone?.body || null };
  switch (o.type) {
    case ContractType.BOUNTY: return bountyOffer(state, station, o.zone, base);
    case ContractType.ESCORT: {
      const dest = pick(others);
      const ship = rollIdentity({ category: 'civilian', kind: pick(['freighter', 'hauler', 'tanker']), near: station.faction, state });
      const g = Math.min(0.5, CLASSES[ship.cls].drive.cruiseG);
      const d = distAU(station, dest);
      return { ...base, dest: dest.id, destName: dest.name, ship, g,
        title: `Escort: ${ship.name} to ${dest.name}`,
        description: `Raiders have been hitting the ${station.name}–${dest.name} run. Fly escort for the ${ship.shipClass} "${ship.name}": it waits for us outside ${station.name}'s approach gate, departs when we join formation there (within 10 km) and burns at ${g}G. Keep it alive; collect at ${dest.name}.`,
        reward: { credits: Math.round(randInt(2500, 5000) + d * 600), pdcRounds: 3000 }, deadline: randInt(8, 20) * DAY_MIN, expires: now + randInt(1, 3) * DAY_MIN };
    }
    case ContractType.SMUGGLE: {
      const dest = blockade && o.zone ? stationAt(state, o.zone) : pick(others.filter(s => s.faction === 'UN' || s.faction === 'MCR')) || pick(others);
      const illegal = o.zone ? [o.zone.factions[0]] : POWERS.filter(f => f !== 'OPA');
      const name = pick(SMUGGLE_GOODS); const mass = randInt(200, 2000);
      const d = distAU(station, dest);
      const through = o.zone ? `through the ${FACTIONS[o.zone.factions[0]].navy} blockade ` : '';
      return { ...base, dest: dest.id, destName: dest.name, cargo: { name, mass, contraband: true, illegalIn: illegal },
        title: `Run ${name} to ${dest.name}`,
        description: `${mass.toLocaleString()} kg of ${name}, ${through}to ${dest.name}. No questions, no manifest. If ${illegal.map(f => FACTIONS[f].short).join(' or ')} inspectors find it, it's gone — and so is the fee. Run silent; don't let patrols stop you.`,
        reward: { credits: Math.round(randInt(6000, 12000) + d * 800) }, deadline: randInt(5, 12) * DAY_MIN, expires: now + randInt(1, 2) * DAY_MIN };
    }
    case ContractType.RECON: {
      const watched = o.zone.factions.find(f => f !== station.faction && POWERS.includes(f));
      const scanMin = randInt(30, 90);
      return { ...base, watched, body: o.zone.body, scanMin, scanned: 0,
        title: `Recon: ${FACTIONS[watched].navy} near ${o.zone.body}`,
        description: `A ${FACTIONS[watched].navy} picket is holding station near ${o.zone.body}. Get within 300,000 km, put a ranging lock on it and hold the track for ${scanMin} minutes. Run silent: if they identify us the job is blown, and ${FACTIONS[watched].short} will remember.`,
        reward: { credits: randInt(4000, 9000) }, deadline: randInt(5, 12) * DAY_MIN, expires: now + randInt(1, 3) * DAY_MIN };
    }
  }
  return null;
}

const CONVOY_WAIT_KM = 3;            // an escort's convoy waits this far out past its station's gate

/** Where an escort's convoy waits for us: just out past its station's gate, riding up with it. */
const convoyWait = (stationId) => { const o = gateOrbit(stationId); return { ...o, r: o.r + CONVOY_WAIT_KM / AU_KM }; };

/**
 * A save from before v0.27 left a waiting convoy inside its station's
 * keep-out, where nobody may come for it uncleared (and from an orbital
 * station's berths too far to join): out to the gate with it.
 */
export function upgradeContracts(state) {
  const world = getWorld(state);
  // (a hunt from before 1.1: its signature on file if it carried one; a bounty graded as the common run)
  const hunts = [...(state.contracts?.active || []), ...(state.contracts?.history || []), ...world.stations.flatMap(st => st.board?.missions || [])]
    .filter(c => c.type === ContractType.BOUNTY || c.type === 'STRIKE');
  for (const c of hunts) {
    c.sigKnown ??= !!c.signature;
    if (!c.sigKnown) c.sigWhy ??= 'It was not on file when the contract was posted.';
    if (c.type === ContractType.BOUNTY) { c.grade ??= 2; c.gradeLabel ??= 'WANTED'; }
    // (before 1.3, a surrender paid half again: now its crew are paid for by the head, brought back)
    if (c.type === ContractType.BOUNTY && c.aliveBonus != null && c.phase !== 'complete' && c.phase !== 'failed') {
      if (c.outcome === 'captured') c.reward = { ...c.reward, credits: Math.round(c.reward.credits / (1 + c.aliveBonus)) };
      c.perHead ??= (BOUNTY_GRADES.find(g => g.grade === c.grade) || BOUNTY_GRADES[1]).perHead;
      c.captainHead ??= c.perHead * CAPTAIN_HEADS;
      delete c.aliveBonus;
    }
  }
  // (a command ship's board drawn before 1.12.10, when an insurgency's posted only strikes and none kept work for our
  // rank: with nothing on it we can sign for, it looks again at once, and keeps such work from then on)
  for (const e of world.forces) {
    const b = e.tags?.command && e.board;
    if (b && flagOf(state) === e.faction && b.missions.length && !b.missions.some(m => !milRefusal(state, m))) b.lastRefresh = -Infinity;
  }
  // (an investigation's ship from before 1.12.7: debris was drawn as a whole hull, a derelict answered as if crewed;
  // when it was lost, from its brief)
  for (const c of [...(state.contracts?.active || []), ...(state.contracts?.history || []), ...world.stations.flatMap(st => st.board?.missions || [])]) {
    if (c.type !== ContractType.INVESTIGATE || c.lostAt != null) continue;
    c.lostAt = c.offeredAt - 60 * Number(/comms (\d+) hours ago/.exec(c.description || '')?.[1] ?? 24);
    const e = c.targetId && world.get(c.targetId);
    if (e && !e.tags?.blown && !e.tags?.derelict) lostShip(e, c);
  }
  // (a salvage job's derelict from before 1.12.11 had no class: nothing to see, dock with or cut up)
  for (const c of [...(state.contracts?.active || []), ...(state.contracts?.history || [])]) {
    const e = c.type === ContractType.SALVAGE && c.targetId ? world.get(c.targetId) : null;
    if (e && !e.cls) derelictHull(state, e, world.get(c.station)?.faction);
  }
  for (const c of state.contracts?.active || []) {
    if (c.type !== ContractType.ESCORT || c.phase !== 'active') continue;
    const e = world.get(c.targetId);
    if (!e || e.agent || !world.get(c.station)) continue;
    e.orbit = convoyWait(c.station);
    world.refresh(e, state.clock.minute);
    world.hash.update(e);
  }
}

/** Spawn what a hot-zone contract needs in the world (on acceptance). */
function spawnHotTarget(state, station, c) {
  const world = getWorld(state);
  const now = state.clock.minute;
  if (c.type === ContractType.ESCORT) {
    // (out past the gate, riding up from the station with it: where a route to the station ends, and no ship needs a clearance to be)
    const e = createEntity({ id: world.newId('convoy'), name: c.ship.name, type: 'ship', faction: c.ship.faction, cls: c.ship.cls, tl: c.ship.tl,
      shipClass: c.ship.shipClass, mass: c.ship.mass, orbit: convoyWait(station.id), tags: { contract: c.id } });
    world.add(e);
    c.targetId = e.id; c.targetName = e.name;
    return;
  }
  if (c.type !== ContractType.BOUNTY && c.type !== ContractType.RECON) return;
  // Somewhere off the zone's body, where a ship could lie there (world.restingOrbit: off a moon, the planet holds it)
  const anchor = restingOrbit(c.body, c.distAU || randRange(0.004, 0.012), random() * Math.PI * 2, now);
  const mark = createEntity({ id: world.newId('mark'), name: c.type === ContractType.BOUNTY ? `Last seen: ${c.ship.name}` : `Picket station near ${c.body}`, type: 'nav', orbit: anchor, transponder: false, tags: { contract: c.id } });
  world.add(mark);
  // (a pirate has moved on from where it was last seen, somewhere inside the brief's search area)
  const off = c.type === ContractType.BOUNTY ? (c.fix?.rKm ? c.fix.rKm / AU_KM * randRange(0.15, 0.75) : 0.002) : 0.0003;
  const ang = random() * Math.PI * 2;
  const pos = { x: mark.pos.x + Math.cos(ang) * off, y: mark.pos.y + Math.sin(ang) * off };
  const vel = { vx: mark.vel.vx, vy: mark.vel.vy };
  // (a signature not on file is still a signature: it flies one of its own)
  const e = c.type === ContractType.BOUNTY
    ? spawnAgent(state, { role: 'pirate', cls: c.ship.cls, faction: 'pirate', name: c.ship.name, pos, vel, contract: c.id, transponder: false, signature: c.sigKnown !== false && c.signature ? c.signature : undefined, tags: { wanted: true, contract: c.id } })
    : spawnAgent(state, { role: 'navy', kind: pick(['corvette', 'frigate']), category: 'military', faction: c.watched, pos, vel, contract: c.id, home: { kind: 'entity', id: mark.id }, zone: c.zone, tags: { contract: c.id } });
  // (the hull the brief describes: its mass is the one on file)
  if (c.ship?.mass) e.mass = c.ship.mass;
  c.markId = mark.id;
  c.targetId = e.id; c.targetName = e.name;
  c.acceptedAt = now;
  // the raiders that run with a notorious one: dark, close by, on no contract of ours to name
  if (c.type === ContractType.BOUNTY && c.escorts) {
    c.escortIds = [];
    for (let i = 0; i < c.escorts; i++) {
      const a = random() * Math.PI * 2, r = randRange(0.00005, 0.0003);
      const x = spawnAgent(state, { role: 'pirate', cls: pick(['pirate-raider', 'pirate-runner']), faction: 'pirate', pos: { x: pos.x + Math.cos(a) * r, y: pos.y + Math.sin(a) * r }, vel: { ...vel }, contract: c.id, transponder: false, tags: { contract: c.id } });
      c.escortIds.push(x.id);
    }
  }
}

/** The hulls a job brought out go back to their own business (the job is over). */
function release(world, ids) {
  for (const id of ids || []) { const a = world.get(id)?.agent; if (a) { a.contract = null; a.ambient = true; } }
}

/** Per-minute progress of hot-zone contracts. */
function hotProgress(state, c, emit) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const t = c.targetId ? world.get(c.targetId) : null;
  switch (c.type) {
    case ContractType.BOUNTY: {
      if (c.phase !== 'active') return;
      // (gone from space: got away, unless its reactor took it, which leaves no wreck: damage.js says so)
      const status = t ? t.combat?.status : c.targetGone === 'destroyed' ? 'wreck' : null;
      if (!t && !status) { failContract(state, c, `The ${c.targetName} got away`, emit); return; }
      if (t) huntTick(state, c, emit);
      if (status === 'wreck' || status === 'surrendered') {
        c.outcome = status === 'surrendered' ? 'captured' : 'destroyed';
        // (destroyed while only a possible: the sensor logs settle who it was)
        if (!c.identified) c.identified = 'logs';
        c.suspects = [];
        release(world, c.escortIds);
        c.phase = 'return';
        // (struck, it waits a day for a boarding party: its crew are paid for only once they are in our brig)
        if (c.outcome === 'captured') t.tags.despawnAt = now + DAY_MIN;
        retireMark(world, c, now);
        emit('contract-progress', { contract: c, text: `${c.targetName} ${c.outcome === 'captured' ? 'has surrendered' : 'destroyed'} — return to ${c.stationName} for the bounty${c.perHead ? `, with any of its crew you take prisoner (${c.perHead.toLocaleString()} MCR a head)` : ''}` });
      }
      return;
    }
    case ContractType.ESCORT: {
      if (!t || t.tags.wreck) { failContract(state, c, `The ${c.targetName} was lost`, emit); return; }
      if (c.phase === 'active' && !t.agent) {
        const d = Math.hypot(t.pos.x - state.flight.pos.x, t.pos.y - state.flight.pos.y) * AU_M;
        if (d <= 10_000) {
          wake(state, t, 'convoy', { mode: 'travel', dest: c.dest, contract: c.id, ambient: false });
          t.agent.travelG = c.g;
          if (!state.combat.protect.includes(t.id)) state.combat.protect.push(t.id);
          const dest = world.get(c.dest);
          const L = dest ? Math.hypot(dest.pos.x - t.pos.x, dest.pos.y - t.pos.y) * AU_M : 0;
          const T = 2 * Math.sqrt(L / (c.g * G0)) / MIN_S;
          c.ambushAt = now + Math.round(T * randRange(0.25, 0.6));
          c.phase = 'underway';
          emit('contract-progress', { contract: c, text: `${c.targetName} is under way for ${c.destName} — stay in formation` });
        }
        return;
      }
      if (c.phase === 'underway') {
        if (c.ambushAt != null && now >= c.ambushAt) {
          c.ambushAt = null;
          const n = chance(0.4) ? 2 : 1;
          for (let i = 0; i < n; i++) {
            const ang = random() * Math.PI * 2;
            const pos = { x: t.pos.x + Math.cos(ang) * 0.004, y: t.pos.y + Math.sin(ang) * 0.004 };
            const p = spawnAgent(state, { role: 'pirate', category: 'irregular', faction: 'pirate', pos, vel: { ...t.vel }, contract: c.id, transponder: false, mode: 'stalk', target: t.id });
            makeHostile(state, p, t.id);
          }
          emit('contract-progress', { contract: c, text: `Contacts closing on the ${c.targetName} — raiders!` });
        }
        if (t.agent?.mode === 'arrived') {
          c.phase = 'arrived';
          emit('contract-progress', { contract: c, text: `${c.targetName} has docked at ${c.destName}. Dock there to collect.` });
        }
      }
      return;
    }
    case ContractType.SMUGGLE:
      if (c.phase === 'active' && !state.cargo.some(x => x.contract === c.id)) failContract(state, c, 'The cargo was seized', emit);
      return;
    case ContractType.RECON: {
      if (c.phase !== 'active') return;
      if ((state.law.lastIdentified?.[c.watched] ?? -Infinity) > c.acceptedAt && zoneHasUs(state, c)) {
        adjustStanding(state, c.watched, -10);
        failContract(state, c, `Identified by ${FACTIONS[c.watched].navy} — the job is blown`, emit);
        return;
      }
      if (!t) { failContract(state, c, 'The picket has moved on', emit); return; }
      const d = Math.hypot(t.pos.x - state.flight.pos.x, t.pos.y - state.flight.pos.y);
      if (state.sensors.locked === t.id && d <= 0.002) {
        c.scanned++;
        if (c.scanned === 1) emit('contract-progress', { contract: c, text: `Lock on the ${c.targetName} — recording` });
        if (c.scanned >= c.scanMin) { c.phase = 'return'; retireMark(world, c, now); emit('contract-progress', { contract: c, text: `Recon complete — get the data to ${c.stationName}` }); }
      }
    }
  }
}

/** Were we near the recon target's area when they identified us? */
function zoneHasUs(state, c) {
  const m = c.markId && getWorld(state).get(c.markId);
  return !m || Math.hypot(m.pos.x - state.flight.pos.x, m.pos.y - state.flight.pos.y) < 0.05;
}

function retireMark(world, c, now) {
  const m = c.markId && world.get(c.markId);
  if (m) m.tags.despawnAt = now + 60;
}

// ---- TICK ----

export function contractsTick(state, emitOut = () => {}) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const C = state.contracts;
  // (what the nav computer says about a job goes on its timeline too)
  const emit = (type, p) => { if (type === 'contract-progress' && p?.contract) logContract(state, p.contract, p.text); emitOut(type, p); };

  // Boards: refresh stations (and command ships) within long sensor range (where we are docked always)
  // (from the few that keep boards, not a search of the space round us: a busy port's holds thousands)
  if (now % 10 === 0) {
    const docked = dockedPort(state);
    const f = state.flight.pos;
    const near = [];
    const keeps = (e) => e.board && Math.hypot(e.pos.x - f.x, e.pos.y - f.y) <= RANGE.LONG;
    for (const e of world.stations) if (keeps(e)) near.push(e);
    for (const e of world.forces) if (e.tags.command && keeps(e)) near.push(e);
    if (docked && !near.includes(docked)) near.push(docked);
    const allStations = world.stations.filter(e => e.board);
    for (const st of near) {
      const b = st.board;
      b.missions = b.missions.filter(m => now < m.expires);
      if (now - b.lastRefresh >= b.refreshInterval || b.missions.length === 0) {
        const others = allStations.filter(s => s.id !== st.id);
        const n = randInt(Math.min(2, b.maxMissions - b.missions.length), b.maxMissions - b.missions.length);
        for (let i = 0; i < n; i++) { const c = generate(state, st, others); if (c) b.missions.push(c); }
        // (a command ship keeps work for the rank of the captain who reports to it, if its fight has any: in place
        // of the oldest it can't take, when the board is full)
        if (st.tags?.command && flagOf(state) === st.faction && !b.missions.some(m => !milRefusal(state, m))) {
          for (let i = 0; i < 8; i++) {
            const c = generate(state, st, others);
            if (!c || milRefusal(state, c)) continue;
            if (b.missions.length >= b.maxMissions) b.missions.shift();
            b.missions.push(c);
            break;
          }
        }
        b.lastRefresh = now;
      }
    }
  }

  for (const c of [...C.active]) {
    if (c.phase === 'complete' || c.phase === 'failed') continue;
    if (now >= c.dueAt) { failContract(state, c, 'Deadline missed', emit); continue; }
    if (c.mil) {
      milProgress(state, c, emit, {
        fail: (reason) => failContract(state, c, reason, emit),
        done: (text) => {
          c.phase = 'return';
          retireMark(world, c, now);
          release(world, c.allies);
          release(world, c.spawned);
          emit('contract-progress', { contract: c, text });
        },
      });
      continue;
    }
    if (HOT_TYPES.has(c.type)) { hotProgress(state, c, emit); continue; }

    const target = c.targetId ? world.get(c.targetId) : null;
    const holding = target && state.flight.hold?.id === target.id;

    if (c.type === ContractType.SURVEY && c.phase === 'active' && target) {
      const d = Math.hypot(target.pos.x - state.flight.pos.x, target.pos.y - state.flight.pos.y);
      if (d <= RANGE.SHORT) {
        c.scanned++;
        if (c.scanned === 1) emit('contract-progress', { contract: c, text: `In the survey zone — collecting ${c.target} data` });
        if (c.scanned >= c.scanMin) {
          c.phase = 'return';
          emit('contract-progress', { contract: c, text: `Survey complete — return to ${c.stationName}` });
          retireTarget(world, c, now);
        }
      }
    }
    if (c.type === ContractType.SALVAGE && c.phase === 'active' && holding) {
      c.worked = (c.worked || 0) + 1;
      if (c.worked === 1) emit('contract-progress', { contract: c, text: `Salvage team out on EVA — ${c.salvage}` });
      if (c.worked >= c.workMin) {
        c.phase = 'return';
        emit('contract-progress', { contract: c, text: `${c.salvage} recovered — return to ${c.stationName}` });
      }
    }
  }

  if (now % 60 === 0 && C.history.length > 40) C.history.splice(0, C.history.length - 40);
}

// ---- PLAYER ACTIONS ----

export function contractsAt(state, stationId) {
  const st = getWorld(state).get(stationId);
  return st?.board?.missions || [];
}

/** Accept a contract from a station board. Returns { ok, text }. */
export function acceptContract(state, stationId, contractId) {
  const world = getWorld(state);
  const st = world.get(stationId);
  const i = st?.board?.missions.findIndex(m => m.id === contractId) ?? -1;
  if (i < 0) return { ok: false, text: 'Contract no longer available.' };
  const c = st.board.missions[i];
  const now = state.clock.minute;
  if (POWERS.includes(st.faction) && state.law.standing[st.faction] < STANDING_TO_TRADE) return { ok: false, text: `${st.name} won't give work to a ship with your record.` };
  if (c.mil) { const no = milRefusal(state, c); if (no) return { ok: false, text: no }; }
  if (!inPort(state, st)) return { ok: false, text: st.tags?.command ? `Come alongside the ${st.name} (inside 10 km) to sign for it.` : `Come into ${st.name}'s port space (inside ${Math.round(PORT_M / 1e6) * 1000} km) to sign for it.` };
  if (c.type === ContractType.PLANETSIDE && !shuttleCanLand(state, c.world)) return { ok: false, text: `It takes a shuttle that can make ${c.world}'s ground: this hull carries none.` };
  if (c.cargo) {
    const load = state.cargo.reduce((s, x) => s + x.mass, 0);
    if (load + c.cargo.mass > state.cargoCapacity) return { ok: false, text: `Not enough hold space (${(state.cargoCapacity - load).toLocaleString()} kg free).` };
    if (!dockedStation(state) || dockedStation(state).id !== st.id) return { ok: false, text: `Dock at ${st.name} to load cargo.` };
    state.cargo.push({ contract: c.id, name: c.cargo.name, mass: c.cargo.mass, ...(c.cargo.contraband ? { contraband: true, illegalIn: c.cargo.illegalIn } : {}) });
  }
  if (c.passengers) {
    const free = freeBerths(state);
    if (c.passengers > free) return { ok: false, text: `Only ${Math.max(0, free)} free berths.` };
    if (!dockedStation(state) || dockedStation(state).id !== st.id) return { ok: false, text: `Dock at ${st.name} to board passengers.` };
    state.passengers.push({ contract: c.id, count: c.passengers });
  }
  st.board.missions.splice(i, 1);
  c.phase = 'active';
  c.acceptedAt = now;
  c.dueAt = now + c.deadline;
  c.signedAt = st.name;
  logContract(state, c, `Signed at ${st.name}`);
  if (c.mil) spawnMil(state, c);
  else if (HOT_TYPES.has(c.type)) spawnHotTarget(state, st, c);
  else if (c.distAU) spawnTarget(state, st, c);
  state.contracts.active.push(c);
  return { ok: true, text: `Contract accepted: ${c.title}` };
}

function spawnTarget(state, station, c) {
  const world = getWorld(state);
  const o = station.orbit;
  const ang = random() * Math.PI * 2;
  // Off the station's body, where something left there would lie (world.restingOrbit)
  const orbit = restingOrbit(o.body, c.distAU, ang, state.clock.minute);
  let e;
  if (c.type === ContractType.SURVEY) {
    e = createEntity({ id: world.newId('mark'), name: `Survey mark ${c.sector}`, type: 'nav', orbit, transponder: false, tags: { contract: c.id } });
  } else if (c.type === ContractType.SALVAGE) {
    e = createEntity({ id: world.newId('wreck'), name: `Derelict ${randInt(100, 999)}`, type: 'ship', orbit, transponder: false, tags: { contract: c.id } });
    derelictHull(state, e, station.faction);
  } else {
    const alive = c.type === ContractType.MEDEVAC || c.outcome === 'alive';
    const name = c.outcome === 'debris' ? `Debris — ${c.ship.name}` : c.ship.name;
    e = createEntity({ id: world.newId('ship'), name, type: 'ship', faction: c.ship.faction, cls: c.ship.cls, tl: c.ship.tl, shipClass: c.ship.shipClass, mass: c.ship.mass, orbit, transponder: alive, sos: alive, tags: { contract: c.id } });
    lostShip(e, c);
  }
  world.add(e);
  c.targetId = e.id;
  c.targetName = e.name;
}

/**
 * An investigation's ship as it was found: debris, blown apart when it
 * dropped off comms (damage.js: no hull, its pieces spreading since); a
 * derelict, a dead hull, dark and cold, nobody aboard to answer.
 */
function lostShip(e, c) {
  if (c.type !== ContractType.INVESTIGATE) return;
  if (c.outcome === 'debris') blowApart(e, c.lostAt ?? c.offeredAt - DAY_MIN);
  else if (c.outcome === 'derelict') { e.tags.derelict = true; e.crewAboard = 0; }
}

/**
 * A salvage job's derelict: the hull of a ship that died out here weeks ago.
 * Its class is what the telescope and the cameras draw and docking finds
 * its collars on (a ship with none shows as nothing at all); dead, it is a
 * wreck to all of them, dark, tumbling, nobody aboard, its name its only
 * record.
 */
function derelictHull(state, e, near) {
  const v = rollIdentity({ category: 'civilian', near, state });
  Object.assign(e, { cls: v.cls, tl: v.tl, faction: v.faction, sub: v.sub, shipClass: v.shipClass, mass: v.mass, crewAboard: 0 });
  e.tags.derelict = true;
  deadHull(e, state.clock.minute - randInt(DERELICT_DAYS[0], DERELICT_DAYS[1]) * DAY_MIN);
}

function retireTarget(world, c, now) {
  const e = c.targetId && world.get(c.targetId);
  if (e) e.tags.despawnAt = now + DAY_MIN;
}

/** Hail a contract target in formation (investigate / medevac). */
export function hailContractTarget(state, entityId) {
  const c = state.contracts.active.find(x => x.targetId === entityId && x.phase === 'active');
  if (!c || (c.type !== ContractType.INVESTIGATE && c.type !== ContractType.MEDEVAC)) return null;
  const world = getWorld(state);
  const e = world.get(entityId);
  const holding = state.flight.hold?.id === entityId;
  const d = Math.hypot(e.pos.x - state.flight.pos.x, e.pos.y - state.flight.pos.y) * AU_M;
  if (!holding || d > 10_000) return { ok: false, text: 'Hold formation within 10 km first.' };
  if (c.type === ContractType.MEDEVAC) {
    if (c.casualties > freeBerths(state)) return { ok: false, text: 'Not enough berths for the casualties.' };
    state.passengers.push({ contract: c.id, count: c.casualties, casualties: true });
    world.setSos(e, false);
    c.phase = 'return';
    retireTarget(world, c, state.clock.minute);
    return { ok: true, contract: c, text: `${c.casualties} casualties transferred aboard. Get them to ${c.stationName}.` };
  }
  const report = {
    alive: 'The crew is alive — cold, scared, and very glad to see you. You log their status and coordinates for a station tug.',
    derelict: 'No response. Through the floodlights: a dark hull, hatches sealed, no heat signature. You log what you can.',
    debris: 'There is no ship. Just a spreading cloud of fragments and frozen vapor. You record the debris pattern.',
  }[c.outcome];
  world.setSos(e, false);
  c.phase = 'return';
  retireTarget(world, c, state.clock.minute);
  return { ok: true, contract: c, text: `${report} Report back to ${c.stationName}.` };
}

/** Contracts that can be completed at this (docked) station right now (military work at any port of its power). */
export function deliverable(state, station) {
  return state.contracts.active.filter(c =>
    (c.phase === 'active' && c.dest === station.id && c.type !== ContractType.ESCORT) ||
    (c.phase === 'arrived' && c.dest === station.id) ||
    (c.phase === 'return' && c.station === station.id) || milTurnIn(c, station));
}

/** Work that is turned in across the collar (goods, people, fuel), not over the radio. */
/** Does turning this in take a berth's collar (goods or people across it: a bounty's crew in our brig too)? */
export const needsBerth = (c, state = null) => !!(c.cargo || c.passengers || c.type === ContractType.FUEL || c.type === ContractType.SALVAGE || c.type === ContractType.MEDEVAC || c.type === ContractType.SMUGGLE
  || (state && bountyHeads(state, c).heads > 0));

/** Are we in port at a station (docked there, or inside its port space), or alongside a command ship (within 10 km)? */
export function inPort(state, st) {
  if (st.tags?.command) return dockedTo(state)?.id === st.id || Math.hypot(st.pos.x - state.flight.pos.x, st.pos.y - state.flight.pos.y) * AU_M <= 10_000;
  return dockedStation(state)?.id === st.id || inPortSpace(st, state.flight.pos);
}

/** Turn in a contract: at the docked station, or (a report) from port at `stationId`. */
export function completeContract(state, contractId, stationId = null) {
  const c = state.contracts.active.find(x => x.id === contractId);
  const st = dockedPort(state) || (stationId ? getWorld(state).get(stationId) : null);
  if (!c || !st) return { ok: false, text: 'Dock at the right station first.' };
  if (!deliverable(state, st).includes(c)) return { ok: false, text: 'This contract is not complete here.' };
  if (dockedPort(state)?.id !== st.id && (needsBerth(c, state) || !inPort(state, st))) return { ok: false, text: needsBerth(c, state) ? `Dock at ${st.name} to hand it over.` : `Come into ${st.name}'s port space to turn it in.` };
  if (c.type === ContractType.FUEL) {
    if (state.resources.fuel.current < c.fuelKg + 50) return { ok: false, text: `Need ${c.fuelKg} kg of reaction mass to spare.` };
    state.resources.fuel.current -= c.fuelKg;
  }
  state.cargo = state.cargo.filter(x => x.contract !== c.id);
  state.passengers = state.passengers.filter(x => x.contract !== c.id);
  let bonus = 0;
  if (c.vip && state.clock.minute - c.acceptedAt < c.deadline * 0.5) bonus = Math.round(c.reward.credits * 0.25);
  // a bounty's crew brought back alive: paid by the head, and handed over with it
  const heads = bountyHeads(state, c);
  if (heads.heads) {
    bonus += heads.pay;
    c.brought = { heads: heads.heads, captains: heads.captains, pay: heads.pay };
    state.passengers = state.passengers.filter(p => !heads.groups.includes(p));
  }
  grant(state, c.reward, bonus);
  c.phase = 'complete';
  c.completedAt = state.clock.minute;
  c.paid = { ...c.reward, credits: (c.reward.credits || 0) + bonus };
  logContract(state, c, `Turned in at ${st.name}: ${(c.reward.credits + bonus).toLocaleString()} MCR paid${c.brought ? ` (${c.brought.pay.toLocaleString()} of it for ${c.brought.heads} of its crew brought back)` : bonus ? ` (${bonus.toLocaleString()} of it a bonus)` : ''}`);
  if (c.mil) creditMission(state, c, true);
  archive(state, c);
  return { ok: true, contract: c, bonus, text: completionText(c, bonus) };
}

function grant(state, reward, bonus = 0) {
  for (const [k, v] of Object.entries(reward)) {
    const r = state.resources[k];
    if (!r) continue;
    r.current = Math.min(r.max, r.current + v + (k === 'credits' ? bonus : 0));
  }
}

function failContract(state, c, reason, emit) {
  c.phase = 'failed';
  c.failReason = reason;
  c.failedAt = state.clock.minute;
  logContract(state, c, `Failed: ${reason}`);
  state.cargo = state.cargo.filter(x => x.contract !== c.id);
  // (and any of it in a shuttle out: its shipper's, gone with the contract)
  for (const r of state.shuttles?.runs || []) if (r.cargo?.length) r.cargo = r.cargo.filter(x => x.contract !== c.id);
  state.passengers = state.passengers.filter(x => x.contract !== c.id);
  const world = getWorld(state);
  retireTarget(world, c, state.clock.minute);
  retireMark(world, c, state.clock.minute);
  const t = c.targetId && world.get(c.targetId);
  if (t?.agent) { t.agent.contract = null; t.agent.ambient = true; }
  // (the warships a mission brought out, a pirate's raiders, go back to their business: they leave when we are gone)
  release(world, c.allies);
  release(world, c.escortIds);
  release(world, c.spawned);
  state.combat.protect = state.combat.protect.filter(id => id !== c.targetId);
  if (c.mil) creditMission(state, c, false, emit);
  archive(state, c);
  emit('contract-failed', { contract: c, reason });
}

export function abandonContract(state, contractId, emit = () => {}) {
  const c = state.contracts.active.find(x => x.id === contractId);
  if (!c) return false;
  failContract(state, c, 'Abandoned', emit);
  return true;
}

/**
 * Freight landed by our shuttle at a PLANETSIDE contract's spaceport
 * (shuttles.js): what is owed counted off, and the contract paid by radio
 * when all of it is down.
 */
export function deliverPlanetside(state, contractId, kg, emit = () => {}) {
  const c = state.contracts.active.find(x => x.id === contractId);
  if (!c || c.type !== ContractType.PLANETSIDE || c.phase !== 'active') return null;
  c.landedKg = (c.landedKg || 0) + kg;
  logContract(state, c, `${Math.round(kg).toLocaleString()} kg landed at ${c.destName}`);
  if (c.landedKg < c.cargo.mass - 1) { emit('contract-progress', { contract: c, text: `${Math.round(c.landedKg).toLocaleString()} of ${c.cargo.mass.toLocaleString()} kg of ${c.cargo.name} on the pad at ${c.destName}.` }); return { done: false, left: c.cargo.mass - c.landedKg }; }
  grant(state, c.reward, 0);
  c.phase = 'complete';
  c.completedAt = state.clock.minute;
  c.paid = { ...c.reward };
  logContract(state, c, `Paid by radio: ${(c.reward.credits || 0).toLocaleString()} MCR`);
  archive(state, c);
  emit('contract-progress', { contract: c, text: completionText(c, 0) });
  return { done: true, text: completionText(c, 0) };
}

function archive(state, c) {
  const C = state.contracts;
  C.active = C.active.filter(x => x !== c);
  C.history.push(c);
}

function completionText(c, bonus) {
  switch (c.type) {
    case ContractType.CARGO: return `Cargo delivered to ${c.destName}. Dock crews start unloading the ${c.cargo.name}. Payment transferred.`;
    case ContractType.PLANETSIDE: return `The ${c.cargo.name} is on the pad at ${c.destName}: ${Math.round(c.landedKg || c.cargo.mass).toLocaleString()} kg signed for. Payment transferred by radio.`;
    case ContractType.PASSENGERS: return `Passengers disembark at ${c.destName}.${bonus ? ' The VIP is impressed — bonus paid.' : ' Another safe transit.'} Payment transferred.`;
    case ContractType.FUEL: return `Fuel transfer complete. ${c.destName} confirms ${c.fuelKg.toLocaleString()} kg received. Payment transferred.`;
    case ContractType.INVESTIGATE: return `Report filed with ${c.stationName}. ${c.outcome === 'alive' ? 'A tug is already on its way.' : c.outcome === 'derelict' ? 'Recovery team scheduled.' : 'The loss is recorded.'} Payment transferred.`;
    case ContractType.SALVAGE: return `${c.salvage} delivered. Salvage rights honored — payment transferred.`;
    case ContractType.SURVEY: return `Survey data uploaded. Sector ${c.sector} mapped for ${c.target}. Payment transferred.`;
    case ContractType.MEDEVAC: return `Casualties rushed to ${c.stationName} medical. ${c.casualties} lives handed over. Supplies restocked as thanks.`;
    case ContractType.BOUNTY: {
      const b = c.brought;
      const out = c.outcome === 'captured' ? `The ${c.targetName} struck its colours: the sensor logs show it.` : `Sensor logs of the ${c.targetName}'s destruction verified.`;
      return b ? `${out} ${b.heads} of its crew${b.captains ? ', its captain among them,' : ''} handed to station security: ${b.pay.toLocaleString()} MCR for them. Bounty paid.`
        : `${out} Bounty paid. (None of its crew brought back: nothing paid by the head.)`;
    }
    case ContractType.ESCORT: return `The ${c.targetName}'s captain buys the first round. Escort fee paid in full.`;
    case ContractType.SMUGGLE: return `A crew with no names unloads the hold in twenty minutes flat. The fee lands in your account from nowhere in particular.`;
    case ContractType.RECON: return `Sensor take uploaded on a secure channel. Someone is very pleased. Payment transferred.`;
    case ContractType.INTEL: return `Intelligence take uploaded to ${FACTIONS[c.faction].navy} command. It goes straight to the plot. Payment transferred.`;
    case ContractType.HOLD: return `Point ${c.point} is ours. ${FACTIONS[c.faction].navy} command logs your ship's part in holding it. Payment transferred.`;
    case ContractType.STRIKE: return `The ${c.targetName} is off the enemy's order of battle. ${FACTIONS[c.faction].navy} command confirms the kill. Payment transferred.`;
    case ContractType.COVERT: return `Take delivered on a channel that doesn't exist. The ${SUBFACTIONS[c.client]?.name || 'client'} pays in full and says nothing.`;
    default: return 'Contract complete. Payment transferred.';
  }
}

// ---- SERVICES (docked only) ----

/** Cost to fill a resource to max. */
export function serviceQuote(state, key) {
  const r = state.resources[key];
  if (!r || !(key in PRICES)) return null;
  const qty = Math.max(0, r.max - r.current);
  return { qty, cost: Math.ceil(qty * priceOf(state, key)) };
}

/** Buy up to `qty` of a resource (or as much as credits allow). */
export function buy(state, key, qty = Infinity) {
  if (!dockedPort(state)) return { ok: false, text: 'Not docked.' };
  const r = state.resources[key];
  if (!r || PRICES[key] == null) return { ok: false, text: 'Not sold here.' };
  const price = priceOf(state, key);
  const room = r.max - r.current;
  const afford = state.resources.credits.current / price;
  const amount = Math.max(0, Math.min(qty, room, afford));
  if (amount < 0.5) return { ok: false, text: room < 0.5 ? 'Already full.' : 'Not enough credits.' };
  const cost = Math.ceil(amount * price);
  state.resources.credits.current -= cost;
  r.current += amount;
  return { ok: true, amount, cost, text: `Bought ${Math.round(amount).toLocaleString()} ${key} for ${cost.toLocaleString()} MCR` };
}

// ---- ARMS ----
// PDC rounds are sold everywhere (every hauler shoots rocks). HE torpedoes
// at Belt and independent stations, or inner-planet yards that trust us,
// and by command ships to their contractors. Nuclear warheads are military
// kit (service.js): only to a licensed captain, at its own power's ports
// (the stations that sell arms, and its command ships from a rank).

const ARMS_STANDING = { he: 20, nuke: 0 };

/** Can this station (or command ship) sell this warhead to us? Returns null or a reason it won't. */
export function torpedoRefusal(state, station, warhead) {
  const f = station.faction;
  if (warhead === 'nuke') {
    const L = licenseOf(state);
    if (!L) return 'Nuclear warheads are military kit: they go only to licensed captains.';
    if (f !== L) return `Only ${FACTIONS[L].short} ports issue warheads to ${FACTIONS[L].short} contractors.`;
    if (station.tags?.command && rankOf(state) < RANK_FOR.nukes) return 'Command issues warheads to contractors of senior rank only.';
    return (state.law.standing[f] ?? 0) >= ARMS_STANDING.nuke ? null : `${FACTIONS[f].short} won't arm a captain with your record.`;
  }
  if (station.tags?.command || f === 'OPA' || f === 'independent' || f === 'pirate') return null;
  return state.law.standing[f] >= ARMS_STANDING.he ? null : `${FACTIONS[f].short} yards sell torpedoes only to ships in good standing (${ARMS_STANDING.he}+).`;
}

/** What a warhead costs us here. */
export const torpedoPrice = (state, warhead) => Math.round(AMMO_PRICES[warhead] * supplyPriceFactor(state) * localFactor(state, 'munitions'));

export function buyTorpedo(state, warhead) {
  const st = dockedPort(state);
  if (!st) return { ok: false, text: 'Not docked.' };
  if (!WARHEADS[warhead]) return { ok: false, text: 'Not sold here.' };
  const no = torpedoRefusal(state, st, warhead);
  if (no) return { ok: false, text: no };
  const M = state.magazine;
  if (M.he + M.nuke >= M.capacity) return { ok: false, text: 'Magazine full.' };
  const price = torpedoPrice(state, warhead);
  if (state.resources.credits.current < price) return { ok: false, text: 'Not enough credits.' };
  state.resources.credits.current -= price;
  M[warhead]++;
  return { ok: true, text: `${WARHEADS[warhead].name} loaded (${price.toLocaleString()} MCR)` };
}

// ---- DRONES ----
// Camera drones (drones.js) are chandlery: every port sells them, whole.

export const dronePrice = (state) => Math.round(DRONE_PRICE * supplyPriceFactor(state));

/** What filling the drone rack costs: { qty, cost } (as many as there is room for). */
export function droneQuote(state) {
  const r = state.resources.drones;
  const qty = Math.max(0, r.max - r.current - (state.drone ? 1 : 0));
  return { qty, cost: qty * dronePrice(state) };
}

/** Fill the rack (a drone out keeps its slot), or as many as credits allow. */
export function buyDrones(state) {
  if (!dockedPort(state)) return { ok: false, text: 'Not docked.' };
  const price = dronePrice(state);
  const n = Math.min(droneQuote(state).qty, Math.floor(state.resources.credits.current / price));
  if (n < 1) return { ok: false, text: droneQuote(state).qty < 1 ? 'The rack is full.' : 'Not enough credits.' };
  state.resources.credits.current -= n * price;
  state.resources.drones.current += n;
  return { ok: true, text: `${n} camera drone${n > 1 ? 's' : ''} loaded (${(n * price).toLocaleString()} MCR)` };
}
