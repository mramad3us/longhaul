// ============================================================
// LONGHAUL — Inertial Physics
// Transient forces during maneuvers: flips, burns, thrust changes.
// Throws unsecured entities (crew, future: loose objects) across
// decks with collision detection and impact damage.
// Designed to scale: any entity with {mass, position, secured}
// can be affected. Ship-agnostic force model.
// ============================================================

import { TileType } from './svg-icons.js';
import { isSeatedInCouch, getMoveState, syncAfterSlide } from './crew-movement.js';

// ---- CONSTANTS ----

const G = 9.81;
const TILE_METERS = 0.9;            // Each tile ≈ 0.9m (9-tile-wide deck ≈ 8m interior)
const FRICTION_GROUNDED = 0.82;      // Per-frame velocity damping on floor under gravity
const FRICTION_FLOATING = 0.97;      // Per-frame velocity damping in micro-G
const VELOCITY_THRESHOLD = 0.05;     // tiles/s — below this, entity stops sliding
const FLIP_FORCE_G = 0.4;           // G-force magnitude during flip maneuver
const CREW_BRACE_THRESHOLD_G = 1.5;  // Burns ≤ this: conscious crew brace (no ragdoll)
const SURPRISE_THRESHOLD_G = 0.5;    // Manual thrust changes: crew ragdoll above this delta

// Impact damage thresholds (m/s at wall contact)
const IMPACT = {
  BUMP:       1,     // No damage
  BRUISE:     3,     // Minor
  HARD:       5,     // Fracture risk
  BREAKING:   8,     // Bone-breaking
  CRUSHING:  12,     // Internal bleeding
  LETHAL:    18,     // Most crew die
  FATAL:     18,     // Instant death above this (same threshold — severity scales within)
};

// ---- MANEUVER TYPES ----

export const ManeuverType = {
  BURN_START:    'BURN_START',
  BURN_STOP:     'BURN_STOP',
  FLIP:          'FLIP',
  THRUST_CHANGE: 'THRUST_CHANGE',
};

// ---- MODULE STATE ----

let activeEntities = [];       // InertialEntity[] currently sliding
let forceVector = { dx: 0, dy: 0 }; // Current force direction (normalized)
let forceMagnitude = 0;        // m/s² magnitude
let maneuverActive = false;
let maneuverType = null;
let maneuverElapsed = 0;       // seconds since maneuver started
let maneuverDuration = 0;      // expected duration (for flips)
let impactEvents = [];         // collected each frame, drained by caller
let _cinematicSavedSpeed = -1; // -1 = not in cinematic mode

// ---- INITIALIZATION ----

export function initInertia() {
  activeEntities = [];
  forceVector = { dx: 0, dy: 0 };
  forceMagnitude = 0;
  maneuverActive = false;
  maneuverType = null;
  maneuverElapsed = 0;
  maneuverDuration = 0;
  impactEvents = [];
  _cinematicSavedSpeed = -1;
}

// ---- ENTITY COLLECTION ----

// Tiles that block sliding (walls, heavy equipment)
const BLOCKING = new Set([
  TileType.HULL_WALL,
  TileType.INTERIOR_WALL,
  TileType.ENGINE,
  TileType.REACTOR,
]);

/**
 * Collect all unsecured entities that will be affected by inertial forces.
 * Currently: crew members who are not dead, not in crash couches, not in medbay.
 * Future: also loose objects from physics.looseObjects.
 *
 * @param {object} ship - Ship state with decks and crew
 * @param {object} physics - Physics state with crewStates
 * @param {object} opts - { surprise: bool } — if true, lower brace threshold
 * @param {number} deltaG - G-force magnitude of the event
 * @returns {InertialEntity[]}
 */
