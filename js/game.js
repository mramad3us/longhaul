// ============================================================
// LONGHAUL — Game State & Time System
// Real-time simulation with 3 speed settings
// ============================================================

import { createDefaultShip } from './ship.js';
import { VERSION } from './version.js';
import { createPhysicsState, computeShipMass, physicsTick } from './physics.js';
import { initLifeSupport, lifeSupportTick } from './life-support.js';
import { createDefaultEntities, initializeEntityOrbit, rebuildSpatialHash, entityTick } from './entities.js';
import { initComms } from './comms.js';
import { initScanner } from './scanner.js';
import { routeTick } from './navigation.js';
import { reactorTick } from './reactor.js';
import { commsTick } from './comms.js';
import { scannerTick } from './scanner.js';
import { initMissions, missionTick, interceptTick } from './missions.js';
import { initInertia, internalBleedingTick } from './inertia.js';

// Speed multipliers: game-minutes per real-second
const SPEED_MULTIPLIERS = {
  0: 0,     // Paused
  1: 1,     // 1 min per second
  2: 60,    // 1 hour per second
  3: 1440,  // 1 day per second
};

export function createGameState(shipName, captainName, crewCount) {
  const ship = createDefaultShip(crewCount);
  ship.name = shipName;
  ship.crew[0].name = captainName;
  ship.crew[0].role = 'Captain';

  const physics = createPhysicsState();
  physics.shipMass = computeShipMass(ship);

  // Initialize crew physics states
  ship.crew.forEach(member => {
    physics.crewStates[member.id] = 'floating'; // start in micro-G
  });

  const state = {
    version: VERSION,
    ship,
    physics,
    // Game time: start date far future
    time: {
      year: 2351,
      month: 3,
      day: 22,
      hour: 8,
      minute: 0,
    },
    speed: 1,
    paused: false,
    resources: {
      credits: { current: 5000, max: Infinity, unit: 'MCR' },
      fuel: { current: 8500, max: 10000, unit: 'kg' },
      oxygen: { current: 950, max: 1000, unit: 'hr' },
      water: { current: 4200, max: 5000, unit: 'L' },
      food: { current: 1800, max: 2000, unit: 'rations' },
      power: { current: 88, max: 100, unit: '%' },
      medSupplies: { current: 50, max: 50, unit: 'units' },
    },
    navigation: {
      thrust: 0,
      heading: null,
      velocity: 0,
      routeActive: false,
      routeHeading: null,
      routeDestination: null,
    },
    stats: {
      distanceTraveled: 0,
      daysElapsed: 0,
    },
    // Ship position in AU (x, y) — start near Ceres in the asteroid belt
    shipPosition: {
      x: 2.77,
      y: 0.0,
    },
    // Combat stations: all crew to couches, high-G burns unlocked
    combatStations: false,
  };

  // Initialize ship orbital velocity at starting position
  // v = sqrt(GM/r) for circular orbit, tangent direction at (x,0) = (0, v)
  const AU_M = 149_597_870_700;
  const GM_SUN = 1.327124e20;
  const r_m = state.shipPosition.x * AU_M;
  const orbitalSpeed = Math.sqrt(GM_SUN / r_m);
  state.physics.velocity = { vx: 0, vy: orbitalSpeed };
  state.physics.speed = orbitalSpeed;

  // Initialize life support system (adds atmosphere to decks, tanks to resources)
  initLifeSupport(state);

  // Initialize entity system — compute orbital positions and velocities
  state.entities = createDefaultEntities();
  for (const entity of state.entities) {
    initializeEntityOrbit(entity, 0);
  }

  // Initialize comms, scanner, missions, and inertia
  initComms(state);
  initScanner(state);
  initMissions(state);
  initInertia();

  return state;
}

// ---- TIME SYSTEM ----

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function advanceTime(time, minutes) {
  time.minute += minutes;

  while (time.minute >= 60) {
    time.minute -= 60;
    time.hour++;
  }

  while (time.hour >= 24) {
    time.hour -= 24;
    time.day++;
  }

  while (time.day > DAYS_IN_MONTH[(time.month - 1) % 12]) {
    time.day -= DAYS_IN_MONTH[(time.month - 1) % 12];
    time.month++;
    if (time.month > 12) {
      time.month = 1;
      time.year++;
    }
  }
}

