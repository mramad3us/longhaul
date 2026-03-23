// ============================================================
// LONGHAUL — Physics Engine
// Mass, acceleration vectors, gravity, crew G-force states
// Everything has mass. Everything reacts to thrust.
// ============================================================

import { TileType } from './svg-icons.js';
import { isSeatedInCouch, getCrewMission } from './crew-movement.js';

// ---- CONSTANTS ----

// Gravitational acceleration at 1G in m/s²
const G = 9.81;

// Crew G-force thresholds
export const G_THRESHOLDS = {
  MICRO_G: 0.01,    // Below this = micro-gravity (floating)
  COMFORTABLE: 0.3, // Comfortable minimum for walking
  STANDARD: 1.0,    // Earth-normal
  HIGH: 1.5,        // Uncomfortable, fatigue over time
  DANGEROUS: 2.5,   // Risk of injury without crash couch
  LETHAL: 8.0,      // Fatal without specialized equipment
};

// Crew physics states
export const CrewState = {
  FLOATING: 'floating',   // Micro-G, no thrust
  STANDING: 'standing',   // Normal gravity, walking around
  STRAINED: 'strained',   // High-G, slower movement, morale drain
  PRONE: 'prone',         // Crushed under heavy G without crash couch
  SECURED: 'secured',     // In crash couch, protected from high-G
};

// ---- MASS REGISTRY ----
// Every tile type has a mass in kg. This is the foundation.
// Bolted = attached to ship structure (doesn't move relative to ship)
// In the future, non-bolted items will react to acceleration changes.

export const TILE_MASS = {
  [TileType.EMPTY]:         0,
  [TileType.HULL_WALL]:     800,   // Heavy structural steel
  [TileType.INTERIOR_WALL]: 200,   // Lighter internal partition
  [TileType.FLOOR]:         150,   // Deck plating
  [TileType.DOOR]:          120,   // Mechanical door + actuator
  [TileType.LADDER]:        40,    // Lightweight rungs
  [TileType.CONSOLE]:       85,    // Computer terminal
  [TileType.NAV_CONSOLE]:   120,   // Navigation station with extra hardware
  [TileType.BUNK]:          60,    // Crew sleeping pod
  [TileType.TABLE]:         35,    // Mess table
  [TileType.ENGINE]:        2200,  // Epstein drive component
  [TileType.REACTOR]:       4500,  // Fusion reactor module
  [TileType.STORAGE]:       50,    // Empty crate (contents add mass later)
  [TileType.LIFE_SUPPORT]:  180,   // O2 scrubbers, water recycler
  [TileType.AIRLOCK]:       350,   // Heavy pressure door
  [TileType.MEDBAY]:        95,    // Medical station
  [TileType.CRASH_COUCH]:   150,   // Gel crash couch with harness
  [TileType.TERMINAL]:      70,    // Control terminal
  [TileType.EVA_LOCKER]:    60,    // EVA suit storage locker
};

// Whether each tile type is structurally bolted to the ship
export const TILE_BOLTED = {
  [TileType.EMPTY]:         true,
  [TileType.HULL_WALL]:     true,
  [TileType.INTERIOR_WALL]: true,
  [TileType.FLOOR]:         true,
  [TileType.DOOR]:          true,
  [TileType.LADDER]:        true,
  [TileType.CONSOLE]:       true,
  [TileType.NAV_CONSOLE]:   true,
  [TileType.BUNK]:          true,   // Crash couches are bolted
  [TileType.TABLE]:         true,   // Bolted for now; future: loose items
  [TileType.ENGINE]:        true,
  [TileType.REACTOR]:       true,
  [TileType.STORAGE]:       false,  // Crates can be loose!
  [TileType.LIFE_SUPPORT]:  true,
  [TileType.AIRLOCK]:       true,
  [TileType.MEDBAY]:        true,
  [TileType.CRASH_COUCH]:   true,   // Bolted for high-G
  [TileType.TERMINAL]:      true,
  [TileType.EVA_LOCKER]:    true,   // Bolted to wall
};

// Average crew member mass in kg
const CREW_MASS = 75;

