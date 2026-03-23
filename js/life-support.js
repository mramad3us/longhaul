// ============================================================
// LONGHAUL — Life Support System
// Per-compartment atmosphere: pressure, O2, N2, CO2
// Tank management, CO2 scrubbing, hull breach, EVA suits
// ============================================================

import { TileType } from './svg-icons.js';

// ---- CONSTANTS ----

// Target atmosphere (commercial aircraft cabin mix)
export const EARTH_PRESSURE = 101.3;   // kPa
export const TARGET_O2_PCT  = 20.9;    // %
export const TARGET_N2_PCT  = 78.1;    // %
export const TARGET_CO2_PCT = 0.04;    // %

// Each non-wall, non-empty tile = ~22.5 m^3 (3m x 3m x 2.5m ceiling)
const TILE_VOLUME = 22.5;

// Crew breathing per game-minute
// Average: 0.84 kg O2/day = 0.000583 kg/min
// CO2 output: ~1.0 kg/day = 0.000694 kg/min
const O2_BREATHE_RATE   = 0.000583; // kg per person per minute
const CO2_EXHALE_RATE   = 0.000694; // kg per person per minute

// CO2 scrubber: removes CO2 pct per minute at full capacity
const SCRUBBER_RATE     = 0.008;    // % CO2 removed per minute (full health)
const PATCH_EFFICIENCY  = 0.5;      // patched equipment runs at 50%

// O2 / N2 injection: % atmosphere injected per minute from tanks
const INJECTION_RATE    = 0.05;     // % per minute

// Tank consumption rate per % injected per m^3 of compartment
const TANK_KG_PER_PCT_M3 = 0.0012; // kg per 1% per m^3

// Hull breach: fraction of pressure lost per minute
const BREACH_RATE       = 0.20;     // 20% of current pressure per minute

// Inter-deck gas exchange through ladder connections
const EXCHANGE_RATE     = 0.08;     // 8% of delta per minute

// Random failure
const FAILURE_CHANCE    = 0.0003;   // per minute (~0.03%, ~once per 55 hours)
const PATCH_DURATION_MIN = 120;     // 2 hours minimum
const PATCH_DURATION_MAX = 480;     // 8 hours maximum

// Health thresholds
export const ATMO_THRESHOLDS = {
  // Low O2
  HYPOXIA_MILD:     16,    // % — mild symptoms
  HYPOXIA_SEVERE:   10,    // % — consciousness loss
  HYPOXIA_LETHAL:   6,     // % — death risk

  // High CO2 (real-world thresholds)
  HYPERCAPNIA_MILD:   2,   // % — headache, drowsiness, tachycardia
  HYPERCAPNIA_MODERATE: 3, // % — dyspnea, dizziness, confusion, panic
  HYPERCAPNIA_SEVERE: 5,   // % — loss of coordination, tremor, near-unconsciousness
  HYPERCAPNIA_LETHAL: 8,   // % — convulsions, death

  // Low pressure
  PRESSURE_LOW:      63,   // kPa — uncomfortable (6000m altitude equiv)
  PRESSURE_DANGER:   35,   // kPa — consciousness loss
  PRESSURE_LETHAL:   12,   // kPa — ebullism, rapid death
};

// EVA suits
export const EVA_SUIT_O2_HOURS  = 48;   // ~2 days per suit

// Suit types (extensible for marine armor, power armor later)
export const SuitType = {
  EVA: 'eva',           // No armor, life support only — blue suit
  // MARINE: 'marine',  // Ballistic protection — black suit (future)
  // POWER: 'power',    // Heavy protection — heavy suit (future)
};

// ---- INITIALIZATION ----

// Count the interior (non-empty, non-wall) tiles in a deck
function countInteriorTiles(deck) {
  let count = 0;
  deck.tiles.forEach(row => {
    row.forEach(tile => {
      if (tile !== TileType.EMPTY && tile !== TileType.HULL_WALL &&
          tile !== TileType.INTERIOR_WALL) {
        count++;
      }
    });
  });
  return count;
}

// Check if two adjacent decks are connected (share a ladder column)
function decksConnected(deckA, deckB) {
  if (!deckA || !deckB) return false;
  const lastRowA = deckA.tiles[deckA.tiles.length - 1];
  const firstRowB = deckB.tiles[0];
  if (!lastRowA || !firstRowB) return false;
  for (let x = 0; x < Math.min(lastRowA.length, firstRowB.length); x++) {
    if (lastRowA[x] === TileType.LADDER && firstRowB[x] === TileType.LADDER) {
      return true;
    }
  }
  return false;
}

