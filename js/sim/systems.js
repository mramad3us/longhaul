// ============================================================
// LONGHAUL — Ship systems: wear, faults, repair
//
// Every machine aboard has an integrity (0–100) that wears down with
// use and time. Worn machines fault more often, and hard driving wears
// them faster. A fault leaves a system DEGRADED (half performance) or
// FAILED (none) until an engineer repairs it at the machine itself,
// using spare parts. With no parts aboard they can only jury-rig it:
// PATCHED runs at half performance and gives out again within a day
// or two. Preventive maintenance restores integrity before it bites.
//
// Spent parts become scrap; the machine shop refurbishes scrap into
// spare parts, so a ship with a working shop and a mechanic can stay
// out longer.
//
// How the ship was built changes all of it (TECH in ship-classes.js).
// A Martian ship's machinery wears slowly and rarely faults, but each
// repair eats more spares, takes longer, and a jury-rig on naval-grade
// kit holds only hours. A Belt refit breaks twice as often, is fixed
// quickly from a handful of parts, and its jury-rigs hold for days.
//
// Machinery follows the hull's fit: a ship without guns has no PDC or
// launcher to wear (shipSystems).
// ============================================================

import { random, pick, randInt, weightedPick } from '../core/rng.js';
import { addJob, closeJob, setJobPriority, JobType, JOB_PRIORITY } from './jobs.js';
import { CLASSES, TECH, PLAYER_CLASS } from './ship-classes.js';

export const Status = { NOMINAL: 'nominal', DEGRADED: 'degraded', PATCHED: 'patched', FAILED: 'failed' };

/**
 * System catalogue (display order). Per system:
 *   desc    — what it is (the ship's library)
 *   fixture — where the work is done (fixture kind in the layout)
 *   wear    — integrity lost per day at idle
 *   mtbf    — days between faults at 50% integrity under nominal load
 *   load/stress(ctx) — multipliers on wear / fault rate from what the ship is doing
 */
