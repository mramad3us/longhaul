// ============================================================
// LONGHAUL — Fusion Reactor System
// Powers all ship systems. Containment failure = catastrophic.
// ============================================================

import { TileType } from './svg-icons.js';

// ---- REACTOR STATES ----
export const ReactorState = {
  ONLINE: 'online',                    // Running, generating power
  SHUTTING_DOWN: 'shutting-down',      // Engineer working (720 game-minutes = 12h)
  SHUTDOWN_COUNTDOWN: 'shutdown-countdown', // 1h countdown after engineer done, cancellable
  OFFLINE: 'offline',                  // Reactor off, emergency power draining
  STARTING_UP: 'starting-up',         // Engineer (eng>15) working (300 min = 5h), needs 2+ fuel
  CONTAINMENT_FAILURE: 'containment-failure', // Damage triggered, countdown to supercritical
  EMERGENCY_SHUTOFF: 'emergency-shutoff',     // 1h countdown before fuel dump
};

// ---- CONSTANTS ----
const SHUTDOWN_WORK_MINUTES = 720;     // 12 hours
const SHUTDOWN_COUNTDOWN_MINUTES = 60; // 1 hour
const STARTUP_WORK_MINUTES = 300;      // 5 hours
const STARTUP_MIN_FUEL = 2;            // Minimum fuel to restart
const STARTUP_MIN_ENGINEERING = 15;    // Minimum engineering skill
const EMERGENCY_SHUTOFF_MINUTES = 60;  // 1 hour countdown
const EMERGENCY_FUEL_RESERVE = 10;     // Fuel kept after emergency shutoff
const POWER_REGEN_PER_MINUTE = 10 / 60; // 10 units/hour when online
const POWER_DRAIN_PER_MINUTE = 1 / 60;  // 1 unit/hour when offline (emergency power)
const CONTAINMENT_FAILURE_MINUTES = 30;  // 30 minutes to supercritical

// ---- INITIALIZATION ----

function findReactorTiles(ship) {
  const result = [];
  ship.decks.forEach((deck, di) => {
    deck.tiles.forEach((row, ry) => {
      row.forEach((tile, rx) => {
        if (tile === TileType.REACTOR) {
          result.push({ deckIdx: di, x: rx, y: ry });
        }
      });
    });
  });
  return result;
}

export function initReactor(gameState) {
  const tiles = findReactorTiles(gameState.ship);
  if (tiles.length === 0) return;

  gameState.reactor = {
    status: ReactorState.ONLINE,
    tile: tiles[0],                 // Primary reactor location
    // Shutdown process
    shutdownProgress: 0,            // Minutes of engineer work done
    shutdownEngineerId: null,       // Crew member performing shutdown
    shutdownCountdown: 0,           // Minutes remaining in countdown
    // Startup process
    startupProgress: 0,
    startupEngineerId: null,
    // Emergency shutoff
    emergencyCountdown: 0,
    // Containment failure
    containmentTimer: 0,            // Minutes until supercritical
    containmentTriggered: false,
  };
}

// ---- PER-MINUTE TICK ----

