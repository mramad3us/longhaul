// ============================================================
// LONGHAUL — Entity System
// Ships, stations, and other objects in the solar system.
// Each entity has a position, velocity vector, and state.
// ============================================================

import { PLANETS, ASTEROIDS } from './solar-system.js';
import { SpatialHash } from './spatial-hash.js';

// ---- CONSTANTS ----
const AU_M = 149_597_870_700;  // meters per AU
const TWO_PI = Math.PI * 2;
const GM_SUN = 1.327124e20;    // m³/s² — solar gravitational parameter
const DT = 60;                  // seconds per game-minute

// ---- SPATIAL INDEX (module-level singleton, rebuilt each tick) ----
let spatialGrid = new SpatialHash(0.05);

export const EntityType = {
  STATION: 'station',
  SHIP: 'ship',
};

export const EntityState = {
  STATIONARY: 'stationary',    // in stable orbit near a body (semantic — physics is same as drifting)
  TRANSFERRING: 'transferring', // under thrust, own velocity vector
  DRIFTING: 'drifting',         // no thrust, residual velocity
};

// ---- ORBITAL MATH ----

// Compute orbital position of a body at a given time
function orbitalPos(body, days) {
  const angle = body.initAngle + (TWO_PI * days / body.period);
  return { x: body.a * Math.cos(angle), y: body.a * Math.sin(angle), angle };
}

// Find a body by name in PLANETS/ASTEROIDS
function findBodyData(name) {
  for (const p of PLANETS) {
    if (p.name === name) return p;
    for (const m of p.moons || []) {
      if (m.name === name) return { ...m, parent: p, type: 'moon' };
    }
  }
  for (const a of ASTEROIDS) {
    if (a.name === name) return a;
  }
  return null;
}

// Compute orbital velocity vector of a body at a given time (m/s)
// For circular orbits: v = 2π·a·AU_M / (T·86400), direction tangent to orbit
export function computeOrbitalVelocity(bodyName, days) {
  const body = findBodyData(bodyName);
  if (!body) return { vx: 0, vy: 0 };

  // Get orbital speed: v = 2π·a / T
  const speedMs = (TWO_PI * body.a * AU_M) / (body.period * 86400);

  // Direction: tangent to orbit (perpendicular to radius, counter-clockwise)
  const angle = body.initAngle + (TWO_PI * days / body.period);
  // Tangent direction = angle + π/2
  const tangent = angle + Math.PI / 2;

  let vx = speedMs * Math.cos(tangent);
  let vy = speedMs * Math.sin(tangent);

  // If moon, add parent's orbital velocity
  if (body.parent) {
    const parentVel = computeOrbitalVelocity(body.parent.name, days);
    vx += parentVel.vx;
    vy += parentVel.vy;
  }

  return { vx, vy };
}

// Get position of a body in AU at given days
function getBodyPosition(bodyName, days) {
  const body = findBodyData(bodyName);
  if (!body) return { x: 0, y: 0 };

  const pos = orbitalPos(body, days);
  if (body.parent) {
    const pp = orbitalPos(body.parent, days);
    return { x: pp.x + pos.x, y: pp.y + pos.y };
  }
  return pos;
}

// ---- ENTITY FACTORY ----

let nextEntityId = 1;