export const SYSTEMS = {
  flightComputer: {
    desc: 'Triple-redundant guidance core fed by ring-laser gyros, accelerometers and a star tracker. It flies every route and stance a minute at a time: the burns, the flips, the last metres of a docking. If it dies, someone has to fly by hand from the helm couch.',
    name: 'Flight computer', short: 'FLT CMP', fixture: 'helm', wear: 0.8, mtbf: 70,
    load: (c) => c.autopilot ? 1.5 : 1,
    stress: (c) => 1 + c.g * 0.2,
    effects: { degraded: 'Guidance errors — burns wander, time warp limited', failed: 'Autopilot offline — someone must fly from the helm' },
    faults: {
      minor: ['IMU gyro drift', 'Guidance coprocessor throwing parity errors', 'Star tracker misaligned'],
      major: ['Guidance core crashed — bad memory bank', 'Flight-control bus short', 'Attitude reference unit failed'],
    },
  },
  drive: {
    desc: 'Fusion torch. Frozen deuterium pellets are compressed and lit inside a magnetic bottle, and the plasma leaves through a magnetic nozzle: enough thrust to hold several G for weeks on one load of reaction mass. Pushed past its rating it runs hot and thirsty, and the bottle can fail.',
    name: 'Epstein drive', short: 'DRIVE', fixture: 'engine', wear: 0.6, mtbf: 60,
    load: (c) => 1 + c.g * 2 + Math.max(0, c.g - 7) * 6,
    stress: (c) => 1 + c.g * 0.6 + Math.max(0, c.g - 7) * 2,
    effects: { degraded: 'Thrust limited to 3G, fuel efficiency −25%', failed: 'No main drive — RCS only' },
    faults: {
      minor: ['Injector misfire in the pellet feed', 'Magnetic nozzle field ripple', 'Fuel pellet feed jam'],
      major: ['Nozzle coil quench', 'Pellet injector failure', 'Ignition laser failure'],
    },
  },
  coolant: {
    desc: 'The pumps, heat exchangers and radiator loop that carry waste heat off the reactor. A reactor runs only as hard as it can be cooled: a degraded loop throttles it, and a dead one leaves it idling on batteries.',
    name: 'Reactor cooling', short: 'COOLANT', fixture: 'reactor', wear: 0.7, mtbf: 80,
    load: (c) => 1 + c.g,
    stress: (c) => 1 + c.g * 0.4,
    effects: { degraded: 'Reactor throttled — 3G limit, half power regeneration', failed: 'Reactor at idle — 0.3G limit, running on batteries' },
    faults: {
      minor: ['Coolant pump bearing wear', 'Radiator panel micro-leak', 'Heat exchanger fouling'],
      major: ['Primary coolant pump seized', 'Radiator loop ruptured', 'Coolant valve stuck closed'],
    },
  },
  rcs: {
    desc: "Thruster clusters round the hull. They swing the nose (a full flip takes six minutes) and push the ship sideways for docking and fine station-keeping, at about twelve times the main drive's reaction mass per G.",
    name: 'RCS thrusters', short: 'RCS', fixture: 'engStation', wear: 0.5, mtbf: 90,
    load: (c) => 1 + c.rcsG * 300 + Math.abs(c.turned) * 20,
    stress: (c) => 1 + Math.abs(c.turned) * 2,
    effects: { degraded: 'Slow attitude control — flips take twice as long', failed: 'Drive gimbal only — very slow turns, no RCS translation' },
    faults: {
      minor: ['Thruster quad valve sticking', 'RCS manifold pressure drop', 'Thruster cluster misfiring'],
      major: ['RCS manifold leak', 'Attitude thruster bank offline'],
    },
  },
  sensors: {
    desc: 'Radar, lidar, thermal imagers and optical telescopes, fused at the ops console into one contact picture. A lit drive plume shows across millions of km; a cold, silent hull only at radar range.',
    name: 'Sensor suite', short: 'SENSORS', fixture: 'ops', wear: 0.5, mtbf: 110,
    load: () => 1, stress: (c) => 1 + c.g * 0.1,
    effects: { degraded: 'Sensor range halved', failed: 'Short-range optics only' },
    faults: {
      minor: ['Radar transmitter drift', 'Thermal array cooling fault', 'Lidar misaligned'],
      major: ['Radar transmitter burned out', 'Sensor processor failure'],
    },
  },
  comms: {
    desc: 'High-gain dish, omni antennas and laser link. Hails, distress calls and torpedo datalinks all go through it.',
    name: 'Comms array', short: 'COMMS', fixture: 'radio', wear: 0.5, mtbf: 120,
    load: () => 1, stress: (c) => 1 + c.g * 0.1,
    effects: { degraded: 'Radio range halved', failed: 'No radio — cannot hail or call for help' },
    faults: {
      minor: ['Antenna gimbal stiction', 'Transmitter amplifier overheating'],
      major: ['High-gain amplifier failed', 'Comms processor crashed'],
    },
  },
  lifeSupport: {
    desc: 'CO₂ scrubbers, oxygen fed from the stores and nitrogen make-up, holding the air at Earth-normal pressure. Without it CO₂ builds up within hours.',
    name: 'Life support', short: 'LIFE SUP', fixture: 'lifeSupport', wear: 0.9, mtbf: 90,
    load: (c) => 1 + c.breathers * 0.1,
    stress: (c) => 1 + Math.max(0, c.g - 1.5) * 2,
    effects: { degraded: 'Scrubbing and O₂ injection at half rate', failed: 'No scrubbing — CO₂ building up' },
    faults: {
      minor: ['CO₂ scrubber bed saturating', 'Air circulation fan failing', 'O₂ regulator drift'],
      major: ['Scrubber cartridge failure', 'Main air handler seized'],
    },
  },
  waterRecycler: {
    desc: 'Reclaims water from humidity, wash water and waste: 95% of what the crew use comes back. Without it every litre drunk or washed is gone.',
    name: 'Water reclamation', short: 'WATER', fixture: 'recycler', wear: 0.9, mtbf: 90,
    load: (c) => 1 + c.breathers * 0.1,
    stress: () => 1,
    effects: { degraded: 'Recovering 70% of water instead of 95%', failed: 'No reclamation — every liter used is lost' },
    faults: {
      minor: ['Filtration membrane fouling', 'Distiller pump cavitating'],
      major: ['Reclamation distiller failed', 'Brine processor jammed'],
    },
  },
  galley: {
    desc: 'Food printers and a pantry that turn stores into meals. When it fails the crew eat cold ration packs, and morale shows it.',
    name: 'Galley', short: 'GALLEY', fixture: 'galley', wear: 0.6, mtbf: 140,
    load: () => 1, stress: () => 1,
    effects: { degraded: 'Slow, joyless meals', failed: 'Cold rations only' },
    faults: {
      minor: ['Oven element burned out', 'Food printer nozzle clogged'],
      major: ['Galley power bus fault', 'Food processor seized'],
    },
  },
  autodoc: {
    desc: 'The automated medical bay: diagnosis, surgery, trauma care and drug delivery (juice included) in an acceleration couch. It heals far faster than any medic working by hand.',
    name: 'Autodoc', short: 'AUTODOC', fixture: 'medbay', wear: 0.4, mtbf: 160,
    load: () => 1, stress: (c) => 1 + c.g * 0.1,
    effects: { degraded: 'Treatment at half speed', failed: 'Manual care only — very slow healing' },
    faults: {
      minor: ['Diagnostic sensors out of calibration', 'Drug synthesizer clogged'],
      major: ['Surgical arm actuator failure', 'Autodoc controller fault'],
    },
  },
  pdc: {
    desc: 'Point-defense cannons: radar-laid gatling turrets firing tungsten at about 1.2 km/s, fifty rounds a second. Their job is shredding torpedoes in the last seconds of an approach; inside a few km they can also rake a hull.',
    name: 'Point defense', short: 'PDC', fixture: 'pdc', wear: 0.4, mtbf: 150,
    load: () => 1, stress: (c) => 1 + c.g * 0.1,
    effects: { degraded: 'Half the PDC mounts answering fire control', failed: 'Point defense down — nothing stops a torpedo' },
    faults: {
      minor: ['PDC feed jam', 'Fire-control radar drift', 'Turret traverse motor overheating'],
      major: ['PDC barrel assembly cracked', 'Fire-control computer fault'],
    },
  },
  launcher: {
    desc: 'Torpedo tubes, and the autoloader that feeds them from the magazine. A tube takes three minutes to cycle.',
    name: 'Torpedo launcher', short: 'TUBES', fixture: 'launcher', wear: 0.3, mtbf: 180,
    load: () => 1, stress: (c) => 1 + c.g * 0.1,
    effects: { degraded: 'Autoloader slow — reloads take twice as long', failed: 'Tubes offline — no torpedo launches' },
    faults: {
      minor: ['Autoloader cradle misaligned', 'Tube door actuator sticking'],
      major: ['Launch rail coil burned out', 'Magazine handling arm seized'],
    },
  },
};

