// ============================================================
// LONGHAUL — Crew Movement & Mission System
// Crew patrol their decks, walking circuits around floor tiles.
// Missions override patrol: recover (walk to medbay), rescue
// (medic goes to unconscious crew, stabilizes, brings to medbay).
// ============================================================

import { TileType } from './svg-icons.js';
import { stabilizeCrew, medbayHealTick } from './physics.js';

const TILE_SIZE = 32;
const OFFSET_X = 100; // labelWidth in ship.js
const OFFSET_Y = 20;
const DECK_GAP = 1;

// Tiles crew can walk/float through (includes medbay as destination)
const WALKABLE = new Set([
  TileType.FLOOR,
  TileType.DOOR,
  TileType.LADDER,
  TileType.MEDBAY,
]);

// Base movement speed in tiles per second (at 1x game speed)
const BASE_SPEED = 0.5;

// Per-crew movement state
const moveState = new Map();

// Cached DOM element references (crew id → DOM element), cleared on init
const _crewElements = new Map();

// Cached deckStartY results (deck index → cumulative Y offset), cleared on init
let _deckYCache = [];

// ---- MISSION TYPES ----
// null          = patrolling (default)
// 'recover'     = walk self to medbay, heal there
// 'rescue'      = go to target crew, stabilize, bring to medbay
// 'healing'     = at medbay, receiving treatment
// 'carrying'    = carrying unconscious crew to medbay

// ---- TILE ANALYSIS ----

function getFloorTiles(deck) {
  const tiles = [];
  deck.tiles.forEach((row, ry) => {
    row.forEach((tile, rx) => {
      if (WALKABLE.has(tile)) tiles.push({ x: rx, y: ry });
    });
  });
  return tiles;
}

// Find medbay tile positions in a given deck
function findMedbayTiles(deck) {
  const tiles = [];
  deck.tiles.forEach((row, ry) => {
    row.forEach((tile, rx) => {
      if (tile === TileType.MEDBAY) tiles.push({ x: rx, y: ry });
    });
  });
  return tiles;
}

// Find the nearest medbay across all decks (returns { deckIdx, x, y } or null)
export function findNearestMedbay(ship, fromDeck, fromX, fromY) {
  let best = null, bestD = Infinity;
  ship.decks.forEach((deck, di) => {
    const medbays = findMedbayTiles(deck);
    medbays.forEach(mb => {
      // Prefer same deck; cross-deck adds penalty
      const deckPenalty = Math.abs(di - fromDeck) * 5;
      const d = Math.abs(mb.x - fromX) + Math.abs(mb.y - fromY) + deckPenalty;
      if (d < bestD) { bestD = d; best = { deckIdx: di, x: mb.x, y: mb.y }; }
    });
  });
  return best;
}

// Find nearest walkable tile adjacent to a target position
function nearestWalkableTo(deck, tx, ty) {
  const adjacent = [
    { x: tx - 1, y: ty },
    { x: tx + 1, y: ty },
    { x: tx, y: ty - 1 },
    { x: tx, y: ty + 1 },
    { x: tx, y: ty }, // the tile itself if walkable
  ];
  for (const pos of adjacent) {
    if (pos.y >= 0 && pos.y < deck.tiles.length &&
        pos.x >= 0 && pos.x < deck.tiles[pos.y].length &&
        WALKABLE.has(deck.tiles[pos.y][pos.x])) {
      return pos;
    }
  }
  return { x: tx, y: ty }; // fallback
}