// ---- ACCELERATION VECTOR ----
// Ship acceleration is always along the thrust axis (stern-to-bow).
// The ship is oriented vertically: thrust pushes "down" (toward stern),
// creating artificial gravity pushing crew toward the floor.
// Positive Y = toward stern (floor direction under thrust)

export function createPhysicsState() {
  return {
    // Ship acceleration vector (m/s²) — currently 1D (along thrust axis)
    acceleration: { x: 0, y: 0 },

    // Current G-force magnitude felt inside the ship
    gForce: 0,

    // Ship velocity (m/s) — scalar for now, will be vector later
    velocity: 0,

    // Distance traveled (meters)
    distance: 0,

    // Thrust state
    thrustActive: false,
    thrustLevel: 0,      // 0 to 1 (fraction of max)
    maxThrust: 10.0,     // Maximum G the engine can produce

    // Heading: 0 = prograde (accelerating), 180 = retrograde (decelerating)
    heading: 0,

    // Flip maneuver state
    flipping: false,
    flipProgress: 0,     // 0 to 1 (animation progress)
    flipDuration: 8,     // seconds of game-time for a full flip

    // Per-crew physics state
    crewStates: {},      // crewId -> CrewState

    // Loose objects tracking (for future use)
    looseObjects: [],    // { deckIdx, x, y, tileType, mass, velocity: {x, y} }

    // Ship total mass (computed)
    shipMass: 0,
  };
}

// ---- MASS COMPUTATION ----

export function computeShipMass(ship) {
  let total = 0;

  // Hull and structural mass
  ship.decks.forEach(deck => {
    deck.tiles.forEach(row => {
      row.forEach(tile => {
        total += TILE_MASS[tile] || 0;
      });
    });
  });

  // Crew mass
  total += ship.crew.length * CREW_MASS;

  return total;
}

// ---- CREW STATE DETERMINATION ----

function determineCrewState(gForce, crewMember) {
  // Crew must be actively seated in crash couch (arrived via secure-burn mission)
  // or actively healing in medbay to get protection
  let inCrashCouch = isSeatedInCouch(crewMember.id) ||
                     getCrewMission(crewMember.id) === 'healing';

  if (gForce < G_THRESHOLDS.MICRO_G) {
    return CrewState.FLOATING;
  }

  if (gForce <= G_THRESHOLDS.HIGH) {
    return CrewState.STANDING;
  }

  if (gForce <= G_THRESHOLDS.DANGEROUS) {
    if (inCrashCouch) return CrewState.SECURED;
    return CrewState.STRAINED;
  }

  // Above dangerous threshold
  if (inCrashCouch) return CrewState.SECURED;
  return CrewState.PRONE;
}

// ---- G-FORCE HEALTH EFFECTS ----
// Realistic high-G effects per game-minute:
//   0-1G:   comfortable, slow recovery
//   1.5G+:  heart stress builds, morale drains
//   2.5G+:  body damage (legs/torso first), consciousness drops
//   5G+:    severe — all body parts, rapid consciousness loss
//   8G+:    lethal — catastrophic damage

function addCondition(member, condition) {
  if (!member.conditions.includes(condition)) member.conditions.push(condition);
}

function removeCondition(member, condition) {
  const idx = member.conditions.indexOf(condition);
  if (idx !== -1) member.conditions.splice(idx, 1);
}

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }

function applyGForceEffects(member, gForce, isSecured = false) {
  // Dead crew don't update
  if (member.dead) return;

  // Crash couch / medbay reduces effective G-force — crew feels ~1/3 of adverse effects
  const effectiveG = isSecured ? gForce * 0.33 : gForce;

  const b = member.body;
  const h = member.heart;

  // ---- DEATH SYSTEM ----
  // Heart health 0% → CRITICAL state, death timer starts
  // Critical ONLY clears via medical intervention (stabilizeCrew)
  // Death happens after a random delay (2-30 minutes)
  const isCritical = member.conditions.includes('critical');

  if (h.health <= 0 || isCritical) {
    if (h.health <= 0) h.health = 0;
    if (!isCritical) {
      // Just entered critical — set random death countdown
      member.deathTimer = 2 + Math.random() * 28; // 2-30 minutes
      addCondition(member, 'critical');
      // Critical = shock → immediate unconsciousness
      member.consciousness = 10;
    }
    // Death timer ticks down even if heart recovers slightly — need medical aid
    if (member.deathTimer >= 0) {
      member.deathTimer -= 1;
      if (member.deathTimer <= 0) {
        member.dead = true;
        member.consciousness = 0;
        h.bpm = 0;
        h.stress = 0;
        member.conditions = ['dead'];
        return;
      }
    }
  }

  // ---- G-FORCE BODY DAMAGE (uses effectiveG — reduced when in crash couch/medbay) ----
  if (effectiveG >= G_THRESHOLDS.LETHAL) {
    b.head = clamp(b.head - 2.0);
    b.torso = clamp(b.torso - 2.5);
    b.leftArm = clamp(b.leftArm - 1.5);
    b.rightArm = clamp(b.rightArm - 1.5);
    b.leftLeg = clamp(b.leftLeg - 2.0);
    b.rightLeg = clamp(b.rightLeg - 2.0);
    h.stress = clamp(h.stress + 8);
    h.health = clamp(h.health - 1.5);
    member.morale = clamp(member.morale - 3);
    addCondition(member, 'crushed');
    addCondition(member, 'cardiac-stress');
  } else if (effectiveG >= G_THRESHOLDS.DANGEROUS) {
    b.torso = clamp(b.torso - 0.4);
    b.leftLeg = clamp(b.leftLeg - 0.6);
    b.rightLeg = clamp(b.rightLeg - 0.6);
    h.stress = clamp(h.stress + 4);
    h.health = clamp(h.health - 0.3);
    member.morale = clamp(member.morale - 1);
    addCondition(member, 'crushed');
    addCondition(member, 'cardiac-stress');
  } else if (effectiveG >= G_THRESHOLDS.HIGH) {
    b.leftLeg = clamp(b.leftLeg - 0.05);
    b.rightLeg = clamp(b.rightLeg - 0.05);
    h.stress = clamp(h.stress + 1.5);
    member.morale = clamp(member.morale - 0.2);
    removeCondition(member, 'crushed');
    if (h.stress > 50) addCondition(member, 'cardiac-stress');
  } else if (effectiveG >= G_THRESHOLDS.COMFORTABLE) {
    h.stress = clamp(h.stress - 5);
    member.morale = clamp(member.morale + 0.05);
    // Slow body recovery (head doesn't auto-heal past brain damage threshold)
    b.torso = clamp(b.torso + 0.01);
    b.leftArm = clamp(b.leftArm + 0.02);
    b.rightArm = clamp(b.rightArm + 0.02);
    b.leftLeg = clamp(b.leftLeg + 0.02);
    b.rightLeg = clamp(b.rightLeg + 0.02);
    if (!member.conditions.includes('brain-damage')) {
      b.head = clamp(b.head + 0.01);
    }
    removeCondition(member, 'crushed');
    if (h.stress < 20) removeCondition(member, 'cardiac-stress');
  } else {
    // Micro-G
    h.stress = clamp(h.stress - 4);
    if (h.stress < 20) removeCondition(member, 'cardiac-stress');
    removeCondition(member, 'crushed');
  }

  // ---- HEART RECOVERY ----
  // Heart heals slowly when no cardiac-stress or critical condition is active
  if (!member.conditions.includes('cardiac-stress') &&
      !member.conditions.includes('critical') &&
      h.health < 100) {
    h.health = clamp(h.health + 0.15);
  }

  // ---- BRAIN DAMAGE ----
  // Head at 0% = brain damage (permanent until medical equipment)
  if (b.head <= 0) {
    b.head = 0;
    addCondition(member, 'brain-damage');
  }
  // brain-damage is NOT auto-removed — requires future medical treatment

  // ---- CONSCIOUSNESS ----
  // Consciousness bottoms at 10% (alive but incapacitated)
  const consciousnessFloor = 10;
  const consciousnessCap = member.conditions.includes('brain-damage') ? 50 : 100;

  // Consciousness pressure from injuries
  if (b.head < 20) member.consciousness -= 2;
  if (b.torso < 15) member.consciousness -= 3;
  if (effectiveG >= G_THRESHOLDS.DANGEROUS) member.consciousness -= 1.5;

  // Recovery when not under extreme stress
  if (effectiveG < G_THRESHOLDS.DANGEROUS && b.head >= 20 && b.torso >= 15) {
    member.consciousness += 0.5;
  }

  member.consciousness = clamp(member.consciousness, consciousnessFloor, consciousnessCap);

  // ---- CARDIAC STRESS DURATION & HEART DEGRADATION ----
  if (member.conditions.includes('cardiac-stress')) {
    h.stressMinutes = (h.stressMinutes || 0) + 1;
    // After 10 minutes of sustained cardiac stress, heart health degrades
    if (h.stressMinutes > 10) {
      const degradeRate = 0.1 + (h.stressMinutes - 10) * 0.02; // accelerates over time
      h.health = clamp(h.health - degradeRate);
    }
  } else {
    h.stressMinutes = 0;
  }

  // ---- HEART BPM & BLOOD PRESSURE ----
  const restBpm = 72;
  h.bpm = Math.round(restBpm + (h.stress / 100) * 120); // 72-192 bpm range

  // Blood pressure: stress and G-force driven
  // Normal: 120/80. Stress raises both. Will spike with bleeding (future).
  const stressFactor = h.stress / 100;
  h.bpSystolic = Math.round(120 + stressFactor * 60 + Math.max(0, gForce - 1) * 15);
  h.bpDiastolic = Math.round(80 + stressFactor * 30 + Math.max(0, gForce - 1) * 8);

  // ---- DERIVED CONDITIONS ----
  const anyInjured = [b.head, b.torso, b.leftArm, b.rightArm, b.leftLeg, b.rightLeg].some(v => v < 70);
  if (anyInjured) addCondition(member, 'injured');
  else removeCondition(member, 'injured');

  if (member.consciousness <= consciousnessFloor) addCondition(member, 'unconscious');
  else removeCondition(member, 'unconscious');
}