export function createEntity(opts) {
  return {
    id: opts.id || `entity-${nextEntityId++}`,
    name: opts.name,
    type: opts.type || EntityType.SHIP,
    state: opts.state || EntityState.STATIONARY,
    // Position in AU (absolute solar frame)
    position: opts.position || { x: 0, y: 0 },
    // Velocity in m/s (2D vector)
    velocity: opts.velocity || { vx: 0, vy: 0 },
    // For stationary entities
    orbitBody: opts.orbitBody || null,
    orbitOffset: opts.orbitOffset || { x: 0, y: 0 }, // small AU offset from body
    // Transponder
    transponderActive: opts.transponderActive !== false,
    // Drive state
    thrustActive: opts.thrustActive || false,
    thrustG: opts.thrustG || 0,
    heading: opts.heading || 0,
    // Identity
    shipClass: opts.shipClass || null,
    driveSignature: opts.driveSignature || `SIG-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
    // SOS
    sosActive: opts.sosActive || false,
    // Faction
    faction: opts.faction || 'independent',
    // Tracking data (revealed over time by scanner)
    mass: opts.mass || 0, // metric tons
  };
}

// ---- DEFAULT ENTITIES ----

export function createDefaultEntities() {
  return [
    // Pallas Station — orbiting asteroid Pallas
    createEntity({
      id: 'pallas-station',
      name: 'Pallas Station',
      type: EntityType.STATION,
      state: EntityState.STATIONARY,
      orbitBody: 'Pallas',
      orbitOffset: { x: 0.0002, y: 0.0001 },
      faction: 'OPA',
      shipClass: 'Tycho-class station',
      mass: 850000,
    }),
    // MCRN Scirocco — patrol ship near Mars
    createEntity({
      id: 'mcrn-scirocco',
      name: 'MCRN Scirocco',
      type: EntityType.SHIP,
      state: EntityState.STATIONARY,
      orbitBody: 'Mars',
      orbitOffset: { x: 0.001, y: -0.0005 },
      faction: 'MCRN',
      shipClass: 'Donnager-class',
      mass: 250000,
    }),
    // Pur'n'Kleen Ice Hauler — drifting near Ceres
    createEntity({
      id: 'ice-hauler-pk',
      name: "Pur'n'Kleen Weeping Somnambulist",
      type: EntityType.SHIP,
      state: EntityState.STATIONARY,
      orbitBody: 'Ceres',
      orbitOffset: { x: -0.0003, y: 0.0002 },
      faction: 'Belter',
      shipClass: 'Canterbury-class',
      mass: 120000,
    }),
    // UNN Agatha King — near Earth
    createEntity({
      id: 'unn-agatha-king',
      name: 'UNN Agatha King',
      type: EntityType.SHIP,
      state: EntityState.STATIONARY,
      orbitBody: 'Earth',
      orbitOffset: { x: 0.0008, y: 0.0003 },
      faction: 'UNN',
      shipClass: 'Truman-class',
      mass: 300000,
    }),
    // Guy Molinari — OPA transport near Tycho/belt
    createEntity({
      id: 'opa-molinari',
      name: 'Guy Molinari',
      type: EntityType.SHIP,
      state: EntityState.STATIONARY,
      orbitBody: 'Vesta',
      orbitOffset: { x: 0.0004, y: -0.0002 },
      faction: 'OPA',
      shipClass: 'Converted freighter',
      mass: 90000,
    }),
  ];
}

// ---- ORBIT INITIALIZATION ----

/**
 * Initialize an entity's position and velocity from its orbitBody.
 * Call once at game start or entity creation. After this, gravity
 * integration maintains the orbit naturally.
 */
export function initializeEntityOrbit(entity, days) {
  if (!entity.orbitBody) return;
  const bodyPos = getBodyPosition(entity.orbitBody, days);
  entity.position.x = bodyPos.x + entity.orbitOffset.x;
  entity.position.y = bodyPos.y + entity.orbitOffset.y;
  const vel = computeOrbitalVelocity(entity.orbitBody, days);
  entity.velocity.vx = vel.vx;
  entity.velocity.vy = vel.vy;
}

// ---- PER-MINUTE TICK ----

/**
 * Apply solar gravity (symplectic Euler) to a position/velocity pair.
 * Velocity is updated first, then position — this conserves energy
 * far better than standard Euler for orbital dynamics.
 *
 * @param {object} pos - { x, y } in AU
 * @param {object} vel - { vx, vy } in m/s
 */
function applyGravity(pos, vel) {
  const rx = pos.x;
  const ry = pos.y;
  const r2_au = rx * rx + ry * ry;
  if (r2_au < 1e-10) return; // avoid singularity near Sun

  const r_au = Math.sqrt(r2_au);
  const r_m = r_au * AU_M;
  const a_mag = GM_SUN / (r_m * r_m); // m/s² toward Sun

  // Symplectic Euler: update velocity first
  const inv_r = 1 / r_au; // unit vector scale
  vel.vx -= a_mag * rx * inv_r * DT;
  vel.vy -= a_mag * ry * inv_r * DT;

  // Then update position with the new velocity
  pos.x += vel.vx * DT / AU_M;
  pos.y += vel.vy * DT / AU_M;
}

export function entityTick(gameState, days) {
  const entities = gameState.entities;
  if (!entities) return;

  for (let i = 0, len = entities.length; i < len; i++) {
    const entity = entities[i];

    // Apply thrust if transferring
    if (entity.state === EntityState.TRANSFERRING &&
        entity.thrustActive && entity.thrustG > 0) {
      const accel = entity.thrustG * 9.81;
      entity.velocity.vx += accel * Math.cos(entity.heading) * DT;
      entity.velocity.vy += accel * Math.sin(entity.heading) * DT;
    }

    // Solar gravity + position integration (all entities, all states)
    applyGravity(entity.position, entity.velocity);
  }
}

/**
 * Rebuild the spatial hash from current entity positions.
 * Call once per tick, after entityTick and physicsTick.
 */
export function rebuildSpatialHash(entities) {
  spatialGrid.clear();
  if (entities && entities.length > 0) {
    spatialGrid.insertAll(entities);
  }
}

// ---- QUERIES ----

export function getEntitiesInRange(entities, shipPos, rangeAU) {
  // Use spatial hash when available (rebuilt each tick)
  if (spatialGrid.count > 0) {
    return spatialGrid.query(shipPos.x, shipPos.y, rangeAU);
  }
  // Fallback: linear scan (first tick before hash is built)
  if (!entities) return [];
  const r2 = rangeAU * rangeAU;
  const result = [];
  for (let i = 0, len = entities.length; i < len; i++) {
    const e = entities[i];
    const dx = e.position.x - shipPos.x;
    const dy = e.position.y - shipPos.y;
    if (dx * dx + dy * dy <= r2) result.push(e);
  }
  return result;
}

/** Query entities in a viewport rectangle (for solar map culling). */
export function getEntitiesInRect(x1, y1, x2, y2) {
  return spatialGrid.queryRect(x1, y1, x2, y2);
}

export function getEntityById(entities, id) {
  if (!entities) return null;
  return entities.find(e => e.id === id) || null;
}

// Distance between two AU positions in AU
export function entityDistanceAU(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Distance in meters
export function entityDistanceM(pos1, pos2) {
  return entityDistanceAU(pos1, pos2) * AU_M;
}

// Bearing from ship to entity in radians
export function bearingTo(shipPos, targetPos) {
  return Math.atan2(targetPos.y - shipPos.y, targetPos.x - shipPos.x);
}

// Relative velocity scalar (positive = closing, negative = opening)
export function relativeSpeed(shipVel, targetVel) {
  const dvx = shipVel.vx - targetVel.vx;
  const dvy = shipVel.vy - targetVel.vy;
  return Math.sqrt(dvx * dvx + dvy * dvy);
}

// Relative velocity with sign (positive = closing, negative = receding)
export function relativeApproachSpeed(shipPos, shipVel, targetPos, targetVel) {
  // Unit vector from ship to target
  const dx = targetPos.x - shipPos.x;
  const dy = targetPos.y - shipPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-15) return 0;
  const ux = dx / dist;
  const uy = dy / dist;
  // Relative velocity
  const dvx = shipVel.vx - targetVel.vx;
  const dvy = shipVel.vy - targetVel.vy;
  // Dot product gives approach component (positive = closing)
  return -(dvx * ux + dvy * uy);
}

// ---- SERIALIZATION ----

export function serializeEntities(entities) {
  if (!entities) return null;
  return JSON.parse(JSON.stringify(entities));
}

export function deserializeEntities(data) {
  if (!data) return createDefaultEntities();
  return data;
}
