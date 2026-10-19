// ============================================================
// LONGHAUL — Game state & simulation tick
//
// One serializable object holds the whole game. Every subsystem
// advances in a fixed one-game-minute step, in a fixed order, so the
// simulation behaves the same at 1 min/s and at 1 day/s. The sim
// reports what happened through the event bus and never touches the DOM.
// ============================================================

import { AU_M, G0, SPEED_MIN_PER_SEC } from '../core/constants.js';
import { createClock } from '../core/clock.js';
import { bus } from '../core/events.js';
import { VERSION } from '../version.js';
import { getWorld, backgroundBudget } from './world.js';
import { createDefaultEntities } from './entities.js';
import { createDefaultLayout, computeShipMass, isSecureSeat } from './ship-layout.js';
import { createCrew, gStateFor, protectedG, physiologyTick, endJuice, G_THRESHOLDS } from './crew.js';
import { crewTick, placeCrew, helmsman } from './crew-ai.js';
import { createJobs } from './jobs.js';
import { needsTick, efficiency } from './needs.js';
import { createFlight, flightStep, fuelUsed, angleDiff, SLEW_RATE, RATED_G, RCS_MAX_G, DRIVE_MAX_G } from './flight.js';
import { autopilotTick, autopilotAfterStep, holdStep, holdStation, crewPolicy, maxSpeed } from './autopilot.js';
import { createLifeSupport, lifeSupportTick, breachJobs } from './life-support.js';
import { createReactor, reactorTick, isReactorOnline, triggerContainmentFailure } from './reactor.js';
import {
  createSystems, systemsTick, systemsJobs, driveLimitG, driveFuelFactor, slewFactor, rcsAvailable,
  flightComputerState, waterRecovery,
} from './systems.js';
import { random, gaussian } from '../core/rng.js';
import { createComms, commsTick } from './comms.js';
import { createSensors, sensorsTick } from './sensors.js';
import { createMissions, missionsTick } from './missions.js';
import { createContracts, contractsTick } from './contracts.js';
import { createTraffic, seedTraffic, trafficTick } from './traffic.js';
import { triggerManeuver, isInertiaActive, updateInertia, Maneuver } from './inertia.js';

export const SAVE_SCHEMA = 3;

// Consumption per person per minute. Crew eat meals (crew-ai); passengers
// are fed from stores continuously. Water figures are gross — the
// reclamation plant recovers most of it.
const WATER_PER_MIN = 0.004;   // L  (≈5.8 L/day drinking & galley; showers on top)
const FOOD_PER_MIN = 0.001;    // rations (≈1.4/day, passengers)
const SECURE_LINGER = 10;      // minutes crew stay strapped in after the last maneuver

const emit = (type, payload) => bus.emit(type, payload);

export function createGame({ shipName = 'UNN Longhaul', captainName = 'J. Doe', crewCount = 4, traffic = 36 } = {}) {
  const crew = createCrew(crewCount);
  crew[0].name = captainName;
  const ship = { name: shipName, decks: createDefaultLayout(), crew };

  const state = {
    schema: SAVE_SCHEMA,
    version: VERSION,
    clock: createClock(),
    speed: 1,
    ship,
    flight: null,
    autopilot: null,
    resources: {
      credits: { current: 5000, max: Infinity, unit: 'MCR' },
      fuel: { current: 8500, max: 10000, unit: 'kg' },
      o2Tank: { current: 500, max: 500, unit: 'kg' },
      n2Tank: { current: 500, max: 500, unit: 'kg' },
      water: { current: 4200, max: 5000, unit: 'L' },
      food: { current: 1800, max: 2000, unit: 'rations' },
      power: { current: 88, max: 100, unit: '%' },
      medSupplies: { current: 50, max: 50, unit: 'units' },
      parts: { current: 12, max: 40, unit: 'parts' },
      scrap: { current: 0, max: 30, unit: 'units' },
    },
    cargo: [],
    cargoCapacity: 15_000,
    passengers: [],
    berths: 12,
    lifeSupport: null,
    reactor: createReactor(),
    systems: createSystems(),
    comms: createComms(),
    sensors: createSensors(),
    jobs: createJobs(),
    missions: createMissions(),
    contracts: createContracts(),
    traffic: createTraffic(traffic),
    entities: createDefaultEntities(),
    nextEntityId: 1,
    combatStations: false,
    crewPolicy: 'free',
    stats: { distance: 0, fuelBurned: 0, peakG: 0 },
    log: [],
  };
  state.lifeSupport = createLifeSupport(ship);
  state.shipMass = computeShipMass(ship);

  const world = getWorld(state);
  const home = world.get('ceres-station');
  state.flight = createFlight({ x: home.pos.x + 3000 / AU_M, y: home.pos.y }, home.vel, Math.PI / 2);
  holdStation(state, { kind: 'entity', id: home.id });
  placeCrew(state);
  seedTraffic(state);
  return state;
}

