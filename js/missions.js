// ============================================================
// LONGHAUL — Mission System
// SOS events, random encounters, intercept routes, rewards
// Designed to scale: missions reference entity IDs, no N² scans
// ============================================================

import { createEntity, EntityType, EntityState, entityDistanceAU, relativeSpeed, bearingTo, computeOrbitalVelocity } from './entities.js';
// Scanner ranges imported if needed for spawn distance calibration
// import { SCANNER_RANGES } from './scanner.js';

// ---- CONSTANTS ----

const AU_M = 149_597_870_700;
const G_ACCEL = 9.81;

export const MissionType = {
  SOS_FUEL_DRY:       'SOS_FUEL_DRY',
  SOS_ENGINE_FAILURE: 'SOS_ENGINE_FAILURE',
  SOS_RUNAWAY_ENGINE: 'SOS_RUNAWAY_ENGINE',
  SOS_REACTOR_SCRAM:  'SOS_REACTOR_SCRAM',
};

export const MissionStatus = {
  OFFERED:     'offered',
  ACCEPTED:    'accepted',
  IN_PROGRESS: 'in_progress',
  COMPLETED:   'completed',
  FAILED:      'failed',
  DECLINED:    'declined',
};

// Intercept route thresholds
const FORMATION_RANGE_AU = 0.0000035;        // ~500m
const FORMATION_REL_VEL = 20;                // m/s — close enough to match

// Intercept type enum and target distances
export const INTERCEPT_TYPE = {
  SCANNER:  'scanner',   // ~15M km — enter sensor detection range
  CLOSE:    'close',     // ~100k km — close approach, full sensor lock
  TACTICAL: 'tactical',  // ~5km — boarding, tow, combat, EVA
};

export const INTERCEPT_RANGE_AU = {
  [INTERCEPT_TYPE.SCANNER]:  0.1002,    // 15M km (≈ LONG scanner range)
  [INTERCEPT_TYPE.CLOSE]:    6.685e-4,  // 100k km
  [INTERCEPT_TYPE.TACTICAL]: 3.34e-8,   // 5 km
};
const EVENT_COOLDOWN_MIN = 720;              // 12 game-hours between events
const EVENT_PROBABILITY = 0.0007;            // ~0.07% per min ≈ ~34% per game-hour
const MAX_ACTIVE_MISSIONS = 3;
const MISSION_HISTORY_CAP = 30;

// Urgency timers by type (in minutes)
// At 1G brachistochrone, 0.005 AU ≈ 290 min, 0.02 AU ≈ 580 min
// Timers must exceed typical transfer time to be completable
const URGENCY_TIMERS = {
  [MissionType.SOS_FUEL_DRY]:       2160, // 36 hours — O2 slowly depleting, longest survival
  [MissionType.SOS_ENGINE_FAILURE]:  1440, // 24 hours — they have power and reserves
  [MissionType.SOS_RUNAWAY_ENGINE]:  480,  // 8 hours — G-forces, but crew may survive longer than expected
  [MissionType.SOS_REACTOR_SCRAM]:   720,  // 12 hours — EVA suit O2, freezing
};

// Rewards by type
const REWARDS = {
  [MissionType.SOS_FUEL_DRY]:       { water: 200, food: 100 },
  [MissionType.SOS_ENGINE_FAILURE]:  { fuel: 500 },
  [MissionType.SOS_RUNAWAY_ENGINE]:  { fuel: 200, medSupplies: 10 },
  [MissionType.SOS_REACTOR_SCRAM]:   { medSupplies: 15, oxygen: 50 },
};

// ---- SHIP TEMPLATES ----