// Find which decks have LIFE_SUPPORT tiles
function findLSTiles(ship) {
  const result = [];
  ship.decks.forEach((deck, di) => {
    deck.tiles.forEach((row, ry) => {
      row.forEach((tile, rx) => {
        if (tile === TileType.LIFE_SUPPORT) {
          result.push({ deckIdx: di, x: rx, y: ry });
        }
      });
    });
  });
  return result;
}

// Find EVA locker tiles per deck
function findLockerTiles(ship) {
  const lockers = []; // { deckIdx, x, y, suitType, hasSuit }
  ship.decks.forEach((deck, di) => {
    deck.tiles.forEach((row, ry) => {
      row.forEach((tile, rx) => {
        if (tile === TileType.EVA_LOCKER) {
          lockers.push({ deckIdx: di, x: rx, y: ry, suitType: SuitType.EVA, hasSuit: true });
        }
      });
    });
  });
  return lockers;
}

export function initLifeSupport(gameState) {
  const ship = gameState.ship;

  // Per-deck atmosphere
  ship.decks.forEach((deck, di) => {
    const interior = countInteriorTiles(deck);
    deck.atmosphere = {
      pressure: EARTH_PRESSURE,
      o2Pct: TARGET_O2_PCT,
      n2Pct: TARGET_N2_PCT,
      co2Pct: TARGET_CO2_PCT,
      volume: interior * TILE_VOLUME,
      breached: false,
      depressurized: false,
    };
  });

  // EVA suit lockers — each locker holds 1 suit
  gameState.suitLockers = findLockerTiles(ship);

  // Life support equipment state
  const lsTiles = findLSTiles(ship);
  gameState.lsEquipment = {};
  lsTiles.forEach(ls => {
    gameState.lsEquipment[ls.deckIdx] = {
      status: 'operational',  // operational | degraded | patched | failed
      enabled: true,          // crew can manually toggle on/off
      co2Scrubber: true,
      o2Injector: true,
      n2Injector: true,
      failureTimer: -1,
      patchDurability: -1,
      deckIdx: ls.deckIdx,
      x: ls.x,
      y: ls.y,
    };
  });

  // Build adjacency list for gas exchange
  gameState.deckConnections = [];
  for (let i = 0; i < ship.decks.length - 1; i++) {
    if (decksConnected(ship.decks[i], ship.decks[i + 1])) {
      gameState.deckConnections.push([i, i + 1]);
    }
  }

  // Replace old oxygen resource with proper tanks
  // Keep old resource keys for backward compat but add tank data
  gameState.resources.o2Tank  = { current: 500, max: 500, unit: 'kg' };
  gameState.resources.n2Tank  = { current: 500, max: 500, unit: 'kg' };

  // EVA suit state per crew
  ship.crew.forEach(member => {
    if (!member.evaSuit) {
      member.evaSuit = {
        wearing: false,
        o2Remaining: 0,
        maxO2: EVA_SUIT_O2_HOURS,
      };
    }
  });
}

// ---- HELPERS ----

function addCondition(member, condition) {
  if (!member.conditions.includes(condition)) member.conditions.push(condition);
}

function removeCondition(member, condition) {
  const idx = member.conditions.indexOf(condition);
  if (idx !== -1) member.conditions.splice(idx, 1);
}

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }

// ---- MAIN TICK ----
// Called once per game-minute