/** Water through the ship's plumbing: what reclamation can't recover is lost. */
function useWater(state, liters) {
  const w = state.resources.water;
  w.current = Math.max(0, w.current - liters * (1 - waterRecovery(state)));
}

/**
 * A human hand on the stick: the command, as flown. Pointing error is a
 * slow drift (correlated minute to minute) whose size depends on the
 * pilot's skill and state — a tired, hungover pilot wanders.
 */
const DRIFT = 0.9;
function handFlown(cmd, pilot, ap) {
  const sigma = pilot ? (0.015 + 0.08 * (1 - pilot.skills.piloting / 100)) / Math.max(0.3, efficiency(pilot)) : 0.025;
  ap.$err = DRIFT * (ap.$err || 0) + Math.sqrt(1 - DRIFT * DRIFT) * sigma * gaussian();
  const k = 1 + gaussian() * sigma * 0.3;
  const c = Math.cos(ap.$err), sn = Math.sin(ap.$err);
  return { ...cmd, ax: (cmd.ax * c - cmd.ay * sn) * k, ay: (cmd.ax * sn + cmd.ay * c) * k };
}

// ---- PER-MINUTE TICK ----

/**
 * Advance the whole game by one minute.
 * Order matters: decide (autopilot) → move ship → advance clock & world →
 * hold station → people → systems → sensors → missions.
 */
