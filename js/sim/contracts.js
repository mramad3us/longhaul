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
// "Docked" = holding station within 50 km of a station.
// ============================================================

import { AU_M, AU_KM, RANGE, DAY_MIN } from '../core/constants.js';
import { random, randInt, randRange, pick, weightedPick } from '../core/rng.js';
import { getWorld } from './world.js';
import { createEntity, rollShipIdentity } from './entities.js';
import { restockSuits } from './life-support.js';
import { overhaulSystems, SYSTEM_IDS, unit } from './systems.js';

export const ContractType = {
  CARGO: 'CARGO', PASSENGERS: 'PASSENGERS', FUEL: 'FUEL',
  INVESTIGATE: 'INVESTIGATE', SALVAGE: 'SALVAGE', SURVEY: 'SURVEY', MEDEVAC: 'MEDEVAC',
};

export const CONTRACT_LABEL = {
  CARGO: 'CARGO HAUL', PASSENGERS: 'PASSENGER TRANSPORT', FUEL: 'FUEL DELIVERY',
  INVESTIGATE: 'INVESTIGATE', SALVAGE: 'SALVAGE', SURVEY: 'SURVEY', MEDEVAC: 'MEDICAL EVAC',
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

export const PRICES = { fuel: 2, water: 0.5, food: 3, o2Tank: 4, n2Tank: 1, medSupplies: 40, parts: 120 };

export function createContracts() {
  return { active: [], history: [], nextId: 1 };
}

// ---- DOCKING ----

/** The station we're docked at (holding within 50 km), or null. */
export function dockedStation(state) {
  const h = state.flight.hold;
  if (!h || h.kind !== 'entity') return null;
  const e = getWorld(state).get(h.id);
  if (!e || e.type !== 'station') return null;
  return Math.hypot(h.ox, h.oy) <= RANGE.DOCK_M ? e : null;
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
      const ship = rollShipIdentity(); const outcome = pick(['derelict', 'debris', 'alive']);
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
      const ship = rollShipIdentity(); const n = randInt(1, 8);
      const dist = randRange(0.003, 0.02);
      return { ...base, distAU: dist, ship, casualties: n,
        title: `MedEvac: ${n} casualties aboard ${ship.name}`,
        description: `The ${ship.shipClass} "${ship.name}" reports ${n} injured after a ${pick(['reactor leak', 'decompression', 'collision', 'equipment failure'])}. Pick them up and bring them to ${station.name}.`,
        reward: { credits: randInt(1800, 4500), medSupplies: randInt(5, 15) }, deadline: randInt(1, 3) * DAY_MIN, expires: now + randInt(12, 36) * 60 };
    }
  }
  return null;
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
  if (c.cargo) {
    const load = state.cargo.reduce((s, x) => s + x.mass, 0);
    if (load + c.cargo.mass > state.cargoCapacity) return { ok: false, text: `Not enough hold space (${(state.cargoCapacity - load).toLocaleString()} kg free).` };
    if (!dockedStation(state) || dockedStation(state).id !== st.id) return { ok: false, text: `Dock at ${st.name} to load cargo.` };
    state.cargo.push({ contract: c.id, name: c.cargo.name, mass: c.cargo.mass });
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
  if (c.distAU) spawnTarget(state, st, c);
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
    e = createEntity({ id: world.newId('ship'), name, type: 'ship', faction: c.ship.faction, shipClass: c.ship.shipClass, mass: c.ship.mass, orbit, transponder: alive, sos: alive, tags: { contract: c.id } });
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
    (c.phase === 'active' && c.dest === station.id) ||
    (c.phase === 'return' && c.station === station.id));
}

/** Turn in a contract at the docked station. */
export function completeContract(state, contractId) {
  const c = state.contracts.active.find(x => x.id === contractId);
  const st = dockedStation(state);
  if (!c || !st) return { ok: false, text: 'Dock at the right station first.' };
  if (!deliverable(state, st).includes(c)) return { ok: false, text: 'This contract is not complete here.' };
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
  retireTarget(getWorld(state), c, state.clock.minute);
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
    default: return 'Contract complete. Payment transferred.';
  }
}

// ---- SERVICES (docked only) ----

/** Cost to fill a resource to max. */
export function serviceQuote(state, key) {
  const r = state.resources[key];
  if (!r || !(key in PRICES)) return null;
  const qty = Math.max(0, r.max - r.current);
  return { qty, cost: Math.ceil(qty * PRICES[key]) };
}

/** Buy up to `qty` of a resource (or as much as credits allow). */
export function buy(state, key, qty = Infinity) {
  if (!dockedStation(state)) return { ok: false, text: 'Not docked.' };
  const r = state.resources[key];
  const price = PRICES[key];
  if (!r || price == null) return { ok: false, text: 'Not sold here.' };
  const room = r.max - r.current;
  const afford = state.resources.credits.current / price;
  const amount = Math.max(0, Math.min(qty, room, afford));
  if (amount < 0.5) return { ok: false, text: room < 0.5 ? 'Already full.' : 'Not enough credits.' };
  const cost = Math.ceil(amount * price);
  state.resources.credits.current -= cost;
  r.current += amount;
  return { ok: true, amount, cost, text: `Bought ${Math.round(amount).toLocaleString()} ${key} for ${cost.toLocaleString()} MCR` };
}

/** Dockyard price to bring every system back to factory condition. */
export function overhaulQuote(state) {
  let cost = 250;
  for (const id of SYSTEM_IDS) {
    const u = unit(state, id);
    cost += (100 - u.integrity) * 8;
    if (u.fault) cost += u.fault.severity === 'major' ? 450 : 150;
  }
  if (state.reactor.breach && state.reactor.status === 'offline') cost += 800;
  return Math.round(cost / 10) * 10;
}

export function buyOverhaul(state) {
  if (!dockedStation(state)) return { ok: false, text: 'Not docked.' };
  const cost = overhaulQuote(state);
  if (state.resources.credits.current < cost) return { ok: false, text: 'Not enough credits.' };
  state.resources.credits.current -= cost;
  overhaulSystems(state);
  restockSuits(state);
  if (state.reactor.breach && state.reactor.status === 'offline') state.reactor.breach = false;
  return { ok: true, text: `Dockside overhaul complete — every system back to spec, suits restocked (${cost.toLocaleString()} MCR)` };
}