const SHIP_TEMPLATES = [
  { className: 'Belter ice hauler',  massRange: [40000, 80000],   factions: ['Belter', 'OPA'],           prefixes: ['Ice', 'Frost', 'Cryo', 'Cold'],       suffixes: ['Hauler', 'Runner', 'Mule', 'Ox', 'Dray'] },
  { className: 'Indie freighter',    massRange: [50000, 120000],  factions: ['independent', 'Belter'],   prefixes: ['Star', 'Deep', 'Far', 'Void'],         suffixes: ['Venture', 'Prospect', 'Horizon', 'Trader'] },
  { className: 'Prospector skiff',   massRange: [8000, 25000],    factions: ['Belter', 'independent'],   prefixes: ['Lucky', 'Iron', 'Red', 'Dust'],        suffixes: ['Strike', 'Vein', 'Claim', 'Pick', 'Digger'] },
  { className: 'Passenger liner',    massRange: [150000, 300000], factions: ['UNN', 'independent'],      prefixes: ['Tycho', 'Ceres', 'Eros', 'Luna'],      suffixes: ['Star', 'Express', 'Transit', 'Grace'] },
  { className: 'Cargo shuttle',      massRange: [15000, 40000],   factions: ['independent', 'OPA', 'Belter'], prefixes: ['Box', 'Load', 'Haul', 'Bulk'],    suffixes: ['Runner', 'Lifter', 'Cart', 'Sled'] },
  { className: 'Mining barge',       massRange: [80000, 200000],  factions: ['Belter', 'OPA'],           prefixes: ['Rock', 'Ore', 'Gravel', 'Stone'],      suffixes: ['Breaker', 'Crusher', 'Chewer', 'Grinder'] },
  { className: 'Courier',            massRange: [5000, 15000],    factions: ['MCRN', 'UNN', 'independent'], prefixes: ['Swift', 'Flash', 'Quick', 'Razor'], suffixes: ['Arrow', 'Dart', 'Wing', 'Bolt'] },
  { className: 'Tanker',             massRange: [100000, 250000], factions: ['independent', 'Belter'],   prefixes: ['Full', 'Heavy', 'Wet', 'Deep'],        suffixes: ['Tank', 'Belly', 'Drum', 'Well'] },
];

function randItem(arr) { return arr[(Math.random() * arr.length) | 0]; }
function randRange(min, max) { return min + Math.random() * (max - min); }

function generateShipName(template) {
  return `${randItem(template.prefixes)} ${randItem(template.suffixes)}`;
}

// ---- MODULE STATE ----

let missions = [];
let eventCooldown = 0;
let interceptState = null;  // { targetEntityId, formation: bool, routeActive: bool }
let nextMissionId = 1;

// ---- INITIALIZATION ----

export function initMissions(gameState) {
  missions = [];
  eventCooldown = 180; // 3-hour grace period at game start
  interceptState = null;
  nextMissionId = 1;
}

// ---- MISSION CRUD ----

function createMission(opts) {
  return {
    id: `mission-${nextMissionId++}`,
    type: opts.type,
    title: opts.title,
    description: opts.description,
    targetEntityId: opts.targetEntityId,
    urgencyTimerMax: opts.urgencyTimer,
    urgencyTimerMin: opts.urgencyTimer,
    rewards: opts.rewards || {},
    status: MissionStatus.OFFERED,
    offeredAt: opts.gameMinute || 0,
    acceptedAt: null,
    completedAt: null,
  };
}

export function acceptMission(missionId) {
  const m = missions.find(m => m.id === missionId);
  if (!m || m.status !== MissionStatus.OFFERED) return false;
  m.status = MissionStatus.ACCEPTED;
  m.acceptedAt = Date.now();
  return true;
}

export function declineMission(missionId) {
  const m = missions.find(m => m.id === missionId);
  if (!m || m.status !== MissionStatus.OFFERED) return false;
  m.status = MissionStatus.DECLINED;
  return true;
}

function failMission(mission) {
  mission.status = MissionStatus.FAILED;
  // Clear intercept if this was the target
  if (interceptState && interceptState.missionId === mission.id) {
    interceptState = null;
  }
}

function completeMission(mission, gameState) {
  mission.status = MissionStatus.COMPLETED;
  mission.completedAt = Date.now();

  // Apply rewards
  const res = gameState.resources;
  for (const [key, amount] of Object.entries(mission.rewards)) {
    if (res[key]) {
      res[key].current = Math.min(res[key].max, res[key].current + amount);
    }
  }

  // Stop SOS on the entity
  const entity = (gameState.entities || []).find(e => e.id === mission.targetEntityId);
  if (entity) {
    entity.sosActive = false;
    entity.thrustActive = false;
    entity.thrustG = 0;
    entity.state = EntityState.DRIFTING;
  }
}

export function getMission(missionId) {
  return missions.find(m => m.id === missionId) || null;
}

export function getActiveMissions() {
  return missions.filter(m =>
    m.status === MissionStatus.OFFERED ||
    m.status === MissionStatus.ACCEPTED ||
    m.status === MissionStatus.IN_PROGRESS
  );
}

export function getMissionLog() {
  return missions;
}

export function getMissionForEntity(entityId) {
  return missions.find(m => m.targetEntityId === entityId &&
    (m.status === MissionStatus.ACCEPTED || m.status === MissionStatus.IN_PROGRESS)
  ) || null;
}

export function getInterceptState() {
  return interceptState;
}

// ---- EVENT NARRATIVES ----

