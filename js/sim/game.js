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
import { createLayout, computeShipMass, isSecureSeat } from './ship-layout.js';
import { createCrew, gStateFor, protectedG, physiologyTick, endJuice, juiceLapsed, mourn } from './crew.js';
import { crewTick, placeCrew, helmsman, crewSecureStatus } from './crew-ai.js';
import { createJobs } from './jobs.js';
import { needsTick, efficiency } from './needs.js';
import { createFlight, flightStep, fuelUsed, angleDiff, SLEW_RATE, RCS_MAX_G, FLIP_TURN } from './flight.js';
import { autopilotTick, autopilotAfterStep, holdStep, holdStation, crewPolicy, maxSpeed, flipInterlock, clearOutTick } from './autopilot.js';
import { createLifeSupport, lifeSupportTick, breachJobs } from './life-support.js';
import { createReactor, reactorTick, isReactorOnline, triggerContainmentFailure } from './reactor.js';
import {
  createSystems, systemsTick, systemsJobs, driveLimitG, driveFuelFactor, slewFactor, rcsAvailable,
  flightComputerState, waterRecovery,
} from './systems.js';
import { random, gaussian } from '../core/rng.js';
import { createComms, commsTick } from './comms.js';
import { createSensors, sensorsTick } from './sensors.js';
import { createNavFlags, flagsTick } from './flags.js';
import { createMissions, missionsTick } from './missions.js';
import { createContracts, contractsTick, upgradeContracts } from './contracts.js';
import { createTraffic, seedTraffic, trafficTick, ensurePopulation, DEFAULT_TRAFFIC } from './traffic.js';
import { seedForces, forcesTick, commandShipFor } from './forces.js';
import { createService, serviceTick } from './service.js';
import { createIntel, ensureIntel, intelTick, recordContacts } from './intel.js';
import { triggerManeuver, isInertiaActive, updateInertia, Maneuver } from './inertia.js';
import { PLAYER_CLASS, CLASSES, playerClass, ratedG } from './ship-classes.js';
import { createCombat, createMagazine, combatTick, combatMove, moveAgents, jinkG } from './combat.js';
import { createLaw, lawTick } from './law.js';
import { createPolitics, politicsTick } from './conflict.js';
import { destroyPlayer } from './damage.js';
import { snapshot, PDC_ROUNDS_PER_MOUNT } from './combatants.js';
import { dockingTick, finishMinute, dockHold, dockHolds, inFrame, frameStep, dockInstant, PROX_RATES, hoverG, hoverOnRcs } from './docking.js';
import { terrainTick } from './terrain.js';
import { worldsTick, airDrag } from './worlds.js';
import { createTrafficControl, trafficControlTick, keepOutDriveCap } from './traffic-control.js';
import { stationsTick } from './station-defense.js';
import { createDossier, dossierTick } from './manifest.js';
import { boardingTick } from './boarding.js';
import { leaveTick } from './crew-services.js';
import { leaseTick } from './leases.js';
import { setGravityEpoch } from './gravity.js';
import { fireTick } from './fire.js';
import { createDroneStores, dronesTick } from './drones.js';
import { createShuttles, shuttlesTick, npcShuttlesTick } from './shuttles.js';

export const SAVE_SCHEMA = 7;

// Consumption per person per minute. Crew eat meals (crew-ai); passengers
// are fed from stores continuously. Water figures are gross — the
// reclamation plant recovers most of it.
const WATER_PER_MIN = 0.004;   // L  (≈5.8 L/day drinking & galley; showers on top)
const FOOD_PER_MIN = 0.001;    // rations (≈1.4/day, passengers)
const SECURE_LINGER = 10;      // minutes crew stay strapped in after the last maneuver
const JINK_FUEL_SHARE = 0.5;   // jinking burns at full G about half the time

const emit = (type, payload) => bus.emit(type, payload);

/**
 * A new game. `classId` is the hull we start in (any PLAYABLE class): it
 * sets the interior fit, the machinery, the drive, hold, berths and
 * weapons. A navy hull in private hands comes without its nuclear warheads.
 */