// ---- PHYSICS TICK ----
// Called once per game-minute from the game loop

export function physicsTick(gameState, physicsState) {
  const nav = gameState.navigation;

  // Update acceleration from thrust
  if (physicsState.thrustActive && gameState.resources.fuel.current > 0) {
    const thrustG = physicsState.maxThrust * physicsState.thrustLevel;
    physicsState.acceleration.y = thrustG * G;
    physicsState.gForce = thrustG;
    nav.thrust = thrustG;
  } else {
    // No thrust = micro-gravity (deep space, no nearby bodies)
    physicsState.acceleration.y = 0;
    physicsState.gForce = 0;
    nav.thrust = 0;

    // Auto-disable thrust if fuel runs out
    if (physicsState.thrustActive && gameState.resources.fuel.current <= 0) {
      physicsState.thrustActive = false;
      physicsState.thrustLevel = 0;
    }
  }

  // Update velocity (m/s) — 1 game-minute = 60 real seconds
  // Heading 0 = prograde (adds velocity), 180 = retrograde (subtracts velocity)
  const dt = 60; // seconds per game-minute
  const thrustSign = physicsState.heading === 0 ? 1 : -1;
  physicsState.velocity += thrustSign * physicsState.acceleration.y * dt;
  nav.velocity = physicsState.velocity;
  nav.heading = physicsState.heading;

  // Update distance traveled
  physicsState.distance += Math.abs(physicsState.velocity) * dt;
  gameState.stats.distanceTraveled = physicsState.distance;

  // Update ship position in AU (convert velocity m/s → AU displacement over dt seconds)
  // 1 AU = 149,597,870,700 m
  if (gameState.shipPosition) {
    const metersPerAU = 149_597_870_700;
    const displacementAU = physicsState.velocity * dt / metersPerAU;
    // Move along current heading axis (simplified: heading 0 = +x prograde)
    const hSign = physicsState.heading === 0 ? 1 : -1;
    gameState.shipPosition.x += hSign * displacementAU;
  }

  // Update crew states
  const stateChanges = [];
  gameState.ship.crew.forEach(member => {
    const newState = determineCrewState(physicsState.gForce, member);
    const oldState = physicsState.crewStates[member.id];

    if (oldState !== newState) {
      stateChanges.push({ member, oldState, newState });
    }

    physicsState.crewStates[member.id] = newState;

    // G-force effects on crew per minute (secured crew get reduced effects)
    applyGForceEffects(member, physicsState.gForce, newState === CrewState.SECURED);
  });

  // Future: process loose objects (slide toward floor under thrust,
  // float when micro-G, slam into walls during maneuvers)

  return stateChanges;
}