export function lifeSupportTick(gameState) {
  const ship = gameState.ship;
  const res = gameState.resources;
  const lsEquip = gameState.lsEquipment;

  // --- SHIP-WIDE LS CHECK ---
  // Any working LS module services the entire ship's atmosphere
  let shipHasWorkingLS = false;
  let bestLSEfficiency = 0;
  for (const [, eq] of Object.entries(lsEquip)) {
    if (eq.enabled !== false && (eq.status === 'operational' || eq.status === 'patched')) {
      shipHasWorkingLS = true;
      const eff = eq.status === 'patched' ? PATCH_EFFICIENCY : 1.0;
      if (eff > bestLSEfficiency) bestLSEfficiency = eff;
    }
  }

  // --- PER-COMPARTMENT PROCESSING ---
  ship.decks.forEach((deck, di) => {
    const atmo = deck.atmosphere;
    if (!atmo) return;

    // Skip fully depressurized compartments (nothing to process except breach)
    const isVacuum = atmo.pressure < 1;

    // 1. HULL BREACH — rapid decompression
    if (atmo.breached && !isVacuum) {
      atmo.pressure *= (1 - BREACH_RATE);
      // Gas composition stays proportional, just less of it
      if (atmo.pressure < 0.1) {
        atmo.pressure = 0;
        atmo.o2Pct = 0;
        atmo.n2Pct = 0;
        atmo.co2Pct = 0;
      }
    }

    // 2. VOLUNTARY DEPRESSURIZATION
    if (atmo.depressurized && !isVacuum) {
      // Controlled venting — slower than breach
      atmo.pressure *= 0.90;
      if (atmo.pressure < 0.5) {
        atmo.pressure = 0;
        atmo.o2Pct = 0;
        atmo.n2Pct = 0;
        atmo.co2Pct = 0;
      }
    }

    if (isVacuum) return; // nothing more to do in vacuum

    // 3. CREW BREATHING — consume O2, produce CO2
    const crewInDeck = ship.crew.filter(c =>
      !c.dead && c.deck === di && !(c.evaSuit && c.evaSuit.wearing)
    );
    const breathingCount = crewInDeck.length;

    if (breathingCount > 0 && atmo.volume > 0) {
      // Air density at current pressure (proportional to sea-level)
      const airDensity = 1.225 * (atmo.pressure / EARTH_PRESSURE);
      const totalAirMass = airDensity * atmo.volume; // kg of air in compartment

      // O2 consumed as percentage of total atmosphere
      const o2Drop = (O2_BREATHE_RATE * breathingCount / totalAirMass) * 100;
      const co2Rise = (CO2_EXHALE_RATE * breathingCount / totalAirMass) * 100;
      atmo.o2Pct = Math.max(0, atmo.o2Pct - o2Drop);
      atmo.co2Pct = Math.min(100, atmo.co2Pct + co2Rise);
    }

    // 4. LIFE SUPPORT EQUIPMENT — scrub CO2, inject O2/N2
    // Any working LS module on the ship services all compartments
    const eq = lsEquip[di];

    if (shipHasWorkingLS && !atmo.breached && !atmo.depressurized) {
      const eff = bestLSEfficiency;

      // CO2 scrubbing
      if (atmo.co2Pct > TARGET_CO2_PCT) {
        const scrub = SCRUBBER_RATE * eff;
        atmo.co2Pct = Math.max(TARGET_CO2_PCT, atmo.co2Pct - scrub);
      }

      // O2 injection (only if we also have N2 — pure O2 is explosive)
      if (atmo.o2Pct < TARGET_O2_PCT && res.o2Tank.current > 0 && res.n2Tank.current > 0) {
        const inject = INJECTION_RATE * eff;
        const needed = TARGET_O2_PCT - atmo.o2Pct;
        const actual = Math.min(inject, needed);
        atmo.o2Pct += actual;

        // Consume from O2 tank
        const tankUse = actual * atmo.volume * TANK_KG_PER_PCT_M3;
        res.o2Tank.current = Math.max(0, res.o2Tank.current - tankUse);
      }

      // N2 injection
      if (atmo.n2Pct < TARGET_N2_PCT && res.n2Tank.current > 0) {
        const inject = INJECTION_RATE * eff;
        const needed = TARGET_N2_PCT - atmo.n2Pct;
        const actual = Math.min(inject, needed);
        atmo.n2Pct += actual;

        const tankUse = actual * atmo.volume * TANK_KG_PER_PCT_M3;
        res.n2Tank.current = Math.max(0, res.n2Tank.current - tankUse);
      }

      // Pressure regulation — maintain target pressure
      const targetPressure = EARTH_PRESSURE;
      if (atmo.pressure < targetPressure - 0.5 && res.o2Tank.current > 0 && res.n2Tank.current > 0) {
        const pressureInject = Math.min(0.5 * eff, targetPressure - atmo.pressure);
        atmo.pressure += pressureInject;
      }
    }

    // 5. RANDOM EQUIPMENT FAILURES
    if (eq && eq.status === 'operational') {
      if (Math.random() < FAILURE_CHANCE) {
        // Random failure mode
        const roll = Math.random();
        if (roll < 0.4) {
          eq.co2Scrubber = false;
          eq.status = 'degraded';
        } else if (roll < 0.7) {
          eq.o2Injector = false;
          eq.status = 'degraded';
        } else {
          eq.co2Scrubber = false;
          eq.o2Injector = false;
          eq.n2Injector = false;
          eq.status = 'failed';
        }
      }
    }

    // 6. PATCH DURABILITY COUNTDOWN
    if (eq && eq.status === 'patched' && eq.patchDurability > 0) {
      eq.patchDurability--;
      if (eq.patchDurability <= 0) {
        // Patch wore out — back to failed
        eq.status = 'failed';
        eq.co2Scrubber = false;
        eq.o2Injector = false;
        eq.n2Injector = false;
        eq.patchDurability = -1;
      }
    }
  });

  // 7. INTER-DECK GAS EXCHANGE (through ladders)
  if (gameState.deckConnections) {
    for (const [a, b] of gameState.deckConnections) {
      const atmoA = ship.decks[a]?.atmosphere;
      const atmoB = ship.decks[b]?.atmosphere;
      if (!atmoA || !atmoB) continue;

      // Don't exchange with depressurized/breached unless both are
      if (atmoA.breached || atmoA.depressurized || atmoB.breached || atmoB.depressurized) {
        // If one side is breached/depressurized, air flows out from the connected deck too
        if ((atmoA.breached || atmoA.depressurized) && atmoA.pressure < atmoB.pressure) {
          const delta = (atmoB.pressure - atmoA.pressure) * EXCHANGE_RATE * 0.5;
          atmoB.pressure -= delta;
        }
        if ((atmoB.breached || atmoB.depressurized) && atmoB.pressure < atmoA.pressure) {
          const delta = (atmoA.pressure - atmoB.pressure) * EXCHANGE_RATE * 0.5;
          atmoA.pressure -= delta;
        }
        continue;
      }

      // Normal equalization
      const pressureDelta = (atmoA.pressure - atmoB.pressure) * EXCHANGE_RATE;
      atmoA.pressure -= pressureDelta;
      atmoB.pressure += pressureDelta;

      const o2Delta = (atmoA.o2Pct - atmoB.o2Pct) * EXCHANGE_RATE;
      atmoA.o2Pct -= o2Delta;
      atmoB.o2Pct += o2Delta;

      const n2Delta = (atmoA.n2Pct - atmoB.n2Pct) * EXCHANGE_RATE;
      atmoA.n2Pct -= n2Delta;
      atmoB.n2Pct += n2Delta;

      const co2Delta = (atmoA.co2Pct - atmoB.co2Pct) * EXCHANGE_RATE;
      atmoA.co2Pct -= co2Delta;
      atmoB.co2Pct += co2Delta;
    }
  }

  // 8. CREW HEALTH EFFECTS FROM ATMOSPHERE
  ship.crew.forEach(member => {
    if (member.dead) return;

    const deck = ship.decks[member.deck];
    if (!deck || !deck.atmosphere) return;
    const atmo = deck.atmosphere;

    // EVA suit users breathe from suit supply
    if (member.evaSuit && member.evaSuit.wearing) {
      member.evaSuit.o2Remaining -= 1 / 60; // hours per minute
      if (member.evaSuit.o2Remaining <= 0) {
        member.evaSuit.o2Remaining = 0;
        member.evaSuit.wearing = false;
        // Suit O2 depleted — now exposed to atmosphere
      } else {
        // Protected by suit
        removeCondition(member, 'hypoxic');
        removeCondition(member, 'hypercapnia');
        removeCondition(member, 'decompression');
        return;
      }
    }

    // LOW O2 effects
    if (atmo.o2Pct < ATMO_THRESHOLDS.HYPOXIA_MILD) {
      addCondition(member, 'hypoxic');
      if (atmo.o2Pct < ATMO_THRESHOLDS.HYPOXIA_LETHAL) {
        member.consciousness = Math.max(10, member.consciousness - 5);
        member.heart.health = clamp(member.heart.health - 0.5);
      } else if (atmo.o2Pct < ATMO_THRESHOLDS.HYPOXIA_SEVERE) {
        member.consciousness = Math.max(10, member.consciousness - 2);
      } else {
        member.consciousness = Math.max(10, member.consciousness - 0.3);
      }
    } else {
      removeCondition(member, 'hypoxic');
    }

    // HIGH CO2 effects (realistic hypercapnia progression)
    if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_MILD) {
      addCondition(member, 'hypercapnia');
      if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_LETHAL) {
        // 8%+ CO2: convulsions, rapid organ damage, death
        member.consciousness = Math.max(0, member.consciousness - 6);
        member.heart.health = clamp(member.heart.health - 1.0);
        member.body.head = clamp(member.body.head - 0.5); // brain damage from CO2 narcosis
        member.body.torso = clamp(member.body.torso - 0.3); // respiratory failure
      } else if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_SEVERE) {
        // 5-8% CO2: loss of coordination, tremor, near-unconsciousness
        member.consciousness = Math.max(10, member.consciousness - 3);
        member.heart.health = clamp(member.heart.health - 0.2); // tachycardia strain
        member.morale = clamp(member.morale - 1.5); // panic/distress
        member.body.head = clamp(member.body.head - 0.2); // confusion, impaired judgment
      } else if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_MODERATE) {
        // 3-5% CO2: dyspnea, dizziness, confusion, anxiety
        member.consciousness = Math.max(10, member.consciousness - 1);
        member.morale = clamp(member.morale - 1.0); // anxiety, panic attacks
        member.heart.health = clamp(member.heart.health - 0.1); // elevated heart rate
      } else {
        // 2-3% CO2: headache, drowsiness, elevated heart rate
        member.consciousness = Math.max(10, member.consciousness - 0.3);
        member.morale = clamp(member.morale - 0.5); // discomfort, headache
      }
    } else {
      removeCondition(member, 'hypercapnia');
    }

    // LOW PRESSURE effects
    if (atmo.pressure < ATMO_THRESHOLDS.PRESSURE_LOW) {
      addCondition(member, 'decompression');
      if (atmo.pressure < ATMO_THRESHOLDS.PRESSURE_LETHAL) {
        // Ebullism — rapid death
        member.consciousness = Math.max(10, member.consciousness - 8);
        member.heart.health = clamp(member.heart.health - 2);
        member.body.torso = clamp(member.body.torso - 1);
        member.body.head = clamp(member.body.head - 1);
      } else if (atmo.pressure < ATMO_THRESHOLDS.PRESSURE_DANGER) {
        member.consciousness = Math.max(10, member.consciousness - 3);
      } else {
        member.consciousness = Math.max(10, member.consciousness - 0.5);
      }
    } else {
      removeCondition(member, 'decompression');
    }
  });

  // 9. UPDATE LEGACY O2 RESOURCE (for resource panel display — shows hours remaining)
  // Calculate approximate hours of O2 remaining based on tank + crew consumption
  const livingCrew = ship.crew.filter(c => !c.dead).length;
  if (livingCrew > 0) {
    const kgPerHour = O2_BREATHE_RATE * 60 * livingCrew;
    const hoursRemaining = kgPerHour > 0 ? res.o2Tank.current / kgPerHour : 999;
    res.oxygen.current = Math.min(hoursRemaining, res.oxygen.max);
  }
}