const EVENT_NARRATIVES = {
  [MissionType.SOS_FUEL_DRY]: [
    'A distress beacon cuts through the static. A {className}, the {name}, is broadcasting mayday — fuel tanks dry, drifting on residual vector. {crew} souls aboard, CO2 scrubbers running on battery reserve.',
    'Emergency beacon detected. The {name}, a {className} registered to {faction}, reports fuel exhaustion during transit. Ship is cold-drifting, life support running on emergency power.',
  ],
  [MissionType.SOS_ENGINE_FAILURE]: [
    'Mayday intercept: the {name}, a {className}, reports catastrophic engine failure. Drive assembly seized mid-burn. Fuel reserves intact but they have no way to maneuver. {crew} crew requesting immediate assistance.',
    'Distress call from the {className} {name}: main drive offline, cause unknown. Ship is drifting unpowered. They have fuel but no thrust. Requesting tow or repair assistance.',
  ],
  [MissionType.SOS_RUNAWAY_ENGINE]: [
    'PRIORITY ALERT — The {name}, a {className}, is broadcasting emergency on all frequencies. Drive throttle control failure — engine at full burn, unable to shut down. Crew under {thrustG}G sustained acceleration. Without intervention, G-forces will be lethal.',
    'Critical distress: {className} {name} reporting stuck throttle. Epstein drive running uncontrolled at {thrustG}G. Crew losing consciousness. Ship accelerating on uncontrolled vector.',
  ],
  [MissionType.SOS_REACTOR_SCRAM]: [
    'Emergency beacon from the {name}, a {className}: reactor scram triggered, total power loss. Ship is dark — no heat, no recyclers, no comms beyond emergency beacon. {crew} crew in EVA suits, estimated {hours} hours of suit O2 remaining.',
    'The {name} has gone dark. Automated distress beacon indicates reactor containment failure on this {className}. All power systems offline. Crew survival depends on EVA suit reserves.',
  ],
};

const ACCEPT_TEXT = {
  [MissionType.SOS_FUEL_DRY]:       'Plot rescue intercept',
  [MissionType.SOS_ENGINE_FAILURE]:  'Plot rescue intercept',
  [MissionType.SOS_RUNAWAY_ENGINE]:  'Emergency intercept — NOW',
  [MissionType.SOS_REACTOR_SCRAM]:   'Plot rescue course',
};

const DECLINE_TEXT = {
  [MissionType.SOS_FUEL_DRY]:       'Log position and continue',
  [MissionType.SOS_ENGINE_FAILURE]:  'Log position and continue',
  [MissionType.SOS_RUNAWAY_ENGINE]:  'Cannot assist — log and continue',
  [MissionType.SOS_REACTOR_SCRAM]:   'Log position and continue',
};

const RESCUE_NARRATIVES = {
  [MissionType.SOS_FUEL_DRY]:
    'You extend the fuel transfer umbilical and pump enough reaction mass to get them moving again. The captain comes on comms, voice shaking with relief. They transfer what supplies they can spare as thanks.',
  [MissionType.SOS_ENGINE_FAILURE]:
    'Your engineer talks their crew through a field bypass of the damaged drive assembly. After twenty tense minutes, their engine coughs back to life at reduced thrust. They insist on transferring fuel as payment.',
  [MissionType.SOS_RUNAWAY_ENGINE]:
    'Matching their acceleration is brutal on your crew. You maneuver alongside and your engineer remotely patches into their fuel management system, cutting flow to the drive. The sudden silence when their engine dies is deafening. The crew is battered but alive.',
  [MissionType.SOS_REACTOR_SCRAM]:
    'You crack their emergency airlock and find the crew huddled in the machine shop, breath fogging in EVA helmets. Your medic gets to work immediately while the engineer begins patching their reactor containment.',
};

// ---- COMMS CHATTER ----