export const SYSTEM_IDS = Object.keys(SYSTEMS);

/** Fixture kind → the system it houses (engine tiles → drive, helm → flight computer…). */
export const SYSTEM_BY_FIXTURE = Object.fromEntries(SYSTEM_IDS.map(id => [SYSTEMS[id].fixture, id]));

export const MAINTAIN_AT = 75;                 // integrity below which maintenance is scheduled
export const PARTS_FOR = { minor: 1, major: 3 };   // at TL2; scaled by TECH.parts
const MAINT_PARTS_PER_POINT = 0.02;            // 25 points of maintenance ≈ half a part
const SCRAP_PER_PART = 0.6;
export const FABRICATE_SCRAP = 1.5;            // scrap per refurbished part
export const FABRICATE_MINUTES = 240;
const METEOROID_DAYS = 150;                    // mean days between damaging strikes

/** Systems a class carries: everything, less the weapons it was built without. */
export function systemsFor(classId = PLAYER_CLASS) {
  const c = CLASSES[classId];
  return SYSTEM_IDS.filter(id => (id !== 'pdc' || c.pdc > 0) && (id !== 'launcher' || c.tubes > 0));
}

/** A fresh set of machinery, in the condition ships of this class are found in. */
export function createSystems(classId = PLAYER_CLASS) {
  const [lo, hi] = TECH[CLASSES[classId].tl].condition;
  const units = {};
  for (const id of systemsFor(classId)) {
    units[id] = { integrity: Math.round(lo + random() * (hi - lo)), status: Status.NOMINAL, fault: null, patchUntil: null, enabled: true };
  }
  return { units, wasBlackout: false };
}