export function minuteTick(state, { lite = false } = {}) {
  const f = state.flight;
  const res = state.resources;
  const prevG = f.thrustG;
  const prevTurn = f.turning;
  const policyBefore = state.crewPolicy;

  // ---- Machinery limits for this minute
  f.maxG = Math.min(DRIVE_MAX_G, driveLimitG(state));
  // Damage control: with the hull holed, the burn eases to 1G so the crew can move
  const breach = state.ship.decks.some(d => d.atmosphere?.breached);
  if (breach) f.maxG = Math.min(f.maxG, 1);
  if (breach !== !!state.damageControl) { state.damageControl = breach; emit('damage-control', { on: breach }); }
  state.$driveCap = f.maxG;
  // Standing order: never push past 1.5G with anyone still on their feet (unless the captain overrides)
  if (state.autopilot?.phase === 'active' && !state.autopilot.override && f.maxG > 1.5 && f.thrustG <= 1.5 + 1e-6 &&
      state.ship.crew.some(m => !m.dead && !isSecureSeat(m.seat))) f.maxG = 1.5;
  f.$slew = SLEW_RATE * slewFactor(state);

  // ---- Flight
  let cmd = autopilotTick(state, emit);
  const ap = state.autopilot;
  if (ap) ap.helm = null;
  if (cmd && ap?.phase === 'active') {
    // Without a working flight computer, someone at the helm flies the plan by hand
    const fc = flightComputerState(state);
    if (fc === 'failed') {
      const flier = helmsman(state);
      if (!flier) { cmd = null; ap.helm = 'unmanned'; }
      else { cmd = handFlown(cmd, flier, ap); ap.helm = 'manual'; ap.helmBy = flier.name; }
    } else if (fc === 'degraded') {
      cmd = handFlown(cmd, null, ap);
      ap.helm = 'degraded';
    }
    if (ap.helm !== (ap.helmWas ?? null)) emit('helm-status', { status: ap.helm, was: ap.helmWas ?? null, by: ap.helmBy });
    ap.helmWas = ap.helm;
  }
  if (!cmd && f.manual && f.manual.throttleG > 0) {
    cmd = { ax: Math.cos(f.facing) * f.manual.throttleG * G0, ay: Math.sin(f.facing) * f.manual.throttleG * G0, maxG: f.manual.throttleG };
  }
  if (!cmd && f.manual?.flipTo != null) {
    if (Math.abs(angleDiff(f.facing, f.manual.flipTo)) < 1e-3) f.manual.flipTo = null;
    else cmd = { ax: 0, ay: 0, face: f.manual.flipTo };
  }
  const driveOK = isReactorOnline(state) && res.fuel.current > 0 && f.maxG > 0;
  let out = { mainG: 0, rcsG: 0, turned: 0 };
  if (f.hold && !(state.autopilot?.phase === 'active')) {
    f.thrustG = 0; f.rcsG = 0; f.turning = 0;
  } else {
    if (cmd && !driveOK) {
      // No drive: RCS only while fuel lasts, and no main-drive burns
      const a = Math.hypot(cmd.ax, cmd.ay);
      const lim = res.fuel.current > 0 && rcsAvailable(state) ? RCS_MAX_G * G0 : 0;
      cmd = a > lim ? { ax: cmd.ax * lim / a, ay: cmd.ay * lim / a, face: cmd.face } : cmd;
    }
    const before = { x: f.pos.x, y: f.pos.y };
    out = flightStep(f, cmd, 1);
    state.stats.distance += Math.hypot(f.pos.x - before.x, f.pos.y - before.y) * AU_M;
    autopilotAfterStep(state, out);
  }

  // ---- Time & world
  state.clock.minute++;
  const world = getWorld(state);
  // Lite minutes (intermediate minutes of a heavy time-warp frame) skip the
  // observation work; the frame's final minute brings everything up to date.
  if (!lite) world.tick(state.clock.minute, f.pos);

  let holdG = 0;
  if (f.hold) {
    holdG = holdStep(state);
    if (holdG > 0) {
      if (!driveOK) { f.hold = null; emit('hold-lost', { reason: 'no drive power' }); }
      else { f.thrustG = holdG; out.mainG = holdG; }
    }
  }

  // Overdriven drive: each minute past the rated limit risks the magnetic bottle
  if (out.mainG > RATED_G && random() < 0.00012 * (out.mainG - RATED_G) ** 2 && triggerContainmentFailure(state)) {
    emit('drive-overstress', { g: out.mainG });
  }

  const burn = fuelUsed(out.mainG, out.rcsG) * driveFuelFactor(state);
  res.fuel.current = Math.max(0, res.fuel.current - burn);
  state.stats.fuelBurned += burn;
  if (res.fuel.current <= 0 && prevG > 0) emit('fuel-exhausted', {});
  state.stats.peakG = Math.max(state.stats.peakG, f.thrustG);

  // ---- Inertial events: the drive lit, cut, changed, or the ship began to flip
  const gNow = f.thrustG;
  const announced = policyBefore === 'secure' || !!state.autopilot;
  const surprise = !announced;
  if (prevG < 0.05 && gNow >= 0.05) fireInertia(state, Maneuver.BURN_START, { deltaG: gNow, surprise, gForce: gNow });
  else if (prevG >= 0.05 && gNow < 0.05) fireInertia(state, Maneuver.BURN_STOP, { deltaG: prevG, surprise, gForce: gNow });
  else if (Math.abs(gNow - prevG) > 0.5) fireInertia(state, Maneuver.THRUST_CHANGE, { deltaG: gNow - prevG, surprise, gForce: gNow });
  // A flip proper: a big rotation (well past 90°) starting from rest
  if (out.rotation > 2.4 && Math.abs(prevTurn) < SLEW_RATE * 0.5 && Math.abs(out.turned) > 0) fireInertia(state, Maneuver.FLIP, { gForce: gNow });

  // ---- People
  const g = gNow + f.rcsG;
  // Hysteresis: once called to couches, the crew stay strapped in until the
  // ship has been quiet for a while (no unstrapping between two maneuvers).
  if (crewPolicy(state) === 'secure') state.secureUntil = state.clock.minute + SECURE_LINGER;
  state.crewPolicy = state.clock.minute < (state.secureUntil ?? -1) ? 'secure' : 'free';
  const living = state.ship.crew.filter(m => !m.dead).length;

  // ---- Machinery: wear, faults, and the work they make
  systemsTick(state, {
    g, rcsG: f.rcsG, turned: out.turned || 0, autopilot: ap?.phase === 'active', breathers: living,
    engWatch: state.$watch?.engineering != null, opsWatch: state.$watch?.ops != null, emit,
  });
  systemsJobs(state);
  breachJobs(state);

  for (const m of state.ship.crew) {
    if (m.dead) continue;
    const secured = isSecureSeat(m.seat);
    m.gState = gStateFor(m, g, secured);
    const eff = protectedG(m, g, secured, res);
    m.$effG = eff;                       // what the body feels (couch + juice)
    const wasCritical = m.conditions.includes('critical');
    for (const ev of physiologyTick(m, eff, g)) {
      if (ev === 'died') { mourn(state, m); emit('crew-died', { member: m }); }
      else if (ev === 'critical' && !wasCritical) emit('crew-critical', { member: m });
      else if (ev === 'brain-damage') emit('crew-brain-damage', { member: m });
      else if (ev === 'stroke') emit('crew-stroke', { member: m });
    }
    if (m.juiced && g <= G_THRESHOLDS.HIGH) {
      const minutes = endJuice(m, Math.max(prevG, state.autopilot?.peakG || 0));
      if (minutes) emit('crew-hangover', { member: m, minutes });
    }
  }
  crewTick(state, {
    gForce: g,
    policy: state.crewPolicy,
    emit,
    hooks: { useWater: (liters) => useWater(state, liters) },
  });

  // ---- Needs & consumables (crew eat meals; passengers are fed from stores)
  const pax = state.passengers.reduce((s, p) => s + p.count, 0);
  useWater(state, (living + pax) * WATER_PER_MIN);
  res.food.current = Math.max(0, res.food.current - pax * FOOD_PER_MIN);
  const water = res.water.current > 0;
  for (const m of state.ship.crew) {
    if (m.dead) continue;
    const asleep = m.activity === 'sleeping' ? 'bunk' : m.activity === 'sleeping-couch' ? 'couch' : null;
    const strapped = isSecureSeat(m.seat) && !m.seat.startsWith('medbay') && (state.crewPolicy === 'secure' || m.task?.type === 'helm');
    needsTick(m, { asleep, secured: strapped, onDuty: m.task?.type === 'watch' || m.task?.type === 'helm' || m.task?.type === 'work', gForce: m.$effG ?? g, res, water });
  }

  // ---- Plant
  lifeSupportTick(state, { emit });
  reactorTick(state, emit);

  // ---- Sensors & comms (blind in a blackout)
  if (!lite) {
    if (!state.reactor.blackout) sensorsTick(state);
    commsTick(state, emit);
  }

  // ---- The wider world
  missionsTick(state, emit);
  contractsTick(state, emit);
  trafficTick(state);

  if (state.crewPolicy !== policyBefore) emit('crew-policy', { policy: state.crewPolicy });
}

