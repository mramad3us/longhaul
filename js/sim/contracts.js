// ============================================================
// LONGHAUL — Station contracts & services
//
// Stations in range post contracts on a schedule. Every contract is a
// physical errand with an entity to fly to:
//   CARGO / PASSENGERS / FUEL  — dock at the destination station, deliver
//   INVESTIGATE / MEDEVAC      — rendezvous with a ship, hail it, return
//   SALVAGE                    — hold formation with a derelict while the
//                                crew strips it (2h), return
//   SURVEY                     — loiter within 150k km of a survey mark
//                                for the required time, return
// Near hot zones (conflict.js) the boards also carry the dangerous work:
//   BOUNTY   — find a wanted pirate; destroy it, or disable it and take
//              its surrender (paid half again), return
//   ESCORT   — fly formation with a convoy ship to its destination; it
//              departs when we join it, and raiders will come
//   SMUGGLE  — carry contraband through a blockade or into inner-planet
//              space; an inspection that finds it ends the job
//   RECON    — get a navy picket inside radar range and hold a lock on it
//              without being identified, return
// "Docked" = hard-docked at one of the station's berths (docking.js). The
// board can be read from anywhere in radio range; signing for work takes
// being in port (inside its port space, holding.js PORT_M: the approach,
// where its holding pattern is); loading, unloading, people and fuel across
// the collar take a hard seal. Work that ends in a report (a survey, an
// investigation, a bounty, recon, an escort brought in) is turned in from port.
// ============================================================

import { AU_M, AU_KM, RANGE, DAY_MIN, G0, MIN_S } from '../core/constants.js';
import { random, randInt, randRange, pick, weightedPick, chance } from '../core/rng.js';
import { getWorld } from './world.js';
import { inPortSpace, PORT_M } from './holding.js';
import { createEntity } from './entities.js';
import { rollIdentity, CLASSES, TECH, hullPoints, PLAYER_CLASS } from './ship-classes.js';
import { restockSuits } from './life-support.js';
import { overhaulSystems, shipSystems, unit } from './systems.js';
import { FACTIONS, POWERS } from './factions.js';
import { zonePos } from './conflict.js';
import { spawnAgent, wake, makeHostile } from './agents.js';
import { PLAYER } from './combatants.js';
import { WARHEADS, AMMO_PRICES } from './weapons.js';
import { adjustStanding } from './law.js';
import { dockedStationEntity } from './docking.js';

export const ContractType = {
  CARGO: 'CARGO', PASSENGERS: 'PASSENGERS', FUEL: 'FUEL',
  INVESTIGATE: 'INVESTIGATE', SALVAGE: 'SALVAGE', SURVEY: 'SURVEY', MEDEVAC: 'MEDEVAC',
  BOUNTY: 'BOUNTY', ESCORT: 'ESCORT', SMUGGLE: 'SMUGGLE', RECON: 'RECON',
};

export const CONTRACT_LABEL = {
  CARGO: 'CARGO HAUL', PASSENGERS: 'PASSENGER TRANSPORT', FUEL: 'FUEL DELIVERY',
  INVESTIGATE: 'INVESTIGATE', SALVAGE: 'SALVAGE', SURVEY: 'SURVEY', MEDEVAC: 'MEDICAL EVAC',
  BOUNTY: 'BOUNTY', ESCORT: 'CONVOY ESCORT', SMUGGLE: 'BLOCKADE RUN', RECON: 'COVERT RECON',
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

/** Unit price of a resource for our ship. */
export const priceOf = (state, key) => PRICES[key] * (key === 'parts' ? shipTech(state).price : 1);

export function createContracts() {
  return { active: [], history: [], nextId: 1 };
}

// ---- DOCKING ----

/** The station we're hard-docked at, or null. */
export function dockedStation(state) {
  return dockedStationEntity(state);
}

// ---- GENERATION ----

const GEN = [
  { type: ContractType.CARGO, weight: 4, dest: true },
  { type: ContractType.PASSENGERS, weight: 3, dest: true },
  { type: ContractType.FUEL, weight: 2, dest: true },
  { type: ContractType.INVESTIGATE, weight: 2 },
  { type: ContractType.SALVAGE, weight: 3 },
  { type: ContractType.SURVEY, weight: 3 },
  { type: ContractType.MEDEVAC, weight: 2 },
];

function distAU(a, b) { return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y); }