function collectUnsecuredEntities(ship, physics, opts, deltaG) {
  const entities = [];
  const surprise = opts?.surprise || false;
  const isBurn = maneuverType === ManeuverType.BURN_START ||
                 maneuverType === ManeuverType.BURN_STOP ||
                 maneuverType === ManeuverType.THRUST_CHANGE;

  for (const member of ship.crew) {
    if (isSeatedInCouch(member.id)) continue;

    // Dead crew: no bracing, no healing check — just get thrown
    if (!member.dead) {
      // Crew bracing logic: only for burn-type events (not flips)
      if (isBurn && !surprise) {
        // Conscious crew brace for expected burns ≤ threshold
        if (member.consciousness > 10 && deltaG <= CREW_BRACE_THRESHOLD_G) {
          continue; // Crew braces successfully, not ragdolled
        }
      }

      // Surprise events: crew ragdoll at lower threshold
      if (isBurn && surprise && deltaG <= SURPRISE_THRESHOLD_G) {
        continue; // Too gentle even for a surprise
      }
    }

    // Skip crew in medbay healing (strapped to bed) — only applies to living crew
    const ms = getMoveState(member.id);
    if (!ms) continue;
    if (!member.dead && ms.mission === 'healing') continue;

    const grounded = physics.gForce >= 0.01;

    entities.push({
      id: member.id,
      type: 'crew',
      mass: 75,
      deckIdx: ms.deckIdx,
      x: ms.x,
      y: ms.y,
      secured: false,
      grounded,
      velocity: { vx: 0, vy: 0 },
      sliding: true,
      _member: member, // back-reference for damage application
    });
  }

  // Future: iterate physics.looseObjects for non-bolted items
  // for (const obj of physics.looseObjects) { ... }

  return entities;
}

// ---- FORCE COMPUTATION ----

/**
 * Compute force direction and magnitude for a maneuver event.
 */
function computeForce(type, opts) {
  const deltaG = opts?.deltaG || 0;

  switch (type) {
    case ManeuverType.BURN_START:
      // Thrust engages → crew pushed toward stern (positive deck-Y)
      return { dx: 0, dy: 1, magnitude: deltaG * G };

    case ManeuverType.BURN_STOP:
      // Thrust cuts → crew float/drift toward bow (negative deck-Y)
      // Much gentler — it's a transition to micro-G, not an impact
      return { dx: 0, dy: -1, magnitude: deltaG * G * 0.3 };

    case ManeuverType.FLIP:
      // Random direction on deck plane — rotational forces are unpredictable
      const angle = Math.random() * Math.PI * 2;
      return {
        dx: Math.cos(angle),
        dy: Math.sin(angle),
        magnitude: FLIP_FORCE_G * G,
      };

    case ManeuverType.THRUST_CHANGE:
      // Same as burn start but could be in either direction
      const dir = deltaG > 0 ? 1 : -1;
      return { dx: 0, dy: dir, magnitude: Math.abs(deltaG) * G };

    default:
      return { dx: 0, dy: 0, magnitude: 0 };
  }
}

// ---- TRIGGER ----

/**
 * Trigger an inertial maneuver event.
 * Call this when a maneuver starts (burn, flip, thrust change).
 *
 * @param {string} type - ManeuverType
 * @param {object} physics - Physics state
 * @param {object} ship - Ship state
 * @param {object} opts - { deltaG: number, surprise: boolean }
 * @returns {{ triggered: boolean, entityCount: number, cinematicSlowdown: boolean }}
 */
export function triggerManeuverEvent(type, physics, ship, opts = {}) {
  const force = computeForce(type, opts);
  if (force.magnitude < 0.1) {
    return { triggered: false, entityCount: 0, cinematicSlowdown: false };
  }

  maneuverType = type;
  forceVector = { dx: force.dx, dy: force.dy };
  forceMagnitude = force.magnitude;
  maneuverElapsed = 0;
  impactEvents = [];

  // Flip has sustained force over its duration; burns are impulse (short burst)
  if (type === ManeuverType.FLIP) {
    maneuverDuration = 4; // seconds of real-time force application during flip
  } else {
    maneuverDuration = 0.8; // short impulse for burns
  }

  // Collect entities
  activeEntities = collectUnsecuredEntities(ship, physics, opts, opts.deltaG || 0);

  if (activeEntities.length === 0) {
    maneuverActive = false;
    return { triggered: false, entityCount: 0, cinematicSlowdown: false };
  }

  maneuverActive = true;
  return {
    triggered: true,
    entityCount: activeEntities.length,
    cinematicSlowdown: true,
  };
}

// ---- FRAME UPDATE ----

/**
 * Update inertia simulation for one animation frame.
 * Call from requestAnimationFrame loop.
 *
 * @param {object} ship - Ship state (for deck tile data)
 * @param {object} physics - Physics state
 * @param {number} dt - Delta time in seconds (real time)
 * @returns {object[]} Impact events that occurred this frame
 */
