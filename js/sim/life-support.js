// ============================================================
// LONGHAUL — Life support
// Per-deck atmosphere (pressure, O₂, N₂, CO₂), scrubbing and
// injection from tanks, breaches, venting, gas exchange through the
// ladder shaft, EVA suits, and the atmosphere's effect on crew.
// The plant itself (wear, faults, repair) is a ship system — see
// systems.js; its condition sets how hard it can scrub and inject.
// ============================================================

import { isInterior } from './tiles.js';
import { addJob, closeJob, JobType, JOB_PRIORITY } from './jobs.js';
import { systemPerf } from './systems.js';
import { shipGeometry, isSecureSeat } from './ship-layout.js';
import { addCondition, removeCondition, refreshDerivedConditions } from './crew.js';

export const EARTH_PRESSURE = 101.3;   // kPa
export const TARGET_O2 = 20.9;         // %
export const TARGET_N2 = 78.1;
export const TARGET_CO2 = 0.04;

const TILE_VOLUME = 6.5;               // m³ per interior tile (0.9 m × 0.9 m section × ~8 m of hull depth)
const O2_PER_MIN = 0.000583;           // kg per person
const CO2_PER_MIN = 0.000694;
const SCRUB_RATE = 0.008;              // CO₂ % removed per minute
const INJECT_RATE = 0.05;              // % per minute
const TANK_KG_PER_PCT_M3 = 0.0012;
const BREACH_RATE = 0.20;
const VENT_RATE = 0.10;
const EXCHANGE = 0.08;
const PRESSURE_DOOR_KPA = 15;          // shaft hatches stay shut across a bigger difference
export const SUIT_O2_HOURS = 48;
export const COUCH_AIR_MIN = 120;      // emergency hood in every crash couch and station seat

export const ATMO = {
  HYPOXIA_MILD: 16, HYPOXIA_SEVERE: 10, HYPOXIA_LETHAL: 6,
  CO2_MILD: 2, CO2_MODERATE: 3, CO2_SEVERE: 5, CO2_LETHAL: 8,
  PRESSURE_LOW: 63, PRESSURE_DANGER: 35, PRESSURE_LETHAL: 12,
};

export function createLifeSupport(ship) {
  const geo = shipGeometry(ship);
  ship.decks.forEach((deck) => {
    let interior = 0;
    for (const row of deck.tiles) for (const t of row) if (isInterior(t)) interior++;
    deck.atmosphere = {
      pressure: EARTH_PRESSURE, o2Pct: TARGET_O2, n2Pct: TARGET_N2, co2Pct: TARGET_CO2,
      volume: interior * TILE_VOLUME, breached: false, vented: false,
    };
  });
  const lockers = {};
  for (const f of geo.fixtures.locker || []) lockers[f.id] = { hasSuit: true };
  return {
    lockers,
    connections: geo.shafts.map(s => [s.upper, s.lower]),
  };
}

export function atmoStatus(atmo) {
  if (!atmo) return 'unknown';
  if (atmo.fire) return 'fire';
  if (atmo.breached) return 'breached';
  if (atmo.vented) return 'vented';
  if (atmo.pressure < ATMO.PRESSURE_LETHAL) return 'vacuum';
  if (atmo.pressure < ATMO.PRESSURE_DANGER || atmo.o2Pct < ATMO.HYPOXIA_SEVERE || atmo.co2Pct > ATMO.CO2_SEVERE) return 'critical';
  if (atmo.pressure < ATMO.PRESSURE_LOW || atmo.o2Pct < ATMO.HYPOXIA_MILD || atmo.co2Pct > ATMO.CO2_MILD) return 'warning';
  return 'nominal';
}

/**
 * One game-minute. ctx: { emit }
 */