const SOS_CHATTER = {
  [MissionType.SOS_FUEL_DRY]: {
    normal:   ['{name} to any ship... fuel dry, requesting assistance. We can hold for now.', 'This is {name}, broadcasting mayday on all channels. Fuel exhausted. Drifting.'],
    urgent:   ['{name} here... CO2 is building up. Scrubbers running at half capacity. Please hurry.', 'Getting hard to breathe on the {name}. Anyone out there?'],
    critical: ['{name} to any... ship... atmosphere is... getting bad...', 'Mayday mayday... {name}... crew losing consciousness...'],
  },
  [MissionType.SOS_ENGINE_FAILURE]: {
    normal:   ['{name}, engine down. We have power and life support. Standing by for assistance.', 'This is the {name}. Main drive inoperable. All other systems nominal. Requesting tow.'],
    urgent:   ['{name} here. Still drifting. Our trajectory takes us away from shipping lanes...', 'Getting lonely out here. {name} requesting anyone in range.'],
    critical: ['{name}... if anyone can hear this... we are far off the lanes now. Supplies running low.', '{name} broadcasting... hope fading...'],
  },
  [MissionType.SOS_RUNAWAY_ENGINE]: {
    normal:   ['MAYDAY — {name} — throttle stuck! We cannot shut down the drive!', '{name} emergency — engine running at {thrustG}G, controls unresponsive!'],
    urgent:   ['{name}... crew is... passing out... G-load is... too much...', 'Can barely... reach comms panel... {name} needs help NOW...'],
    critical: ['{name}... {thrustG}G sustained... structural warnings... hull...', '... ... {name} ... anyone ...'],
  },
  [MissionType.SOS_REACTOR_SCRAM]: {
    normal:   ['{name} emergency beacon — reactor scram, total blackout. On suit O2.', 'This is {name}, we are dark. Repeat, total power loss. {crew} crew in suits.'],
    urgent:   ['{name}... suit O2 at fifty percent. Temperature dropping. Please respond.', 'Getting cold in here. {name} to any ship. We need help.'],
    critical: ['{name}... suit O2 critical... fingers... can barely move...', '... {name} ... cold ... please ...'],
  },
};

function getChatterMessage(mission, entities) {
  const fraction = mission.urgencyTimerMin / mission.urgencyTimerMax;
  const tier = fraction > 0.5 ? 'normal' : fraction > 0.2 ? 'urgent' : 'critical';
  const templates = SOS_CHATTER[mission.type]?.[tier];
  if (!templates || templates.length === 0) return null;

  const entity = entities.find(e => e.id === mission.targetEntityId);
  const template = randItem(templates);
  return template
    .replace(/\{name\}/g, entity?.name || 'Unknown')
    .replace(/\{thrustG\}/g, entity?.thrustG?.toFixed(1) || '?')
    .replace(/\{crew\}/g, String(Math.floor(Math.random() * 8) + 2));
}

// ---- RANDOM EVENT SPAWNING ----

export function checkRandomEvents(gameState, days) {
  if (eventCooldown > 0) return null;

  const active = getActiveMissions();
  if (active.length >= MAX_ACTIVE_MISSIONS) return null;

  if (Math.random() > EVENT_PROBABILITY) return null;

  // Pick event type (weighted)
  const types = [
    { type: MissionType.SOS_FUEL_DRY, weight: 4 },
    { type: MissionType.SOS_ENGINE_FAILURE, weight: 3 },
    { type: MissionType.SOS_RUNAWAY_ENGINE, weight: 1 },
    { type: MissionType.SOS_REACTOR_SCRAM, weight: 2 },
  ];
  const totalWeight = types.reduce((s, t) => s + t.weight, 0);
  let roll = Math.random() * totalWeight;
  let eventType = types[0].type;
  for (const t of types) {
    roll -= t.weight;
    if (roll <= 0) { eventType = t.type; break; }
  }

  // Pick ship template
  const template = randItem(SHIP_TEMPLATES);
  const shipName = generateShipName(template);
  const faction = randItem(template.factions);
  const mass = Math.round(randRange(template.massRange[0], template.massRange[1]));

  // Spawn position: random bearing, distance within long scanner range
  const shipPos = gameState.shipPosition;
  const bearing = Math.random() * Math.PI * 2;
  const spawnDist = randRange(0.004, 0.025); // ~600k-3.7M km — reachable at 1G within timer
  const spawnX = shipPos.x + Math.cos(bearing) * spawnDist;
  const spawnY = shipPos.y + Math.sin(bearing) * spawnDist;

  // Compute orbital velocity at spawn position + perturbation
  const r_m = Math.sqrt(spawnX * spawnX + spawnY * spawnY) * AU_M;
  const orbSpeed = Math.sqrt(1.327124e20 / r_m);
  const orbAngle = Math.atan2(spawnY, spawnX) + Math.PI / 2; // tangent
  let vx = orbSpeed * Math.cos(orbAngle);
  let vy = orbSpeed * Math.sin(orbAngle);

  // Add velocity perturbation (they were doing something before the emergency)
  const perturbAngle = Math.random() * Math.PI * 2;
  const perturbMag = randRange(50, 300); // 50-300 m/s perturbation
  vx += perturbMag * Math.cos(perturbAngle);
  vy += perturbMag * Math.sin(perturbAngle);

  // Create entity
  const isRunaway = eventType === MissionType.SOS_RUNAWAY_ENGINE;
  const thrustG = isRunaway ? randRange(2, 6) : 0;
  const entityId = `sos-${nextMissionId}`;

  const entity = createEntity({
    id: entityId,
    name: shipName,
    type: EntityType.SHIP,
    state: isRunaway ? EntityState.TRANSFERRING : EntityState.DRIFTING,
    position: { x: spawnX, y: spawnY },
    velocity: { vx, vy },
    faction,
    shipClass: template.className,
    mass,
    sosActive: true,
    thrustActive: isRunaway,
    thrustG: Math.round(thrustG * 10) / 10,
    heading: isRunaway ? Math.random() * Math.PI * 2 : 0,
    transponderActive: true,
  });

  gameState.entities.push(entity);

  // Build narrative
  const crewCount = Math.floor(Math.random() * 12) + 2;
  const hours = Math.floor(URGENCY_TIMERS[eventType] / 60);
  const narrativeTemplates = EVENT_NARRATIVES[eventType];
  const narrative = randItem(narrativeTemplates)
    .replace(/\{name\}/g, shipName)
    .replace(/\{className\}/g, template.className)
    .replace(/\{faction\}/g, faction)
    .replace(/\{crew\}/g, String(crewCount))
    .replace(/\{thrustG\}/g, thrustG.toFixed(1))
    .replace(/\{hours\}/g, String(hours));

  // Create mission
  const mission = createMission({
    type: eventType,
    title: `SOS — ${shipName}`,
    description: narrative,
    targetEntityId: entityId,
    urgencyTimer: URGENCY_TIMERS[eventType],
    rewards: { ...REWARDS[eventType] },
    gameMinute: (gameState.time.hour * 60 + gameState.time.minute),
  });

  missions.push(mission);
  eventCooldown = EVENT_COOLDOWN_MIN;

  // Return event descriptor for UI
  return {
    type: eventType,
    missionId: mission.id,
    entityName: shipName,
    shipClass: template.className,
    faction,
    distance: formatDistKm(spawnDist),
    narrative,
    acceptText: ACCEPT_TEXT[eventType],
    declineText: DECLINE_TEXT[eventType],
    urgencyLabel: `${hours}h estimated survival`,
  };
}