/** A death aboard weighs on everyone for days. */
function mourn(state, dead) {
  for (const m of state.ship.crew) if (m !== dead && !m.dead) m.moraleMod = (m.moraleMod || 0) - 25;
}

function fireInertia(state, type, opts) {
  if (isInertiaActive(state)) return;
  const n = triggerManeuver(state, type, opts);
  if (n > 0) emit('inertia-start', { type, count: n });
}

/**
 * Advance `minutes` game-minutes with background upkeep sized to match.
 * (Tests and headless runs; the browser loop budgets per frame instead.)
 */
export function advance(state, minutes = 1) {
  for (let i = 0; i < minutes; i++) {
    minuteTick(state);
    const world = getWorld(state);
    world.background(state.clock.minute, backgroundBudget(world.count, 1));
  }
}

// ---- LOOP ----

/**
 * Drives the sim from requestAnimationFrame (browser) or manual stepping (tests).
 * Game time freezes while an inertial event plays out in real time.
 */
export class GameLoop {
  constructor(state, { onFrame = () => {}, onError = (e) => console.error(e) } = {}) {
    this.state = state;
    this.onFrame = onFrame;
    this.onError = onError;
    this.acc = 0;
    this.running = false;
    this._last = 0;
    this._raf = 0;
    this.stepsLastFrame = 0;
    this.simMsLastFrame = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(frame);
      const dt = Math.min((now - this._last) / 1000, 0.25);
      this._last = now;
      this.frame(dt);
    };
    this._raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  setSpeed(speed) {
    this.state.speed = Math.max(0, Math.min(speed, maxSpeed(this.state)));
    return this.state.speed;
  }

  /** Advance by dt real seconds: inertia (real time) or sim minutes (scaled). */
  frame(dt) {
    const s = this.state;
    const t0 = performance.now();
    let steps = 0;
    try {
      if (isInertiaActive(s)) {
        const hits = updateInertia(s, dt);
        for (const h of hits) emit('inertia-impact', h);
        if (!isInertiaActive(s)) emit('inertia-end', {});
      } else if (s.speed > 0) {
        this.acc += dt * SPEED_MIN_PER_SEC[s.speed];
        const cap = 3000;                  // never stall a frame: drop excess at extreme rates
        while (this.acc >= 1 && steps < cap) {
          this.acc -= 1;
          minuteTick(s, { lite: s.speed >= 3 && this.acc >= 1 });
          steps++;
          // Warp limits and inertial events take effect immediately
          const max = maxSpeed(s);
          if (s.speed > max) { s.speed = max; emit('speed-limited', { speed: max }); this.acc = Math.min(this.acc, 1); }
          if (isInertiaActive(s)) { this.acc = 0; break; }
        }
        if (steps >= cap) this.acc = 0;
        if (steps > 0) {
          const world = getWorld(s);
          world.background(s.clock.minute, backgroundBudget(world.count, steps));
        }
      }
    } catch (e) {
      this.onError(e);
    }
    this.stepsLastFrame = steps;
    this.simMsLastFrame = performance.now() - t0;
    // Fraction of the next minute elapsed — for smooth interpolation in the renderer
    this.alpha = s.speed > 0 ? Math.min(1, this.acc) : 1;
    try { this.onFrame(s, this.alpha); } catch (e) { this.onError(e); }
  }
}