export const unit = (state, id) => state.systems.units[id];

/** The systems this ship actually has (display order). */
export const shipSystems = (state) => SYSTEM_IDS.filter(id => state.systems.units[id]);

/** Tech level of our ship's machinery. */
const techOf = (state) => TECH[state.ship.tl || CLASSES[state.ship.classId || PLAYER_CLASS].tl];

/** Spare parts a repair of this severity takes on our ship. */
export const partsFor = (state, severity) => Math.ceil(PARTS_FOR[severity] * techOf(state).parts);

/** 1 = full, 0.5 = degraded/patched, 0 = failed, disabled or unpowered. */
export function systemPerf(state, id) {
  const u = state.systems.units[id];
  if (!u || !u.enabled) return 0;
  if (state.reactor.blackout) return 0;
  return u.status === Status.NOMINAL ? 1 : u.status === Status.FAILED ? 0 : 0.5;
}

const by = (perf, full, half, none) => perf >= 1 ? full : perf > 0 ? half : none;

// ---- EFFECTS (what each system's condition means for the ship) ----

/** Highest main-drive G available (drive and reactor cooling). */
export function driveLimitG(state) {
  const drive = by(systemPerf(state, 'drive'), Infinity, 3, 0);
  const cool = by(systemPerf(state, 'coolant'), Infinity, 3, 0.3);
  // A battered hull can't take hard burns: below half structure, 3G at most
  const hull = (state.hull?.integrity ?? 100) < HULL_SAFE_PCT ? 3 : Infinity;
  return Math.min(drive, cool, hull);
}
export const HULL_SAFE_PCT = 50;
export const driveFuelFactor = (state) => systemPerf(state, 'drive') === 0.5 ? 1.25 : 1;
export const slewFactor = (state) => by(systemPerf(state, 'rcs'), 1, 0.5, 0.2);
export const rcsAvailable = (state) => systemPerf(state, 'rcs') > 0;
export const sensorRangeFactor = (state) => by(systemPerf(state, 'sensors'), 1, 0.5, 0.15);
export const radioRangeFactor = (state) => by(systemPerf(state, 'comms'), 1, 0.5, 0);
export const waterRecovery = (state) => by(systemPerf(state, 'waterRecycler'), 0.95, 0.7, 0);
export const autodocRate = (state) => by(systemPerf(state, 'autodoc'), 1, 0.5, 0.15);
/** Reactor surplus power multiplier (a throttled reactor makes less). */
export const powerRegenFactor = (state) => by(systemPerf(state, 'coolant'), 1, 0.5, 0);

/** Flight computer: 'ok' | 'degraded' | 'failed'. */
export function flightComputerState(state) {
  const p = systemPerf(state, 'flightComputer');
  return p >= 1 ? 'ok' : p > 0 ? 'degraded' : 'failed';
}

// ---- FAULTS ----

function setFault(state, id, severity, cause, emit) {
  const u = state.systems.units[id];
  const def = SYSTEMS[id];
  if (u.status === Status.FAILED) return false;
  if (u.status !== Status.NOMINAL) severity = 'major';      // a second fault on a sick machine finishes it
  u.fault = { text: pick(def.faults[severity]), severity, at: state.clock.minute, cause };
  u.status = severity === 'major' ? Status.FAILED : Status.DEGRADED;
  u.patchUntil = null;
  emit('system-fault', { id, name: def.name, fault: u.fault, status: u.status, cause });
  return true;
}