export function lifeSupportTick(state, ctx) {
  const ship = state.ship;
  const ls = state.lifeSupport;
  const res = state.resources;
  const geo = shipGeometry(ship);

  // Who breathes where
  const breathers = new Array(ship.decks.length).fill(0);
  for (const m of ship.crew) {
    if (m.dead || m.suit.wearing || m.away) continue;
    breathers[geo.deckOfRow(m.pos.sy)]++;
  }

  // One plant services the whole ship through the ducting
  const eff = systemPerf(state, 'lifeSupport');

  ship.decks.forEach((deck, di) => {
    const a = deck.atmosphere;
    if (!a) return;
    if (a.breached && a.pressure > 0) {
      a.pressure *= (1 - BREACH_RATE);
      if (a.pressure < 0.1) a.pressure = 0;
    }
    if (a.vented && a.pressure > 0) {
      a.pressure *= (1 - VENT_RATE);
      if (a.pressure < 0.5) a.pressure = 0;
    }
    const sealed = !a.breached && !a.vented;
    const haveGas = res.o2Tank.current > 0 && res.n2Tank.current > 0;
    // Repressurize from the tanks — from hard vacuum too, once the hole is sealed
    if (eff > 0 && sealed && haveGas && a.pressure < EARTH_PRESSURE - 0.5) {
      if (a.pressure < 1) { a.o2Pct = TARGET_O2; a.n2Pct = TARGET_N2; a.co2Pct = TARGET_CO2; }
      const add = Math.min(0.5 * eff, EARTH_PRESSURE - a.pressure);
      a.pressure += add;
      const kg = add / EARTH_PRESSURE * 1.225 * a.volume;
      res.o2Tank.current = Math.max(0, res.o2Tank.current - kg * 0.21);
      res.n2Tank.current = Math.max(0, res.n2Tank.current - kg * 0.79);
    }
    if (a.pressure < 1) return;

    if (breathers[di] > 0 && a.volume > 0) {
      const airKg = 1.225 * (a.pressure / EARTH_PRESSURE) * a.volume;
      a.o2Pct = Math.max(0, a.o2Pct - O2_PER_MIN * breathers[di] / airKg * 100);
      a.co2Pct = Math.min(100, a.co2Pct + CO2_PER_MIN * breathers[di] / airKg * 100);
    }

    if (eff > 0 && sealed) {
      if (a.co2Pct > TARGET_CO2) a.co2Pct = Math.max(TARGET_CO2, a.co2Pct - SCRUB_RATE * eff);
      if (a.o2Pct < TARGET_O2 && haveGas) {
        const add = Math.min(INJECT_RATE * eff, TARGET_O2 - a.o2Pct);
        a.o2Pct += add;
        res.o2Tank.current = Math.max(0, res.o2Tank.current - add * a.volume * TANK_KG_PER_PCT_M3);
      }
      if (a.n2Pct < TARGET_N2 && res.n2Tank.current > 0) {
        const add = Math.min(INJECT_RATE * eff, TARGET_N2 - a.n2Pct);
        a.n2Pct += add;
        res.n2Tank.current = Math.max(0, res.n2Tank.current - add * a.volume * TANK_KG_PER_PCT_M3);
      }
    }
  });

  // Gas exchange through the ladder shaft. Pressure doors seal a deck off
  // when it's holed or venting, and stay shut until the pressures match
  // again — a breach costs one deck's air, not the ship's.
  for (const [i, j] of ls.connections) {
    const A = ship.decks[i].atmosphere, B = ship.decks[j].atmosphere;
    if (A.breached || A.vented || B.breached || B.vented || Math.abs(A.pressure - B.pressure) > PRESSURE_DOOR_KPA) continue;
    for (const k of ['pressure', 'o2Pct', 'n2Pct', 'co2Pct']) {
      const d = (A[k] - B[k]) * EXCHANGE;
      A[k] -= d; B[k] += d;
    }
  }

  // Effects on crew
  for (const m of ship.crew) {
    if (m.dead) continue;
    if (m.suit.wearing) {
      m.suit.o2 -= 1 / 60;
      if (m.suit.o2 <= 0) {
        m.suit.o2 = 0;
        m.suit.wearing = false;
        ctx.emit?.('suit-depleted', { member: m });
      } else {
        removeCondition(m, 'hypoxic'); removeCondition(m, 'hypercapnia'); removeCondition(m, 'decompression');
        // Stow the suit once the air on deck is good again (unless heading into bad air on a job, or across to another hull)
        if (m.away) continue;
        const a = ship.decks[geo.deckOfRow(m.pos.sy)].atmosphere;
        if (atmoStatus(a) === 'nominal' && !m.suit.keep && !state.suitsOn) stowSuit(state, m);
        continue;
      }
    }
    if (m.away) continue;          // breathing the other ship's air (boarding.js)
    const a = ship.decks[geo.deckOfRow(m.pos.sy)].atmosphere;
    m.couchAir ??= COUCH_AIR_MIN;
    if (atmoStatus(a) === 'nominal') m.couchAir = Math.min(COUCH_AIR_MIN, m.couchAir + 0.5);
    else if (isSecureSeat(m.seat) && m.couchAir > 0) {
      // Strapped in: the couch's emergency hood drops and buys some time
      m.couchAir -= 1;
      removeCondition(m, 'hypoxic'); removeCondition(m, 'hypercapnia'); removeCondition(m, 'decompression');
      continue;
    }
    breathe(m, a);
    refreshDerivedConditions(m);
  }

  // Display helper: hours of O₂ in the tanks for the living crew
  const living = ship.crew.filter(c => !c.dead).length;
  ls.oxygenHours = living > 0 ? res.o2Tank.current / (O2_PER_MIN * 60 * living) : Infinity;
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function breathe(m, a) {
  if (a.o2Pct < ATMO.HYPOXIA_MILD) {
    addCondition(m, 'hypoxic');
    if (a.o2Pct < ATMO.HYPOXIA_LETHAL) { m.consciousness = Math.max(10, m.consciousness - 5); m.heart.health = clamp(m.heart.health - 0.5); }
    else if (a.o2Pct < ATMO.HYPOXIA_SEVERE) m.consciousness = Math.max(10, m.consciousness - 2);
    else m.consciousness = Math.max(10, m.consciousness - 0.3);
  } else removeCondition(m, 'hypoxic');

  if (a.co2Pct > ATMO.CO2_MILD) {
    addCondition(m, 'hypercapnia');
    if (a.co2Pct > ATMO.CO2_LETHAL) {
      m.consciousness = Math.max(10, m.consciousness - 6); m.heart.health = clamp(m.heart.health - 1);
      m.body.head = clamp(m.body.head - 0.5); m.body.torso = clamp(m.body.torso - 0.3);
    } else if (a.co2Pct > ATMO.CO2_SEVERE) {
      m.consciousness = Math.max(10, m.consciousness - 3); m.heart.health = clamp(m.heart.health - 0.2);
      m.morale = clamp(m.morale - 1.5); m.body.head = clamp(m.body.head - 0.2);
    } else if (a.co2Pct > ATMO.CO2_MODERATE) {
      m.consciousness = Math.max(10, m.consciousness - 1); m.morale = clamp(m.morale - 1); m.heart.health = clamp(m.heart.health - 0.1);
    } else {
      m.consciousness = Math.max(10, m.consciousness - 0.3); m.morale = clamp(m.morale - 0.5);
    }
  } else removeCondition(m, 'hypercapnia');

  if (a.pressure < ATMO.PRESSURE_LOW) {
    addCondition(m, 'decompression');
    if (a.pressure < ATMO.PRESSURE_LETHAL) {
      m.consciousness = Math.max(10, m.consciousness - 8); m.heart.health = clamp(m.heart.health - 2);
      m.body.torso = clamp(m.body.torso - 1); m.body.head = clamp(m.body.head - 1);
    } else if (a.pressure < ATMO.PRESSURE_DANGER) m.consciousness = Math.max(10, m.consciousness - 3);
    else m.consciousness = Math.max(10, m.consciousness - 0.5);
  } else removeCondition(m, 'decompression');
}

export function stowSuit(state, m) {
  if (!m.suit.wearing && !m.suit.lockerId) return;
  const locker = state.lifeSupport.lockers[m.suit.lockerId];
  if (locker) locker.hasSuit = true;
  m.suit = { wearing: false, o2: 0, lockerId: null };
}

// ---- JOBS ----

/** Every holed deck needs an engineer in a suit with a patch kit. */
export function breachJobs(state) {
  state.ship.decks.forEach((d, deck) => {
    const job = state.jobs.list.find(j => j.type === JobType.SEAL && j.data.deck === deck);
    if (d.atmosphere?.breached && !job) addJob(state, JobType.SEAL, JOB_PRIORITY.CRITICAL, { deck });
    else if (!d.atmosphere?.breached && job) closeJob(state, job);
  });
}

/** Finish patching a breach. */
export function completeSeal(state, deck) {
  const a = state.ship.decks[deck].atmosphere;
  a.breached = false;
  const parts = state.resources.parts;
  const used = Math.min(parts.current, 0.5);
  parts.current -= used;
  return { success: true, message: `Hull breach on ${state.ship.decks[deck].name} sealed${used ? '' : ' with emergency sealant'} — repressurizing` };
}

// ---- CONTROLS ----

/**
 * The SUITS order: every hand into an EVA suit and kept in it (crew-ai.js
 * does the walking), so a deck can be vented to put out a fire, or holed in
 * a fight, with its people still on it. Off: suits come off once the air
 * where they stand is good again.
 */
export function orderSuits(state, on) {
  state.suitsOn = !!on;
  // (lifted, it leaves the suit on whoever needs it for the work in hand: a breach, a fire, a boarding)
  for (const m of state.ship.crew) if (m.suit.wearing) m.suit.keep = !!on || needsSuitForTask(m);
  return state.suitsOn;
}

const needsSuitForTask = (m) => m.task?.type === 'board' || m.task?.type === 'suit' && m.task.thenJob != null ||
  m.task?.type === 'work' && (m.task.kind === JobType.SEAL || m.task.kind === JobType.FIRE);

export const suitedCount = (state) => state.ship.crew.filter(m => !m.dead && !m.away && m.suit.wearing).length;

/** Dockside: every suit locker restocked. */
export function restockSuits(state) {
  for (const l of Object.values(state.lifeSupport.lockers)) l.hasSuit = true;
}

export function setVented(state, deck, vented) {
  const a = state.ship.decks[deck]?.atmosphere;
  if (!a) return false;
  a.vented = vented;
  return true;
}

export function setBreach(state, deck, breached) {
  const a = state.ship.decks[deck]?.atmosphere;
  if (!a) return false;
  a.breached = breached;
  return true;
}

export function suitsOnDeck(state, deck) {
  const geo = shipGeometry(state.ship);
  return (geo.fixtures.locker || []).filter(f => f.deck === deck && state.lifeSupport.lockers[f.id]?.hasSuit).length;
}
