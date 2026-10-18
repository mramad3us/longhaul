// ============================================================
// LONGHAUL — Life support
// Per-deck atmosphere (pressure, O₂, N₂, CO₂), scrubbing and
// injection from tanks, breaches, venting, gas exchange through the
// ladder shaft, EVA suits, and the atmosphere's effect on crew.
// ============================================================

import { random } from '../core/rng.js';
import { isInterior } from './tiles.js';
import { shipGeometry } from './ship-layout.js';
import { addCondition, removeCondition, refreshDerivedConditions } from './crew.js';

export const EARTH_PRESSURE = 101.3;   // kPa
export const TARGET_O2 = 20.9;         // %
export const TARGET_N2 = 78.1;
export const TARGET_CO2 = 0.04;

const TILE_VOLUME = 22.5;              // m³ per interior tile
const O2_PER_MIN = 0.000583;           // kg per person
const CO2_PER_MIN = 0.000694;
const SCRUB_RATE = 0.008;              // CO₂ % removed per minute
const PATCH_EFFICIENCY = 0.5;
const INJECT_RATE = 0.05;              // % per minute
const TANK_KG_PER_PCT_M3 = 0.0012;
const BREACH_RATE = 0.20;
const VENT_RATE = 0.10;
const EXCHANGE = 0.08;
const FAILURE_BASE = 0.000004;          // per minute per unit (~1 per 6 months, more under stress)
export const SUIT_O2_HOURS = 48;

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
  const equipment = {};
  for (const f of geo.fixtures.lifeSupport || []) {
    equipment[f.deck] = { status: 'operational', enabled: true, patchMinutes: 0, fixture: f.id };
  }
  const lockers = {};
  for (const f of geo.fixtures.locker || []) lockers[f.id] = { hasSuit: true };
  return {
    equipment,
    lockers,
    connections: geo.shafts.map(s => [s.upper, s.lower]),
  };
}

export function atmoStatus(atmo) {
  if (!atmo) return 'unknown';
  if (atmo.breached) return 'breached';
  if (atmo.vented) return 'vented';
  if (atmo.pressure < ATMO.PRESSURE_LETHAL) return 'vacuum';
  if (atmo.pressure < ATMO.PRESSURE_DANGER || atmo.o2Pct < ATMO.HYPOXIA_SEVERE || atmo.co2Pct > ATMO.CO2_SEVERE) return 'critical';
  if (atmo.pressure < ATMO.PRESSURE_LOW || atmo.o2Pct < ATMO.HYPOXIA_MILD || atmo.co2Pct > ATMO.CO2_MILD) return 'warning';
  return 'nominal';
}

export function equipmentLabel(eq) {
  if (!eq) return 'None';
  if (!eq.enabled) return 'DISABLED (manual override)';
  switch (eq.status) {
    case 'operational': return 'Operational';
    case 'patched': return `Patched (${Math.round(eq.patchMinutes / 60)}h left)`;
    case 'degraded': return 'Degraded — needs repair';
    case 'failed': return 'FAILED — needs repair';
    default: return eq.status;
  }
}

/**
 * One game-minute. ctx: { powered (bool), gForce, emit }
 */