/** External damage (meteoroid, overstress, combat). */
export function damageSystem(state, id, { severity = 'minor', loss = 0, cause = 'damage' } = {}, emit = () => {}) {
  const u = state.systems.units[id];
  if (!u) return false;
  u.integrity = Math.max(0, u.integrity - loss);
  return setFault(state, id, severity, cause, emit);
}

/**
 * One minute of wear and random faults.
 * ctx: { g, rcsG, turned, autopilot, breathers, engWatch, opsWatch, emit }
 */
export function systemsTick(state, ctx) {
  const emit = ctx.emit || (() => {});
  const now = state.clock.minute;
  const S = state.systems;
  const T = techOf(state);

  for (const id of SYSTEM_IDS) {
    const u = S.units[id];
    const def = SYSTEMS[id];
    if (!u || !u.enabled) continue;
    u.integrity = Math.max(0, u.integrity - def.wear * T.wear / 1440 * def.load(ctx));

    if (u.status === Status.PATCHED && now >= u.patchUntil) {
      u.status = Status.FAILED;
      u.patchUntil = null;
      u.fault.severity = 'major';
      emit('system-patch-failed', { id, name: def.name, fault: u.fault });
      continue;
    }
    if (u.status === Status.FAILED) continue;
    // Worn machines fault far more often; an engineer on watch catches
    // trouble early (fewer faults reach the point of breaking)
    const wornness = 1 - u.integrity / 100;
    const hazard = def.stress(ctx) * (0.4 + 3 * wornness * wornness) / (def.mtbf * T.mtbf * 1440) * (ctx.engWatch ? 0.6 : 1);
    if (random() < hazard) {
      const severity = random() < 0.25 + 0.5 * wornness ? 'major' : 'minor';
      u.integrity = Math.max(0, u.integrity - (severity === 'major' ? 12 : 5));
      setFault(state, id, severity, 'wear', emit);
    }
  }

  // Coming back from a blackout: the flight computer may not boot clean
  const blackout = !!state.reactor.blackout;
  if (S.wasBlackout && !blackout && random() < 0.5) setFault(state, 'flightComputer', 'minor', 'power loss', emit);
  S.wasBlackout = blackout;

  // Micrometeoroids: rare, random, and an ops watch can often dodge them
  if (random() < 1 / (METEOROID_DAYS * 1440)) meteoroidStrike(state, emit, ctx.opsWatch ? 0.5 : 0);
}

/** A grain of rock at tens of km/s. Returns what it hit (or null if dodged). */
export function meteoroidStrike(state, emit = () => {}, dodgeChance = 0) {
  if (random() < dodgeChance) { emit('meteoroid-dodged', {}); return null; }
  const decks = state.ship.decks;
  const deck = randInt(0, decks.length - 1);
  const breach = random() < 0.35 && !!decks[deck].atmosphere;
  if (breach) decks[deck].atmosphere.breached = true;
  let system = null;
  if (random() < 0.7) {
    system = weightedPick(shipSystems(state), (id) => id === 'drive' || id === 'coolant' || id === 'sensors' || id === 'comms' || id === 'rcs' ? 2 : 1);
    damageSystem(state, system, { severity: random() < 0.35 ? 'major' : 'minor', loss: randInt(10, 30), cause: 'meteoroid' }, emit);
  }
  emit('meteoroid-strike', { deck, deckName: decks[deck].name, breach, system, systemName: system && SYSTEMS[system].name });
  return { deck, breach, system };
}

// ---- WORK ----

const skillFactor = (skill) => Math.max(0.6, 1.6 - skill / 100);

/** Will a repair now be a proper fix (parts aboard) or a jury-rig? */
export function repairMode(state, id) {
  const u = state.systems.units[id];
  const need = partsFor(state, u.fault?.severity || 'major');
  return state.resources.parts.current >= need ? 'repair' : 'jury';
}