// ---- INTERCEPT ----

export function startIntercept(gameState, targetEntityId, missionId, interceptType = INTERCEPT_TYPE.SCANNER) {
  // Mark mission in progress
  const mission = missionId ? missions.find(m => m.id === missionId) : null;
  if (mission && (mission.status === MissionStatus.ACCEPTED || mission.status === MissionStatus.OFFERED)) {
    mission.status = MissionStatus.IN_PROGRESS;
  }

  interceptState = {
    targetEntityId,
    missionId: missionId || null,
    formation: false,
    interceptType,
    targetRangeAU: INTERCEPT_RANGE_AU[interceptType] ?? INTERCEPT_RANGE_AU[INTERCEPT_TYPE.SCANNER],
    rangeReached: false,
  };

  return interceptState;
}

export function cancelIntercept() {
  interceptState = null;
}

/**
 * Compute an intercept route to a scanner contact.
 * Returns a route object compatible with the navigation system.
 *
 * @param {object} gameState
 * @param {string} targetEntityId
 * @param {object} opts - { targetRangeAU: number } — stop at this distance from target instead of exact position
 */
export function computeInterceptRoute(gameState, targetEntityId, opts = {}) {
  const entity = (gameState.entities || []).find(e => e.id === targetEntityId);
  if (!entity) return null;

  const targetRangeAU = opts.targetRangeAU ?? 0;
  const shipPos = gameState.shipPosition;
  const shipVel = gameState.physics.velocity;
  // Runaway targets are accelerating — need to exceed their thrust to catch them
  // Standard rescues use 1G, runaways need target's G + margin (capped at 5G for crew)
  const targetG = (entity.thrustActive && entity.thrustG > 0) ? entity.thrustG : 0;
  const maxG = targetG > 0 ? Math.min(targetG + 1.0, 5.0) : 1.0;

  // If ship is already within target range, no route needed
  const dist0 = entityDistanceAU(shipPos, entity.position);
  if (targetRangeAU > 0 && dist0 <= targetRangeAU) return null;

  // ---- VELOCITY MISALIGNMENT CHECK ----
  // Ship may have significant velocity from a prior route that's not aligned
  // with the new intercept heading. Need to kill it first or the brachistochrone
  // flip/burn timings will be completely wrong.
  const relVx = shipVel.vx - entity.velocity.vx;
  const relVy = shipVel.vy - entity.velocity.vy;
  const relSpeed = Math.sqrt(relVx * relVx + relVy * relVy);

  // Predict target position at estimated arrival time (iterative)
  const effectiveDist0 = Math.max(dist0 - targetRangeAU, dist0 * 0.01) * AU_M;
  let estTimeSec = 2 * Math.sqrt(effectiveDist0 / (maxG * G_ACCEL));

  let targetPos = { x: entity.position.x, y: entity.position.y };
  for (let i = 0; i < 3; i++) {
    const dt = estTimeSec;
    targetPos = {
      x: entity.position.x + entity.velocity.vx * dt / AU_M,
      y: entity.position.y + entity.velocity.vy * dt / AU_M,
    };
    if (entity.thrustActive && entity.thrustG > 0) {
      const aMs2 = entity.thrustG * G_ACCEL;
      targetPos.x += 0.5 * aMs2 * Math.cos(entity.heading) * dt * dt / AU_M;
      targetPos.y += 0.5 * aMs2 * Math.sin(entity.heading) * dt * dt / AU_M;
    }
    const newDist = Math.max(entityDistanceAU(shipPos, targetPos) - targetRangeAU, dist0 * 0.01) * AU_M;
    estTimeSec = 2 * Math.sqrt(newDist / (maxG * G_ACCEL));
  }

  const headingAngle = Math.atan2(targetPos.y - shipPos.y, targetPos.x - shipPos.x);

  // Project relative velocity onto intercept heading
  const closingSpeed = relVx * Math.cos(headingAngle) + relVy * Math.sin(headingAngle);
  // cosAngle: 1 = perfectly aligned toward target, -1 = flying directly away
  const cosAngle = relSpeed > 1 ? closingSpeed / relSpeed : 1;

  // Determine if a velocity kill burn is needed before approach
  // Threshold: > 500 m/s relative AND velocity is more than 60° off from target heading
  const needsVelocityKill = relSpeed > 500 && cosAngle < 0.5;

  let brakingPhases = [];
  let brakeDeltaV = 0;
  let postBrakeDist_m = Math.max(entityDistanceAU(shipPos, targetPos) - targetRangeAU, dist0 * 0.01) * AU_M;

  if (needsVelocityKill) {
    // Kill ALL relative velocity with a single braking burn, then start fresh
    // Thrust direction = opposite to relative velocity vector
    const velAngle = Math.atan2(relVy, relVx);
    const brakeDir = velAngle + Math.PI; // opposite to current relative velocity

    const brakeTimeSec = relSpeed / (maxG * G_ACCEL);
    const brakeTimeMin = Math.max(1, Math.ceil(brakeTimeSec / 60));
    brakeDeltaV = relSpeed;

    // Distance traveled during braking: ship moves at average relSpeed/2 along
    // velocity direction for brakeTimeSec. If diverging, distance to target grows.
    const brakeDist_m = (relSpeed * brakeTimeSec) / 2;
    if (closingSpeed < 0) {
      // Diverging: distance increases during braking
      postBrakeDist_m += brakeDist_m * Math.abs(closingSpeed) / relSpeed;
    } else {
      // Partially closing: some component helps, but cross-track drifts
      postBrakeDist_m += brakeDist_m * 0.2; // rough correction
    }

    brakingPhases = [
      { type: 'orient', durationMin: 2, description: 'Orient retrograde — velocity kill' },
      { type: 'secure', durationMin: 3, description: 'Secure for braking maneuver' },
      { type: 'burn', durationMin: brakeTimeMin, thrustG: maxG, deltaV: relSpeed,
        thrustDirection: brakeDir,
        description: `Velocity kill at ${maxG.toFixed(1)}G` },
    ];
  }

  // ---- APPROACH BRACHISTOCHRONE ----
  // Computed from post-brake state (or current state if no braking needed)
  const approachDist_m = postBrakeDist_m;
  const approachTimeSec = 2 * Math.sqrt(approachDist_m / (maxG * G_ACCEL));
  const approachTimeMin = Math.ceil(approachTimeSec / 60);
  const approachBurnMin = Math.ceil(approachTimeMin * 0.45);
  const approachDv = 2 * Math.sqrt(approachDist_m * maxG * G_ACCEL);

  const approachPhases = [
    { type: 'orient', durationMin: 2, description: 'Orienting for intercept burn' },
    { type: 'secure', durationMin: 3, description: 'Secure for high-G maneuver' },
    { type: 'burn', durationMin: approachBurnMin, thrustG: maxG, deltaV: approachDv / 2,
      description: `Intercept burn at ${maxG.toFixed(1)}G` },
    { type: 'flip', durationMin: 6, description: 'Flip maneuver' },
    { type: 'burn', durationMin: approachBurnMin, thrustG: maxG, deltaV: approachDv / 2,
      description: `Deceleration burn at ${maxG.toFixed(1)}G` },
    { type: 'match', durationMin: 5, description: 'Matching target velocity' },
    { type: 'arrive', durationMin: 1, description: 'Intercept range achieved' },
  ];

  const phases = [...brakingPhases, ...approachPhases];
  const dv = approachDv + brakeDeltaV;

  return {
    type: 'intercept',
    destinationName: entity.name,
    destinationType: 'entity',
    targetEntityId,
    headingAngle,
    totalTimeMin: phases.reduce((s, p) => s + p.durationMin, 0),
    deltaV: dv,
    accelG: maxG,
    maxG,
    phases,
    needsContinuousCorrection: entity.thrustActive,
    targetRangeAU,
    startPosition: { ...shipPos },
  };
}