export function updateInertiaFrame(ship, physics, dt) {
  if (!maneuverActive || activeEntities.length === 0) return [];

  maneuverElapsed += dt;
  const frameImpacts = [];

  // Apply force if still within maneuver duration
  const applyForce = maneuverElapsed <= maneuverDuration;

  for (let i = activeEntities.length - 1; i >= 0; i--) {
    const ent = activeEntities[i];
    if (!ent.sliding) continue;

    const deck = ship.decks[ent.deckIdx];
    if (!deck) { ent.sliding = false; continue; }

    // Apply acceleration (force → tiles/s²)
    if (applyForce) {
      const accelTiles = forceMagnitude / TILE_METERS;
      ent.velocity.vx += forceVector.dx * accelTiles * dt;
      ent.velocity.vy += forceVector.dy * accelTiles * dt;
    }

    // Apply friction
    const fric = ent.grounded ? FRICTION_GROUNDED : FRICTION_FLOATING;
    ent.velocity.vx *= fric;
    ent.velocity.vy *= fric;

    // Integrate position
    const newX = ent.x + ent.velocity.vx * dt;
    const newY = ent.y + ent.velocity.vy * dt;

    // Collision detection
    const collision = checkCollision(deck, ent.x, ent.y, newX, newY);

    if (collision.hit) {
      // Impact!
      const speedTiles = Math.sqrt(ent.velocity.vx ** 2 + ent.velocity.vy ** 2);
      const speedMs = speedTiles * TILE_METERS;

      ent.x = collision.stopX;
      ent.y = collision.stopY;
      ent.velocity.vx = 0;
      ent.velocity.vy = 0;

      if (speedMs >= IMPACT.BUMP) {
        const impact = applyImpactDamage(ent, speedMs);
        if (impact) {
          frameImpacts.push(impact);
          impactEvents.push(impact);
        }
      }

      ent.sliding = false;
    } else {
      // Check bounds (don't go outside deck grid)
      ent.x = Math.max(0, Math.min(deck.tiles[0].length - 1, newX));
      ent.y = Math.max(0, Math.min(deck.tiles.length - 1, newY));

      // Check if hit deck boundary
      if (ent.x !== newX || ent.y !== newY) {
        const speedTiles = Math.sqrt(ent.velocity.vx ** 2 + ent.velocity.vy ** 2);
        const speedMs = speedTiles * TILE_METERS;
        ent.velocity.vx = 0;
        ent.velocity.vy = 0;

        if (speedMs >= IMPACT.BUMP) {
          const impact = applyImpactDamage(ent, speedMs);
          if (impact) {
            frameImpacts.push(impact);
            impactEvents.push(impact);
          }
        }
        ent.sliding = false;
      }
    }

    // Check if velocity is below threshold → stop
    const speed = Math.sqrt(ent.velocity.vx ** 2 + ent.velocity.vy ** 2);
    if (!ent.sliding || speed < VELOCITY_THRESHOLD) {
      ent.sliding = false;
    }

    // Sync visual position for crew
    if (ent.type === 'crew' && ent._member) {
      ent._member.x = ent.x;
      ent._member.y = ent.y;
      ent._member._sliding = ent.sliding;
    }
  }

  // Check if all entities done sliding
  const anySliding = activeEntities.some(e => e.sliding);
  if (!anySliding && maneuverElapsed > maneuverDuration) {
    // Finalize positions
    for (const ent of activeEntities) {
      if (ent.type === 'crew') {
        const snapX = Math.round(ent.x);
        const snapY = Math.round(ent.y);
        syncAfterSlide(ent.id, snapX, snapY, ent.deckIdx);
        if (ent._member) {
          ent._member.x = snapX;
          ent._member.y = snapY;
          ent._member._sliding = false;
        }
      }
    }
    maneuverActive = false;
    activeEntities = [];
  }

  return frameImpacts;
}

// ---- COLLISION DETECTION ----

/**
 * Trace a line from (x0,y0) to (x1,y1) on the deck tile grid.
 * Returns { hit: bool, stopX, stopY, wallTileX, wallTileY }.
 */