export function formatDate(time) {
  return `${time.year}.${String(time.month).padStart(2, '0')}.${String(time.day).padStart(2, '0')}`;
}

export function formatTime(time) {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

// ---- GAME LOOP ----

export class GameLoop {
  constructor(state, onTick, onPhysicsEvent) {
    this.state = state;
    this.onTick = onTick;
    this.onPhysicsEvent = onPhysicsEvent || (() => {});
    this.lastTime = null;
    this.accumulator = 0;
    this._autosaveCounter = 0;
    this.running = false;
    this._raf = null;
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this._tick();
  }

  stop() {
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  setSpeed(speed) {
    this.state.speed = speed;
    this.state.paused = speed === 0;
  }

  _tick() {
    if (!this.running) return;

    const now = performance.now();
    const delta = (now - this.lastTime) / 1000; // seconds
    this.lastTime = now;

    if (!this.state.paused && this.state.speed > 0) {
      const gameMinutes = delta * SPEED_MULTIPLIERS[this.state.speed];
      this.accumulator += gameMinutes;

      // Process in whole-minute increments
      while (this.accumulator >= 1) {
        this.accumulator -= 1;
        this._processMinute();
      }
    }

    this.onTick(this.state);
    this._raf = requestAnimationFrame(() => this._tick());
  }

  _processMinute() {
    advanceTime(this.state.time, 1);
    const days = this.state.stats.daysElapsed;

    // --- ENTITIES (gravity + position integration) ---
    entityTick(this.state, days);

    // --- PHYSICS (ship gravity + position integration) ---
    const stateChanges = physicsTick(this.state, this.state.physics);
    if (stateChanges.length > 0) {
      this.onPhysicsEvent('crewStateChange', stateChanges);
    }

    // --- SPATIAL INDEX (rebuild after all positions are updated) ---
    rebuildSpatialHash(this.state.entities);

    // --- ROUTE EXECUTION (must run per game-minute, before resource consumption) ---
    const routeEvents = routeTick(this.state);
    if (routeEvents && routeEvents.length > 0) {
      this.onPhysicsEvent('routeEvents', routeEvents);
    }

    // --- LIFE SUPPORT ---
    lifeSupportTick(this.state);

    // --- REACTOR ---
    const reactorEvents = reactorTick(this.state);
    if (reactorEvents && reactorEvents.length > 0) {
      this.onPhysicsEvent('reactorEvents', reactorEvents);
    }

    // Resource consumption per game-minute
    const crewCount = this.state.ship.crew.length;
    const res = this.state.resources;

    // Water: consumed slowly
    res.water.current = Math.max(0, res.water.current - (crewCount * 0.002));

    // Food: consumed at meal times (simplified: steady drain)
    res.food.current = Math.max(0, res.food.current - (crewCount * 0.001));

    // Fuel: consumed only under thrust (physics drives this now via nav.thrust)
    if (this.state.navigation.thrust > 0) {
      res.fuel.current = Math.max(0, res.fuel.current - (this.state.navigation.thrust * 0.05));
    }

    // Power: managed by reactorTick (generation when online, drain when offline)

    // --- SCANNER & COMMS ---
    scannerTick(this.state, days);
    commsTick(this.state, days);

    // --- INTERNAL BLEEDING (from inertial impacts) ---
    this.state.ship.crew.forEach(member => internalBleedingTick(member));

    // --- MISSIONS & INTERCEPT ---
    const missionEvents = missionTick(this.state, days);
    if (missionEvents && missionEvents.length > 0) {
      this.onPhysicsEvent('missionEvents', missionEvents);
    }
    const intEvents = interceptTick(this.state);
    if (intEvents && intEvents.length > 0) {
      this.onPhysicsEvent('interceptEvents', intEvents);
    }

    // Track elapsed days
    this.state.stats.daysElapsed += 1 / 1440;

    // Autosave every game-hour (60 minutes)
    this._autosaveCounter++;
    if (this._autosaveCounter >= 60) {
      this._autosaveCounter = 0;
      this.onPhysicsEvent('autosave', null);
    }
  }
}