/**
 * A new game. `traffic`: civilian ships in the system; `forces`: police,
 * navies and pirates in the background (forces.js) — on whenever there is
 * traffic, off for test suites that leave both out.
 */
/** Where a new captain starts, by license: at its power's yards (a civilian at Ceres). */
export const HOME_PORT = { UN: 'luna-yards', MCR: 'phobos-yard', OPA: 'tycho-station', none: 'ceres-station' };

export function createGame({ shipName = 'UNN Longhaul', captainName = 'J. Doe', crewCount = 4, traffic = DEFAULT_TRAFFIC, forces = traffic > 0, classId = PLAYER_CLASS, license = null, home = null, docked = true } = {}) {
  if (!CLASSES[classId]) classId = PLAYER_CLASS;
  home ||= HOME_PORT[license || 'none'];
  const cls = CLASSES[classId];
  const ship = { name: shipName, classId, tl: cls.tl, decks: createLayout(classId), crew: [] };
  ship.crew = createCrew(crewCount, ship);
  ship.crew[0].name = captainName;

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
      pdcRounds: { current: cls.pdc * PDC_ROUNDS_PER_MOUNT * 0.6, max: cls.pdc * PDC_ROUNDS_PER_MOUNT, unit: 'rds' },
      drones: createDroneStores(classId),
    },
    hull: { integrity: 100 },
    magazine: { ...createMagazine(classId), nuke: 0 },
    combat: createCombat(classId),
    law: createLaw(license),
    service: createService(license, 0),
    politics: createPolitics(),
    cargo: [],
    cargoCapacity: cls.cargoT * 1000,
    passengers: [],
    berths: cls.berths,
    brig: cls.brig || 0,
    lifeSupport: null,
    reactor: createReactor(),
    systems: createSystems(classId),
    comms: createComms(),
    sensors: createSensors(),
    navFlags: createNavFlags(),
    intel: createIntel(),
    jobs: createJobs(),
    missions: createMissions(),
    contracts: createContracts(),
    traffic: createTraffic(traffic),
    tc: createTrafficControl(),
    dock: null,
    drone: null,
    shuttles: createShuttles(classId),
    boarding: null,
    dossier: createDossier(),
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
  const port = world.get(home) || world.get('ceres-station');
  // Start in a berth, sealed (taken before the traffic arrives), or (docked:
  // false, for test suites) holding at the station's approach gate
  const gate = world.get(`${port.id}-gate`) || port;
  state.flight = createFlight({ x: gate.pos.x, y: gate.pos.y }, gate.vel, Math.PI / 2);
  if (!docked || !dockInstant(state, port.id)) holdStation(state, { kind: 'entity', id: gate.id });
  placeCrew(state);
  seedTraffic(state);
  if (forces) seedForces(state);
  return state;
}

/**
 * A save from v0.10 (same schema, fewer systems): give it a plot, the
 * traffic of a settled system, and the background forces. Nothing it
 * already has changes. (And an escort's convoy waiting where nobody could
 * come for it goes out to its gate: contracts.js.)
 */