export function reactorTick(gameState) {
  const r = gameState.reactor;
  if (!r) return null;

  const res = gameState.resources;
  const events = [];

  switch (r.status) {
    case ReactorState.ONLINE:
      // Generate power
      res.power.current = Math.min(res.power.max, res.power.current + POWER_REGEN_PER_MINUTE);
      break;

    case ReactorState.SHUTTING_DOWN: {
      // Check engineer is still alive and able
      const eng = r.shutdownEngineerId != null
        ? gameState.ship.crew.find(c => c.id === r.shutdownEngineerId)
        : null;
      if (!eng || eng.dead || eng.consciousness <= 10) {
        // Engineer incapacitated — abort shutdown
        r.status = ReactorState.ONLINE;
        r.shutdownProgress = 0;
        r.shutdownEngineerId = null;
        events.push({ type: 'shutdown-aborted', reason: 'engineer-incapacitated' });
        // Still generating power this tick
        res.power.current = Math.min(res.power.max, res.power.current + POWER_REGEN_PER_MINUTE);
        break;
      }
      // Engineer is working — still generating power during shutdown process
      res.power.current = Math.min(res.power.max, res.power.current + POWER_REGEN_PER_MINUTE);
      r.shutdownProgress++;
      if (r.shutdownProgress >= SHUTDOWN_WORK_MINUTES) {
        // Engineer done — begin 1h countdown
        r.status = ReactorState.SHUTDOWN_COUNTDOWN;
        r.shutdownCountdown = SHUTDOWN_COUNTDOWN_MINUTES;
        r.shutdownEngineerId = null;
        events.push({ type: 'shutdown-countdown-started' });
      }
      break;
    }

    case ReactorState.SHUTDOWN_COUNTDOWN:
      // Still running during countdown
      res.power.current = Math.min(res.power.max, res.power.current + POWER_REGEN_PER_MINUTE);
      r.shutdownCountdown--;
      if (r.shutdownCountdown <= 0) {
        // Reactor goes offline
        r.status = ReactorState.OFFLINE;
        // Kill thrust
        if (gameState.physics.thrustActive) {
          gameState.physics.thrustActive = false;
          gameState.physics.thrustLevel = 0;
        }
        events.push({ type: 'reactor-offline' });
      }
      break;

    case ReactorState.OFFLINE:
      // Emergency power drain
      res.power.current = Math.max(0, res.power.current - POWER_DRAIN_PER_MINUTE);
      // Block thrust while offline
      if (gameState.physics.thrustActive) {
        gameState.physics.thrustActive = false;
        gameState.physics.thrustLevel = 0;
      }
      break;

    case ReactorState.STARTING_UP: {
      // Drain emergency power during startup
      res.power.current = Math.max(0, res.power.current - POWER_DRAIN_PER_MINUTE);
      // Block thrust during startup
      if (gameState.physics.thrustActive) {
        gameState.physics.thrustActive = false;
        gameState.physics.thrustLevel = 0;
      }
      // Check engineer is still alive and able
      const startEng = r.startupEngineerId != null
        ? gameState.ship.crew.find(c => c.id === r.startupEngineerId)
        : null;
      if (!startEng || startEng.dead || startEng.consciousness <= 10) {
        r.status = ReactorState.OFFLINE;
        r.startupProgress = 0;
        r.startupEngineerId = null;
        events.push({ type: 'startup-aborted', reason: 'engineer-incapacitated' });
        break;
      }
      // Check fuel still available
      if (res.fuel.current < STARTUP_MIN_FUEL) {
        r.status = ReactorState.OFFLINE;
        r.startupProgress = 0;
        r.startupEngineerId = null;
        events.push({ type: 'startup-aborted', reason: 'insufficient-fuel' });
        break;
      }
      r.startupProgress++;
      if (r.startupProgress >= STARTUP_WORK_MINUTES) {
        r.status = ReactorState.ONLINE;
        r.startupProgress = 0;
        r.startupEngineerId = null;
        events.push({ type: 'reactor-online' });
      }
      break;
    }

    case ReactorState.EMERGENCY_SHUTOFF:
      // Still running during countdown
      res.power.current = Math.min(res.power.max, res.power.current + POWER_REGEN_PER_MINUTE);
      r.emergencyCountdown--;
      if (r.emergencyCountdown <= 0) {
        // Dump fuel, go offline
        res.fuel.current = Math.min(res.fuel.current, EMERGENCY_FUEL_RESERVE);
        r.status = ReactorState.OFFLINE;
        if (gameState.physics.thrustActive) {
          gameState.physics.thrustActive = false;
          gameState.physics.thrustLevel = 0;
        }
        events.push({ type: 'emergency-shutoff-complete', fuelRemaining: res.fuel.current });
      }
      break;

    case ReactorState.CONTAINMENT_FAILURE:
      // Reactor still running during containment failure!
      res.power.current = Math.min(res.power.max, res.power.current + POWER_REGEN_PER_MINUTE);
      r.containmentTimer--;
      if (r.containmentTimer <= 0) {
        // SUPERCRITICAL — game over
        events.push({ type: 'supercritical' });
      }
      break;
  }

  return events.length > 0 ? events : null;
}

// ---- ACTIONS ----

/**
 * Begin reactor shutdown. Requires an engineer crew member.
 * Returns { success, message }
 */