// ---- EQUIPMENT REPAIR ----

// Quick patch — temporary fix, requires engineering skill
// Returns { success, message }
export function quickPatchLS(gameState, deckIdx, engineerSkill) {
  const eq = gameState.lsEquipment[deckIdx];
  if (!eq) return { success: false, message: 'No life support equipment on this deck' };
  if (eq.status === 'operational') return { success: false, message: 'Equipment already operational' };

  // Success chance: 40% base + 0.6% per skill point
  const chance = 0.40 + engineerSkill * 0.006;
  if (Math.random() > chance) {
    return { success: false, message: 'Patch attempt failed — retry needed' };
  }

  eq.status = 'patched';
  eq.co2Scrubber = true;
  eq.o2Injector = true;
  eq.n2Injector = true;
  eq.patchDurability = PATCH_DURATION_MIN +
    Math.floor(Math.random() * (PATCH_DURATION_MAX - PATCH_DURATION_MIN));

  return { success: true, message: `Patched — estimated ${Math.round(eq.patchDurability / 60)}h durability` };
}

// Full repair — permanent fix, requires materials or station dock
export function fullRepairLS(gameState, deckIdx) {
  const eq = gameState.lsEquipment[deckIdx];
  if (!eq) return { success: false, message: 'No life support equipment' };

  eq.status = 'operational';
  eq.co2Scrubber = true;
  eq.o2Injector = true;
  eq.n2Injector = true;
  eq.patchDurability = -1;

  return { success: true, message: 'Life support fully restored' };
}