export function upgradeState(state) {
  setGravityEpoch(state.clock.minute);
  ensureIntel(state);
  state.tc ??= createTrafficControl();
  state.service ??= createService(null);
  state.dossier ??= createDossier();
  state.navFlags ??= createNavFlags();
  state.resources.drones ??= createDroneStores(state.ship.classId);
  if (state.drone === undefined) state.drone = null;
  state.shuttles ??= createShuttles(state.ship.classId);
  if (state.dock === undefined) state.dock = null;
  if (state.boarding === undefined) state.boarding = null;
  state.combat.fuses ??= [];
  // (a save from before fuses were kept: a scuttled hull still counting down is armed again)
  for (const e of state.entities || []) if (e.combat?.containment != null && !e.agent && !state.combat.fuses.includes(e.id)) state.combat.fuses.push(e.id);
  const fresh = state.traffic && !state.traffic.v;
  ensurePopulation(state);
  if (fresh && state.traffic.population > 0) seedForces(state);
  upgradeContracts(state);
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
 * NPC ships fly → hold station → ordnance flies and strikes → a drone out
 * keeps up or is left behind → people →
 * systems → sensors → combat decisions, politics, missions.
 */
export function minuteTick(state, { lite = false } = {}) {
  setGravityEpoch(state.clock.minute);          // everything flown this minute falls from here
  const f = state.flight;
  const res = state.resources;
  const prevG = f.thrustG;
  const prevTurn = f.turning;
  const policyBefore = state.crewPolicy;
  state.$prev = snapshot(f.pos, f.vel);          // for closest-approach checks this minute
  const jink = jinkG(state);                     // evasive maneuvering: random hard thrust, no net Δv
  state.$jinkG = jink;

  // ---- Machinery limits for this minute
  const cls = playerClass(state);
  f.maxG = Math.min(cls.drive.maxG, driveLimitG(state));
  // Damage control: with the hull holed, the burn eases to 1G so the crew can move
  const breach = state.ship.decks.some(d => d.atmosphere?.breached);
  if (breach) f.maxG = Math.min(f.maxG, 1);
  if (breach !== !!state.damageControl) { state.damageControl = breach; emit('damage-control', { on: breach }); }
  // (routes are planned on what the drive can give once out of port: nav.js)
  state.$planG = f.maxG;
  // No torch inside a station's gate (traffic-control.js)
  if (!state.autopilot?.climbing) f.maxG = Math.min(f.maxG, keepOutDriveCap(state));   // (pulling up off a rock, the drive is the drive)
  state.$driveCap = f.maxG;
  // Standing order: never push past 1.5G with anyone still on their feet (unless the captain overrides)
  if (state.autopilot?.phase === 'active' && !state.autopilot.override && f.maxG > 1.5 && f.thrustG <= 1.5 + 1e-6 &&
      state.ship.crew.some(m => !m.dead && !isSecureSeat(m.seat))) f.maxG = 1.5;
  f.$slew = SLEW_RATE * slewFactor(state);

  // ---- Docking: phases move on; while the dock holds us we fly in the berth's frame
  let held = dockingTick(state, emit);

  // ---- Flight (a route plotted at a berth undocks first: autopilot.js)
  // (taking the stick ends a clear-out: autopilot.js clearOutTick)
  if (f.leaving && (f.manual?.throttleG > 0 || f.manual?.flipTo != null)) f.leaving = null;
  let cmd = autopilotTick(state, emit) || clearOutTick(state, emit);
  // (a route leaving the hold point lets the dock go: this minute is flown, or we'd fall a minute behind the world)
  if (held && !dockHolds(state)) held = false;
  if (held) cmd = null;
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
    // No flip with the crew on their feet
    if (cmd && !cmd.climb) cmd = flipInterlock(state, cmd, emit);   // (pulling up off a rock overrides it: terrain.js)
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
  if (held) {
    // Proximity operations fly the rest of the minute second by second (docking.js)
    finishMinute(state, emit);
    f.thrustG = state.dock?.phase === 'approach' ? (state.$dockThrust || 0) : 0;
    f.turning = 0;
    f.rcsG = inFrame(state) ? state.$dockRcs || 0 : 0;      // (sealed at a berth, nothing is firing)
    out.mainG = 0; out.rcsG = 0;      // (reaction mass already spent second by second)
  } else if (f.hold && !(state.autopilot?.phase === 'active')) {
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
    // (a world's air drags on us: worlds.js)
    airDrag(state, 60);
    state.stats.distance += Math.hypot(f.pos.x - before.x, f.pos.y - before.y) * AU_M;
    autopilotAfterStep(state, out);
  }

  // ---- Time & world
  state.clock.minute++;
  const world = getWorld(state);
  // Lite minutes (intermediate minutes of a heavy time-warp frame) skip the
  // observation work; the frame's final minute brings everything up to date.
  if (!lite) world.tick(state.clock.minute, f.pos);
  moveAgents(state, emit);

  let holdG = 0;
  if (dockHolds(state)) {
    dockHold(state);
    // hovering off a berth beside a rock costs thrust (docking.js hoverG): the RCS's, but on the final approach
    const hov = hoverG(state);
    if (hov > 1e-5 && hoverOnRcs(state)) { out.rcsG = Math.hypot(out.rcsG, hov); f.rcsG = Math.hypot(f.rcsG || 0, hov); }
    else if (hov > 1e-5 && driveOK) { out.mainG = Math.hypot(out.mainG, hov); f.thrustG = Math.hypot(f.thrustG, hov); }
  } else if (f.hold) {
    holdG = holdStep(state);
    if (holdG > 0) {
      // a light hold (hovering at a small rock's gate) is kept on the RCS when the drive is down
      const onRcs = holdG <= RCS_MAX_G && res.fuel.current > 0 && rcsAvailable(state);
      if (driveOK) { f.thrustG = holdG; out.mainG = holdG; }
      else if (onRcs) { f.rcsG = holdG; out.rcsG = holdG; }
      else { f.hold = null; emit('hold-lost', { reason: 'no drive power' }); }
    }
  }
  combatMove(state, emit);
  // Flying free near a body: the ground (terrain.js)
  terrainTick(state, emit, { free: !held && !f.hold && !dockHolds(state) });
  worldsTick(state, emit);
  // A drone out can't keep up with a burn (drones.js)
  dronesTick(state, emit);

  // Overdriven drive: each minute past the rated limit risks the magnetic bottle
  const rated = ratedG(cls);
  if (out.mainG > rated && random() < 0.00012 * (out.mainG - rated) ** 2 && triggerContainmentFailure(state)) {
    emit('drive-overstress', { g: out.mainG });
  }

  const burn = (fuelUsed(out.mainG, out.rcsG, 1, rated) + fuelUsed(jink * JINK_FUEL_SHARE, 0, 1, rated)) * driveFuelFactor(state);
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
  if (out.rotation > FLIP_TURN && Math.abs(prevTurn) < SLEW_RATE * 0.5 && Math.abs(out.turned) > 0) fireInertia(state, Maneuver.FLIP, { gForce: gNow });

  // ---- People (jinking throws the crew around on top of the burn)
  const g = Math.hypot(gNow, jink) + f.rcsG;
  // Hysteresis: once called to couches, the crew stay strapped in until the
  // ship has been quiet for a while (no unstrapping between two maneuvers).
  if (crewPolicy(state) === 'secure') state.secureUntil = state.clock.minute + SECURE_LINGER;
  state.crewPolicy = state.clock.minute < (state.secureUntil ?? -1) ? 'secure' : 'free';
  // The maneuvering lights: the nav computer has called the crew in, and someone able is still up
  state.$maneuverAlert = !!state.autopilot && state.crewPolicy === 'secure' && !state.combatStations && crewSecureStatus(state).unsecured.length > 0;
  const living = state.ship.crew.filter(m => !m.dead && !m.away).length;

  // ---- Machinery: wear, faults, and the work they make
  systemsTick(state, {
    g, rcsG: f.rcsG, turned: out.turned || 0, autopilot: ap?.phase === 'active', breathers: living,
    engWatch: state.$watch?.engineering != null, opsWatch: state.$watch?.ops != null, emit,
  });
  systemsJobs(state);
  breachJobs(state);

  for (const m of state.ship.crew) {
    if (m.dead) continue;
    const gHere = m.away ? 0 : g;          // a boarding party feels the other hull, not ours
    const secured = isSecureSeat(m.seat);
    m.gState = gStateFor(m, gHere, secured);
    const eff = protectedG(m, gHere, secured, res);
    m.$effG = eff;                       // what the body feels (couch + juice)
    const wasCritical = m.conditions.includes('critical');
    for (const ev of physiologyTick(m, eff, gHere)) {
      if (ev === 'died') { mourn(state.ship.crew, m); emit('crew-died', { member: m }); }
      else if (ev === 'critical' && !wasCritical) emit('crew-critical', { member: m });
      else if (ev === 'brain-damage') emit('crew-brain-damage', { member: m });
      else if (ev === 'stroke') emit('crew-stroke', { member: m });
    }
    if (juiceLapsed(m)) {
      const minutes = endJuice(m);
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
    if (m.dead || m.away) continue;
    const asleep = m.activity === 'sleeping' ? 'bunk' : m.activity === 'sleeping-couch' ? 'couch' : null;
    const strapped = isSecureSeat(m.seat) && !m.seat.startsWith('medbay') && (state.crewPolicy === 'secure' || m.task?.type === 'helm');
    needsTick(m, { asleep, secured: strapped, onDuty: m.task?.type === 'watch' || m.task?.type === 'helm' || m.task?.type === 'work', gForce: m.$effG ?? g, res, water });
  }

  // ---- Plant
  fireTick(state, emit);
  lifeSupportTick(state, { emit });
  reactorTick(state, emit);
  if (state.reactor.supercritical && !state.lost) destroyPlayer(state, 'reactor', emit);

  // ---- Sensors & comms (blind in a blackout)
  if (!lite) {
    if (!state.reactor.blackout) { sensorsTick(state); recordContacts(state); }
    commsTick(state, emit);
  }
  trafficControlTick(state, emit);
  dossierTick(state, emit);

  // ---- The wider world
  combatTick(state, emit);
  stationsTick(state, emit);
  boardingTick(state, emit);
  shuttlesTick(state, emit);
  npcShuttlesTick(state);
  leaveTick(state, emit);
  leaseTick(state, emit);
  lawTick(state);
  politicsTick(state, emit);
  serviceTick(state, emit, { commandShipFor });
  missionsTick(state, emit);
  contractsTick(state, emit);
  trafficTick(state);
  forcesTick(state, { lite });
  intelTick(state, emit);
  flagsTick(state, emit);

  if (state.crewPolicy !== policyBefore) emit('crew-policy', { policy: state.crewPolicy });
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
    let docking = false;
    try {
      if (isInertiaActive(s)) {
        const hits = updateInertia(s, dt);
        for (const h of hits) emit('inertia-impact', h);
        if (!isInertiaActive(s)) emit('inertia-end', {});
      } else if (s.speed === 1 && dockHolds(s)) {
        // Docking mode: the minute is flown in game seconds at the dock's rate,
        // proximity operations a second at a time (docking.js), so a view
        // drawn between minutes shows where the ship really is (×60 included:
        // flown whole, a minute's motion would show as a jump)
        docking = true;
        this.proxAcc = (this.proxAcc || 0) + dt * PROX_RATES[s.dock.rate ?? 3];
        this.sub = this.sub || 0;
        let n = 0;
        while (this.proxAcc >= 1 && n < 600) {
          this.proxAcc -= 1; n++;
          if (inFrame(s)) frameStep(s, 1, emit);
          if (++this.sub >= 60) {
            this.sub = 0;
            minuteTick(s);
            steps++;
            const world = getWorld(s);
            world.background(s.clock.minute, backgroundBudget(world.count, 1));
            if (isInertiaActive(s) || !dockHolds(s)) { this.proxAcc = 0; break; }
          }
        }
      } else if (s.speed > 0) {
        this.sub = 0;
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
    // Fraction of the next minute elapsed — for smooth interpolation in the renderer: in docking
    // mode the seconds flown (and the part of one), otherwise the minutes owed; paused, where it stood
    if (s.speed > 0) this.alpha = Math.min(1, docking ? (this.sub + Math.min(1, this.proxAcc || 0)) / 60 : this.acc);
    else this.alpha ??= 0;
    try { this.onFrame(s, this.alpha); } catch (e) { this.onError(e); }
  }
}

