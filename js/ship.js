// ============================================================
// LONGHAUL — Ship Data Model & Cross-Section Renderer
// Expanse-style vertical ship with hull outline, ambient glow
// ============================================================

import { SVG_NS, TileType, renderTile, renderCrewMember, INTERACTIVE_TILES, TILE_NAMES } from './svg-icons.js';

const TILE_SIZE = 32;

// Ship deck definitions — top to bottom (bow to stern)
export function createDefaultShip(crewCount = 4) {
  const T = TileType;

  return {
    name: 'RSV Canterbury',
    decks: [
      {
        name: 'Bridge',
        id: 'bridge',
        glow: { color: 'rgba(91, 192, 235, 0.06)', accent: '#5BC0EB' },
        tiles: [
          [T.EMPTY,     T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.EMPTY],
          [T.HULL_WALL, T.TERMINAL,   T.CRASH_COUCH,T.FLOOR,      T.FLOOR,      T.FLOOR,      T.CRASH_COUCH,T.TERMINAL,   T.HULL_WALL],
          [T.HULL_WALL, T.EVA_LOCKER, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.EVA_LOCKER, T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.LADDER,     T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Quarters',
        id: 'quarters',
        glow: { color: 'rgba(192, 132, 252, 0.04)', accent: '#C084FC' },
        tiles: [
          [T.HULL_WALL, T.TERMINAL,   T.CRASH_COUCH,T.FLOOR,      T.LADDER,     T.FLOOR,      T.CRASH_COUCH,T.TERMINAL,   T.HULL_WALL],
          [T.HULL_WALL, T.EVA_LOCKER, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.EVA_LOCKER, T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.DOOR,       T.FLOOR,      T.MEDBAY,     T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Mess',
        id: 'mess',
        glow: { color: 'rgba(107, 203, 119, 0.04)', accent: '#6BCB77' },
        tiles: [
          [T.HULL_WALL, T.EVA_LOCKER, T.FLOOR,      T.FLOOR,      T.LADDER,     T.FLOOR,      T.FLOOR,      T.EVA_LOCKER, T.HULL_WALL],
          [T.HULL_WALL, T.TERMINAL,   T.CRASH_COUCH,T.FLOOR,      T.FLOOR,      T.FLOOR,      T.CRASH_COUCH,T.TERMINAL,   T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.LIFE_SUPPORT,T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Cargo',
        id: 'cargo',
        glow: { color: 'rgba(79, 209, 197, 0.03)', accent: '#4FD1C5' },
        tiles: [
          [T.HULL_WALL, T.TERMINAL,   T.CRASH_COUCH,T.FLOOR,      T.LADDER,     T.FLOOR,      T.CRASH_COUCH,T.TERMINAL,   T.HULL_WALL],
          [T.HULL_WALL, T.STORAGE,    T.STORAGE,    T.FLOOR,      T.FLOOR,      T.FLOOR,      T.STORAGE,    T.STORAGE,    T.HULL_WALL],
          [T.HULL_WALL, T.STORAGE,    T.EVA_LOCKER, T.FLOOR,      T.AIRLOCK,    T.FLOOR,      T.EVA_LOCKER, T.STORAGE,    T.HULL_WALL],
        ],
      },
      {
        name: 'Engine',
        id: 'engineering',
        glow: { color: 'rgba(226, 163, 85, 0.06)', accent: '#E2A355' },
        tiles: [
          [T.HULL_WALL, T.TERMINAL,   T.CRASH_COUCH,T.FLOOR,      T.LADDER,     T.FLOOR,      T.CRASH_COUCH,T.TERMINAL,   T.HULL_WALL],
          [T.HULL_WALL, T.EVA_LOCKER, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.EVA_LOCKER, T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Reactor',
        id: 'reactor',
        glow: { color: 'rgba(226, 85, 85, 0.06)', accent: '#E25555' },
        tiles: [
          [T.EMPTY,     T.HULL_WALL,  T.HULL_WALL,  T.FLOOR,      T.LADDER,     T.FLOOR,      T.HULL_WALL,  T.HULL_WALL,  T.EMPTY],
          [T.EMPTY,     T.HULL_WALL,  T.EVA_LOCKER, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.EVA_LOCKER, T.HULL_WALL,  T.EMPTY],
          [T.EMPTY,     T.EMPTY,      T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.EMPTY,      T.EMPTY],
        ],
      },
    ],
    crew: generateCrew(crewCount),
  };
}

// Compute overall health from body parts (weighted average)
export function getOverallHealth(member) {
  if (member.dead) return 0;
  const b = member.body;
  return Math.round(
    b.head * 0.25 + b.torso * 0.3 +
    b.leftArm * 0.1 + b.rightArm * 0.1 +
    b.leftLeg * 0.125 + b.rightLeg * 0.125
  );
}

// Role → primary skill affinity (gets a boost)
const ROLE_SKILL_AFFINITY = {
  Captain:    'piloting',
  Pilot:      'piloting',
  Engineer:   'engineering',
  Medic:      'medical',
  Gunner:     'security',
  Mechanic:   'engineering',
  Scientist:  'medical',
  Cook:       'medical',
};

function generateCrew(count) {
  const names = ['Chen', 'Nakamura', 'Okafor', 'Petrov', 'Morales', 'Kim', 'Al-Rashid', 'Johansson'];
  const roles = ['Captain', 'Pilot', 'Engineer', 'Medic', 'Gunner', 'Mechanic', 'Scientist', 'Cook'];
  const crew = [];

  const defaultPositions = [
    { deck: 0, x: 3, y: 1 },   // Captain — Bridge
    { deck: 0, x: 5, y: 1 },   // Pilot — Bridge
    { deck: 4, x: 3, y: 0 },   // Engineer — Engine
    { deck: 2, x: 3, y: 0 },   // Medic — Mess
    { deck: 1, x: 3, y: 1 },   // Gunner — Quarters
    { deck: 3, x: 4, y: 0 },   // Mechanic — Cargo
    { deck: 1, x: 5, y: 1 },   // Scientist — Quarters
    { deck: 4, x: 5, y: 0 },   // Cook — Engine
  ];

  for (let i = 0; i < Math.min(count, 8); i++) {
    const pos = defaultPositions[i];
    const role = roles[i];
    const randSkill = () => 20 + Math.floor(Math.random() * 40); // 20-59 base

    const skills = {
      piloting: randSkill(),
      security: randSkill(),
      engineering: randSkill(),
      medical: randSkill(),
    };
    // Boost primary affinity skill
    const primary = ROLE_SKILL_AFFINITY[role];
    if (primary) skills[primary] = Math.min(100, skills[primary] + 25 + Math.floor(Math.random() * 15));

    crew.push({
      id: i,
      name: names[i],
      role,
      deck: pos.deck,
      x: pos.x,
      y: pos.y,

      // Body part health (0-100 each)
      body: {
        head: 100,
        torso: 100,
        leftArm: 100,
        rightArm: 100,
        leftLeg: 100,
        rightLeg: 100,
      },

      // Cardiovascular system
      heart: {
        health: 100,    // 0-100, degrades under sustained stress
        bpm: 68 + Math.floor(Math.random() * 12), // resting 68-79
        stress: 0,      // 0-100, drives bpm up
        stressMinutes: 0, // minutes of continuous cardiac-stress
        bpSystolic: 120,  // mmHg, normal ~120
        bpDiastolic: 80,  // mmHg, normal ~80
      },

      // Mental state
      consciousness: 100, // 10-100 while alive (bottoms at 10 unless dead)
      morale: 70 + Math.floor(Math.random() * 30),

      // Life state
      dead: false,
      deathTimer: -1, // minutes until death once critical (-1 = not dying)

      // Active status conditions
      conditions: [], // e.g. ['crushed', 'critical', 'dead', 'brain-damage']

      // Skills (0-100)
      skills,
    });
  }

  return crew;
}

// ---- HULL OUTLINE BUILDER ----
// Traces the outer edge of non-empty tiles across all decks

function buildHullPath(ship, offsetX, offsetY, deckGap) {
  // Collect all deck bounding info
  const segments = [];
  let currentY = 0;

  ship.decks.forEach((deck) => {
    const deckStartY = currentY;
    const rows = deck.tiles;

    for (let ry = 0; ry < rows.length; ry++) {
      const row = rows[ry];
      let leftMost = -1;
      let rightMost = -1;

      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== TileType.EMPTY) {
          if (leftMost === -1) leftMost = rx;
          rightMost = rx;
        }
      }

      if (leftMost !== -1) {
        segments.push({
          y: deckStartY + ry,
          left: leftMost,
          right: rightMost + 1,
        });
      }
    }

    currentY += rows.length + deckGap;
  });

  if (segments.length === 0) return '';

  // Build path going down the left side, then up the right side
  const pts = [];
  const T = TILE_SIZE;
  const margin = 3; // pixels outside tiles

  // Left side (top to bottom)
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const x = offsetX + s.left * T - margin;
    const y1 = offsetY + s.y * T;
    const y2 = offsetY + (s.y + 1) * T;

    if (i === 0) {
      pts.push(`M ${offsetX + s.left * T} ${y1 - margin}`);
      pts.push(`L ${x} ${y1}`);
    }

    // Step in/out for width changes
    if (i > 0) {
      const prev = segments[i - 1];
      const prevX = offsetX + prev.left * T - margin;
      if (x !== prevX) {
        pts.push(`L ${prevX} ${offsetY + s.y * T}`);
        pts.push(`L ${x} ${offsetY + s.y * T}`);
      }
    }

    pts.push(`L ${x} ${y2}`);
  }

  // Bottom
  const last = segments[segments.length - 1];
  const bottomY = offsetY + (last.y + 1) * T + margin;
  pts.push(`L ${offsetX + last.left * T} ${bottomY}`);
  pts.push(`L ${offsetX + last.right * T} ${bottomY}`);

  // Right side (bottom to top)
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    const x = offsetX + s.right * T + margin;
    const y1 = offsetY + (s.y + 1) * T;
    const y2 = offsetY + s.y * T;

    pts.push(`L ${x} ${y1}`);

    if (i > 0) {
      const prev = segments[i - 1];
      const prevX = offsetX + prev.right * T + margin;
      if (x !== prevX) {
        pts.push(`L ${x} ${offsetY + s.y * T}`);
        pts.push(`L ${prevX} ${offsetY + s.y * T}`);
      }
    }

    pts.push(`L ${x} ${y2}`);
  }

  // Close at top
  const first = segments[0];
  pts.push(`L ${offsetX + first.right * T} ${offsetY + first.y * T - margin}`);
  pts.push('Z');

  return pts.join(' ');
}

// ---- SHIP RENDERER ----

export function renderShip(ship, container, onCrewClick, onTileClick) {
  container.innerHTML = '';

  const maxWidth = Math.max(...ship.decks.map(d => d.tiles[0].length));
  const totalRows = ship.decks.reduce((sum, d) => sum + d.tiles.length, 0);
  const deckGap = 1;
  const totalHeight = totalRows + (ship.decks.length - 1) * deckGap;
  const labelWidth = 100;

  const svgWidth = maxWidth * TILE_SIZE + labelWidth + 40;
  const svgHeight = totalHeight * TILE_SIZE + 60;

  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.setAttribute('width', svgWidth);
  svgEl.setAttribute('height', svgHeight);
  svgEl.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  svgEl.setAttribute('shape-rendering', 'crispEdges');
  svgEl.style.display = 'block';

  const offsetX = labelWidth;
  const offsetY = 20;

  // --- DEFS (filters for glow) ---
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `
    <filter id="hull-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="ambient-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
  `;
  svgEl.appendChild(defs);

  // --- HULL OUTLINE (behind everything) ---
  const hullPath = buildHullPath(ship, offsetX, offsetY, deckGap);
  if (hullPath) {
    // Hull glow
    const hullGlow = document.createElementNS(SVG_NS, 'path');
    hullGlow.setAttribute('d', hullPath);
    hullGlow.setAttribute('fill', 'none');
    hullGlow.setAttribute('stroke', '#2D5A6A');
    hullGlow.setAttribute('stroke-width', '6');
    hullGlow.setAttribute('filter', 'url(#hull-glow)');
    hullGlow.setAttribute('opacity', '0.3');
    svgEl.appendChild(hullGlow);

    // Hull outline
    const hullOutline = document.createElementNS(SVG_NS, 'path');
    hullOutline.setAttribute('d', hullPath);
    hullOutline.setAttribute('fill', 'none');
    hullOutline.setAttribute('stroke', '#2D5A6A');
    hullOutline.setAttribute('stroke-width', '2');
    hullOutline.setAttribute('opacity', '0.6');
    svgEl.appendChild(hullOutline);
  }

  // --- RENDER DECKS ---
  let currentY = 0;

  ship.decks.forEach((deck, deckIndex) => {
    const deckStartY = currentY;
    const deckHeight = deck.tiles.length;

    // Deck group for hover highlighting
    const deckGroup = document.createElementNS(SVG_NS, 'g');
    deckGroup.setAttribute('class', 'deck-group');
    deckGroup.setAttribute('data-deck', deckIndex);

    // Ambient glow behind this deck
    if (deck.glow) {
      const glowRect = document.createElementNS(SVG_NS, 'rect');
      glowRect.setAttribute('x', offsetX + TILE_SIZE);
      glowRect.setAttribute('y', offsetY + deckStartY * TILE_SIZE);
      glowRect.setAttribute('width', (maxWidth - 2) * TILE_SIZE);
      glowRect.setAttribute('height', deckHeight * TILE_SIZE);
      glowRect.setAttribute('fill', deck.glow.color);
      glowRect.setAttribute('filter', 'url(#ambient-glow)');
      deckGroup.appendChild(glowRect);
    }

    // Deck highlight overlay (shown on hover via CSS)
    const highlight = document.createElementNS(SVG_NS, 'rect');
    highlight.setAttribute('x', offsetX);
    highlight.setAttribute('y', offsetY + deckStartY * TILE_SIZE);
    highlight.setAttribute('width', maxWidth * TILE_SIZE);
    highlight.setAttribute('height', deckHeight * TILE_SIZE);
    highlight.setAttribute('fill', 'rgba(79, 209, 197, 0.03)');
    highlight.setAttribute('class', 'deck-highlight');
    deckGroup.appendChild(highlight);

    // Render tiles
    deck.tiles.forEach((row, ry) => {
      row.forEach((tile, rx) => {
        if (tile !== TileType.EMPTY) {
          const tileGroup = renderTile(tile, 0, 0, null);
          tileGroup.setAttribute('transform',
            `translate(${offsetX + rx * TILE_SIZE}, ${offsetY + (deckStartY + ry) * TILE_SIZE})`);
          // Click handler for interactive tiles
          if (onTileClick && INTERACTIVE_TILES.has(tile)) {
            tileGroup.addEventListener('click', (e) => {
              e.stopPropagation();
              onTileClick(tile, deckIndex, rx, ry);
            });
          }
          deckGroup.appendChild(tileGroup);
        }
      });
    });

    svgEl.appendChild(deckGroup);

    // Deck label (outside the group so it doesn't trigger hover)
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', labelWidth - 10);
    label.setAttribute('y', offsetY + (deckStartY + deckHeight / 2) * TILE_SIZE + 3);
    label.setAttribute('class', 'deck-label');
    label.setAttribute('font-family', '"Press Start 2P", monospace');
    label.setAttribute('font-size', '7');
    label.setAttribute('fill', '#3A4E62');
    label.setAttribute('text-anchor', 'end');
    label.textContent = deck.name.toUpperCase();
    svgEl.appendChild(label);

    // Deck indicator — small colored dot
    const dot = document.createElementNS(SVG_NS, 'rect');
    dot.setAttribute('x', labelWidth - 6);
    dot.setAttribute('y', offsetY + (deckStartY + deckHeight / 2) * TILE_SIZE - 1);
    dot.setAttribute('width', 3);
    dot.setAttribute('height', 3);
    dot.setAttribute('fill', deck.glow ? deck.glow.accent : '#3A4E62');
    dot.setAttribute('opacity', '0.6');
    svgEl.appendChild(dot);

    // Atmosphere status indicator (small dot below deck label)
    const atmoDot = document.createElementNS(SVG_NS, 'rect');
    atmoDot.setAttribute('x', labelWidth - 6);
    atmoDot.setAttribute('y', offsetY + (deckStartY + deckHeight / 2) * TILE_SIZE + 5);
    atmoDot.setAttribute('width', 3);
    atmoDot.setAttribute('height', 3);
    atmoDot.setAttribute('class', 'atmo-indicator');
    atmoDot.setAttribute('data-deck-atmo', deckIndex);
    atmoDot.setAttribute('fill', '#4FD1C5'); // default nominal
    svgEl.appendChild(atmoDot);

    // Deck separator
    if (deckIndex < ship.decks.length - 1) {
      const sepY = offsetY + (deckStartY + deckHeight) * TILE_SIZE + (deckGap * TILE_SIZE) / 2;

      // Structural connectors (small hull pieces between decks)
      const connL = document.createElementNS(SVG_NS, 'rect');
      connL.setAttribute('x', offsetX);
      connL.setAttribute('y', offsetY + (deckStartY + deckHeight) * TILE_SIZE);
      connL.setAttribute('width', TILE_SIZE);
      connL.setAttribute('height', deckGap * TILE_SIZE);
      connL.setAttribute('fill', '#0C1420');
      connL.setAttribute('stroke', '#162030');
      connL.setAttribute('stroke-width', '1');
      svgEl.appendChild(connL);

      const connR = document.createElementNS(SVG_NS, 'rect');
      connR.setAttribute('x', offsetX + (maxWidth - 1) * TILE_SIZE);
      connR.setAttribute('y', offsetY + (deckStartY + deckHeight) * TILE_SIZE);
      connR.setAttribute('width', TILE_SIZE);
      connR.setAttribute('height', deckGap * TILE_SIZE);
      connR.setAttribute('fill', '#0C1420');
      connR.setAttribute('stroke', '#162030');
      connR.setAttribute('stroke-width', '1');
      svgEl.appendChild(connR);

      // Center ladder shaft connector
      const ladderX = 4; // ladder column
      const connC = document.createElementNS(SVG_NS, 'rect');
      connC.setAttribute('x', offsetX + ladderX * TILE_SIZE + 8);
      connC.setAttribute('y', offsetY + (deckStartY + deckHeight) * TILE_SIZE);
      connC.setAttribute('width', TILE_SIZE - 16);
      connC.setAttribute('height', deckGap * TILE_SIZE);
      connC.setAttribute('fill', '#0C1420');
      connC.setAttribute('stroke', '#3A4A5A');
      connC.setAttribute('stroke-width', '0.5');
      svgEl.appendChild(connC);
    }

    currentY += deckHeight + deckGap;
  });

  // --- RENDER CREW (on top of tiles) ---
  const crewLayer = document.createElementNS(SVG_NS, 'g');
  crewLayer.setAttribute('class', 'crew-layer');

  let crewCurrentY = 0;
  ship.decks.forEach((deck, deckIndex) => {
    const deckStartY = crewCurrentY;

    ship.crew.forEach((member, memberIdx) => {
      if (member.deck === deckIndex) {
        const crewEl = renderCrewMember(0, 0, memberIdx, `${member.name} (${member.role})`);
        crewEl.setAttribute('transform',
          `translate(${offsetX + member.x * TILE_SIZE}, ${offsetY + (deckStartY + member.y) * TILE_SIZE})`);
        crewEl.setAttribute('data-crew-id', member.id);

        if (onCrewClick) {
          crewEl.addEventListener('click', () => onCrewClick(member));
        }

        crewLayer.appendChild(crewEl);
      }
    });

    crewCurrentY += deck.tiles.length + deckGap;
  });

  svgEl.appendChild(crewLayer);

  // --- TORCH ENGINE PLUME (below reactor) ---
  // Massive Epstein drive plume: 30% wider than ship, extends way past viewport
  // The ship cross-section shows only the base of the plume — the rest is clipped.
  // Tactical view will show the full scale.
  const hullBottomY = offsetY + (currentY - deckGap) * TILE_SIZE;
  const nozzleHeight = 6 * 4; // nozzleRows * P — nozzle bell height
  const exhaustY = hullBottomY + nozzleHeight; // plume starts at nozzle exit
  const shipWidth = maxWidth * TILE_SIZE;
  const nozzleCenterX = offsetX + maxWidth * TILE_SIZE / 2;

  // Plume is 30% wider than the ship on each side
  const plumeHalfW = shipWidth * 0.65; // 130% of ship width / 2
  const plumeLength = shipWidth * 4;   // 4x ship width long (mostly clipped)

  // Add plume glow filters to defs
  defs.innerHTML += `
    <filter id="torch-glow" x="-100%" y="-50%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="12" result="blur1"/>
      <feGaussianBlur stdDeviation="28" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur2"/>
        <feMergeNode in="blur1"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="torch-bloom" x="-200%" y="-100%" width="500%" height="400%">
      <feGaussianBlur stdDeviation="40"/>
    </filter>
  `;

  const exhaust = document.createElementNS(SVG_NS, 'g');
  exhaust.setAttribute('class', 'engine-exhaust');
  exhaust.setAttribute('id', 'engine-plume');
  exhaust.setAttribute('display', 'none'); // OFF by default
  exhaust.setAttribute('shape-rendering', 'crispEdges'); // 8-bit blocky style

  // Plume shape: fireball near nozzle (fast expansion) + long tapered tail
  const nozzleHalfW = 1.25 * TILE_SIZE; // matches nozzle bottom opening (half of nozzleBotW)
  const fireballLen = plumeLength * 0.15;
  const tailLen = plumeLength * 0.85;
  const peakW = nozzleHalfW + (plumeHalfW - nozzleHalfW) * Math.sin(0.7 * Math.PI);

  // Helper: compute plume half-width at a given distance from nozzle
  function plumeWidthAt(dist) {
    if (dist <= 0) return nozzleHalfW;
    if (dist < fireballLen) {
      const ft = dist / fireballLen;
      return nozzleHalfW + (plumeHalfW - nozzleHalfW) * Math.sin(ft * Math.PI * 0.7);
    }
    const tt = (dist - fireballLen) / tailLen;
    return Math.max(2, peakW * Math.pow(1 - Math.min(tt, 1), 0.6));
  }

  // Build smooth plume outline as a polygon path
  const numPoints = 60;
  const leftPts = [];
  const rightPts = [];

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const dist = t * plumeLength;
    const y = exhaustY + dist;
    const w = plumeWidthAt(dist);
    leftPts.push(`${nozzleCenterX - w},${y}`);
    rightPts.push(`${nozzleCenterX + w},${y}`);
  }

  // Plume outline: down the left side, back up the right side
  rightPts.reverse();
  const outlinePath = `M ${leftPts[0]} L ${leftPts.slice(1).join(' L ')}`
    + ` L ${rightPts.join(' L ')} Z`;

  // Add gradient defs for plume layers
  const plumeGradId = 'plume-grad-main';
  const plumeGlowGradId = 'plume-grad-glow';
  defs.innerHTML += `
    <linearGradient id="${plumeGradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
      <stop offset="5%" stop-color="#FFFFFF" stop-opacity="0.85"/>
      <stop offset="12%" stop-color="#E0E8FF" stop-opacity="0.7"/>
      <stop offset="20%" stop-color="#C0D8FF" stop-opacity="0.5"/>
      <stop offset="40%" stop-color="#80B0FF" stop-opacity="0.3"/>
      <stop offset="70%" stop-color="#5090FF" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#3060CC" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="${plumeGlowGradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.5"/>
      <stop offset="10%" stop-color="#D0E8FF" stop-opacity="0.3"/>
      <stop offset="30%" stop-color="#80C0FF" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#4080FF" stop-opacity="0"/>
    </linearGradient>
  `;

  const sections = [];

  // Outer glow layer (wider, softer)
  sections.push(`<path d="${outlinePath}" fill="url(#${plumeGlowGradId})"
    filter="url(#torch-glow)" opacity="0.6">
    <animate attributeName="opacity" values="0.4;0.7;0.4" dur="0.15s" repeatCount="indefinite"/>
  </path>`);

  // Main plume shape
  sections.push(`<path d="${outlinePath}" fill="url(#${plumeGradId})" opacity="0.9">
    <animate attributeName="opacity" values="0.8;0.95;0.8" dur="0.08s" repeatCount="indefinite"/>
  </path>`);

  // Inner core: narrower, white-hot near nozzle
  const corePoints = 30;
  const coreLeftPts = [];
  const coreRightPts = [];
  const coreLen = fireballLen * 1.5;
  for (let i = 0; i <= corePoints; i++) {
    const t = i / corePoints;
    const dist = t * coreLen;
    const y = exhaustY + dist;
    const w = plumeWidthAt(dist) * (0.4 - t * 0.25);
    coreLeftPts.push(`${nozzleCenterX - Math.max(w, 1)},${y}`);
    coreRightPts.push(`${nozzleCenterX + Math.max(w, 1)},${y}`);
  }

  coreRightPts.reverse();
  const corePath = `M ${coreLeftPts[0]} L ${coreLeftPts.slice(1).join(' L ')}`
    + ` L ${coreRightPts.join(' L ')} Z`;

  sections.push(`<path d="${corePath}" fill="#FFFFFF" opacity="0.8">
    <animate attributeName="opacity" values="0.7;0.9;0.7" dur="0.05s" repeatCount="indefinite"/>
  </path>`);

  // Exhaust particles (streaming downward)
  for (let i = 0; i < 10; i++) {
    const px = nozzleCenterX + (Math.random() - 0.5) * plumeHalfW * 0.6;
    const startY = exhaustY + Math.random() * fireballLen * 0.5;
    const endY = exhaustY + fireballLen + Math.random() * tailLen * 0.4;
    const dur = (0.3 + Math.random() * 0.5).toFixed(2);
    const begin = (Math.random() * 0.6).toFixed(2);
    const colors = ['#FFFFFF', '#D0E8FF', '#8ECAFF', '#FFFFFF', '#B0D0FF'];
    sections.push(`<circle cx="${px}" cy="${startY}" r="${1 + Math.random()}" fill="${colors[i % 5]}" opacity="0">
      <animate attributeName="opacity" values="0;0.8;0.3;0" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
      <animate attributeName="cy" values="${startY};${endY}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
    </circle>`);
  }

  // Fireball bloom glow (soft elliptical wash)
  sections.push(`<ellipse cx="${nozzleCenterX}" cy="${exhaustY + fireballLen * 0.35}"
    rx="${plumeHalfW * 1.4}" ry="${fireballLen * 0.8}"
    fill="#FFFFFF" opacity="0.05" filter="url(#torch-bloom)">
    <animate attributeName="opacity" values="0.03;0.07;0.03" dur="0.2s" repeatCount="indefinite"/>
  </ellipse>`);

  exhaust.innerHTML = sections.join('\n');
  svgEl.appendChild(exhaust);

  // Nozzle bell — always visible, pixel-art style, flush under reactor hull
  // Reactor bottom is 5 tiles wide (cols 2-6), nozzle tapers from that width
  const nozzle = document.createElementNS(SVG_NS, 'g');
  nozzle.setAttribute('id', 'engine-nozzle');
  const P = 4; // pixel size for 8-bit look
  const nozzleTopW = 5 * TILE_SIZE; // matches reactor bottom (160px)
  const nozzleBotW = 2.5 * TILE_SIZE; // narrows to exhaust opening (80px)
  const nozzleRows = 6; // 6 rows of pixels tall
  const nozzleTopX = nozzleCenterX - nozzleTopW / 2;
  const nozzleTopY = hullBottomY; // flush against hull bottom

  // Build stepped trapezoid (wide top, narrower bottom) — pixel staircase
  const nozzleParts = [];
  for (let row = 0; row < nozzleRows; row++) {
    const t = row / (nozzleRows - 1);
    const rowW = nozzleTopW - t * (nozzleTopW - nozzleBotW);
    const rx = nozzleCenterX - rowW / 2;
    const ry = nozzleTopY + row * P;
    // Outer shell
    const shade = Math.round(14 + t * 8);
    const highlight = Math.round(35 + t * 15);
    nozzleParts.push(`<rect x="${rx}" y="${ry}" width="${rowW}" height="${P}"
      fill="rgb(${shade},${shade + 12},${shade + 20})"
      stroke="rgb(${highlight},${highlight + 20},${highlight + 30})" stroke-width="0.5"/>`);
  }

  // Inner bore (dark center channel)
  const boreW = nozzleBotW * 0.5;
  const boreX = nozzleCenterX - boreW / 2;
  nozzleParts.push(`<rect x="${boreX}" y="${nozzleTopY + P}" width="${boreW}" height="${(nozzleRows - 1) * P}"
    fill="#060C14" opacity="0.7"/>`);

  // Mounting bolts (small accent squares at top corners)
  const boltSize = 3;
  const boltY = nozzleTopY + 1;
  nozzleParts.push(`<rect x="${nozzleTopX + 4}" y="${boltY}" width="${boltSize}" height="${boltSize}" fill="#3A5A6A"/>`);
  nozzleParts.push(`<rect x="${nozzleTopX + nozzleTopW - 4 - boltSize}" y="${boltY}" width="${boltSize}" height="${boltSize}" fill="#3A5A6A"/>`);
  nozzleParts.push(`<rect x="${nozzleCenterX - boreW / 2 - 8}" y="${boltY}" width="${boltSize}" height="${boltSize}" fill="#2A4A5A"/>`);
  nozzleParts.push(`<rect x="${nozzleCenterX + boreW / 2 + 5}" y="${boltY}" width="${boltSize}" height="${boltSize}" fill="#2A4A5A"/>`);

  nozzle.innerHTML = nozzleParts.join('\n');
  svgEl.appendChild(nozzle);

  container.appendChild(svgEl);
}

// ---- TACTICAL VIEW RENDERER ----
// Three zoom levels. Ship centered. Plume = fireball near ship + long taper.
// At far zoom ship is a dot and the plume is a blazing sun.

// Zoom configs: scale multiplier, range label, ship render mode
const TAC_ZOOM_LEVELS = [
  { scale: 1,   range: '1 km',   shipMode: 'hull' },   // Close: hull outline visible
  { scale: 5,   range: '5 km',   shipMode: 'icon' },   // Medium: ship is small icon, full plume
  { scale: 25,  range: '25 km',  shipMode: 'dot' },    // Far: ship is dot, plume is a star
];

export function renderTacView(ship, container, thrustActive, zoomLevel = 0, flipping = false, velocity = 0) {
  container.innerHTML = '';

  const viewW = container.clientWidth || 186;
  const viewH = container.clientHeight || 220;
  const zoom = TAC_ZOOM_LEVELS[zoomLevel];

  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.setAttribute('width', viewW);
  svgEl.setAttribute('height', viewH);
  svgEl.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
  svgEl.setAttribute('shape-rendering', 'crispEdges');
  svgEl.style.display = 'block';

  const cx = viewW / 2;
  const cy = viewH / 2;

  // Defs (filters)
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `
    <filter id="tac-glow" x="-100%" y="-50%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
    <filter id="tac-bloom" x="-200%" y="-100%" width="500%" height="400%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
    <filter id="tac-sun" x="-300%" y="-300%" width="700%" height="700%">
      <feGaussianBlur stdDeviation="20"/>
    </filter>
  `;
  svgEl.appendChild(defs);

  // Grid
  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('opacity', '0.06');
  const gridSpacing = viewW / (4 + zoomLevel * 2);
  for (let x = cx % gridSpacing; x < viewW; x += gridSpacing) {
    gridGroup.innerHTML += `<line x1="${x}" y1="0" x2="${x}" y2="${viewH}" stroke="#4FD1C5" stroke-width="0.5"/>`;
  }
  for (let y = cy % gridSpacing; y < viewH; y += gridSpacing) {
    gridGroup.innerHTML += `<line x1="0" y1="${y}" x2="${viewW}" y2="${y}" stroke="#4FD1C5" stroke-width="0.5"/>`;
  }
  svgEl.appendChild(gridGroup);

  // Range rings
  const ringGroup = document.createElementNS(SVG_NS, 'g');
  ringGroup.setAttribute('opacity', '0.05');
  const ringSpacing = viewW / (3 + zoomLevel);
  for (let r = ringSpacing; r < viewW; r += ringSpacing) {
    ringGroup.innerHTML += `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="none" stroke="#4FD1C5" stroke-width="0.5"/>`;
  }
  svgEl.appendChild(ringGroup);

  // Crosshair
  const chGroup = document.createElementNS(SVG_NS, 'g');
  chGroup.setAttribute('opacity', '0.08');
  chGroup.innerHTML = `
    <line x1="${cx}" y1="0" x2="${cx}" y2="${viewH}" stroke="#4FD1C5" stroke-width="0.5"/>
    <line x1="0" y1="${cy}" x2="${viewW}" y2="${cy}" stroke="#4FD1C5" stroke-width="0.5"/>
  `;
  svgEl.appendChild(chGroup);

  // ---- COMPUTE SHIP DIMENSIONS ----
  const deckGapTac = 1;
  const hullPath = buildHullPath(ship, 0, 0, deckGapTac);
  const maxTileCols = Math.max(...ship.decks.map(d => d.tiles[0].length));
  const totalTileRows = ship.decks.reduce((sum, d) => sum + d.tiles.length, 0);
  const totalWithGaps = totalTileRows + (ship.decks.length - 1) * deckGapTac;
  const hullRawW = maxTileCols * TILE_SIZE;
  const hullRawH = totalWithGaps * TILE_SIZE;

  // Ship size at each zoom: close = ~16px wide, gets smaller with zoom
  const shipPixelW = Math.max(2, 16 / zoom.scale);
  const scaleFactor = shipPixelW / hullRawW;
  const shipPixelH = hullRawH * scaleFactor;

  // ---- PLUME (rendered behind ship) ----
  if (thrustActive) {
    const plumeGroup = document.createElementNS(SVG_NS, 'g');
    const nozzleY = cy + shipPixelH / 2;

    // Plume geometry: fireball near ship then long taper
    // Fireball = 2x ship length, width = wider than ship
    // Total plume = 15x ship length
    const fireballLen = shipPixelH * 2;
    const fireballHalfW = shipPixelW * 2.5; // much wider than ship
    const tailLen = shipPixelH * 13;
    const totalPlumeLen = fireballLen + tailLen;

    if (zoom.shipMode === 'dot') {
      // FAR ZOOM: plume is a blazing star
      const starR = Math.min(viewW, viewH) * 0.3;
      plumeGroup.innerHTML += `
        <ellipse cx="${cx}" cy="${cy + 2}" rx="${starR}" ry="${starR * 1.3}"
          fill="#FFFFFF" opacity="0.06" filter="url(#tac-sun)">
          <animate attributeName="opacity" values="0.03;0.08;0.03" dur="0.3s" repeatCount="indefinite"/>
        </ellipse>
        <ellipse cx="${cx}" cy="${cy + 2}" rx="${starR * 0.5}" ry="${starR * 0.7}"
          fill="#D0E8FF" opacity="0.1" filter="url(#tac-bloom)">
          <animate attributeName="opacity" values="0.06;0.14;0.06" dur="0.2s" repeatCount="indefinite"/>
        </ellipse>
        <ellipse cx="${cx}" cy="${cy + 1}" rx="${starR * 0.15}" ry="${starR * 0.2}"
          fill="#FFFFFF" opacity="0.7" filter="url(#tac-glow)">
          <animate attributeName="opacity" values="0.5;0.8;0.5" dur="0.1s" repeatCount="indefinite"/>
        </ellipse>
        <rect x="${cx - 1}" y="${cy}" width="2" height="2" fill="#FFFFFF" opacity="1">
          <animate attributeName="opacity" values="0.8;1;0.8" dur="0.08s" repeatCount="indefinite"/>
        </rect>
      `;
    } else {
      // CLOSE / MEDIUM: render fireball + tail shape
      const numSections = 24;
      const sections = [];

      for (let i = 0; i < numSections; i++) {
        const t = i / numSections;
        const dist = t * totalPlumeLen;
        const y = nozzleY + dist;
        const h = totalPlumeLen / numSections + 0.5;

        // Width profile: expands fast to fireball, then tapers
        let halfW;
        const fireballT = dist / fireballLen; // 0-1 within fireball zone
        if (dist < fireballLen) {
          // Fireball: fast expansion with peak ~60% through
          halfW = fireballHalfW * Math.sin(fireballT * Math.PI * 0.7);
          halfW = Math.max(halfW, 1);
        } else {
          // Tail: gradual taper from fireball width
          const tailT = (dist - fireballLen) / tailLen;
          const startW = fireballHalfW * Math.sin(0.7 * Math.PI);
          halfW = startW * Math.pow(1 - tailT, 0.7);
          halfW = Math.max(halfW, 0.5);
        }

        // Color: white core → blue-white → blue → dim blue
        let color, opacity;
        if (dist < fireballLen * 0.3) {
          color = '#FFFFFF';
          opacity = 0.9 - t * 0.5;
        } else if (dist < fireballLen) {
          const ft = (dist - fireballLen * 0.3) / (fireballLen * 0.7);
          const r = Math.round(255 - ft * 60);
          const g = Math.round(255 - ft * 30);
          color = `rgb(${r},${g},255)`;
          opacity = 0.7 - ft * 0.3;
        } else {
          const tt = (dist - fireballLen) / tailLen;
          const r = Math.round(195 - tt * 100);
          const g = Math.round(225 - tt * 80);
          color = `rgb(${Math.max(60, r)},${Math.max(100, g)},255)`;
          opacity = Math.max(0.02, 0.4 - tt * 0.38);
        }

        sections.push(`<rect x="${cx - halfW}" y="${y}" width="${halfW * 2}" height="${h}"
          fill="${color}" opacity="${opacity.toFixed(3)}">
          <animate attributeName="opacity"
            values="${(opacity * 0.8).toFixed(3)};${opacity.toFixed(3)};${(opacity * 0.8).toFixed(3)}"
            dur="${(0.05 + t * 0.15).toFixed(2)}s" repeatCount="indefinite"/>
        </rect>`);
      }

      // White-hot nozzle core
      const coreLen = fireballLen * 0.3;
      for (let i = 0; i < 5; i++) {
        const t = i / 5;
        const y = nozzleY + t * coreLen;
        const h = coreLen / 5 + 0.5;
        const halfW = Math.max(1, shipPixelW * 0.4 * (1 + t * 2));
        const op = 1.0 - t * 0.2;
        sections.push(`<rect x="${cx - halfW}" y="${y}" width="${halfW * 2}" height="${h}"
          fill="#FFFFFF" opacity="${op.toFixed(2)}">
          <animate attributeName="opacity"
            values="${(op * 0.9).toFixed(2)};${op.toFixed(2)};${(op * 0.9).toFixed(2)}"
            dur="0.05s" repeatCount="indefinite"/>
        </rect>`);
      }

      // Fireball bloom
      sections.push(`<ellipse cx="${cx}" cy="${nozzleY + fireballLen * 0.4}"
        rx="${fireballHalfW * 1.2}" ry="${fireballLen * 0.6}"
        fill="#FFFFFF" opacity="0.05" filter="url(#tac-bloom)">
        <animate attributeName="opacity" values="0.03;0.07;0.03" dur="0.2s" repeatCount="indefinite"/>
      </ellipse>`);

      // Nozzle flash
      sections.push(`<ellipse cx="${cx}" cy="${nozzleY + 1}"
        rx="${shipPixelW * 0.6}" ry="${shipPixelW * 0.3}"
        fill="#FFFFFF" opacity="0.4" filter="url(#tac-glow)">
        <animate attributeName="opacity" values="0.3;0.5;0.3" dur="0.1s" repeatCount="indefinite"/>
      </ellipse>`);

      plumeGroup.innerHTML = sections.join('\n');
    }

    svgEl.appendChild(plumeGroup);
  }

  // ---- SHIP ----
  const shipGroup = document.createElementNS(SVG_NS, 'g');

  if (zoom.shipMode === 'hull' && hullPath) {
    // Close zoom: actual hull outline
    const tx = cx - (hullRawW * scaleFactor) / 2;
    const ty = cy - (hullRawH * scaleFactor) / 2;

    const hullEl = document.createElementNS(SVG_NS, 'path');
    hullEl.setAttribute('d', hullPath);
    hullEl.setAttribute('fill', '#0C1420');
    hullEl.setAttribute('stroke', '#2D5A6A');
    hullEl.setAttribute('stroke-width', `${1 / scaleFactor}`);
    hullEl.setAttribute('transform', `translate(${tx},${ty}) scale(${scaleFactor})`);
    shipGroup.appendChild(hullEl);

    const hullGlow = document.createElementNS(SVG_NS, 'path');
    hullGlow.setAttribute('d', hullPath);
    hullGlow.setAttribute('fill', 'none');
    hullGlow.setAttribute('stroke', '#3D7A8A');
    hullGlow.setAttribute('stroke-width', `${2 / scaleFactor}`);
    hullGlow.setAttribute('opacity', '0.3');
    hullGlow.setAttribute('transform', `translate(${tx},${ty}) scale(${scaleFactor})`);
    shipGroup.appendChild(hullGlow);

    // Label next to ship
    const labelEl = document.createElementNS(SVG_NS, 'text');
    labelEl.setAttribute('x', cx + shipPixelW / 2 + 4);
    labelEl.setAttribute('y', cy + 2);
    labelEl.setAttribute('font-family', '"Press Start 2P", monospace');
    labelEl.setAttribute('font-size', '4');
    labelEl.setAttribute('fill', '#3A4E62');
    labelEl.textContent = ship.name.substring(0, 10).toUpperCase();
    shipGroup.appendChild(labelEl);
  } else if (zoom.shipMode === 'icon') {
    // Medium zoom: small diamond icon
    const s = 3;
    shipGroup.innerHTML += `
      <polygon points="${cx},${cy - s} ${cx + s * 0.6},${cy} ${cx},${cy + s} ${cx - s * 0.6},${cy}"
        fill="#1A2A3A" stroke="#3D7A8A" stroke-width="0.5"/>
    `;
  }
  // dot mode: blinking dot only (below)

  // RCS thrusters (close zoom only, during flip)
  if (flipping && zoom.shipMode === 'hull') {
    const rcsGroup = document.createElementNS(SVG_NS, 'g');
    const rcsW = 3;
    const rcsH = 1.5;
    // 4 corners: top-left fires left, top-right fires right, etc.
    const rcsPositions = [
      { x: cx - shipPixelW / 2 - rcsW, y: cy - shipPixelH / 2 + 1, },
      { x: cx + shipPixelW / 2, y: cy - shipPixelH / 2 + 1, },
      { x: cx - shipPixelW / 2 - rcsW, y: cy + shipPixelH / 2 - 2, },
      { x: cx + shipPixelW / 2, y: cy + shipPixelH / 2 - 2, },
    ];
    rcsPositions.forEach(pos => {
      rcsGroup.innerHTML += `
        <rect x="${pos.x}" y="${pos.y}" width="${rcsW}" height="${rcsH}"
          fill="#E2A355" opacity="0.9">
          <animate attributeName="opacity" values="0.5;1;0.5" dur="0.08s" repeatCount="indefinite"/>
        </rect>
      `;
    });
    shipGroup.appendChild(rcsGroup);
  }

  // Blinking center dot (always visible)
  const dotSize = zoom.shipMode === 'dot' ? 2 : 1;
  shipGroup.innerHTML += `
    <rect x="${cx - dotSize / 2}" y="${cy - dotSize / 2}" width="${dotSize}" height="${dotSize}" fill="#4FD1C5" opacity="0.9">
      <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" repeatCount="indefinite"/>
    </rect>
  `;
  svgEl.appendChild(shipGroup);

  // Movement particles — driven by velocity vector
  // velocity > 0 → particles flow down (we're moving "up"), < 0 → flow up
  const absVel = Math.abs(velocity);
  const tacSpeedFactor = Math.min(1, absVel / 100000);

  if (absVel > 1) {
    const movGroup = document.createElementNS(SVG_NS, 'g');
    movGroup.setAttribute('opacity', String(0.08 + tacSpeedFactor * 0.15));
    const flowDir = velocity > 0 ? 1 : -1;
    const numDust = Math.round(6 + tacSpeedFactor * 10);
    const streakBase = 1 + tacSpeedFactor * 6;
    const travelDist = 10 + tacSpeedFactor * 30;

    for (let i = 0; i < numDust; i++) {
      const px = Math.random() * viewW;
      const streakLen = streakBase + Math.random() * streakBase;
      const startY = flowDir > 0
        ? Math.random() * viewH * 0.5
        : viewH * 0.5 + Math.random() * viewH * 0.5;
      const endY = startY + flowDir * travelDist * (0.7 + Math.random() * 0.6);
      const dur = (1.5 + Math.random() * 2 - tacSpeedFactor).toFixed(2);
      const begin = (Math.random() * 3).toFixed(2);
      movGroup.innerHTML += `
        <rect x="${px}" y="${startY}" width="1" height="${streakLen}" fill="#4FD1C5" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0.2;0" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
          <animate attributeName="y" values="${startY};${endY}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
        </rect>
      `;
    }
    svgEl.appendChild(movGroup);
  }

  container.appendChild(svgEl);
}
