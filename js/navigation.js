// ============================================================
// LONGHAUL — Navigation & Route Planning
// Epstein drive transfers: brachistochrone, economy, Hohmann.
// Route execution with phased burn sequences.
// ============================================================

import { PLANETS, ASTEROIDS } from './solar-system.js';
import { computeOrbitalVelocity } from './entities.js';

// ---- CONSTANTS ----

const AU_M = 149_597_870_700;        // meters per AU
const G_ACCEL = 9.81;                // m/s²
const MU_SUN = 1.327124e20;          // Sun gravitational parameter (m³/s²)
const TWO_PI = Math.PI * 2;
const FUEL_RATE = 0.05;              // kg per G per game-minute (from game.js)
const ORIENT_MIN = 6;                // minutes to orient ship
const SECURE_MIN = 10;               // minutes for crew to reach crash couches

// ---- BODY LOOKUP ----

export function findBody(name, gameState) {
  for (const p of PLANETS) {
    if (p.name === name) return { ...p, type: 'planet' };
    for (const m of (p.moons || [])) {
      if (m.name === name) return { ...m, type: 'moon', parent: p };
    }
  }
  for (const a of ASTEROIDS) {
    if (a.name === name) return { ...a, type: 'asteroid' };
  }
  if (name === 'Sol') return { name: 'Sol', a: 0, period: 1, initAngle: 0, type: 'star' };
  // Search entities (stations, ships)
  if (gameState && gameState.entities) {
    const entity = gameState.entities.find(e => e.name === name);
    if (entity) {
      return { name: entity.name, type: 'entity', entity };
    }
  }
  return null;
}

function orbitalPos(body, days) {
  if (body.type === 'star') return { x: 0, y: 0 };
  const angle = body.initAngle + (TWO_PI * days / body.period);
  return { x: body.a * Math.cos(angle), y: body.a * Math.sin(angle) };
}

export function getBodyWorldPos(body, days) {
  if (body.type === 'entity' && body.entity) {
    return { x: body.entity.position.x, y: body.entity.position.y };
  }
  if (body.type === 'moon' && body.parent) {
    const pp = orbitalPos(body.parent, days);
    const mp = orbitalPos(body, days);
    return { x: pp.x + mp.x, y: pp.y + mp.y };
  }
  return orbitalPos(body, days);
}

function gameTimeToDays(time, stats) {
  return (stats?.daysElapsed || 0) + (time?.hour || 0) / 24 + (time?.minute || 0) / 1440;
}