/**
 * Compute a short-range fine-tune approach route.
 * Used by the approach slider to close remaining distance at low G.
 *
 * @param {object} gameState
 * @param {string} targetEntityId
 * @param {number} targetDistAU — desired stopping distance from target
 */
export function computeFineTuneRoute(gameState, targetEntityId, targetDistAU) {
  const entity = (gameState.entities || []).find(e => e.id === targetEntityId);
  if (!entity) return null;

  const shipPos = gameState.shipPosition;
  const currentDist = entityDistanceAU(shipPos, entity.position);
  const closeDist = currentDist - targetDistAU;
  if (closeDist <= 0) return null; // already at or past target

  const closeDist_m = closeDist * AU_M;
  const currentDistKm = currentDist * (AU_M / 1000);

  // G scales with range: 0.3G close-in, 1G at scanner edge
  const burnG = Math.min(1.0, Math.max(0.3, 0.3 + 0.7 * (currentDistKm / 15e6)));

  const tBurn = Math.sqrt(closeDist_m / (burnG * G_ACCEL));
  const burnMin = Math.max(1, Math.ceil(tBurn / 60));
  const dv = 2 * Math.sqrt(closeDist_m * burnG * G_ACCEL);
  const headingAngle = bearingTo(shipPos, entity.position);

  const phases = [
    { type: 'orient', durationMin: 2, description: 'Orienting for fine approach' },
    { type: 'burn', durationMin: burnMin, thrustG: burnG, deltaV: dv / 2, description: `Approach at ${burnG.toFixed(1)}G` },
    { type: 'flip', durationMin: 1, description: 'Deceleration flip' },
    { type: 'burn', durationMin: burnMin, thrustG: burnG, deltaV: dv / 2, description: `Brake at ${burnG.toFixed(1)}G` },
    { type: 'arrive', durationMin: 1, description: 'Approach complete' },
  ];

  return {
    type: 'intercept',
    destinationName: entity.name,
    destinationType: 'entity',
    targetEntityId,
    headingAngle,
    totalTimeMin: phases.reduce((s, p) => s + p.durationMin, 0),
    deltaV: dv,
    accelG: burnG,
    maxG: burnG,
    phases,
    targetRangeAU: targetDistAU,
    isTuneBurn: true,
    startPosition: { ...shipPos },
  };
}