export function lifeSupportTick(state, ctx) {
  const ship = state.ship;
  const ls = state.lifeSupport;
  const res = state.resources;
  const geo = shipGeometry(ship);

  // Who breathes where
  const breathers = new Array(ship.decks.length).fill(0);
  for (const m of ship.crew) {
    if (m.dead || m.suit.wearing) continue;
    breathers[geo.deckOfRow(m.pos.sy)]++;
  }

  // Best working unit services the whole ship (ducting)
  let eff = 0;
  for (const eq of Object.values(ls.equipment)) {
    if (!eq.enabled) continue;
    if (eq.status === 'operational') eff = Math.max(eff, 1);
    else if (eq.status === 'patched' || eq.status === 'degraded') eff = Math.max(eff, PATCH_EFFICIENCY);
  }
  if (!ctx.powered) eff = 0;

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
    if (a.pressure < 1) return;

    if (breathers[di] > 0 && a.volume > 0) {
      const airKg = 1.225 * (a.pressure / EARTH_PRESSURE) * a.volume;
      a.o2Pct = Math.max(0, a.o2Pct - O2_PER_MIN * breathers[di] / airKg * 100);
      a.co2Pct = Math.min(100, a.co2Pct + CO2_PER_MIN * breathers[di] / airKg * 100);
    }

    if (eff > 0 && !a.breached && !a.vented) {
      if (a.co2Pct > TARGET_CO2) a.co2Pct = Math.max(TARGET_CO2, a.co2Pct - SCRUB_RATE * eff);
      const haveGas = res.o2Tank.current > 0 && res.n2Tank.current > 0;
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
      if (a.pressure < EARTH_PRESSURE - 0.5 && haveGas) {
        const add = Math.min(0.5 * eff, EARTH_PRESSURE - a.pressure);
        a.pressure += add;
        const kg = add / EARTH_PRESSURE * 1.225 * a.volume;
        res.o2Tank.current = Math.max(0, res.o2Tank.current - kg * 0.21);
        res.n2Tank.current = Math.max(0, res.n2Tank.current - kg * 0.79);
      }
    }
  });

  // Equipment wear: patches expire; rare failures, likelier under hard G
  for (const [deckStr, eq] of Object.entries(ls.equipment)) {
    if (eq.status === 'patched' && --eq.patchMinutes <= 0) {
      eq.status = 'failed';
      ctx.emit?.('ls-patch-expired', { deck: +deckStr });
    }
    if (eq.status === 'operational' && eq.enabled) {
      const stress = 1 + Math.max(0, ctx.gForce - 1.5) * 4;
      if (random() < FAILURE_BASE * stress) {
        eq.status = random() < 0.7 ? 'degraded' : 'failed';
        ctx.emit?.('ls-failure', { deck: +deckStr, status: eq.status });
      }
    }
  }

  // Gas exchange through the ladder shaft
  for (const [i, j] of ls.connections) {
    const A = ship.decks[i].atmosphere, B = ship.decks[j].atmosphere;
    if (A.breached || A.vented || B.breached || B.vented) {
      // A hole on one side pulls air from the other
      if ((A.breached || A.vented) && A.pressure < B.pressure) B.pressure -= (B.pressure - A.pressure) * EXCHANGE * 0.5;
      if ((B.breached || B.vented) && B.pressure < A.pressure) A.pressure -= (A.pressure - B.pressure) * EXCHANGE * 0.5;
      continue;
    }
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
        // Stow the suit once the air on deck is good again
        const a = ship.decks[geo.deckOfRow(m.pos.sy)].atmosphere;
        if (atmoStatus(a) === 'nominal') stowSuit(state, m);
        continue;
      }
    }
    const a = ship.decks[geo.deckOfRow(m.pos.sy)].atmosphere;
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

// ---- REPAIR & CONTROLS ----

/** Engineer repair attempt. Degraded → full repair; failed → temporary patch. */
export function repairLS(state, deck, skill) {
  const eq = state.lifeSupport.equipment[deck];
  if (!eq) return { success: false, message: 'No life support on this deck' };
  if (eq.status === 'operational') return { success: true, type: 'none', message: 'Already operational' };
  if (eq.status === 'degraded') {
    if (random() > 0.6 + skill * 0.008) return { success: false, message: 'Repair attempt failed — retrying' };
    eq.status = 'operational';
    return { success: true, type: 'full', message: 'Life support fully repaired' };
  }
  if (random() > 0.4 + skill * 0.006) return { success: false, message: 'Patch attempt failed — retrying' };
  eq.status = 'patched';
  eq.patchMinutes = 120 + Math.floor(random() * 360);
  return { success: true, type: 'patch', message: `Patched — about ${Math.round(eq.patchMinutes / 60)}h of service` };
}

/** Station dock overhaul: everything back to factory spec. */
export function overhaulLS(state) {
  for (const eq of Object.values(state.lifeSupport.equipment)) { eq.status = 'operational'; eq.patchMinutes = 0; }
  for (const l of Object.values(state.lifeSupport.lockers)) l.hasSuit = true;
}

export function toggleLS(state, deck) {
  const eq = state.lifeSupport.equipment[deck];
  if (!eq) return null;
  eq.enabled = !eq.enabled;
  return eq.enabled;
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
