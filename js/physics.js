// ============================================================
// LONGHAUL — Physics Engine
// Mass, acceleration vectors, gravity, crew G-force states
// Everything has mass. Everything reacts to thrust.
// ============================================================

import { TileType } from './svg-icons.js';

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
  // Future: check if crew is in a crash couch (bunk tile)
  const inCrashCouch = false; // Will check tile type later

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
  const dt = 60; // seconds per game-minute
  physicsState.velocity += physicsState.acceleration.y * dt;
  nav.velocity = physicsState.velocity;

  // Update distance traveled
  physicsState.distance += Math.abs(physicsState.velocity) * dt;
  gameState.stats.distanceTraveled = physicsState.distance;

  // Update crew states
  const stateChanges = [];
  gameState.ship.crew.forEach(member => {
    const newState = determineCrewState(physicsState.gForce, member);
    const oldState = physicsState.crewStates[member.id];

    if (oldState !== newState) {
      stateChanges.push({ member, oldState, newState });
    }

    physicsState.crewStates[member.id] = newState;

    // G-force effects on crew per minute
    if (physicsState.gForce >= G_THRESHOLDS.DANGEROUS) {
      // Prone crew take health damage
      member.health = Math.max(0, member.health - 0.5);
      member.morale = Math.max(0, member.morale - 1);
    } else if (physicsState.gForce >= G_THRESHOLDS.HIGH) {
      // Strained crew lose morale slowly
      member.morale = Math.max(0, member.morale - 0.2);
    } else if (physicsState.gForce >= G_THRESHOLDS.COMFORTABLE &&
               physicsState.gForce <= G_THRESHOLDS.STANDARD) {
      // Comfortable gravity slowly restores morale
      member.morale = Math.min(100, member.morale + 0.05);
    }
  });

  // Future: process loose objects (slide toward floor under thrust,
  // float when micro-G, slam into walls during maneuvers)

  return stateChanges;
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