/** Minutes of hands-on work a job takes for this worker. */
export function workMinutes(state, type, id, skill, eff = 1) {
  const u = state.systems.units[id];
  let base;
  if (type === JobType.MAINTAIN) base = Math.max(20, (100 - u.integrity) * 3);
  else if (type === JobType.FABRICATE) base = FABRICATE_MINUTES;
  else {
    base = u.fault?.severity === 'major' ? 150 : 50;
    if (repairMode(state, id) === 'jury') base *= 0.6;
  }
  return Math.round(base * techOf(state).repairTime * skillFactor(skill) / Math.max(0.25, eff));
}

/** Finish a repair attempt. Returns { success, mode, message }. */
export function completeRepair(state, id, skill) {
  const u = state.systems.units[id];
  const def = SYSTEMS[id];
  if (u.status === Status.NOMINAL) return { success: true, mode: 'none', message: `${def.name} already working` };
  if (random() > Math.min(0.97, 0.55 + skill * 0.005)) return { success: false, mode: 'retry', message: `${def.name}: couldn't isolate the fault — trying again` };
  const res = state.resources;
  const need = partsFor(state, u.fault?.severity || 'major');
  if (res.parts.current >= need) {
    res.parts.current -= need;
    res.scrap.current = Math.min(res.scrap.max, res.scrap.current + need * SCRAP_PER_PART);
    const what = u.fault?.text || 'fault';
    u.status = Status.NOMINAL; u.fault = null; u.patchUntil = null;
    u.integrity = Math.min(100, u.integrity + 25);
    return { success: true, mode: 'repair', message: `${def.name} repaired (${what}) — ${need} part${need > 1 ? 's' : ''} used` };
  }
  if (u.status === Status.PATCHED) return { success: false, mode: 'no-parts', message: `${def.name}: no spare parts for a proper repair` };
  const [lo, hi] = techOf(state).patchHours;
  u.status = Status.PATCHED;
  u.patchUntil = state.clock.minute + randInt(lo * 60, hi * 60);
  return { success: true, mode: 'jury', message: `${def.name} jury-rigged — no spare parts. It won't hold for long.` };
}

/** Finish preventive maintenance. */
export function completeMaintenance(state, id) {
  const u = state.systems.units[id];
  const def = SYSTEMS[id];
  const parts = state.resources.parts;
  const cost = (100 - u.integrity) * MAINT_PARTS_PER_POINT * techOf(state).parts;
  if (parts.current >= cost) {
    parts.current -= cost;
    u.integrity = 100;
    return { success: true, message: `${def.name} serviced — back to spec` };
  }
  u.integrity = Math.min(100, u.integrity + (100 - u.integrity) * 0.5);
  return { success: true, message: `${def.name} serviced without spares — partly restored` };
}

/** Machine shop: refurbish scrap into one spare part. */
export function completeFabrication(state) {
  const res = state.resources;
  if (res.scrap.current < FABRICATE_SCRAP) return { success: false, message: 'Not enough scrap to work with' };
  res.scrap.current -= FABRICATE_SCRAP;
  res.parts.current = Math.min(res.parts.max, res.parts.current + 1);
  return { success: true, message: 'Machine shop: one spare part refurbished from scrap' };
}

/** Dockside overhaul: every system back to factory condition. */
export function overhaulSystems(state) {
  for (const u of Object.values(state.systems.units)) {
    u.integrity = 100; u.status = Status.NOMINAL; u.fault = null; u.patchUntil = null; u.enabled = true;
  }
}

/** Captain's order: service this system now (maintenance at high priority). */
export function orderService(state, id) {
  const u = state.systems.units[id];
  if (u.status !== Status.NOMINAL) return prioritizeRepair(state, id);
  if (u.integrity >= 99) return { ok: false, text: `${SYSTEMS[id].name} is in good order` };
  let job = state.jobs.list.find(j => j.type === JobType.MAINTAIN && j.data.system === id);
  if (!job) job = addJob(state, JobType.MAINTAIN, JOB_PRIORITY.HIGH, { system: id });
  else if (job.status === 'open') setJobPriority(state, job, JOB_PRIORITY.HIGH);
  return { ok: true, text: `Servicing ordered: ${SYSTEMS[id].name}` };
}