// ---- EQUIPMENT CONTROLS ----

// Toggle life support on/off for a deck
export function toggleLS(gameState, deckIdx) {
  const eq = gameState.lsEquipment[deckIdx];
  if (!eq) return false;
  eq.enabled = !eq.enabled;
  return eq.enabled;
}

// ---- COMPARTMENT CONTROLS ----

// Voluntarily depressurize a compartment (fire suppression)
export function depressurizeCompartment(gameState, deckIdx) {
  const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
  if (!atmo) return false;
  atmo.depressurized = true;
  return true;
}

// Cancel depressurization and begin repressurization
export function repressurizeCompartment(gameState, deckIdx) {
  const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
  if (!atmo) return false;
  atmo.depressurized = false;
  // LS will naturally repressurize on next ticks
  return true;
}

// Trigger a hull breach on a compartment
export function breachCompartment(gameState, deckIdx) {
  const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
  if (!atmo) return false;
  atmo.breached = true;
  return true;
}

// Seal a hull breach (repair)
export function sealBreach(gameState, deckIdx) {
  const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
  if (!atmo) return false;
  atmo.breached = false;
  return true;
}

// ---- EVA SUIT ----

// Find nearest locker with a suit on the crew's deck
export function findNearestSuitLocker(gameState, deckIdx, fromX, fromY) {
  if (!gameState.suitLockers) return null;
  let best = null, bestD = Infinity;
  for (const locker of gameState.suitLockers) {
    if (locker.deckIdx !== deckIdx || !locker.hasSuit) continue;
    const d = Math.abs(locker.x - fromX) + Math.abs(locker.y - fromY);
    if (d < bestD) { bestD = d; best = locker; }
  }
  return best;
}