// ---- PER-TICK ----

export function missionTick(gameState, days) {
  const events = [];
  const entities = gameState.entities || [];

  // Decrement cooldown
  if (eventCooldown > 0) eventCooldown--;

  // Process active missions
  for (const mission of missions) {
    if (mission.status !== MissionStatus.ACCEPTED && mission.status !== MissionStatus.IN_PROGRESS) continue;

    // Decrement urgency
    mission.urgencyTimerMin--;

    // Check failure
    if (mission.urgencyTimerMin <= 0) {
      failMission(mission);
      events.push({ type: 'mission-failed', missionId: mission.id, title: mission.title });
      continue;
    }

    // Chatter at intervals (every ~30 minutes, randomized)
    if (mission.urgencyTimerMin % 30 === 0 || (mission.urgencyTimerMin < 60 && mission.urgencyTimerMin % 10 === 0)) {
      const msg = getChatterMessage(mission, entities);
      if (msg) {
        events.push({
          type: 'chatter',
          missionId: mission.id,
          from: entities.find(e => e.id === mission.targetEntityId)?.name || 'Unknown',
          text: msg,
        });
      }
    }
  }

  // Check for new random events
  const event = checkRandomEvents(gameState, days);
  if (event) {
    events.push({ ...event, type: 'event-spawned', eventType: event.type });
  }

  // Prune old declined/completed/failed missions beyond cap
  if (missions.length > MISSION_HISTORY_CAP + MAX_ACTIVE_MISSIONS) {
    const inactive = missions.filter(m =>
      m.status === MissionStatus.DECLINED ||
      m.status === MissionStatus.COMPLETED ||
      m.status === MissionStatus.FAILED
    );
    if (inactive.length > MISSION_HISTORY_CAP) {
      const toRemove = new Set(inactive.slice(0, inactive.length - MISSION_HISTORY_CAP).map(m => m.id));
      missions = missions.filter(m => !toRemove.has(m.id));
    }
  }

  return events;
}