function checkCollision(deck, x0, y0, x1, y1) {
  const tiles = deck.tiles;
  const rows = tiles.length;
  const cols = tiles[0]?.length || 0;

  // Step along the path checking each tile we enter
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.ceil(Math.abs(dx) * 4), Math.ceil(Math.abs(dy) * 4), 1);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = x0 + dx * t;
    const py = y0 + dy * t;
    const tx = Math.round(px);
    const ty = Math.round(py);

    // Out of bounds = hull wall
    if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) {
      return {
        hit: true,
        stopX: Math.max(0.5, Math.min(cols - 1.5, x0 + dx * ((i - 1) / steps))),
        stopY: Math.max(0.5, Math.min(rows - 1.5, y0 + dy * ((i - 1) / steps))),
        wallTileX: tx,
        wallTileY: ty,
      };
    }

    const tileType = tiles[ty]?.[tx];
    if (BLOCKING.has(tileType)) {
      // Stop just before the blocking tile
      const prevT = (i - 1) / steps;
      return {
        hit: true,
        stopX: x0 + dx * prevT,
        stopY: y0 + dy * prevT,
        wallTileX: tx,
        wallTileY: ty,
      };
    }
  }

  return { hit: false, stopX: x1, stopY: y1 };
}

// ---- IMPACT DAMAGE ----

/**
 * Apply impact damage to an entity based on collision velocity.
 * Damage scales quadratically (kinetic energy). High speed = death.
 *
 * @param {InertialEntity} ent
 * @param {number} speedMs - Impact speed in m/s
 * @returns {object|null} Impact event descriptor for UI
 */
function applyImpactDamage(ent, speedMs) {
  if (ent.type !== 'crew' || !ent._member) return null;
  const member = ent._member;

  // Dead crew: body is already gone — just emit an impact event with no further damage
  if (member.dead) {
    if (speedMs < IMPACT.BUMP) return null;
    return {
      entityId: ent.id,
      entityType: 'crew',
      name: member.name,
      severity: 'corpse',
      speedMs,
      message: `${member.name}'s body slammed into bulkhead`,
    };
  }

  // Determine severity
  let severity, baseTorso, baseHead, baseLimb, consciousnessLoss, cardiacStress;

  if (speedMs < IMPACT.BUMP) {
    return null; // No damage
  } else if (speedMs < IMPACT.BRUISE) {
    severity = 'bruise';
    baseTorso = 3 + (speedMs - 1) * 2.5;
    baseHead = baseTorso * 0.3;
    baseLimb = baseTorso * 0.5;
    consciousnessLoss = 0;
    cardiacStress = 0;
  } else if (speedMs < IMPACT.HARD) {
    severity = 'hard-impact';
    baseTorso = 10 + (speedMs - 3) * 5;
    baseHead = baseTorso * 0.6;
    baseLimb = baseTorso * 0.6;
    consciousnessLoss = 15;
    cardiacStress = 0;
  } else if (speedMs < IMPACT.BREAKING) {
    severity = 'bone-breaking';
    baseTorso = 20 + (speedMs - 5) * 6.7;
    baseHead = baseTorso * 0.7;
    baseLimb = baseTorso * 0.65;
    consciousnessLoss = 30;
    cardiacStress = 10;
  } else if (speedMs < IMPACT.CRUSHING) {
    severity = 'crushing';
    baseTorso = 40 + (speedMs - 8) * 6.25;
    baseHead = baseTorso * 0.7;
    baseLimb = baseTorso * 0.6;
    consciousnessLoss = 60;
    cardiacStress = 25;
  } else if (speedMs < IMPACT.LETHAL) {
    severity = 'lethal';
    baseTorso = 60 + (speedMs - 12) * 5;
    baseHead = baseTorso * 0.85;
    baseLimb = baseTorso * 0.55;
    consciousnessLoss = 90;
    cardiacStress = 50;
  } else {
    // >= 18 m/s: instant death
    severity = 'fatal';
    member.body.head = 0;
    member.body.torso = 0;
    member.body.leftArm = 0;
    member.body.rightArm = 0;
    member.body.leftLeg = 0;
    member.body.rightLeg = 0;
    member.consciousness = 0;
    member.dead = true;
    if (!member.conditions.includes('dead')) member.conditions.push('dead');

    return {
      entityId: ent.id,
      entityType: 'crew',
      name: member.name,
      severity: 'fatal',
      speedMs,
      message: `${member.name} killed on impact`,
    };
  }

  // Apply damage with +-20% randomization
  const rand = () => 0.8 + Math.random() * 0.4;

  member.body.torso = Math.max(0, member.body.torso - baseTorso * rand());
  member.body.head = Math.max(0, member.body.head - baseHead * rand());
  member.body.leftArm = Math.max(0, member.body.leftArm - baseLimb * rand());
  member.body.rightArm = Math.max(0, member.body.rightArm - baseLimb * rand());
  member.body.leftLeg = Math.max(0, member.body.leftLeg - baseLimb * rand());
  member.body.rightLeg = Math.max(0, member.body.rightLeg - baseLimb * rand());

  // Consciousness loss
  if (consciousnessLoss > 0) {
    member.consciousness = Math.max(0, member.consciousness - consciousnessLoss);
  }

  // Cardiac stress
  if (cardiacStress > 0 && member.heart) {
    member.heart.stress = Math.min(100, (member.heart.stress || 0) + cardiacStress);
  }

  // Apply conditions
  if (severity === 'hard-impact' && Math.random() < 0.3) {
    if (!member.conditions.includes('fracture')) member.conditions.push('fracture');
  }
  if (severity === 'bone-breaking') {
    if (!member.conditions.includes('fracture')) member.conditions.push('fracture');
  }
  if (severity === 'crushing') {
    if (!member.conditions.includes('fracture')) member.conditions.push('fracture');
    if (!member.conditions.includes('internal-bleeding')) member.conditions.push('internal-bleeding');
  }
  if (severity === 'lethal') {
    if (!member.conditions.includes('fracture')) member.conditions.push('fracture');
    if (!member.conditions.includes('internal-bleeding')) member.conditions.push('internal-bleeding');
    if (!member.conditions.includes('brain-damage') && member.body.head < 20) {
      member.conditions.push('brain-damage');
    }
  }

  // Check for unconsciousness
  if (member.consciousness <= 10 && !member.conditions.includes('unconscious')) {
    member.conditions.push('unconscious');
  }

  // Check for death (head or torso zeroed)
  if (member.body.head <= 0 || member.body.torso <= 0) {
    member.consciousness = 0;
    member.dead = true;
    if (!member.conditions.includes('dead')) member.conditions.push('dead');
    return {
      entityId: ent.id,
      entityType: 'crew',
      name: member.name,
      severity: 'fatal',
      speedMs,
      message: `${member.name} killed on impact`,
    };
  }

  const severityLabels = {
    'bruise': 'bruised',
    'hard-impact': 'injured',
    'bone-breaking': 'bones broken',
    'crushing': 'critically injured',
    'lethal': 'near-fatal injuries',
  };

  return {
    entityId: ent.id,
    entityType: 'crew',
    name: member.name,
    severity,
    speedMs,
    message: `${member.name} slammed into bulkhead — ${severityLabels[severity] || severity}`,
  };
}