// ---- MEDICAL INTERVENTION ----

// Stabilize a critical crew member (first aid or medbay).
// Cancels death timer, restores heart to 15%, removes critical.
// Returns true if stabilization succeeded.
export function stabilizeCrew(member) {
  if (member.dead) return false;
  if (!member.conditions.includes('critical')) return false;

  removeCondition(member, 'critical');
  member.deathTimer = -1;
  member.heart.health = Math.max(member.heart.health, 15); // minimum 15% heart
  member.heart.stress = Math.min(member.heart.stress, 50); // reduce stress
  return true;
}

// Apply medbay healing per game-minute. Heals all body parts and heart.
// Returns true if crew is fully healed.
export function medbayHealTick(member) {
  if (member.dead) return false;
  const b = member.body;
  const h = member.heart;

  // Heal body parts
  b.head = clamp(b.head + 0.3);
  b.torso = clamp(b.torso + 0.25);
  b.leftArm = clamp(b.leftArm + 0.4);
  b.rightArm = clamp(b.rightArm + 0.4);
  b.leftLeg = clamp(b.leftLeg + 0.35);
  b.rightLeg = clamp(b.rightLeg + 0.35);

  // Heal heart
  h.health = clamp(h.health + 0.2);
  h.stress = clamp(h.stress - 1);

  // Restore consciousness
  const cap = member.conditions.includes('brain-damage') ? 50 : 100;
  member.consciousness = clamp(member.consciousness + 0.8, 10, cap);

  // Check if fully healed
  const parts = [b.head, b.torso, b.leftArm, b.rightArm, b.leftLeg, b.rightLeg];
  const bodyOk = parts.every(v => v >= 99.5);
  const heartOk = h.health >= 99.5;
  return bodyOk && heartOk;
}

// ---- THRUST CONTROL ----

export function toggleThrust(physicsState) {
  physicsState.thrustActive = !physicsState.thrustActive;
  if (physicsState.thrustActive) {
    physicsState.thrustLevel = 1.0; // Full thrust (2G)
  } else {
    physicsState.thrustLevel = 0;
  }
  return physicsState.thrustActive;
}

export function setThrustLevel(physicsState, level) {
  physicsState.thrustLevel = Math.max(0, Math.min(1, level));
  if (physicsState.thrustLevel === 0) {
    physicsState.thrustActive = false;
  } else {
    physicsState.thrustActive = true;
  }
}

// ---- FLIP MANEUVER ----
// 180° rotation using RCS thrusters. Ship must cut main engine first.

export function startFlip(physicsState) {
  if (physicsState.flipping) return false;
  // Cut thrust during flip
  physicsState.thrustActive = false;
  physicsState.thrustLevel = 0;
  physicsState.flipping = true;
  physicsState.flipProgress = 0;
  return true;
}

// Called from animation frame (real-time, not game-time)
export function updateFlip(physicsState, deltaSec) {
  if (!physicsState.flipping) return false;
  physicsState.flipProgress += deltaSec / physicsState.flipDuration;
  if (physicsState.flipProgress >= 1) {
    physicsState.flipProgress = 0;
    physicsState.flipping = false;
    physicsState.heading = physicsState.heading === 0 ? 180 : 0;
    return true; // flip complete
  }
  return false; // still flipping
}
