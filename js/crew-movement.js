// ============================================================
// LONGHAUL — Crew Movement System
// Crew patrol their decks, walking circuits around floor tiles.
// Speed depends on G-force: float at half speed, walk normally,
// slow above 1G, stop when crushed.
// ============================================================

import { TileType } from './svg-icons.js';

const TILE_SIZE = 32;
const OFFSET_X = 100; // labelWidth in ship.js
const OFFSET_Y = 20;
const DECK_GAP = 1;

// Tiles crew can walk/float through
const WALKABLE = new Set([
  TileType.FLOOR,
  TileType.DOOR,
  TileType.LADDER,
]);

// Base movement speed in tiles per second (at 1x game speed)
const BASE_SPEED = 0.5;

// Per-crew movement state
const moveState = new Map();

// ---- WALKABLE TILE ANALYSIS ----

function getFloorTiles(deck) {
  const tiles = [];
  deck.tiles.forEach((row, ry) => {
    row.forEach((tile, rx) => {
      if (WALKABLE.has(tile)) tiles.push({ x: rx, y: ry });
    });
  });
  return tiles;
}

// Pick 4 corner-ish waypoints from floor tiles to form a patrol circuit
function pickPatrolCorners(floorTiles) {
  if (floorTiles.length < 2) return floorTiles.slice();

  const xs = floorTiles.map(t => t.x);
  const ys = floorTiles.map(t => t.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  // Target the 4 corners, offset inward slightly to avoid hull column
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

// Cumulative tile-row offset for a given deck index
function deckStartY(ship, deckIdx) {
  let y = 0;
  for (let i = 0; i < deckIdx; i++) {
    y += ship.decks[i].tiles.length + DECK_GAP;
  }
  return y;
}

// ---- SPEED CALCULATION ----

function crewSpeed(gState, gForce) {
  switch (gState) {
    case 'floating':
      return BASE_SPEED * 0.5;
    case 'standing':
      // Normal up to 1G, gradually slower above
      if (gForce <= 1.0) return BASE_SPEED;
      return BASE_SPEED * Math.max(0.2, 1.0 - (gForce - 1.0) * 1.5);
    case 'strained':
      return BASE_SPEED * 0.1;
    default: // prone, secured
      return 0;
  }
}

// ---- PUBLIC API ----

export function initCrewMovement(ship) {
  moveState.clear();

  const deckFloors = ship.decks.map(d => getFloorTiles(d));

  ship.crew.forEach(member => {
    const corners = pickPatrolCorners(deckFloors[member.deck]);
    // Start heading to a random corner
    const startIdx = Math.floor(Math.random() * corners.length);

    moveState.set(member.id, {
      x: member.x,
      y: member.y,
      deckIdx: member.deck,
      waypoints: corners,
      wpIdx: startIdx,
      pause: 1 + Math.random() * 4, // stagger initial movement
      segDist: 0,   // total distance of current segment
      traveled: 0,  // distance traveled along current segment
    });
  });
}

// Call every animation frame. deltaSec = real-time seconds since last call.
// gameSpeed = current game speed multiplier (0=paused, 1=normal, 2=fast, 3=fastest).
export function updateCrewMovement(ship, physics, deltaSec, gameSpeed) {
  if (gameSpeed === 0) return; // paused
  if (physics.flipping) return; // crew brace during flip

  // Scale movement with game speed, but cap so crew don't teleport
  const speedScale = [0, 1, 4, 10][gameSpeed] || 0;
  const dt = Math.min(deltaSec * speedScale, 0.5);

  ship.crew.forEach(member => {
    const ms = moveState.get(member.id);
    if (!ms || ms.waypoints.length < 2) return;

    const gState = physics.crewStates[member.id] || 'floating';
    const speed = crewSpeed(gState, physics.gForce);
    if (speed === 0) return;

    // Pause at each waypoint
    if (ms.pause > 0) {
      ms.pause -= dt;
      return;
    }

    const target = ms.waypoints[ms.wpIdx];
    const dx = target.x - ms.x;
    const dy = target.y - ms.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Compute total segment distance on first frame of this segment
    if (ms.segDist === 0) {
      ms.segDist = dist;
      ms.traveled = 0;
    }

    if (dist < 0.06) {
      // Arrived — snap and pick next waypoint
      ms.x = target.x;
      ms.y = target.y;
      member.x = target.x;
      member.y = target.y;
      ms.wpIdx = (ms.wpIdx + 1) % ms.waypoints.length;
      ms.pause = 1.5 + Math.random() * 3;
      ms.segDist = 0;
      ms.traveled = 0;
      return;
    }

    // Ease-in-out: smooth acceleration and deceleration
    const t = ms.segDist > 0 ? ms.traveled / ms.segDist : 0;
    const easeMultiplier = t < 0.15
      ? 0.3 + (t / 0.15) * 0.7           // ease-in: ramp up over first 15%
      : t > 0.8
        ? 0.3 + ((1 - t) / 0.2) * 0.7    // ease-out: ramp down over last 20%
        : 1.0;                              // full speed in the middle

    const step = Math.min(speed * easeMultiplier * dt, dist);
    ms.x += (dx / dist) * step;
    ms.y += (dy / dist) * step;
    ms.traveled += step;

    // Update SVG transform — straight slide, no bobbing
    const el = document.querySelector(`[data-crew-id="${member.id}"]`);
    if (el) {
      const dsy = deckStartY(ship, ms.deckIdx);
      const px = OFFSET_X + ms.x * TILE_SIZE;
      const py = OFFSET_Y + (dsy + ms.y) * TILE_SIZE;
      el.setAttribute('transform', `translate(${px}, ${py})`);
    }
  });
}