export function interceptTick(gameState) {
  if (!interceptState) return [];
  const events = [];
  const entity = (gameState.entities || []).find(e => e.id === interceptState.targetEntityId);

  if (!entity) {
    interceptState = null;
    return [{ type: 'intercept-lost', message: 'Target lost' }];
  }

  const shipPos = gameState.shipPosition;
  const shipVel = gameState.physics.velocity;
  const dist = entityDistanceAU(shipPos, entity.position);
  const relVel = relativeSpeed(shipVel, entity.velocity);

  // Check formation condition
  if (dist <= FORMATION_RANGE_AU && relVel <= FORMATION_REL_VEL) {
    if (!interceptState.formation) {
      interceptState.formation = true;
      events.push({ type: 'formation-entered', targetName: entity.name });
    }
    // Maintain formation: match velocity
    gameState.physics.velocity.vx = entity.velocity.vx;
    gameState.physics.velocity.vy = entity.velocity.vy;
    gameState.physics.speed = Math.sqrt(entity.velocity.vx ** 2 + entity.velocity.vy ** 2);
  } else if (interceptState.formation) {
    // Lost formation
    interceptState.formation = false;
    events.push({ type: 'formation-lost', targetName: entity.name });
  }

  // For intercepts with continuous correction (runaway), update route heading
  if (interceptState && interceptState.formation === false && gameState.navigation?.routeActive) {
    const headingAngle = bearingTo(shipPos, entity.position);
    gameState.navigation.routeHeading = headingAngle;
  }

  // Check if we've entered the intercept target range (non-formation completion)
  if (interceptState && !interceptState.rangeReached && !interceptState.formation) {
    const targetRange = interceptState.targetRangeAU ?? INTERCEPT_RANGE_AU[INTERCEPT_TYPE.SCANNER];
    if (dist <= targetRange) {
      interceptState.rangeReached = true;
      // Match velocity and kill thrust — prevent overshoot
      gameState.physics.velocity.vx = entity.velocity.vx;
      gameState.physics.velocity.vy = entity.velocity.vy;
      gameState.physics.speed = Math.sqrt(entity.velocity.vx ** 2 + entity.velocity.vy ** 2);
      gameState.physics.thrustActive = false;
      gameState.physics.thrustLevel = 0;

      events.push({
        type: 'intercept-range-reached',
        interceptType: interceptState.interceptType,
        targetName: entity.name,
      });
      // Auto-clear if no mission attached — intercept is complete
      if (!interceptState.missionId) {
        interceptState = null;
      }
    }
  }

  return events;
}

/**
 * Complete a mission via hail when in formation.
 * Returns { success, narrative, rewards } for UI.
 */
export function completeMissionViaHail(missionId, gameState) {
  const mission = missions.find(m => m.id === missionId);
  if (!mission) return { success: false, narrative: 'No such mission.' };
  if (!interceptState || !interceptState.formation) {
    return { success: false, narrative: 'Must be in formation with target to complete rescue.' };
  }

  completeMission(mission, gameState);
  interceptState = null;

  return {
    success: true,
    narrative: RESCUE_NARRATIVES[mission.type] || 'The rescue is complete.',
    rewards: mission.rewards,
  };
}

// ---- SERIALIZATION ----

export function serializeMissions() {
  return {
    missions: JSON.parse(JSON.stringify(missions)),
    eventCooldown,
    interceptState: interceptState ? { ...interceptState } : null,
    nextMissionId,
  };
}

export function deserializeMissions(data) {
  if (!data) return;
  missions = data.missions || [];
  eventCooldown = data.eventCooldown || 0;
  interceptState = data.interceptState || null;
  nextMissionId = data.nextMissionId || (missions.length + 1);
}

// ---- HELPERS ----

function formatDistKm(au) {
  const km = au * 149_597_870.7;
  if (km < 1000) return `${Math.round(km)} km`;
  if (km < 1_000_000) return `${(km / 1000).toFixed(0)}k km`;
  return `${(km / 1_000_000).toFixed(1)}M km`;
}