function generate(state, station, others) {
  if (chance(HOT_SHARE)) {
    const hot = generateHot(state, station, others);
    if (hot) return hot;
  }
  const gen = weightedPick(others.length ? GEN : GEN.filter(g => !g.dest));
  const id = `c-${state.contracts.nextId++}`;
  const now = state.clock.minute;
  const base = { id, type: gen.type, station: station.id, stationName: station.name, offeredAt: now, phase: 'offered' };
  switch (gen.type) {
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
      const ship = rollIdentity({ category: 'civilian', near: station.faction }); const outcome = pick(['derelict', 'debris', 'alive']);
      const dist = randRange(0.004, 0.04);
      return { ...base, distAU: dist, ship, outcome,
        title: `Investigate: ${ship.name} — contact lost`,
        description: `The ${ship.shipClass} "${ship.name}" dropped off comms ${randInt(2, 48)} hours ago, ${Math.round(dist * AU_KM).toLocaleString()} km out. Find it, report what you see.`,
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
      const ship = rollIdentity({ category: 'civilian', near: station.faction }); const n = randInt(1, 8);
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
const HOT_TYPES = new Set([ContractType.BOUNTY, ContractType.ESCORT, ContractType.SMUGGLE, ContractType.RECON]);
const HOT_SHARE = 0.4;               // share of board slots offered to conflict work when any applies
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
    case ContractType.BOUNTY: {
      const ship = rollIdentity({ category: 'irregular', faction: 'pirate' });
      const where = o.zone ? `near ${o.zone.body}` : `out past ${station.orbit.body}`;
      return { ...base, ship, body: o.zone?.body || station.orbit.body, distAU: randRange(0.008, 0.03),
        title: `Bounty: the ${ship.name}`,
        description: `The ${ship.shipClass} "${ship.name}" has been taking ships ${where}. ${station.name} pays for it destroyed — half again if you disable it and take the crew's surrender. Last reported position on file; it runs cold.`,
        reward: { credits: randInt(3000, 8000) }, aliveBonus: 0.5, deadline: randInt(6, 14) * DAY_MIN, expires: now + randInt(2, 4) * DAY_MIN };
    }
    case ContractType.ESCORT: {
      const dest = pick(others);
      const ship = rollIdentity({ category: 'civilian', kind: pick(['freighter', 'hauler', 'tanker']), near: station.faction });
      const g = Math.min(0.5, CLASSES[ship.cls].drive.cruiseG);
      const d = distAU(station, dest);
      return { ...base, dest: dest.id, destName: dest.name, ship, g,
        title: `Escort: ${ship.name} to ${dest.name}`,
        description: `Raiders have been hitting the ${station.name}–${dest.name} run. Fly escort for the ${ship.shipClass} "${ship.name}": it departs when we join formation (within 10 km) and burns at ${g}G. Keep it alive; collect at ${dest.name}.`,
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

/** Spawn what a hot-zone contract needs in the world (on acceptance). */
function spawnHotTarget(state, station, c) {
  const world = getWorld(state);
  const now = state.clock.minute;
  if (c.type === ContractType.ESCORT) {
    const o = station.orbit;
    const e = createEntity({ id: world.newId('convoy'), name: c.ship.name, type: 'ship', faction: c.ship.faction, cls: c.ship.cls, tl: c.ship.tl,
      shipClass: c.ship.shipClass, mass: c.ship.mass, orbit: { body: o.body, r: o.r * 1.01, phase: o.phase - 0.001, period: o.period }, tags: { contract: c.id } });
    world.add(e);
    c.targetId = e.id; c.targetName = e.name;
    return;
  }
  if (c.type !== ContractType.BOUNTY && c.type !== ContractType.RECON) return;
  // Somewhere off the zone's body, roughly at rest there
  const anchor = { body: c.body, r: c.distAU || randRange(0.004, 0.012), phase: random() * Math.PI * 2, period: 0 };
  const mark = createEntity({ id: world.newId('mark'), name: c.type === ContractType.BOUNTY ? `Last seen: ${c.ship.name}` : `Picket station near ${c.body}`, type: 'nav', orbit: anchor, transponder: false, tags: { contract: c.id } });
  world.add(mark);
  const off = c.type === ContractType.BOUNTY ? 0.002 : 0.0003;
  const ang = random() * Math.PI * 2;
  const pos = { x: mark.pos.x + Math.cos(ang) * off, y: mark.pos.y + Math.sin(ang) * off };
  const vel = { vx: mark.vel.vx, vy: mark.vel.vy };
  const e = c.type === ContractType.BOUNTY
    ? spawnAgent(state, { role: 'pirate', cls: c.ship.cls, faction: 'pirate', name: c.ship.name, pos, vel, contract: c.id, transponder: false, tags: { wanted: true, contract: c.id } })
    : spawnAgent(state, { role: 'navy', kind: pick(['corvette', 'frigate']), category: 'military', faction: c.watched, pos, vel, contract: c.id, home: { kind: 'entity', id: mark.id }, zone: c.zone, tags: { contract: c.id } });
  c.markId = mark.id;
  c.targetId = e.id; c.targetName = e.name;
  c.acceptedAt = now;
}

/** Per-minute progress of hot-zone contracts. */
function hotProgress(state, c, emit) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const t = c.targetId ? world.get(c.targetId) : null;
  switch (c.type) {
    case ContractType.BOUNTY: {
      if (c.phase !== 'active') return;
      if (!t) { failContract(state, c, `The ${c.targetName} got away`, emit); return; }
      if (t.combat?.status === 'wreck' || t.combat?.status === 'surrendered') {
        c.outcome = t.combat.status === 'surrendered' ? 'captured' : 'destroyed';
        c.phase = 'return';
        if (c.outcome === 'captured') { c.reward = { ...c.reward, credits: Math.round(c.reward.credits * (1 + c.aliveBonus)) }; t.tags.despawnAt = now + DAY_MIN; }
        retireMark(world, c, now);
        emit('contract-progress', { contract: c, text: `${c.targetName} ${c.outcome === 'captured' ? 'has surrendered' : 'destroyed'} — return to ${c.stationName} for the bounty` });
      }
      return;
    }
    case ContractType.ESCORT: {
      if (!t || t.tags.wreck) { failContract(state, c, `The ${c.targetName} was lost`, emit); return; }
      if (c.phase === 'active' && !t.agent) {
        const d = Math.hypot(t.pos.x - state.flight.pos.x, t.pos.y - state.flight.pos.y) * AU_M;
        if (d <= 10_000) {
          wake(state, t, 'convoy', { mode: 'travel', dest: c.dest, contract: c.id, ambient: false });
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

export function contractsTick(state, emit = () => {}) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const C = state.contracts;

  // Boards: refresh stations within long sensor range (docked station always)
  if (now % 10 === 0) {
    const docked = dockedStation(state);
    const near = world.query(state.flight.pos, RANGE.LONG).filter(e => e.type === 'station' && e.board);
    if (docked && !near.includes(docked)) near.push(docked);
    const allStations = world.stations.filter(e => e.board);
    for (const st of near) {
      const b = st.board;
      b.missions = b.missions.filter(m => now < m.expires);
      if (now - b.lastRefresh >= b.refreshInterval || b.missions.length === 0) {
        const others = allStations.filter(s => s.id !== st.id);
        const n = randInt(Math.min(2, b.maxMissions - b.missions.length), b.maxMissions - b.missions.length);
        for (let i = 0; i < n; i++) { const c = generate(state, st, others); if (c) b.missions.push(c); }
        b.lastRefresh = now;
      }
    }
  }

  for (const c of C.active) {
    if (c.phase === 'complete' || c.phase === 'failed') continue;
    if (now >= c.dueAt) { failContract(state, c, 'Deadline missed', emit); continue; }
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
  if (!inPort(state, st)) return { ok: false, text: `Come into ${st.name}'s port space (inside ${Math.round(PORT_M / 1e6) * 1000} km) to sign for it.` };
  if (c.cargo) {
    const load = state.cargo.reduce((s, x) => s + x.mass, 0);
    if (load + c.cargo.mass > state.cargoCapacity) return { ok: false, text: `Not enough hold space (${(state.cargoCapacity - load).toLocaleString()} kg free).` };
    if (!dockedStation(state) || dockedStation(state).id !== st.id) return { ok: false, text: `Dock at ${st.name} to load cargo.` };
    state.cargo.push({ contract: c.id, name: c.cargo.name, mass: c.cargo.mass, ...(c.cargo.contraband ? { contraband: true, illegalIn: c.cargo.illegalIn } : {}) });
  }
  if (c.passengers) {
    const aboard = state.passengers.reduce((s, x) => s + x.count, 0);
    if (aboard + c.passengers > state.berths) return { ok: false, text: `Only ${state.berths - aboard} free berths.` };
    if (!dockedStation(state) || dockedStation(state).id !== st.id) return { ok: false, text: `Dock at ${st.name} to board passengers.` };
    state.passengers.push({ contract: c.id, count: c.passengers });
  }
  st.board.missions.splice(i, 1);
  c.phase = 'active';
  c.acceptedAt = now;
  c.dueAt = now + c.deadline;
  if (HOT_TYPES.has(c.type)) spawnHotTarget(state, st, c);
  else if (c.distAU) spawnTarget(state, st, c);
  state.contracts.active.push(c);
  return { ok: true, text: `Contract accepted: ${c.title}` };
}

function spawnTarget(state, station, c) {
  const world = getWorld(state);
  const o = station.orbit;
  const ang = random() * Math.PI * 2;
  // Placed relative to the station's anchor body so it stays put relative to it
  const orbit = { body: o.body, r: c.distAU, phase: ang, period: 0 };
  let e;
  if (c.type === ContractType.SURVEY) {
    e = createEntity({ id: world.newId('mark'), name: `Survey mark ${c.sector}`, type: 'nav', orbit, transponder: false, tags: { contract: c.id } });
  } else if (c.type === ContractType.SALVAGE) {
    e = createEntity({ id: world.newId('wreck'), name: `Derelict ${randInt(100, 999)}`, type: 'ship', shipClass: pick(['Wreck', 'Hulk', 'Derelict']), mass: randInt(30_000, 150_000), orbit, transponder: false, tags: { contract: c.id } });
  } else {
    const alive = c.type === ContractType.MEDEVAC || c.outcome === 'alive';
    const name = c.outcome === 'debris' ? `Debris — ${c.ship.name}` : c.ship.name;
    e = createEntity({ id: world.newId('ship'), name, type: 'ship', faction: c.ship.faction, cls: c.ship.cls, tl: c.ship.tl, shipClass: c.ship.shipClass, mass: c.ship.mass, orbit, transponder: alive, sos: alive, tags: { contract: c.id } });
  }
  world.add(e);
  c.targetId = e.id;
  c.targetName = e.name;
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
    const aboard = state.passengers.reduce((s, x) => s + x.count, 0);
    if (aboard + c.casualties > state.berths) return { ok: false, text: 'Not enough berths for the casualties.' };
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

/** Contracts that can be completed at this (docked) station right now. */
export function deliverable(state, station) {
  return state.contracts.active.filter(c =>
    (c.phase === 'active' && c.dest === station.id && c.type !== ContractType.ESCORT) ||
    (c.phase === 'arrived' && c.dest === station.id) ||
    (c.phase === 'return' && c.station === station.id));
}

/** Work that is turned in across the collar (goods, people, fuel), not over the radio. */
export const needsBerth = (c) => !!(c.cargo || c.passengers || c.type === ContractType.FUEL || c.type === ContractType.SALVAGE || c.type === ContractType.MEDEVAC || c.type === ContractType.SMUGGLE);

/** Are we in port at a station: docked there, or inside its port space? */
export function inPort(state, st) {
  return dockedStation(state)?.id === st.id || inPortSpace(st, state.flight.pos);
}

/** Turn in a contract: at the docked station, or (a report) from port at `stationId`. */
export function completeContract(state, contractId, stationId = null) {
  const c = state.contracts.active.find(x => x.id === contractId);
  const st = dockedStation(state) || (stationId ? getWorld(state).get(stationId) : null);
  if (!c || !st) return { ok: false, text: 'Dock at the right station first.' };
  if (!deliverable(state, st).includes(c)) return { ok: false, text: 'This contract is not complete here.' };
  if (dockedStation(state)?.id !== st.id && (needsBerth(c) || !inPort(state, st))) return { ok: false, text: needsBerth(c) ? `Dock at ${st.name} to hand it over.` : `Come into ${st.name}'s port space to turn it in.` };
  if (c.type === ContractType.FUEL) {
    if (state.resources.fuel.current < c.fuelKg + 50) return { ok: false, text: `Need ${c.fuelKg} kg of reaction mass to spare.` };
    state.resources.fuel.current -= c.fuelKg;
  }
  state.cargo = state.cargo.filter(x => x.contract !== c.id);
  state.passengers = state.passengers.filter(x => x.contract !== c.id);
  let bonus = 0;
  if (c.vip && state.clock.minute - c.acceptedAt < c.deadline * 0.5) bonus = Math.round(c.reward.credits * 0.25);
  grant(state, c.reward, bonus);
  c.phase = 'complete';
  c.completedAt = state.clock.minute;
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
  state.cargo = state.cargo.filter(x => x.contract !== c.id);
  state.passengers = state.passengers.filter(x => x.contract !== c.id);
  const world = getWorld(state);
  retireTarget(world, c, state.clock.minute);
  retireMark(world, c, state.clock.minute);
  const t = c.targetId && world.get(c.targetId);
  if (t?.agent) { t.agent.contract = null; t.agent.ambient = true; }
  state.combat.protect = state.combat.protect.filter(id => id !== c.targetId);
  archive(state, c);
  emit('contract-failed', { contract: c, reason });
}

export function abandonContract(state, contractId, emit = () => {}) {
  const c = state.contracts.active.find(x => x.id === contractId);
  if (!c) return false;
  failContract(state, c, 'Abandoned', emit);
  return true;
}

function archive(state, c) {
  const C = state.contracts;
  C.active = C.active.filter(x => x !== c);
  C.history.push(c);
}

function completionText(c, bonus) {
  switch (c.type) {
    case ContractType.CARGO: return `Cargo delivered to ${c.destName}. Dock crews start unloading the ${c.cargo.name}. Payment transferred.`;
    case ContractType.PASSENGERS: return `Passengers disembark at ${c.destName}.${bonus ? ' The VIP is impressed — bonus paid.' : ' Another safe transit.'} Payment transferred.`;
    case ContractType.FUEL: return `Fuel transfer complete. ${c.destName} confirms ${c.fuelKg.toLocaleString()} kg received. Payment transferred.`;
    case ContractType.INVESTIGATE: return `Report filed with ${c.stationName}. ${c.outcome === 'alive' ? 'A tug is already on its way.' : c.outcome === 'derelict' ? 'Recovery team scheduled.' : 'The loss is recorded.'} Payment transferred.`;
    case ContractType.SALVAGE: return `${c.salvage} delivered. Salvage rights honored — payment transferred.`;
    case ContractType.SURVEY: return `Survey data uploaded. Sector ${c.sector} mapped for ${c.target}. Payment transferred.`;
    case ContractType.MEDEVAC: return `Casualties rushed to ${c.stationName} medical. ${c.casualties} lives handed over. Supplies restocked as thanks.`;
    case ContractType.BOUNTY: return c.outcome === 'captured'
      ? `The ${c.targetName}'s crew are handed to station security. Bounty paid — with the bonus for bringing them in alive.`
      : `Sensor logs of the ${c.targetName}'s destruction verified. Bounty paid.`;
    case ContractType.ESCORT: return `The ${c.targetName}'s captain buys the first round. Escort fee paid in full.`;
    case ContractType.SMUGGLE: return `A crew with no names unloads the hold in twenty minutes flat. The fee lands in your account from nowhere in particular.`;
    case ContractType.RECON: return `Sensor take uploaded on a secure channel. Someone is very pleased. Payment transferred.`;
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
  if (!dockedStation(state)) return { ok: false, text: 'Not docked.' };
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

/**
 * Dockyard price to bring every system back to factory condition: labour and
 * spares at the ship's tech level, hull plating by the tonne of structure.
 */
export function overhaulQuote(state) {
  let cost = 250;
  for (const id of shipSystems(state)) {
    const u = unit(state, id);
    cost += (100 - u.integrity) * 8;
    if (u.fault) cost += u.fault.severity === 'major' ? 450 : 150;
  }
  if (state.reactor.breach && state.reactor.status === 'offline') cost += 800;
  const c = CLASSES[state.ship.classId || PLAYER_CLASS];
  cost += (100 - state.hull.integrity) * HULL_REPAIR_PER_PCT * hullPoints(c) / 120;
  return Math.round(cost * shipTech(state).price / 10) * 10;
}

const HULL_REPAIR_PER_PCT = 30;                // per % of a 120-DP hull, at TL2

export function buyOverhaul(state) {
  if (!dockedStation(state)) return { ok: false, text: 'Not docked.' };
  const cost = overhaulQuote(state);
  if (state.resources.credits.current < cost) return { ok: false, text: 'Not enough credits.' };
  state.resources.credits.current -= cost;
  overhaulSystems(state);
  restockSuits(state);
  state.hull.integrity = 100;
  state.ship.decks.forEach(d => { if (d.atmosphere) d.atmosphere.breached = false; });
  if (state.reactor.breach && state.reactor.status === 'offline') state.reactor.breach = false;
  return { ok: true, text: `Dockside overhaul complete — hull and every system back to spec, suits restocked (${cost.toLocaleString()} MCR)` };
}

// ---- ARMS ----
// PDC rounds are sold everywhere (every hauler shoots rocks). HE torpedoes
// at Belt and independent stations, or inner-planet yards that trust us;
// nuclear warheads only from the OPA, and only to friends.

const ARMS_STANDING = { he: 20, nuke: 0 };

/** Can this station sell this warhead to us? Returns null or a reason it won't. */
export function torpedoRefusal(state, station, warhead) {
  const f = station.faction;
  if (warhead === 'nuke') return f === 'OPA' && state.law.standing.OPA >= ARMS_STANDING.nuke ? null : 'Nuclear warheads only change hands at OPA stations, among friends.';
  if (f === 'OPA' || f === 'independent' || f === 'pirate') return null;
  return state.law.standing[f] >= ARMS_STANDING.he ? null : `${FACTIONS[f].short} yards sell torpedoes only to ships in good standing (${ARMS_STANDING.he}+).`;
}

export function buyTorpedo(state, warhead) {
  const st = dockedStation(state);
  if (!st) return { ok: false, text: 'Not docked.' };
  if (!WARHEADS[warhead]) return { ok: false, text: 'Not sold here.' };
  const no = torpedoRefusal(state, st, warhead);
  if (no) return { ok: false, text: no };
  const M = state.magazine;
  if (M.he + M.nuke >= M.capacity) return { ok: false, text: 'Magazine full.' };
  const price = AMMO_PRICES[warhead];
  if (state.resources.credits.current < price) return { ok: false, text: 'Not enough credits.' };
  state.resources.credits.current -= price;
  M[warhead]++;
  return { ok: true, text: `${WARHEADS[warhead].name} loaded (${price.toLocaleString()} MCR)` };
}