// Count available suits on a deck
export function countSuitsOnDeck(gameState, deckIdx) {
  if (!gameState.suitLockers) return 0;
  return gameState.suitLockers.filter(l => l.deckIdx === deckIdx && l.hasSuit).length;
}

// Crew member dons an EVA suit from nearest locker
export function donEvaSuit(gameState, member, locker) {
  if (!member.evaSuit) return false;
  if (member.evaSuit.wearing) return false;
  if (!locker || !locker.hasSuit) return false;

  locker.hasSuit = false;
  member.evaSuit.wearing = true;
  member.evaSuit.suitType = locker.suitType;
  member.evaSuit.o2Remaining = member.evaSuit.maxO2;
  member.evaSuit.fromLocker = locker; // track source for return
  return true;
}

// Crew member removes EVA suit (returns to its locker)
export function removeEvaSuit(gameState, member) {
  if (!member.evaSuit || !member.evaSuit.wearing) return false;
  if (member.evaSuit.fromLocker) {
    member.evaSuit.fromLocker.hasSuit = true;
  }
  member.evaSuit.wearing = false;
  member.evaSuit.suitType = null;
  member.evaSuit.o2Remaining = 0;
  member.evaSuit.fromLocker = null;
  return true;
}

// ---- ATMOSPHERE STATUS ----

export function getAtmoStatus(atmo) {
  if (!atmo) return 'unknown';
  if (atmo.breached) return 'breached';
  if (atmo.depressurized) return 'depressurized';
  if (atmo.pressure < ATMO_THRESHOLDS.PRESSURE_LETHAL) return 'vacuum';
  if (atmo.pressure < ATMO_THRESHOLDS.PRESSURE_DANGER) return 'critical';
  if (atmo.o2Pct < ATMO_THRESHOLDS.HYPOXIA_SEVERE) return 'critical';
  if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_SEVERE) return 'critical';
  if (atmo.pressure < ATMO_THRESHOLDS.PRESSURE_LOW) return 'warning';
  if (atmo.o2Pct < ATMO_THRESHOLDS.HYPOXIA_MILD) return 'warning';
  if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_MODERATE) return 'warning';
  if (atmo.co2Pct > ATMO_THRESHOLDS.HYPERCAPNIA_MILD) return 'warning';
  return 'nominal';
}

export function getEquipmentStatusLabel(eq) {
  if (!eq) return 'None';
  if (eq.enabled === false) return 'DISABLED (Manual Override)';
  switch (eq.status) {
    case 'operational': return 'Operational';
    case 'patched':     return `Patched (${Math.round(eq.patchDurability / 60)}h left)`;
    case 'degraded':    return 'Degraded — Needs Repair';
    case 'failed':      return 'FAILED — Needs Repair';
    default:            return eq.status;
  }
}