export function beginShutdown(gameState, crewId) {
  const r = gameState.reactor;
  if (!r) return { success: false, message: 'No reactor' };
  if (r.status !== ReactorState.ONLINE && r.status !== ReactorState.CONTAINMENT_FAILURE) {
    return { success: false, message: 'Reactor not running' };
  }

  const crew = gameState.ship.crew.find(c => c.id === crewId);
  if (!crew || crew.dead || crew.consciousness <= 10) {
    return { success: false, message: 'Crew member unavailable' };
  }
  if (crew.role !== 'Engineer') {
    return { success: false, message: 'Only engineers can shut down the reactor' };
  }

  // During containment failure, engineer performs emergency scram (instant shutdown)
  if (r.status === ReactorState.CONTAINMENT_FAILURE) {
    r.status = ReactorState.OFFLINE;
    r.containmentTimer = 0;
    // containmentTriggered stays true — needs patching
    r.shutdownProgress = 0;
    r.shutdownEngineerId = null;
    // Kill thrust
    if (gameState.physics.thrustActive) {
      gameState.physics.thrustActive = false;
      gameState.physics.thrustLevel = 0;
    }
    return { success: true, message: `${crew.name} emergency scram — reactor offline, containment breach needs patching` };
  }

  r.status = ReactorState.SHUTTING_DOWN;
  r.shutdownProgress = 0;
  r.shutdownEngineerId = crewId;
  r.containmentTriggered = false;
  r.containmentTimer = 0;
  return { success: true, message: `${crew.name} beginning reactor shutdown` };
}

/**
 * Cancel shutdown during the 1-hour countdown phase.
 */
export function cancelShutdown(gameState) {
  const r = gameState.reactor;
  if (!r) return { success: false, message: 'No reactor' };
  if (r.status !== ReactorState.SHUTDOWN_COUNTDOWN) {
    return { success: false, message: 'Not in countdown phase' };
  }

  r.status = ReactorState.ONLINE;
  r.shutdownCountdown = 0;
  return { success: true, message: 'Shutdown cancelled — reactor remains online' };
}

/**
 * Begin emergency shutoff. Anyone can trigger this.
 * 1-hour countdown, then dumps all fuel except reserve.
 */
export function beginEmergencyShutoff(gameState) {
  const r = gameState.reactor;
  if (!r) return { success: false, message: 'No reactor' };
  if (r.status === ReactorState.OFFLINE || r.status === ReactorState.STARTING_UP) {
    return { success: false, message: 'Reactor already offline' };
  }
  if (r.status === ReactorState.EMERGENCY_SHUTOFF) {
    return { success: false, message: 'Emergency shutoff already in progress' };
  }

  r.status = ReactorState.EMERGENCY_SHUTOFF;
  r.emergencyCountdown = EMERGENCY_SHUTOFF_MINUTES;
  r.shutdownProgress = 0;
  r.shutdownEngineerId = null;
  r.containmentTriggered = false;
  r.containmentTimer = 0;
  return { success: true, message: `EMERGENCY SHUTOFF — fuel dump in ${EMERGENCY_SHUTOFF_MINUTES} min` };
}

/**
 * Cancel emergency shutoff during countdown.
 */
export function cancelEmergencyShutoff(gameState) {
  const r = gameState.reactor;
  if (!r) return { success: false, message: 'No reactor' };
  if (r.status !== ReactorState.EMERGENCY_SHUTOFF) {
    return { success: false, message: 'No emergency shutoff in progress' };
  }

  r.status = ReactorState.ONLINE;
  r.emergencyCountdown = 0;
  return { success: true, message: 'Emergency shutoff cancelled' };
}

/**
 * Begin reactor startup. Requires engineer with engineering > 15 and 2+ fuel.
 */
export function beginStartup(gameState, crewId) {
  const r = gameState.reactor;
  if (!r) return { success: false, message: 'No reactor' };
  if (r.status !== ReactorState.OFFLINE) {
    return { success: false, message: 'Reactor must be offline to start up' };
  }

  const crew = gameState.ship.crew.find(c => c.id === crewId);
  if (!crew || crew.dead || crew.consciousness <= 10) {
    return { success: false, message: 'Crew member unavailable' };
  }
  if ((crew.skills?.engineering || 0) < STARTUP_MIN_ENGINEERING) {
    return { success: false, message: `Requires engineering skill ≥ ${STARTUP_MIN_ENGINEERING}` };
  }

  const res = gameState.resources;
  if (res.fuel.current < STARTUP_MIN_FUEL) {
    return { success: false, message: `Requires at least ${STARTUP_MIN_FUEL} fuel units` };
  }

  r.status = ReactorState.STARTING_UP;
  r.startupProgress = 0;
  r.startupEngineerId = crewId;
  return { success: true, message: `${crew.name} beginning reactor startup sequence` };
}

/**
 * Trigger containment failure (called from damage/combat system).
 * Can only happen while reactor is running.
 */