// Pick 4 corner-ish waypoints from floor tiles to form a patrol circuit
function pickPatrolCorners(floorTiles) {
  if (floorTiles.length < 2) return floorTiles.slice();

  const xs = floorTiles.map(t => t.x);
  const ys = floorTiles.map(t => t.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const targets = [
    { cx: minX + 1, cy: minY },
    { cx: maxX - 1, cy: minY },
    { cx: maxX - 1, cy: maxY },
    { cx: minX + 1, cy: maxY },
  ];

  const corners = [];
  for (const tgt of targets) {
    let best = null, bestD = Infinity;
    for (const t of floorTiles) {
      const d = Math.abs(t.x - tgt.cx) + Math.abs(t.y - tgt.cy);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best && !corners.some(c => c.x === best.x && c.y === best.y)) {
      corners.push({ x: best.x, y: best.y });
    }
  }

  return corners.length >= 2 ? corners : [floorTiles[0], floorTiles[Math.floor(floorTiles.length / 2)]];
}

// Cumulative tile-row offset for a given deck index (cached)
function deckStartY(ship, deckIdx) {
  if (_deckYCache[deckIdx] !== undefined) return _deckYCache[deckIdx];
  let y = 0;
  for (let i = 0; i < deckIdx; i++) {
    y += ship.decks[i].tiles.length + DECK_GAP;
  }
  _deckYCache[deckIdx] = y;
  return y;
}

// ---- SPEED CALCULATION ----

function crewSpeed(_gState, gForce, member) {
  const legHealth = (member.body.leftLeg + member.body.rightLeg) / 2;
  const legsGone = legHealth <= 0;

  // No legs + any gravity = can't move (need legs to walk/stand)
  // No legs + zero-G = can pull yourself along at half speed (arms only)
  if (legsGone && gForce >= 0.01) return 0;

  if (member.consciousness <= 10) return 0;

  let speed;
  if (gForce < 0.01) speed = BASE_SPEED * 0.5;
  else if (gForce < 0.3) speed = BASE_SPEED * (0.5 + (gForce / 0.3) * 0.5);
  else if (gForce <= 1.0) speed = BASE_SPEED;
  else if (gForce < 2.5) speed = BASE_SPEED * Math.max(0, 1.0 - (gForce - 1.0) / 1.5);
  else return 0;

  // No legs in zero-G: half speed (pulling with arms)
  if (legsGone) return speed * 0.5;

  const legFactor = legHealth / 100;
  return speed * legFactor;
}

// ---- MOVEMENT HELPERS ----

function moveToward(ms, target, speed, dt) {
  const dx = target.x - ms.x;
  const dy = target.y - ms.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (ms.segDist === 0) {
    ms.segDist = dist;
    ms.traveled = 0;
  }

  if (dist < 0.06) return true; // arrived

  const t = ms.segDist > 0 ? ms.traveled / ms.segDist : 0;
  const easeMultiplier = t < 0.15
    ? 0.3 + (t / 0.15) * 0.7
    : t > 0.8
      ? 0.3 + ((1 - t) / 0.2) * 0.7
      : 1.0;

  const step = Math.min(speed * easeMultiplier * dt, dist);
  ms.x += (dx / dist) * step;
  ms.y += (dy / dist) * step;
  ms.traveled += step;
  return false;
}

function snapTo(ms, member, pos) {
  ms.x = pos.x;
  ms.y = pos.y;
  member.x = pos.x;
  member.y = pos.y;
  ms.segDist = 0;
  ms.traveled = 0;
}

function updateCrewVisual(ship, ms, member) {
  let el = _crewElements.get(member.id);
  if (el === undefined || (el && !el.isConnected)) {
    el = document.querySelector(`[data-crew-id="${member.id}"]`);
    _crewElements.set(member.id, el);
  }
  if (el) {
    const dsy = deckStartY(ship, ms.deckIdx);
    const px = OFFSET_X + ms.x * TILE_SIZE;
    const py = OFFSET_Y + (dsy + ms.y) * TILE_SIZE;
    el.setAttribute('transform', `translate(${px}, ${py})`);
  }
}

// ---- PUBLIC API ----

export function initCrewMovement(ship) {
  moveState.clear();
  _crewElements.clear();
  _deckYCache = [];

  const deckFloors = ship.decks.map(d => getFloorTiles(d));

  ship.crew.forEach(member => {
    const corners = pickPatrolCorners(deckFloors[member.deck]);
    const startIdx = Math.floor(Math.random() * corners.length);

    moveState.set(member.id, {
      x: member.x,
      y: member.y,
      deckIdx: member.deck,
      waypoints: corners,
      wpIdx: startIdx,
      pause: 1 + Math.random() * 4,
      segDist: 0,
      traveled: 0,
      // Mission state
      mission: null,        // null | 'recover' | 'rescue' | 'healing' | 'carrying'
      missionTarget: null,  // { x, y } destination or crew id
      rescueTargetId: null, // id of crew being rescued
      rescuePhase: null,    // 'goto' | 'stabilize' | 'carry'
      stabilizeTimer: 0,    // seconds remaining for first-aid
    });
  });
}

// ---- SERIALIZATION (save/load) ----

export function serializeCrewMovement() {
  const data = {};
  for (const [id, ms] of moveState) {
    data[id] = {
      x: ms.x, y: ms.y, deckIdx: ms.deckIdx,
      mission: ms.mission,
      missionTarget: ms.missionTarget,
      _couchPos: ms._couchPos || null,
      _arrivedAtCouch: ms._arrivedAtCouch || false,
    };
  }
  const couches = {};
  for (const [id, pos] of couchOccupants) {
    couches[id] = pos;
  }
  return { moveStates: data, couchOccupants: couches };
}

export function restoreCrewMovement(ship, saved) {
  if (!saved || !saved.moveStates) return;
  // Init first to set up waypoints, then overlay saved state
  initCrewMovement(ship);

  for (const [id, ms] of moveState) {
    const s = saved.moveStates[id];
    if (!s) continue;
    ms.x = s.x;
    ms.y = s.y;
    ms.deckIdx = s.deckIdx;
    ms.mission = s.mission;
    ms.missionTarget = s.missionTarget;
    if (s._couchPos) ms._couchPos = s._couchPos;
    if (s._arrivedAtCouch) ms._arrivedAtCouch = true;
    ms.pause = 0;
    ms.segDist = 0;
    ms.traveled = 0;
  }

  couchOccupants.clear();
  if (saved.couchOccupants) {
    for (const [id, pos] of Object.entries(saved.couchOccupants)) {
      couchOccupants.set(id, pos);
    }
  }
}

// Get mission state for a crew member (for UI)
export function getCrewMission(memberId) {
  const ms = moveState.get(memberId);
  return ms ? ms.mission : null;
}

// Check if crew member has completed their LS repair
export function isRepairComplete(memberId) {
  const ms = moveState.get(memberId);
  return ms && ms.mission === 'repair-ls' && ms._repairComplete === true;
}

// Check if crew member has arrived at their crash couch
export function isSeatedInCouch(memberId) {
  const ms = moveState.get(memberId);
  return ms && ms.mission === 'secure-burn' && ms._arrivedAtCouch === true;
}

// Check if a crew member is currently being rescued by someone
export function isBeingRescued(memberId) {
  for (const [, ms] of moveState) {
    if ((ms.mission === 'rescue' || ms.mission === 'carrying') &&
        ms.rescueTargetId === memberId) {
      return true;
    }
  }
  return false;
}

// ---- CRASH COUCH FINDER ----

function findCrashCouchTiles(deck) {
  const tiles = [];
  deck.tiles.forEach((row, ry) => {
    row.forEach((tile, rx) => {
      if (tile === TileType.CRASH_COUCH) tiles.push({ x: rx, y: ry });
    });
  });
  return tiles;
}

// Track which crash couches are occupied (crewId → { deckIdx, x, y })
const couchOccupants = new Map();

export function findNearestCrashCouch(ship, fromDeck, fromX, fromY, excludeCrewId) {
  let best = null, bestD = Infinity;
  // Collect occupied positions
  const occupied = new Set();
  for (const [id, pos] of couchOccupants) {
    if (id !== excludeCrewId) occupied.add(`${pos.deckIdx},${pos.x},${pos.y}`);
  }

  ship.decks.forEach((deck, di) => {
    const couches = findCrashCouchTiles(deck);
    couches.forEach(cc => {
      const key = `${di},${cc.x},${cc.y}`;
      if (occupied.has(key)) return; // already taken
      const deckPenalty = Math.abs(di - fromDeck) * 5;
      const d = Math.abs(cc.x - fromX) + Math.abs(cc.y - fromY) + deckPenalty;
      if (d < bestD) { bestD = d; best = { deckIdx: di, x: cc.x, y: cc.y }; }
    });
  });
  return best;
}

// ---- MISSION DISPATCH ----

// Send a crew member to the nearest crash couch for high-G burn
export function assignSecureBurnMission(ship, member) {
  const ms = moveState.get(member.id);
  if (!ms || member.dead) return false;
  if (ms.mission === 'secure-burn' || ms.mission === 'healing') return false;

  const couch = findNearestCrashCouch(ship, ms.deckIdx, ms.x, ms.y, member.id);
  if (!couch) return false;

  // Walk to the tile adjacent to the crash couch (it's not walkable itself)
  const dest = nearestWalkableTo(ship.decks[couch.deckIdx], couch.x, couch.y);

  ms.mission = 'secure-burn';
  ms.missionTarget = { x: dest.x, y: dest.y };
  ms._couchPos = { x: couch.x, y: couch.y }; // actual couch tile to snap onto when arrived
  ms._arrivedAtCouch = false;
  ms.pause = 0;
  ms.segDist = 0;
  ms.traveled = 0;

  couchOccupants.set(member.id, couch);
  return true;
}

// Release crash couch when mission ends
export function releaseSecureBurn(memberId) {
  couchOccupants.delete(memberId);
}

// Send crew member to nearest EVA suit locker to don a suit
export function assignEquipSuitMission(ship, member, lockerX, lockerY, lockerDeckIdx) {
  const ms = moveState.get(member.id);
  if (!ms || member.dead) return false;
  if (ms.mission) return false;

  const dest = nearestWalkableTo(ship.decks[lockerDeckIdx], lockerX, lockerY);

  ms.mission = 'equip-suit';
  ms.missionTarget = { x: dest.x, y: dest.y };
  ms._suitLockerPos = { x: lockerX, y: lockerY, deckIdx: lockerDeckIdx };
  ms._suitTimer = 0;
  ms._suitDuration = 2 + Math.random(); // 2-3 seconds to don suit
  ms._suitDonned = false;
  ms.pause = 0;
  ms.segDist = 0;
  ms.traveled = 0;

  return true;
}

// Check if crew member has finished donning their suit
export function isSuitDonned(memberId) {
  const ms = moveState.get(memberId);
  return ms && ms.mission === 'equip-suit' && ms._suitDonned === true;
}

// Send engineer to repair life support on a deck
export function assignRepairLSMission(ship, member, deckIdx, tileX, tileY) {
  const ms = moveState.get(member.id);
  if (!ms || member.dead) return false;
  if (ms.mission) return false;

  const dest = nearestWalkableTo(ship.decks[deckIdx], tileX, tileY);

  ms.mission = 'repair-ls';
  ms.missionTarget = { x: dest.x, y: dest.y };
  ms._repairDeckIdx = deckIdx;
  ms._repairTimer = 0;
  ms._repairDuration = 3 + Math.random() * 2; // 3-5 seconds of work
  ms.pause = 0;
  ms.segDist = 0;
  ms.traveled = 0;

  return true;
}

// Send a crew member to the medbay to recover
export function assignRecoverMission(ship, member) {
  const ms = moveState.get(member.id);
  if (!ms || member.dead) return false;

  const medbay = findNearestMedbay(ship, ms.deckIdx, ms.x, ms.y);
  if (!medbay) return false;

  // For now, crew can only go to medbay on their own deck
  // (cross-deck movement is a future feature)
  const dest = nearestWalkableTo(ship.decks[medbay.deckIdx], medbay.x, medbay.y);

  ms.mission = 'recover';
  ms.missionTarget = { x: dest.x, y: dest.y };
  ms.pause = 0;
  ms.segDist = 0;
  ms.traveled = 0;
  return true;
}

// Find the best available medic to rescue an unconscious crew member
function findBestMedic(ship, excludeId) {
  let best = null, bestSkill = -1;
  ship.crew.forEach(c => {
    if (c.id === excludeId) return;
    if (c.dead) return;
    if (c.consciousness <= 10) return;
    if (c.skills.medical <= 20) return; // need >20 medical skill
    const ms = moveState.get(c.id);
    // Prefer crew not already on a mission
    const missionPenalty = (ms && ms.mission) ? 50 : 0;
    const score = c.skills.medical - missionPenalty;
    if (score > bestSkill) { bestSkill = score; best = c; }
  });
  return best;
}

// Dispatch a rescue mission for an unconscious or critical crew member
export function assignRescueMission(ship, patient) {
  if (patient.dead) return { success: false, reason: 'dead' };
  const needsRescue = patient.consciousness <= 10 || patient.conditions.includes('critical');
  if (!needsRescue) return { success: false, reason: 'not-critical' };

  const medic = findBestMedic(ship, patient.id);
  if (!medic) return { success: false, reason: 'no-medic' };

  const ms = moveState.get(medic.id);
  if (!ms) return { success: false, reason: 'no-state' };

  const patientMs = moveState.get(patient.id);
  const patientPos = patientMs ? { x: patientMs.x, y: patientMs.y } : { x: patient.x, y: patient.y };

  ms.mission = 'rescue';
  ms.rescueTargetId = patient.id;
  ms.rescuePhase = 'goto';
  ms.missionTarget = { x: patientPos.x, y: patientPos.y };
  ms.pause = 0;
  ms.segDist = 0;
  ms.traveled = 0;
  ms.stabilizeTimer = 0;
  return { success: true, medicName: medic.name };
}

// Cancel a crew member's current mission, return to patrol
// Pass ship to snap crew off non-walkable tiles (e.g. crash couches)
export function cancelMission(memberId, ship) {
  const ms = moveState.get(memberId);
  if (!ms) return;
  const wasSecureBurn = ms.mission === 'secure-burn';
  if (wasSecureBurn) couchOccupants.delete(memberId);
  ms.mission = null;
  ms.missionTarget = null;
  ms.rescueTargetId = null;
  ms.rescuePhase = null;
  ms.stabilizeTimer = 0;
  ms._arrivedAtCouch = false;
  ms._couchPos = null;
  ms._repairComplete = false;
  ms._repairTimer = 0;
  ms._repairDeckIdx = null;
  ms._suitDonned = false;
  ms._suitTimer = 0;
  ms._suitLockerPos = null;
  ms.pause = 0.5;
  ms.segDist = 0;
  ms.traveled = 0;

  // Move crew off non-walkable tile (crash couch) back to adjacent floor
  if (wasSecureBurn && ship) {
    const deck = ship.decks[ms.deckIdx];
    if (deck) {
      const tx = Math.round(ms.x);
      const ty = Math.round(ms.y);
      if (!WALKABLE.has(deck.tiles[ty]?.[tx])) {
        const walkable = nearestWalkableTo(deck, tx, ty);
        const member = ship.crew.find(c => c.id === memberId);
        if (member) snapTo(ms, member, walkable);
      }
    }
  }
}

// ---- UPDATE LOOP ----

export function updateCrewMovement(ship, physics, deltaSec, gameSpeed) {
  if (gameSpeed === 0) return;
  if (physics.flipping) return;

  const speedScale = [0, 1, 4, 10][gameSpeed] || 0;
  const dt = Math.min(deltaSec * speedScale, 0.5);

  const crewById = new Map(ship.crew.map(c => [c.id, c]));

  ship.crew.forEach(member => {
    if (member.dead) return;

    const ms = moveState.get(member.id);
    if (!ms) return;

    const gState = physics.crewStates[member.id] || 'floating';
    const speed = crewSpeed(gState, physics.gForce, member);

    // ---- HEALING AT MEDBAY ----
    if (ms.mission === 'healing') {
      // Heal per real-time second scaled by game speed
      // medbayHealTick is per game-minute, so we call it proportionally
      // At game speed 1: ~1 call per 60 real seconds
      // We approximate: call every dt-scaled frame, accumulate
      if (!ms._healAccum) ms._healAccum = 0;
      ms._healAccum += dt;
      while (ms._healAccum >= 1.0) {
        ms._healAccum -= 1.0;
        // Auto-stabilize if critical and at medbay
        if (member.conditions.includes('critical')) {
          stabilizeCrew(member);
        }
        const fullyHealed = medbayHealTick(member);
        if (fullyHealed) {
          ms.mission = null;
          ms.missionTarget = null;
          ms._healAccum = 0;
          ms.pause = 1;
          break;
        }
      }
      updateCrewVisual(ship, ms, member);
      return;
    }

    if (speed === 0) {
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- SECURE FOR BURN ----
    if (ms.mission === 'secure-burn') {
      if (ms._arrivedAtCouch) {
        // Already seated — stay put
        updateCrewVisual(ship, ms, member);
        return;
      }
      if (ms.missionTarget) {
        if (ms.pause > 0) { ms.pause -= dt; updateCrewVisual(ship, ms, member); return; }

        const arrived = moveToward(ms, ms.missionTarget, speed, dt);
        if (arrived) {
          // Snap onto the actual crash couch tile
          const couchPos = ms._couchPos || ms.missionTarget;
          snapTo(ms, member, couchPos);
          ms._arrivedAtCouch = true;
        }
        member.x = ms.x;
        member.y = ms.y;
      }
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- EQUIP EVA SUIT MISSION ----
    if (ms.mission === 'equip-suit' && ms.missionTarget) {
      if (ms.pause > 0) { ms.pause -= dt; updateCrewVisual(ship, ms, member); return; }

      const arrived = moveToward(ms, ms.missionTarget, speed, dt);
      if (arrived) {
        snapTo(ms, member, ms.missionTarget);
        // Don suit timer
        ms._suitTimer = (ms._suitTimer || 0) + dt;
        if (ms._suitTimer >= (ms._suitDuration || 2.5)) {
          ms._suitDonned = true;
        }
      }
      member.x = ms.x;
      member.y = ms.y;
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- REPAIR LS MISSION ----
    if (ms.mission === 'repair-ls' && ms.missionTarget) {
      if (ms.pause > 0) { ms.pause -= dt; updateCrewVisual(ship, ms, member); return; }

      const arrived = moveToward(ms, ms.missionTarget, speed, dt);
      if (arrived) {
        snapTo(ms, member, ms.missionTarget);
        // Repair timer
        ms._repairTimer = (ms._repairTimer || 0) + dt;
        if (ms._repairTimer >= (ms._repairDuration || 4)) {
          // Repair complete — signal via callback (app.js handles actual repair)
          ms._repairComplete = true;
        }
      }
      member.x = ms.x;
      member.y = ms.y;
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- RECOVER MISSION ----
    if (ms.mission === 'recover' && ms.missionTarget) {
      if (ms.pause > 0) { ms.pause -= dt; updateCrewVisual(ship, ms, member); return; }

      const arrived = moveToward(ms, ms.missionTarget, speed, dt);
      if (arrived) {
        snapTo(ms, member, ms.missionTarget);
        // Start healing at medbay
        ms.mission = 'healing';
        ms._healAccum = 0;
      }
      member.x = ms.x;
      member.y = ms.y;
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- RESCUE MISSION ----
    if (ms.mission === 'rescue' && ms.rescueTargetId != null) {
      if (ms.pause > 0) { ms.pause -= dt; updateCrewVisual(ship, ms, member); return; }

      const patient = crewById.get(ms.rescueTargetId);
      if (!patient || patient.dead) {
        // Patient died — abort
        cancelMission(member.id);
        updateCrewVisual(ship, ms, member);
        return;
      }

      if (ms.rescuePhase === 'goto') {
        // Walk to patient
        const patientMs = moveState.get(patient.id);
        const patientPos = patientMs ? { x: patientMs.x, y: patientMs.y } : { x: patient.x, y: patient.y };
        ms.missionTarget = { x: patientPos.x, y: patientPos.y };

        const arrived = moveToward(ms, ms.missionTarget, speed, dt);
        if (arrived) {
          snapTo(ms, member, ms.missionTarget);
          ms.rescuePhase = 'stabilize';
          ms.stabilizeTimer = 5; // 5 seconds of first aid
          ms.segDist = 0;
          ms.traveled = 0;
        }
        member.x = ms.x;
        member.y = ms.y;
        updateCrewVisual(ship, ms, member);
        return;
      }

      if (ms.rescuePhase === 'stabilize') {
        // Performing first aid
        ms.stabilizeTimer -= dt;
        if (ms.stabilizeTimer <= 0) {
          // Stabilize the patient
          stabilizeCrew(patient);
          // Now carry to medbay
          const medbay = findNearestMedbay(ship, ms.deckIdx, ms.x, ms.y);
          if (medbay) {
            const dest = nearestWalkableTo(ship.decks[medbay.deckIdx], medbay.x, medbay.y);
            ms.rescuePhase = 'carry';
            ms.mission = 'carrying';
            ms.missionTarget = { x: dest.x, y: dest.y };
            ms.segDist = 0;
            ms.traveled = 0;
          } else {
            // No medbay — mission done after stabilization
            cancelMission(member.id);
          }
        }
        updateCrewVisual(ship, ms, member);
        return;
      }
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- CARRYING (part of rescue) ----
    if (ms.mission === 'carrying' && ms.missionTarget) {
      if (ms.pause > 0) { ms.pause -= dt; updateCrewVisual(ship, ms, member); return; }

      // Move at half speed when carrying
      const arrived = moveToward(ms, ms.missionTarget, speed * 0.5, dt);

      // Drag patient along
      const patient = crewById.get(ms.rescueTargetId);
      if (patient && !patient.dead) {
        const patientMs = moveState.get(patient.id);
        if (patientMs) {
          patientMs.x = ms.x;
          patientMs.y = ms.y;
          patient.x = ms.x;
          patient.y = ms.y;
          updateCrewVisual(ship, patientMs, patient);
        }
      }

      if (arrived) {
        snapTo(ms, member, ms.missionTarget);
        // Place patient at medbay
        if (patient && !patient.dead) {
          const patientMs = moveState.get(patient.id);
          if (patientMs) {
            snapTo(patientMs, patient, ms.missionTarget);
            patientMs.mission = 'healing';
            patientMs._healAccum = 0;
          }
        }
        // Medic returns to patrol
        cancelMission(member.id);
      }

      member.x = ms.x;
      member.y = ms.y;
      updateCrewVisual(ship, ms, member);
      return;
    }

    // ---- DEFAULT PATROL ----
    if (!ms.waypoints || ms.waypoints.length < 2) return;

    if (ms.pause > 0) {
      ms.pause -= dt;
      return;
    }

    const target = ms.waypoints[ms.wpIdx];
    const arrived = moveToward(ms, target, speed, dt);

    if (arrived) {
      snapTo(ms, member, target);
      ms.wpIdx = (ms.wpIdx + 1) % ms.waypoints.length;
      ms.pause = 1.5 + Math.random() * 3;
      return;
    }

    member.x = ms.x;
    member.y = ms.y;
    updateCrewVisual(ship, ms, member);
  });
}