function distAU(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function headingAngle(from, to) {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

// ---- FUEL ----

function fuelForBurn(thrustG, minutes) {
  return thrustG * FUEL_RATE * minutes;
}

// ---- ROUTE CALCULATORS ----

// Brachistochrone: constant-thrust burn → flip → constant-thrust brake
function calcBrachistochrone(distAU_, accelG, shipPos, destPos) {
  const d = distAU_ * AU_M;
  const a = accelG * G_ACCEL;

  const tTotal = 2 * Math.sqrt(d / a);          // seconds
  const tBurn = tTotal / 2;
  const tBurnMin = tBurn / 60;
  const tTotalMin = tTotal / 60;
  const peakV = a * tBurn;
  const deltaV = a * tTotal;
  const fuel = fuelForBurn(accelG, tTotalMin);   // both burns combined

  return {
    type: 'brachistochrone',
    accelG,
    totalTimeMin: tTotalMin + ORIENT_MIN + SECURE_MIN,
    deltaV,
    peakVelocity: peakV,
    fuelRequired: fuel,
    headingAngle: headingAngle(shipPos, destPos),
    phases: [
      { type: 'orient', durationMin: ORIENT_MIN, description: 'Orient ship for burn' },
      { type: 'secure', durationMin: SECURE_MIN, description: 'All hands to crash couches' },
      { type: 'burn', durationMin: tBurnMin, thrustG: accelG, deltaV: deltaV / 2, description: `Acceleration burn at ${accelG.toFixed(1)}G` },
      { type: 'flip', durationMin: 6, description: 'Flip maneuver' },
      { type: 'burn', durationMin: tBurnMin, thrustG: accelG, deltaV: deltaV / 2, description: `Deceleration burn at ${accelG.toFixed(1)}G` },
      { type: 'match', durationMin: 3, description: 'Matching target orbit' },
      { type: 'arrive', durationMin: 0, description: 'Arrival' },
    ],
  };
}

// Economy: short burn → long coast → secure → flip → short brake
function calcEconomy(distAU_, accelG, coastFraction, shipPos, destPos) {
  const d = distAU_ * AU_M;
  const a = accelG * G_ACCEL;

  const tFullBrach = 2 * Math.sqrt(d / a);
  const burnFraction = 1 - coastFraction;
  const tBurn = (tFullBrach / 2) * burnFraction;

  const burnDist = a * tBurn * tBurn; // distance covered by both burns combined
  const coastV = a * tBurn;
  const coastDist = d - burnDist;

  if (coastDist <= 0) return calcBrachistochrone(distAU_, accelG, shipPos, destPos);

  const tCoast = coastDist / coastV;
  const tBurnMin = tBurn / 60;
  const tCoastMin = tCoast / 60;
  const deltaV = 2 * a * tBurn;
  const fuel = fuelForBurn(accelG, 2 * tBurnMin);

  return {
    type: 'economy',
    accelG,
    totalTimeMin: (2 * tBurn + tCoast) / 60 + ORIENT_MIN + 2 * SECURE_MIN,
    deltaV,
    peakVelocity: coastV,
    fuelRequired: fuel,
    headingAngle: headingAngle(shipPos, destPos),
    phases: [
      { type: 'orient', durationMin: ORIENT_MIN, description: 'Orient ship for burn' },
      { type: 'secure', durationMin: SECURE_MIN, description: 'All hands to crash couches' },
      { type: 'burn', durationMin: tBurnMin, thrustG: accelG, deltaV: deltaV / 2, description: `Acceleration burn at ${accelG.toFixed(1)}G` },
      { type: 'coast', durationMin: tCoastMin, description: 'Coast phase — crew free to move' },
      { type: 'secure', durationMin: SECURE_MIN, description: 'All hands to crash couches' },
      { type: 'flip', durationMin: 6, description: 'Flip maneuver' },
      { type: 'burn', durationMin: tBurnMin, thrustG: accelG, deltaV: deltaV / 2, description: `Deceleration burn at ${accelG.toFixed(1)}G` },
      { type: 'match', durationMin: 3, description: 'Matching target orbit' },
      { type: 'arrive', durationMin: 0, description: 'Arrival' },
    ],
  };
}

// Hohmann: minimum-energy transfer between circular orbits
function calcHohmann(r1AU, r2AU, shipPos, destPos) {
  const r1 = r1AU * AU_M;
  const r2 = r2AU * AU_M;
  const aT = (r1 + r2) / 2;

  const tTransfer = Math.PI * Math.sqrt(aT * aT * aT / MU_SUN); // seconds

  const v1 = Math.sqrt(MU_SUN / r1);
  const v2 = Math.sqrt(MU_SUN / r2);
  const vPeri = Math.sqrt(MU_SUN * (2 / r1 - 1 / aT));
  const vApo = Math.sqrt(MU_SUN * (2 / r2 - 1 / aT));

  const dv1 = Math.abs(vPeri - v1);
  const dv2 = Math.abs(v2 - vApo);
  const deltaV = dv1 + dv2;

  const burnG = 0.3;
  const burnA = burnG * G_ACCEL;
  const burn1Min = (dv1 / burnA) / 60;
  const burn2Min = (dv2 / burnA) / 60;
  const coastMin = tTransfer / 60 - burn1Min - burn2Min;
  const fuel = fuelForBurn(burnG, burn1Min + burn2Min);

  return {
    type: 'hohmann',
    accelG: burnG,
    totalTimeMin: tTransfer / 60 + ORIENT_MIN + 2 * SECURE_MIN,
    deltaV,
    peakVelocity: vPeri,
    fuelRequired: fuel,
    headingAngle: headingAngle(shipPos, destPos),
    phases: [
      { type: 'orient', durationMin: ORIENT_MIN, description: 'Orient for departure burn' },
      { type: 'secure', durationMin: SECURE_MIN, description: 'All hands to crash couches' },
      { type: 'burn', durationMin: burn1Min, thrustG: burnG, deltaV: dv1, description: `Departure burn at ${burnG}G` },
      { type: 'coast', durationMin: Math.max(0, coastMin), description: 'Transfer orbit coast' },
      { type: 'secure', durationMin: SECURE_MIN, description: 'All hands to crash couches' },
      { type: 'flip', durationMin: 6, description: 'Flip maneuver' },
      { type: 'burn', durationMin: burn2Min, thrustG: burnG, deltaV: dv2, description: `Arrival burn at ${burnG}G` },
      { type: 'match', durationMin: 3, description: 'Matching target orbit' },
      { type: 'arrive', durationMin: 0, description: 'Arrival' },
    ],
  };
}

// ---- MAIN CALCULATOR ----

export function calculateRoutes(gameState, destBody) {
  const shipPos = gameState.shipPosition;
  const days = gameTimeToDays(gameState.time, gameState.stats);
  const maxThrust = gameState.physics.maxThrust;

  // Iterative intercept: estimate travel time → predict dest position → refine
  function destPosAt(travelMin) {
    if (destBody.type === 'entity' && destBody.entity) {
      // Project entity position forward using its velocity vector
      const e = destBody.entity;
      const dtSec = travelMin * 60;
      return {
        x: e.position.x + (e.velocity.vx * dtSec) / AU_M,
        y: e.position.y + (e.velocity.vy * dtSec) / AU_M,
      };
    }
    return getBodyWorldPos(destBody, days + travelMin / 1440);
  }

  let destPos = getBodyWorldPos(destBody, days);
  let dist = distAU(shipPos, destPos);

  // Two iterations with 1G brachistochrone estimate
  for (let i = 0; i < 2; i++) {
    const estMin = 2 * Math.sqrt(dist * AU_M / G_ACCEL) / 60;
    destPos = destPosAt(estMin);
    dist = distAU(shipPos, destPos);
  }

  if (dist < 0.001) return []; // already there

  const routes = [];
  const currentFuel = gameState.resources.fuel.current;

  // 1. Express — high-G brachistochrone (capped at 5G for crew safety)
  if (maxThrust > 1) {
    const expressG = Math.min(maxThrust, 5);
    // Refine intercept for this specific profile
    const eDest = destPosAt(2 * Math.sqrt(dist * AU_M / (expressG * G_ACCEL)) / 60);
    const eDist = distAU(shipPos, eDest);
    const r = calcBrachistochrone(eDist, expressG, shipPos, eDest);
    r.name = 'EXPRESS';
    r.label = `${expressG.toFixed(1)}G Brachistochrone`;
    r.description = 'Maximum thrust burn-flip-brake. Fastest but highest G-force.';
    routes.push(r);
  }

  // 2. Standard — 1G brachistochrone
  {
    const sDest = destPosAt(2 * Math.sqrt(dist * AU_M / G_ACCEL) / 60);
    const sDist = distAU(shipPos, sDest);
    const r = calcBrachistochrone(sDist, 1.0, shipPos, sDest);
    r.name = 'STANDARD';
    r.label = '1G Brachistochrone';
    r.description = 'Earth-normal gravity throughout. Comfortable and efficient.';
    routes.push(r);
  }

  // 3. Economy — 0.3G burns, 70% coast
  {
    const econ = calcEconomy(dist, 0.3, 0.7, shipPos, destPos);
    // Refine intercept
    const ecDest = destPosAt(econ.totalTimeMin);
    const ecDist = distAU(shipPos, ecDest);
    const r = calcEconomy(ecDist, 0.3, 0.7, shipPos, ecDest);
    r.name = 'ECONOMY';
    r.label = '0.3G Economy';
    r.description = 'Short burns, long coast. Saves fuel but extended micro-G.';
    routes.push(r);
  }

  // 4. Hohmann — minimum energy transfer (only for celestial bodies with known orbits)
  if (destBody.type !== 'entity') {
    const shipR = Math.sqrt(shipPos.x * shipPos.x + shipPos.y * shipPos.y);
    const destR = (destBody.type === 'moon' && destBody.parent) ? destBody.parent.a : destBody.a;
    if (shipR > 0.1 && destR > 0.1 && Math.abs(shipR - destR) > 0.05) {
      const r = calcHohmann(shipR, destR, shipPos, destPos);
      r.name = 'HOHMANN';
      r.label = 'Hohmann Transfer';
      r.description = 'Minimum-fuel orbital transfer. Very long travel time.';
      routes.push(r);
    }
  }

  // Annotate feasibility
  routes.forEach(r => {
    r.feasible = r.fuelRequired <= currentFuel * 0.95;
    r.fuelPercent = (r.fuelRequired / currentFuel) * 100;
    r.destinationName = destBody.name;
    r.destinationType = destBody.type;
    r.distanceAU = dist;
  });

  return routes;
}

// ---- ACTIVE ROUTE STATE ----

let activeRoute = null;

export function getActiveRoute() {
  return activeRoute;
}

// Reset route state without touching gameState (for new game)
export function resetRoute() {
  activeRoute = null;
}

// Override secure phase blocking (player chose to proceed with unsecured crew)
export function overrideSecure() {
  if (!activeRoute) return false;
  activeRoute._secureComplete = true;
  activeRoute._secureBlocking = false;
  return true;
}

// Mark secure phase as complete (all crew are in crash couches)
export function markSecureComplete() {
  if (!activeRoute) return false;
  activeRoute._secureComplete = true;
  activeRoute._secureBlocking = false;
  return true;
}

// Check if currently blocking on secure phase
export function isSecureBlocking() {
  return activeRoute && activeRoute._secureBlocking === true;
}

export function activateRoute(gameState, route) {
  // Cancel any existing route cleanly before activating the new one
  if (activeRoute) {
    gameState.physics.thrustActive = false;
    gameState.physics.thrustLevel = 0;
  }

  activeRoute = {
    ...route,
    active: true,
    currentPhase: 0,
    phaseElapsed: 0,
    _secureComplete: false,
    _secureBlocking: false,
    startPosition: { ...gameState.shipPosition },
  };

  gameState.navigation.routeHeading = route.headingAngle;
  gameState.navigation.routeActive = true;
  gameState.navigation.routeDestination = route.destinationName;

  // Reset heading to prograde for the new route — ship will orient toward
  // the new heading during orient phase, then burn prograde
  gameState.physics.heading = 0;

  return activeRoute;
}

export function cancelRoute(gameState) {
  if (!activeRoute) return;
  activeRoute = null;
  gameState.navigation.routeActive = false;
  gameState.navigation.routeHeading = null;
  gameState.navigation.routeDestination = null;

  // Kill thrust
  gameState.physics.thrustActive = false;
  gameState.physics.thrustLevel = 0;
}

// ---- ROUTE TICK (called once per game-minute) ----

export function routeTick(gameState) {
  if (!activeRoute || !activeRoute.active) return null;

  const phase = activeRoute.phases[activeRoute.currentPhase];
  if (!phase) {
    // Route complete
    const result = [{ event: 'complete', route: activeRoute }];
    finishRoute(gameState);
    return result;
  }

  activeRoute.phaseElapsed += 1;
  const events = [];

  // Phase just started
  if (activeRoute.phaseElapsed === 1) {
    events.push({ event: 'phase-start', phase, phaseIndex: activeRoute.currentPhase });
    applyPhaseStart(gameState, phase);
  }

  // ---- VELOCITY KILL BURN: condition-based ----
  // These burns (marked with velocityKill: true) run until relative velocity
  // to the target drops below 50 m/s, then end early. The thrust direction
  // updates each tick to track the CURRENT relative velocity vector — no stale
  // direction from route creation time.
  if (phase.velocityKill && activeRoute.targetEntityId) {
    const target = (gameState.entities || []).find(e => e.id === activeRoute.targetEntityId);
    if (target) {
      const vel = gameState.physics.velocity;
      const relVx = vel.vx - target.velocity.vx;
      const relVy = vel.vy - target.velocity.vy;
      const relV = Math.sqrt(relVx * relVx + relVy * relVy);

      if (relV < 50) {
        // Velocity killed — snap and force phase to end immediately
        vel.vx = target.velocity.vx;
        vel.vy = target.velocity.vy;
        gameState.physics.speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
        activeRoute.phaseElapsed = phase.durationMin; // trigger phase end
      } else {
        // Update thrust direction to oppose CURRENT relative velocity
        const liveDir = Math.atan2(relVy, relVx) + Math.PI;
        phase.thrustDirection = liveDir;
        gameState.navigation.routeHeading = liveDir;
        gameState.physics.heading = 0; // prograde relative to brake direction
      }
    }
  }

  // ---- MATCH PHASE: velocity convergence ----
  // Handles residual velocity from minute-granularity rounding in the
  // brachistochrone burns. Exponential reduction → snap when close.
  if (phase.type === 'match' && activeRoute.targetEntityId) {
    const target = (gameState.entities || []).find(e => e.id === activeRoute.targetEntityId);
    if (target) {
      const vel = gameState.physics.velocity;
      const relVx = vel.vx - target.velocity.vx;
      const relVy = vel.vy - target.velocity.vy;
      const relV = Math.sqrt(relVx * relVx + relVy * relVy);
      if (relV > 20) {
        const keep = relV > 1000 ? 0.3 : relV > 100 ? 0.5 : 0.7;
        vel.vx = target.velocity.vx + relVx * keep;
        vel.vy = target.velocity.vy + relVy * keep;
      } else {
        vel.vx = target.velocity.vx;
        vel.vy = target.velocity.vy;
      }
      gameState.physics.speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
    }
  }

  // Phase complete?
  if (activeRoute.phaseElapsed >= phase.durationMin) {
    // Secure phase blocks until all crew are in crash couches (or overridden)
    if (phase.type === 'secure' && !activeRoute._secureComplete) {
      // Emit blocking event once per tick so the UI can show the prompt
      if (!activeRoute._secureBlocking) {
        activeRoute._secureBlocking = true;
        events.push({ event: 'secure-blocking', phase, phaseIndex: activeRoute.currentPhase });
      }
      return events.length > 0 ? events : null;
    }

    events.push({ event: 'phase-end', phase, phaseIndex: activeRoute.currentPhase });
    applyPhaseEnd(gameState, phase);

    activeRoute.currentPhase++;
    activeRoute.phaseElapsed = 0;

    // Reset secure flags for next secure phase
    activeRoute._secureComplete = false;
    activeRoute._secureBlocking = false;

    // Check if all phases done
    if (activeRoute.currentPhase >= activeRoute.phases.length) {
      events.push({ event: 'complete', route: activeRoute });
      finishRoute(gameState);
    }
  }

  return events.length > 0 ? events : null;
}

function applyPhaseStart(gameState, phase) {
  const phys = gameState.physics;

  switch (phase.type) {
    case 'burn': {
      phys.thrustActive = true;
      phys.thrustLevel = Math.min(1, phase.thrustG / phys.maxThrust);

      if (phase.thrustDirection != null) {
        // Phase-specific thrust direction (e.g. velocity kill burns that point
        // opposite to current velocity, not toward the route destination)
        gameState.navigation.routeHeading = phase.thrustDirection;
        phys.heading = 0; // prograde relative to this phase's direction
      } else {
        // Standard: burns before flip = prograde (0), after flip = retrograde (180)
        const flipIdx = activeRoute.phases.findIndex(p => p.type === 'flip');
        phys.heading = activeRoute.currentPhase > flipIdx ? 180 : 0;
      }
      break;
    }
    case 'coast':
      phys.thrustActive = false;
      phys.thrustLevel = 0;
      break;
    case 'flip':
      phys.thrustActive = false;
      phys.thrustLevel = 0;
      break;
    case 'orient':
      phys.orienting = true;
      // Restore route heading to the route's target heading — clears any
      // override from a prior velocity-kill burn phase
      if (activeRoute?.headingAngle != null) {
        gameState.navigation.routeHeading = activeRoute.headingAngle;
      }
      break;
    case 'match':
      phys.thrustActive = false;
      phys.thrustLevel = 0;
      break;
    case 'secure':
    case 'arrive':
      break;
  }
}

function applyPhaseEnd(gameState, phase) {
  if (phase.type === 'orient') {
    gameState.physics.orienting = false;
  }
  if (phase.type === 'flip') {
    gameState.physics.heading = gameState.physics.heading === 0 ? 180 : 0;
  }
}

function finishRoute(gameState) {
  const destName = activeRoute?.destinationName;
  const destType = activeRoute?.destinationType;

  // Match target velocity instead of zeroing — orbit matching
  let targetVel = { vx: 0, vy: 0 };

  if (destType === 'entity') {
    const entity = (gameState.entities || []).find(e => e.name === destName);
    if (entity) {
      targetVel = { vx: entity.velocity.vx, vy: entity.velocity.vy };
    }
  } else if (destName) {
    const days = (gameState.stats?.daysElapsed || 0) +
                 (gameState.time?.hour || 0) / 24 +
                 (gameState.time?.minute || 0) / 1440;
    const vel = computeOrbitalVelocity(destName, days);
    targetVel = { vx: vel.vx, vy: vel.vy };
  }

  gameState.physics.velocity = targetVel;
  gameState.physics.speed = Math.sqrt(targetVel.vx * targetVel.vx + targetVel.vy * targetVel.vy);

  activeRoute = null;
  gameState.physics.thrustActive = false;
  gameState.physics.thrustLevel = 0;
  gameState.navigation.routeActive = false;
  gameState.navigation.routeHeading = null;
  gameState.navigation.routeDestination = null;
}

// ---- ROUTE PROGRESS ----

export function getRouteProgress() {
  if (!activeRoute || !activeRoute.active) return null;

  let elapsed = 0;
  for (let i = 0; i < activeRoute.currentPhase; i++) {
    elapsed += activeRoute.phases[i].durationMin;
  }
  elapsed += activeRoute.phaseElapsed;

  const total = activeRoute.phases.reduce((s, p) => s + p.durationMin, 0);
  const phase = activeRoute.phases[activeRoute.currentPhase];

  // Compute flip fraction (fraction of total time at which flip occurs)
  const flipIdx = activeRoute.phases.findIndex(p => p.type === 'flip');
  let flipTimeFraction = 0.5; // fallback
  let flipDone = false;
  if (flipIdx >= 0) {
    let timeAtFlip = 0;
    for (let i = 0; i <= flipIdx; i++) timeAtFlip += activeRoute.phases[i].durationMin;
    flipTimeFraction = total > 0 ? timeAtFlip / total : 0.5;
    flipDone = activeRoute.currentPhase > flipIdx;
  }

  return {
    elapsed,
    total,
    fraction: total > 0 ? elapsed / total : 1,
    currentPhase: phase,
    phaseIndex: activeRoute.currentPhase,
    phaseElapsed: activeRoute.phaseElapsed,
    phaseDuration: phase?.durationMin || 0,
    etaMin: total - elapsed,
    destinationName: activeRoute.destinationName,
    flipFraction: flipTimeFraction,
    flipDone,
    startPosition: activeRoute.startPosition,
  };
}

// ---- FORMATTING ----

export function formatDuration(minutes) {
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function formatDeltaV(ms) {
  if (ms < 1000) return `${Math.round(ms)} m/s`;
  return `${(ms / 1000).toFixed(1)} km/s`;
}

// ---- SERIALIZE / DESERIALIZE (for save/load) ----

export function serializeRoute() {
  return activeRoute ? JSON.parse(JSON.stringify(activeRoute)) : null;
}

export function deserializeRoute(data, gameState) {
  if (!data) return;
  activeRoute = data;
  if (activeRoute.active) {
    gameState.navigation.routeActive = true;
    gameState.navigation.routeHeading = activeRoute.headingAngle;
    gameState.navigation.routeDestination = activeRoute.destinationName;
  }
}