/** Captain's order: drop everything and fix this. */
export function prioritizeRepair(state, id) {
  const job = state.jobs.list.find(j => j.type === JobType.REPAIR && j.data.system === id);
  if (!job) return { ok: false, text: `${SYSTEMS[id].name}: nothing to repair` };
  job.data.urgent = true;
  if (job.status === 'open') setJobPriority(state, job, JOB_PRIORITY.CRITICAL);
  return { ok: true, text: `Repair prioritized: ${SYSTEMS[id].name}` };
}

/** Player switch (life support can be shut off deliberately). */
export function toggleSystem(state, id) {
  const u = state.systems.units[id];
  if (!u) return null;
  u.enabled = !u.enabled;
  return u.enabled;
}

// ---- JOBS ----

const ESSENTIAL = new Set(['lifeSupport', 'coolant']);
const FLIGHT = new Set(['flightComputer', 'drive', 'rcs']);

function repairPriority(state, id, u) {
  if (u.status === Status.FAILED) return ESSENTIAL.has(id) || (FLIGHT.has(id) && state.autopilot) ? JOB_PRIORITY.CRITICAL : JOB_PRIORITY.HIGH;
  if (u.status === Status.DEGRADED) return JOB_PRIORITY.HIGH;
  return JOB_PRIORITY.NORMAL;                                  // patched: proper fix once parts are aboard
}

/** Keep the job board in step with the machinery. */
export function systemsJobs(state) {
  const jobs = state.jobs.list;
  const parts = state.resources.parts.current;
  for (const id of shipSystems(state)) {
    const u = state.systems.units[id];
    const repair = jobs.find(j => j.type === JobType.REPAIR && j.data.system === id);
    const maint = jobs.find(j => j.type === JobType.MAINTAIN && j.data.system === id);
    const needsRepair = u.status === Status.DEGRADED || u.status === Status.FAILED ||
      (u.status === Status.PATCHED && parts >= partsFor(state, u.fault?.severity || 'major'));
    if (needsRepair) {
      const pr = repair?.data.urgent ? JOB_PRIORITY.CRITICAL : repairPriority(state, id, u);
      if (!repair) addJob(state, JobType.REPAIR, pr, { system: id });
      else if (repair.status === 'open') setJobPriority(state, repair, pr);
    } else if (repair && repair.status === 'open') closeJob(state, repair);

    const needsMaint = u.status === Status.NOMINAL && u.enabled && u.integrity < MAINTAIN_AT;
    if (needsMaint && !maint) addJob(state, JobType.MAINTAIN, JOB_PRIORITY.NORMAL, { system: id });
    else if (maint && maint.status === 'open' && u.status !== Status.NOMINAL) closeJob(state, maint);
  }
  const res = state.resources;
  const fab = jobs.find(j => j.type === JobType.FABRICATE);
  const canFab = res.scrap.current >= FABRICATE_SCRAP && res.parts.current <= res.parts.max - 1;
  if (canFab && !fab) addJob(state, JobType.FABRICATE, JOB_PRIORITY.NORMAL, {});
  else if (!canFab && fab && fab.status === 'open') closeJob(state, fab);
}

/** Label for UI lists. */
export function statusLabel(u) {
  if (!u.enabled) return 'OFF';
  switch (u.status) {
    case Status.NOMINAL: return u.integrity < MAINTAIN_AT ? 'SERVICE DUE' : 'NOMINAL';
    case Status.DEGRADED: return 'DEGRADED';
    case Status.PATCHED: return 'JURY-RIGGED';
    case Status.FAILED: return 'FAILED';
    default: return u.status.toUpperCase();
  }
}