export function triggerContainmentFailure(gameState) {
  const r = gameState.reactor;
  if (!r) return false;
  // Only online or shutdown-in-progress reactors can have containment failure
  if (r.status !== ReactorState.ONLINE && r.status !== ReactorState.SHUTTING_DOWN &&
      r.status !== ReactorState.SHUTDOWN_COUNTDOWN && r.status !== ReactorState.EMERGENCY_SHUTOFF) {
    return false;
  }

  r.status = ReactorState.CONTAINMENT_FAILURE;
  r.containmentTimer = CONTAINMENT_FAILURE_MINUTES;
  r.containmentTriggered = true;
  r.shutdownProgress = 0;
  r.shutdownEngineerId = null;
  r.emergencyCountdown = 0;
  return true;
}

/**
 * Patch the reactor to stop containment failure.
 * Reactor must be OFFLINE first (engineer must shut it down during containment failure).
 * Actually — the user spec says patching can only be done if reactor is off.
 * But containment failure means it's running. So the sequence is:
 * 1. Engineer begins shutdown (during containment failure)
 * 2. Once offline, engineer patches
 *
 * However, 12h shutdown is too long for a 30min containment failure.
 * So during containment failure, shutdown is instant once engineer reaches it.
 * We handle this in beginShutdown — if status is CONTAINMENT_FAILURE,
 * the shutdown skips the 12h process and goes straight to offline.
 */
export function patchReactor(gameState, crewId) {
  const r = gameState.reactor;
  if (!r) return { success: false, message: 'No reactor' };
  if (r.status !== ReactorState.OFFLINE || !r.containmentTriggered) {
    return { success: false, message: 'Reactor must be offline with containment breach to patch' };
  }

  const crew = gameState.ship.crew.find(c => c.id === crewId);
  if (!crew || crew.dead || crew.consciousness <= 10) {
    return { success: false, message: 'Crew member unavailable' };
  }
  if ((crew.skills?.engineering || 0) < 10) {
    return { success: false, message: 'Requires engineering skill ≥ 10' };
  }

  r.containmentTriggered = false;
  return { success: true, message: `${crew.name} patched reactor containment` };
}

/**
 * Check if reactor is running (for thrust gating etc.)
 */
export function isReactorOnline(gameState) {
  const r = gameState.reactor;
  if (!r) return true; // No reactor system = assume power available
  return r.status === ReactorState.ONLINE ||
         r.status === ReactorState.SHUTTING_DOWN ||
         r.status === ReactorState.SHUTDOWN_COUNTDOWN ||
         r.status === ReactorState.EMERGENCY_SHUTOFF ||
         r.status === ReactorState.CONTAINMENT_FAILURE;
}

/**
 * Get human-readable status for UI.
 */
export function getReactorStatusText(gameState) {
  const r = gameState.reactor;
  if (!r) return 'No Reactor';

  switch (r.status) {
    case ReactorState.ONLINE:
      return 'ONLINE — Nominal';
    case ReactorState.SHUTTING_DOWN: {
      const remaining = SHUTDOWN_WORK_MINUTES - r.shutdownProgress;
      const hrs = Math.floor(remaining / 60);
      const mins = remaining % 60;
      return `SHUTTING DOWN — ${hrs}h ${mins}m remaining`;
    }
    case ReactorState.SHUTDOWN_COUNTDOWN:
      return `SHUTDOWN IN ${r.shutdownCountdown}m — Cancel available`;
    case ReactorState.OFFLINE:
      if (r.containmentTriggered) return 'OFFLINE — CONTAINMENT BREACH — Patch required';
      return 'OFFLINE — Emergency power';
    case ReactorState.STARTING_UP: {
      const rem = STARTUP_WORK_MINUTES - r.startupProgress;
      const h = Math.floor(rem / 60);
      const m = rem % 60;
      return `STARTING UP — ${h}h ${m}m remaining`;
    }
    case ReactorState.CONTAINMENT_FAILURE:
      return `⚠ CONTAINMENT FAILURE — ${r.containmentTimer}m to supercritical`;
    case ReactorState.EMERGENCY_SHUTOFF:
      return `EMERGENCY SHUTOFF — Fuel dump in ${r.emergencyCountdown}m`;
    default:
      return 'Unknown';
  }
}

// Re-export constants for UI
export { STARTUP_MIN_ENGINEERING, STARTUP_MIN_FUEL };