// ---- INTERNAL BLEEDING TICK ----
// Called from physics or game loop to apply ongoing internal bleeding damage.

export function internalBleedingTick(member) {
  if (!member.conditions.includes('internal-bleeding')) return;
  if (member.dead) return;

  // -0.5 torso per game-minute until treated in medbay
  member.body.torso = Math.max(0, member.body.torso - 0.5);
  if (member.body.torso <= 0) {
    member.consciousness = 0;
    member.dead = true;
    if (!member.conditions.includes('dead')) member.conditions.push('dead');
  }
}

// ---- CINEMATIC TIME ----

/**
 * Enter cinematic slowdown (save current game speed, set to 1).
 * Returns the saved speed, or -1 if already in cinematic mode.
 */
export function enterCinematicTime(gameState) {
  if (_cinematicSavedSpeed >= 0) return -1; // Already in cinematic
  _cinematicSavedSpeed = gameState.speed;
  gameState.speed = 1;
  return _cinematicSavedSpeed;
}

/**
 * Exit cinematic slowdown (restore saved game speed).
 */
export function exitCinematicTime(gameState) {
  if (_cinematicSavedSpeed < 0) return;
  gameState.speed = _cinematicSavedSpeed;
  _cinematicSavedSpeed = -1;
}

export function isInCinematicTime() {
  return _cinematicSavedSpeed >= 0;
}

// ---- QUERIES ----

export function isInertiaActive() {
  return maneuverActive;
}

export function getSlideState(entityId) {
  const ent = activeEntities.find(e => e.id === entityId);
  if (!ent) return null;
  return { x: ent.x, y: ent.y, vx: ent.velocity.vx, vy: ent.velocity.vy, sliding: ent.sliding };
}

export function drainImpactEvents() {
  const events = impactEvents.slice();
  impactEvents = [];
  return events;
}

export function getActiveEntityCount() {
  return activeEntities.filter(e => e.sliding).length;
}
