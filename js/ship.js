// ============================================================
// LONGHAUL — Ship Data Model & Cross-Section Renderer
// Expanse-style vertical ship with hull outline, ambient glow
// ============================================================

import { SVG_NS, TileType, renderTile, renderCrewMember, INTERACTIVE_TILES, TILE_NAMES } from './svg-icons.js';

const TILE_SIZE = 32;

// ---- Caches for renderTacView (computed once per ship layout) ----
let _cachedHullPath = null;
let _cachedHullDeckCount = -1;
let _cachedMaxTileCols = -1;
let _cachedMaxTileColsDeckCount = -1;

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
          [T.HULL_WALL, T.RADIO,      T.CRASH_COUCH,T.FLOOR,      T.FLOOR,      T.FLOOR,      T.CRASH_COUCH,T.TRANSPONDER,T.HULL_WALL],
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
          [T.EMPTY,     T.HULL_WALL,  T.EVA_LOCKER, T.FLOOR,      T.REACTOR,    T.FLOOR,      T.EVA_LOCKER, T.HULL_WALL,  T.EMPTY],
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
      conditions: [], // e.g. ['crushed', 'critical', 'dead', 'brain-damage', 'juice-hangover']
      juiceHangover: 0, // minutes remaining of juice hangover (increases brain damage risk under G)

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

  // --- EXTERIOR HULL VIEW (shown during fast-forward / pause) ---
  const exteriorGroup = document.createElementNS(SVG_NS, 'g');
  exteriorGroup.setAttribute('class', 'ship-exterior');
  exteriorGroup.setAttribute('display', 'none');
  {
    const T = TILE_SIZE;
    const ox = offsetX;
    const oy = offsetY;
    const W = maxWidth;
    // Colors for hull plating
    const hullDk = '#0E1E2E';
    const hullMd = '#142838';
    const hullLt = '#1A3248';
    const hullAcc = '#223C50';
    const rivet = '#2A4A60';
    const panel = '#162E40';
    const glow = '#2D5A6A';
    const porthole = '#1A3A4A';
    const portholeGlow = '#3A8A9A';

    // Fill the hull shape with dark plating
    if (hullPath) {
      const hullFill = document.createElementNS(SVG_NS, 'path');
      hullFill.setAttribute('d', hullPath);
      hullFill.setAttribute('fill', hullDk);
      hullFill.setAttribute('stroke', 'none');
      exteriorGroup.appendChild(hullFill);
    }

    // Armor panel grid — horizontal and vertical seam lines
    let ey = 0;
    ship.decks.forEach((deck, di) => {
      const rows = deck.tiles.length;

      // Find deck width bounds
      let deckLeft = W, deckRight = 0;
      deck.tiles.forEach(row => {
        row.forEach((tile, rx) => {
          if (tile !== TileType.EMPTY) {
            if (rx < deckLeft) deckLeft = rx;
            if (rx > deckRight) deckRight = rx;
          }
        });
      });
      const dLeft = ox + deckLeft * T;
      const dRight = ox + (deckRight + 1) * T;
      const dTop = oy + ey * T;
      const dBottom = oy + (ey + rows) * T;
      const dW = dRight - dLeft;
      const dH = dBottom - dTop;

      // Panel fill with slight variation per deck
      const panelFill = document.createElementNS(SVG_NS, 'rect');
      panelFill.setAttribute('x', dLeft);
      panelFill.setAttribute('y', dTop);
      panelFill.setAttribute('width', dW);
      panelFill.setAttribute('height', dH);
      panelFill.setAttribute('fill', di % 2 === 0 ? hullMd : panel);
      panelFill.setAttribute('opacity', '0.6');
      exteriorGroup.appendChild(panelFill);

      // Horizontal seam lines (between tile rows)
      for (let r = 1; r < rows; r++) {
        const seamY = dTop + r * T;
        const seam = document.createElementNS(SVG_NS, 'line');
        seam.setAttribute('x1', dLeft + 2);
        seam.setAttribute('y1', seamY);
        seam.setAttribute('x2', dRight - 2);
        seam.setAttribute('y2', seamY);
        seam.setAttribute('stroke', hullAcc);
        seam.setAttribute('stroke-width', '0.5');
        seam.setAttribute('opacity', '0.4');
        exteriorGroup.appendChild(seam);
      }

      // Vertical seam lines (panel divisions — every 2 tiles)
      for (let c = deckLeft + 2; c <= deckRight; c += 2) {
        const seamX = ox + c * T;
        if (seamX <= dLeft || seamX >= dRight) continue;
        const seam = document.createElementNS(SVG_NS, 'line');
        seam.setAttribute('x1', seamX);
        seam.setAttribute('y1', dTop + 2);
        seam.setAttribute('x2', seamX);
        seam.setAttribute('y2', dBottom - 2);
        seam.setAttribute('stroke', hullAcc);
        seam.setAttribute('stroke-width', '0.5');
        seam.setAttribute('opacity', '0.3');
        exteriorGroup.appendChild(seam);
      }

      // Rivets along left and right hull edges
      for (let r = 0; r < rows; r++) {
        const ry = dTop + r * T + T / 2;
        // Left rivets
        const rL = document.createElementNS(SVG_NS, 'rect');
        rL.setAttribute('x', dLeft + 3);
        rL.setAttribute('y', ry - 1);
        rL.setAttribute('width', 2);
        rL.setAttribute('height', 2);
        rL.setAttribute('fill', rivet);
        rL.setAttribute('opacity', '0.5');
        exteriorGroup.appendChild(rL);
        // Right rivets
        const rR = document.createElementNS(SVG_NS, 'rect');
        rR.setAttribute('x', dRight - 5);
        rR.setAttribute('y', ry - 1);
        rR.setAttribute('width', 2);
        rR.setAttribute('height', 2);
        rR.setAttribute('fill', rivet);
        rR.setAttribute('opacity', '0.5');
        exteriorGroup.appendChild(rR);
      }

      // Portholes (small lit windows) — 2-3 per deck, offset per deck
      const phCount = di === 0 ? 3 : di === 5 ? 1 : 2;
      const phStart = di % 2 === 0 ? 2 : 3;
      for (let p = 0; p < phCount; p++) {
        const phX = ox + (deckLeft + phStart + p * 2) * T + T / 2 - 3;
        const phY = dTop + Math.floor(rows / 2) * T + T / 2 - 2;
        // Dark window frame
        const frame = document.createElementNS(SVG_NS, 'rect');
        frame.setAttribute('x', phX - 1);
        frame.setAttribute('y', phY - 1);
        frame.setAttribute('width', 8);
        frame.setAttribute('height', 6);
        frame.setAttribute('fill', porthole);
        frame.setAttribute('rx', '1');
        exteriorGroup.appendChild(frame);
        // Lit interior
        const light = document.createElementNS(SVG_NS, 'rect');
        light.setAttribute('x', phX);
        light.setAttribute('y', phY);
        light.setAttribute('width', 6);
        light.setAttribute('height', 4);
        light.setAttribute('fill', deck.glow ? deck.glow.accent : portholeGlow);
        light.setAttribute('opacity', '0.6');
        light.setAttribute('rx', '1');
        exteriorGroup.appendChild(light);
      }

      // Deck separator — structural beam
      if (di < ship.decks.length - 1) {
        const beamY = dBottom;
        const beam = document.createElementNS(SVG_NS, 'rect');
        beam.setAttribute('x', dLeft);
        beam.setAttribute('y', beamY);
        beam.setAttribute('width', dW);
        beam.setAttribute('height', deckGap * T);
        beam.setAttribute('fill', hullLt);
        beam.setAttribute('opacity', '0.5');
        exteriorGroup.appendChild(beam);
      }

      ey += rows + deckGap;
    });

    // Hull highlights — edge lighting along hull outline
    if (hullPath) {
      const highlight = document.createElementNS(SVG_NS, 'path');
      highlight.setAttribute('d', hullPath);
      highlight.setAttribute('fill', 'none');
      highlight.setAttribute('stroke', glow);
      highlight.setAttribute('stroke-width', '1.5');
      highlight.setAttribute('opacity', '0.5');
      exteriorGroup.appendChild(highlight);

      // Inner glow
      const innerGlow = document.createElementNS(SVG_NS, 'path');
      innerGlow.setAttribute('d', hullPath);
      innerGlow.setAttribute('fill', 'none');
      innerGlow.setAttribute('stroke', glow);
      innerGlow.setAttribute('stroke-width', '4');
      innerGlow.setAttribute('filter', 'url(#hull-glow)');
      innerGlow.setAttribute('opacity', '0.15');
      exteriorGroup.appendChild(innerGlow);
    }

    // Bow sensor array — antenna dishes at top of bridge
    const bowY = oy;
    const centerX = ox + W * T / 2;
    // Central antenna mast
    const mast = document.createElementNS(SVG_NS, 'line');
    mast.setAttribute('x1', centerX);
    mast.setAttribute('y1', bowY - 16);
    mast.setAttribute('x2', centerX);
    mast.setAttribute('y2', bowY);
    mast.setAttribute('stroke', rivet);
    mast.setAttribute('stroke-width', '2');
    exteriorGroup.appendChild(mast);
    // Dish
    const dish = document.createElementNS(SVG_NS, 'path');
    dish.setAttribute('d', `M ${centerX - 8} ${bowY - 12} Q ${centerX} ${bowY - 20} ${centerX + 8} ${bowY - 12}`);
    dish.setAttribute('fill', 'none');
    dish.setAttribute('stroke', glow);
    dish.setAttribute('stroke-width', '1.5');
    dish.setAttribute('opacity', '0.6');
    exteriorGroup.appendChild(dish);
    // Side sensor nubs
    [-18, 18].forEach(dx => {
      const nub = document.createElementNS(SVG_NS, 'rect');
      nub.setAttribute('x', centerX + dx - 2);
      nub.setAttribute('y', bowY - 6);
      nub.setAttribute('width', 4);
      nub.setAttribute('height', 4);
      nub.setAttribute('fill', hullLt);
      nub.setAttribute('stroke', rivet);
      nub.setAttribute('stroke-width', '0.5');
      exteriorGroup.appendChild(nub);
    });

    // Engine bell nozzles at bottom
    const sternY = oy + (ey - deckGap) * T;
    const nozzleW = 10;
    const nozzleH = 14;
    [-1, 0, 1].forEach(n => {
      const nx = centerX + n * (nozzleW + 4) - nozzleW / 2;
      // Bell shape
      const bell = document.createElementNS(SVG_NS, 'path');
      bell.setAttribute('d', `M ${nx + 2} ${sternY} L ${nx} ${sternY + nozzleH} L ${nx + nozzleW} ${sternY + nozzleH} L ${nx + nozzleW - 2} ${sternY} Z`);
      bell.setAttribute('fill', '#0C1820');
      bell.setAttribute('stroke', rivet);
      bell.setAttribute('stroke-width', '1');
      exteriorGroup.appendChild(bell);
      // Inner glow of engine
      const innerB = document.createElementNS(SVG_NS, 'rect');
      innerB.setAttribute('x', nx + 2);
      innerB.setAttribute('y', sternY + nozzleH - 3);
      innerB.setAttribute('width', nozzleW - 4);
      innerB.setAttribute('height', 2);
      innerB.setAttribute('fill', '#E2A355');
      innerB.setAttribute('opacity', '0.3');
      exteriorGroup.appendChild(innerB);
    });

    // Ship name stenciled on hull
    const nameY = oy + 3 * T + T / 2;
    const nameText = document.createElementNS(SVG_NS, 'text');
    nameText.setAttribute('x', centerX);
    nameText.setAttribute('y', nameY);
    nameText.setAttribute('text-anchor', 'middle');
    nameText.setAttribute('font-family', '"Press Start 2P", monospace');
    nameText.setAttribute('font-size', '6');
    nameText.setAttribute('fill', glow);
    nameText.setAttribute('opacity', '0.5');
    nameText.setAttribute('letter-spacing', '2');
    nameText.textContent = ship.name.toUpperCase();
    exteriorGroup.appendChild(nameText);

    // Registration hash marks — small tally lines near bow
    const regY = oy + T + 4;
    for (let i = 0; i < 4; i++) {
      const tick = document.createElementNS(SVG_NS, 'line');
      tick.setAttribute('x1', centerX - 20 + i * 6);
      tick.setAttribute('y1', regY);
      tick.setAttribute('x2', centerX - 20 + i * 6);
      tick.setAttribute('y2', regY + 6);
      tick.setAttribute('stroke', rivet);
      tick.setAttribute('stroke-width', '1');
      tick.setAttribute('opacity', '0.4');
      exteriorGroup.appendChild(tick);
    }
  }
  svgEl.appendChild(exteriorGroup);

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

export function renderTacView(ship, container, thrustActive, zoomLevel = 0, flipping = false, velocity = 0, orienting = false, nearbyEntities = null) {
  const viewW = container.clientWidth || 186;
  const viewH = container.clientHeight || 220;
  const zoom = TAC_ZOOM_LEVELS[zoomLevel];

  const cx = viewW / 2;
  const cy = viewH / 2;

  // String builder — collect all SVG content, write once
  const parts = [];

  // Defs (filters)
  parts.push(`<defs>
    <filter id="tac-glow" x="-100%" y="-50%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
    <filter id="tac-bloom" x="-200%" y="-100%" width="500%" height="400%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
    <filter id="tac-sun" x="-300%" y="-300%" width="700%" height="700%">
      <feGaussianBlur stdDeviation="20"/>
    </filter>
  </defs>`);

  // Grid
  const gridSpacing = viewW / (4 + zoomLevel * 2);
  parts.push('<g opacity="0.06">');
  for (let x = cx % gridSpacing; x < viewW; x += gridSpacing) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${viewH}" stroke="#4FD1C5" stroke-width="0.5"/>`);
  }
  for (let y = cy % gridSpacing; y < viewH; y += gridSpacing) {
    parts.push(`<line x1="0" y1="${y}" x2="${viewW}" y2="${y}" stroke="#4FD1C5" stroke-width="0.5"/>`);
  }
  parts.push('</g>');

  // Range rings
  const ringSpacing = viewW / (3 + zoomLevel);
  parts.push('<g opacity="0.05">');
  for (let r = ringSpacing; r < viewW; r += ringSpacing) {
    parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="none" stroke="#4FD1C5" stroke-width="0.5"/>`);
  }
  parts.push('</g>');

  // Crosshair
  parts.push(`<g opacity="0.08">
    <line x1="${cx}" y1="0" x2="${cx}" y2="${viewH}" stroke="#4FD1C5" stroke-width="0.5"/>
    <line x1="0" y1="${cy}" x2="${viewW}" y2="${cy}" stroke="#4FD1C5" stroke-width="0.5"/>
  </g>`);

  // ---- COMPUTE SHIP DIMENSIONS (with caching) ----
  const deckGapTac = 1;
  const deckCount = ship.decks.length;

  // Cache buildHullPath — hull shape never changes
  if (_cachedHullDeckCount !== deckCount) {
    _cachedHullPath = buildHullPath(ship, 0, 0, deckGapTac);
    _cachedHullDeckCount = deckCount;
  }
  const hullPath = _cachedHullPath;

  // Cache maxTileCols
  if (_cachedMaxTileColsDeckCount !== deckCount) {
    _cachedMaxTileCols = Math.max(...ship.decks.map(d => d.tiles[0].length));
    _cachedMaxTileColsDeckCount = deckCount;
  }
  const maxTileCols = _cachedMaxTileCols;

  const totalTileRows = ship.decks.reduce((sum, d) => sum + d.tiles.length, 0);
  const totalWithGaps = totalTileRows + (deckCount - 1) * deckGapTac;
  const hullRawW = maxTileCols * TILE_SIZE;
  const hullRawH = totalWithGaps * TILE_SIZE;

  // Ship size at each zoom: close = ~16px wide, gets smaller with zoom
  const shipPixelW = Math.max(2, 16 / zoom.scale);
  const scaleFactor = shipPixelW / hullRawW;
  const shipPixelH = hullRawH * scaleFactor;

  // ---- PLUME (rendered behind ship) ----
  if (thrustActive) {
    const nozzleY = cy + shipPixelH / 2;

    // Plume geometry: fireball near ship then long taper
    // Fireball = 2x ship length, width = wider than ship
    // Total plume = 15x ship length
    const fireballLen = shipPixelH * 2;
    const fireballHalfW = shipPixelW * 2.5; // much wider than ship
    const tailLen = shipPixelH * 13;
    const totalPlumeLen = fireballLen + tailLen;

    parts.push('<g>');
    if (zoom.shipMode === 'dot') {
      // FAR ZOOM: plume is a blazing star
      const starR = Math.min(viewW, viewH) * 0.3;
      parts.push(`<ellipse cx="${cx}" cy="${cy + 2}" rx="${starR}" ry="${starR * 1.3}"
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
        </rect>`);
    } else {
      // CLOSE / MEDIUM: render fireball + tail shape
      const numSections = 24;

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

        parts.push(`<rect x="${cx - halfW}" y="${y}" width="${halfW * 2}" height="${h}"
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
        parts.push(`<rect x="${cx - halfW}" y="${y}" width="${halfW * 2}" height="${h}"
          fill="#FFFFFF" opacity="${op.toFixed(2)}">
          <animate attributeName="opacity"
            values="${(op * 0.9).toFixed(2)};${op.toFixed(2)};${(op * 0.9).toFixed(2)}"
            dur="0.05s" repeatCount="indefinite"/>
        </rect>`);
      }

      // Fireball bloom
      parts.push(`<ellipse cx="${cx}" cy="${nozzleY + fireballLen * 0.4}"
        rx="${fireballHalfW * 1.2}" ry="${fireballLen * 0.6}"
        fill="#FFFFFF" opacity="0.05" filter="url(#tac-bloom)">
        <animate attributeName="opacity" values="0.03;0.07;0.03" dur="0.2s" repeatCount="indefinite"/>
      </ellipse>`);

      // Nozzle flash
      parts.push(`<ellipse cx="${cx}" cy="${nozzleY + 1}"
        rx="${shipPixelW * 0.6}" ry="${shipPixelW * 0.3}"
        fill="#FFFFFF" opacity="0.4" filter="url(#tac-glow)">
        <animate attributeName="opacity" values="0.3;0.5;0.3" dur="0.1s" repeatCount="indefinite"/>
      </ellipse>`);
    }
    parts.push('</g>');
  }

  // ---- SHIP ----
  parts.push('<g>');

  if (zoom.shipMode === 'hull' && hullPath) {
    // Close zoom: actual hull outline
    const tx = cx - (hullRawW * scaleFactor) / 2;
    const ty = cy - (hullRawH * scaleFactor) / 2;

    parts.push(`<path d="${hullPath}" fill="#0C1420" stroke="#2D5A6A"
      stroke-width="${1 / scaleFactor}" transform="translate(${tx},${ty}) scale(${scaleFactor})"/>`);
    parts.push(`<path d="${hullPath}" fill="none" stroke="#3D7A8A"
      stroke-width="${2 / scaleFactor}" opacity="0.3" transform="translate(${tx},${ty}) scale(${scaleFactor})"/>`);

    // Label next to ship
    parts.push(`<text x="${cx + shipPixelW / 2 + 4}" y="${cy + 2}"
      font-family="&quot;Press Start 2P&quot;, monospace" font-size="4" fill="#3A4E62">${ship.name.substring(0, 10).toUpperCase()}</text>`);
  } else if (zoom.shipMode === 'icon') {
    // Medium zoom: small diamond icon
    const s = 3;
    parts.push(`<polygon points="${cx},${cy - s} ${cx + s * 0.6},${cy} ${cx},${cy + s} ${cx - s * 0.6},${cy}"
      fill="#1A2A3A" stroke="#3D7A8A" stroke-width="0.5"/>`);
  }
  // dot mode: blinking dot only (below)

  // RCS thrusters (close zoom only, during flip or orient)
  if ((flipping || orienting) && zoom.shipMode === 'hull') {
    const rcsW = 3;
    const rcsH = 1.5;
    // 4 corners: top-left, top-right, bottom-left, bottom-right
    // For rotation: diagonal pairs fire together (TL+BR or TR+BL)
    const rcsPositions = [
      { x: cx - shipPixelW / 2 - rcsW, y: cy - shipPixelH / 2 + 1 },  // 0: top-left
      { x: cx + shipPixelW / 2,        y: cy - shipPixelH / 2 + 1 },  // 1: top-right
      { x: cx - shipPixelW / 2 - rcsW, y: cy + shipPixelH / 2 - 2 },  // 2: bottom-left
      { x: cx + shipPixelW / 2,        y: cy + shipPixelH / 2 - 2 },  // 3: bottom-right
    ];

    if (flipping) {
      // Flip: all 4 fire rapidly
      rcsPositions.forEach(pos => {
        parts.push(`<rect x="${pos.x}" y="${pos.y}" width="${rcsW}" height="${rcsH}"
            fill="#E2A355" opacity="0.9">
            <animate attributeName="opacity" values="0.5;1;0.5" dur="0.08s" repeatCount="indefinite"/>
          </rect>`);
      });
    } else {
      // Orient: alternating diagonal pairs with irregular pulses
      // Pair A: top-left + bottom-right (clockwise torque)
      // Pair B: top-right + bottom-left (counter-clockwise correction)
      const pairA = [0, 3];
      rcsPositions.forEach((pos, i) => {
        const isPairA = pairA.includes(i);
        // Pair A: long pulse, short off — dominant thrust
        // Pair B: short correction pulse with longer pause
        const vals = isPairA
          ? '0;0.9;0.9;0.7;0;0;0;0;0;0.8;0.9;0;0'
          : '0;0;0;0;0;0.7;0.8;0;0;0;0;0;0';
        const dur = '2.4s';
        parts.push(`<rect x="${pos.x}" y="${pos.y}" width="${rcsW}" height="${rcsH}"
            fill="#E2A355" opacity="0">
            <animate attributeName="opacity" values="${vals}" dur="${dur}" repeatCount="indefinite"/>
          </rect>`);
      });
    }
  }

  // Blinking center dot (always visible)
  const dotSize = zoom.shipMode === 'dot' ? 2 : 1;
  parts.push(`<rect x="${cx - dotSize / 2}" y="${cy - dotSize / 2}" width="${dotSize}" height="${dotSize}" fill="#4FD1C5" opacity="0.9">
      <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" repeatCount="indefinite"/>
    </rect>`);
  parts.push('</g>');

  // Movement particles — driven by velocity vector
  // velocity > 0 → particles flow down (we're moving "up"), < 0 → flow up
  const absVel = Math.abs(velocity);
  const tacSpeedFactor = Math.min(1, absVel / 100000);

  if (absVel > 1) {
    parts.push(`<g opacity="${0.08 + tacSpeedFactor * 0.15}">`);
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
      parts.push(`<rect x="${px}" y="${startY}" width="1" height="${streakLen}" fill="#4FD1C5" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0.2;0" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
          <animate attributeName="y" values="${startY};${endY}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
        </rect>`);
    }
    parts.push('</g>');
  }

  // ---- NEARBY ENTITIES ----
  // Draw other ships/stations within the tac view range
  if (nearbyEntities && nearbyEntities.length > 0) {
    const rangeKm = zoom.scale; // 1, 5, or 25 km
    const rangeM = rangeKm * 1000;
    const pxPerM = (viewH / 2) / rangeM; // pixels per meter for this zoom

    for (const ne of nearbyEntities) {
      if (ne.distM > rangeM) continue;

      // Position relative to ship (bearing + distance → screen coords)
      // bearing is relative to ship facing (forward = up on tac screen)
      const ex = cx + Math.sin(ne.relBearing) * ne.distM * pxPerM;
      const ey = cy - Math.cos(ne.relBearing) * ne.distM * pxPerM;

      // Skip if offscreen
      if (ex < -10 || ex > viewW + 10 || ey < -10 || ey > viewH + 10) continue;

      // Color by faction/SOS
      let color = '#7A8EA2';
      if (ne.sosActive) color = '#E25555';
      else if (ne.faction === 'MCRN') color = '#C1553B';
      else if (ne.faction === 'UNN') color = '#4A90D9';
      else if (ne.faction === 'OPA' || ne.faction === 'Belter') color = '#7EC8D9';

      if (zoom.shipMode === 'hull') {
        // Close zoom: draw ship/station silhouette, shape varies by class & mass
        const massScale = ne.mass ? Math.min(2.5, Math.max(0.4, ne.mass / 80000)) : 1;
        const seed = ne.seed || 0;
        // Seeded pseudo-random for consistent per-entity variation
        const sv = (i) => ((seed * 2654435761 + i * 340573321) >>> 0) / 4294967296;
        const cls = (ne.shipClass || '').toLowerCase();
        const isStation = ne.entityType === 'station';

        parts.push(`<g transform="translate(${ex},${ey})">`);

        if (isStation) {
          // STATION: spinning drum/ring shape
          const r = 12 * massScale;
          const ringW = r * (0.15 + sv(0) * 0.1);
          // Outer ring
          parts.push(`<circle cx="0" cy="0" r="${r}" fill="none" stroke="${color}" stroke-width="${ringW}" opacity="0.7"/>`);
          // Inner structure spokes
          const spokes = 3 + (seed % 3);
          for (let s = 0; s < spokes; s++) {
            const a = (s / spokes) * Math.PI * 2 + sv(1) * 0.3;
            parts.push(`<line x1="0" y1="0" x2="${Math.cos(a) * r}" y2="${Math.sin(a) * r}" stroke="${color}" stroke-width="0.6" opacity="0.4"/>`);
          }
          // Hub
          parts.push(`<circle cx="0" cy="0" r="${r * 0.2}" fill="${color}" opacity="0.3"/>`);
          // Docking arm
          const dockA = sv(2) * Math.PI * 2;
          parts.push(`<line x1="${Math.cos(dockA) * r}" y1="${Math.sin(dockA) * r}" x2="${Math.cos(dockA) * (r + 5)}" y2="${Math.sin(dockA) * (r + 5)}" stroke="${color}" stroke-width="1" opacity="0.5"/>`);

        } else {
          // SHIP: shape varies by class
          const h = (14 + sv(0) * 6) * massScale;  // hull length
          const w = (4 + sv(1) * 3) * massScale;   // hull width
          const bow = -h / 2;
          const stern = h / 2;
          const hw = w / 2;

          if (cls.includes('hauler') || cls.includes('barge') || cls.includes('tanker') || cls.includes('freighter')) {
            // BULK: wide, boxy, blunt bow, cargo pods
            const boxW = hw * (1.1 + sv(2) * 0.3);
            const neckW = hw * (0.5 + sv(3) * 0.2);
            const neckY = bow + h * (0.2 + sv(4) * 0.1);
            // Narrow neck at bow, wide cargo section
            parts.push(`<polygon points="0,${bow} ${neckW},${neckY} ${boxW},${neckY + h * 0.15} ${boxW},${stern - 2} ${-boxW},${stern - 2} ${-boxW},${neckY + h * 0.15} ${-neckW},${neckY}"
              fill="none" stroke="${color}" stroke-width="0.8" opacity="0.8"/>`);
            // Cargo pod lines
            const pods = 1 + (seed % 3);
            for (let p = 0; p < pods; p++) {
              const py = neckY + h * 0.3 + p * h * 0.15;
              parts.push(`<line x1="-${boxW}" y1="${py}" x2="${boxW}" y2="${py}" stroke="${color}" stroke-width="0.4" opacity="0.3"/>`);
            }

          } else if (cls.includes('liner') || cls.includes('donnager') || cls.includes('truman')) {
            // CAPITAL: long, angular, with fins/nacelles
            const finW = hw * (0.4 + sv(2) * 0.2);
            const finStart = stern - h * (0.3 + sv(3) * 0.1);
            // Main hull — tapered bow
            parts.push(`<polygon points="0,${bow} ${hw * 0.6},${bow + h * 0.15} ${hw},${bow + h * 0.35} ${hw},${stern} -${hw},${stern} -${hw},${bow + h * 0.35} -${hw * 0.6},${bow + h * 0.15}"
              fill="none" stroke="${color}" stroke-width="0.8" opacity="0.8"/>`);
            // Nacelle fins
            parts.push(`<line x1="${hw}" y1="${finStart}" x2="${hw + finW}" y2="${stern}" stroke="${color}" stroke-width="0.8" opacity="0.6"/>`);
            parts.push(`<line x1="-${hw}" y1="${finStart}" x2="-${hw + finW}" y2="${stern}" stroke="${color}" stroke-width="0.8" opacity="0.6"/>`);
            // Bridge stripe
            parts.push(`<line x1="-${hw * 0.4}" y1="${bow + h * 0.12}" x2="${hw * 0.4}" y2="${bow + h * 0.12}" stroke="${color}" stroke-width="0.6" opacity="0.5"/>`);

          } else if (cls.includes('skiff') || cls.includes('courier') || cls.includes('shuttle')) {
            // SMALL: compact, narrow, sharp bow
            const sharpness = 0.35 + sv(2) * 0.15;
            parts.push(`<polygon points="0,${bow} ${hw},${bow + h * sharpness} ${hw * 0.8},${stern} -${hw * 0.8},${stern} -${hw},${bow + h * sharpness}"
              fill="none" stroke="${color}" stroke-width="0.7" opacity="0.8"/>`);
            // Wing stubs
            if (sv(3) > 0.4) {
              const wy = bow + h * 0.5;
              const wExt = hw * (0.6 + sv(4) * 0.5);
              parts.push(`<line x1="${hw}" y1="${wy}" x2="${hw + wExt}" y2="${wy + 2}" stroke="${color}" stroke-width="0.6" opacity="0.5"/>`);
              parts.push(`<line x1="-${hw}" y1="${wy}" x2="-${hw + wExt}" y2="${wy + 2}" stroke="${color}" stroke-width="0.6" opacity="0.5"/>`);
            }

          } else {
            // DEFAULT: medium ship — pointed bow, tapered stern
            const bowTaper = 0.25 + sv(2) * 0.1;
            const sternTaper = 0.8 + sv(3) * 0.15;
            parts.push(`<polygon points="0,${bow} ${hw},${bow + h * bowTaper} ${hw},${stern * sternTaper} ${hw * 0.6},${stern} -${hw * 0.6},${stern} -${hw},${stern * sternTaper} -${hw},${bow + h * bowTaper}"
              fill="none" stroke="${color}" stroke-width="0.8" opacity="0.8"/>`);
            // Mid-section detail
            parts.push(`<line x1="-${hw * 0.7}" y1="0" x2="${hw * 0.7}" y2="0" stroke="${color}" stroke-width="0.4" opacity="0.3"/>`);
          }

          // Engine glow at stern (all ships)
          if (ne.thrustActive) {
            const glowW = hw * (0.6 + sv(5) * 0.3);
            parts.push(`<rect x="-${glowW}" y="${stern}" width="${glowW * 2}" height="${3 + massScale}" fill="#E2A355" opacity="0.7">
              <animate attributeName="opacity" values="0.5;0.9;0.5" dur="0.25s" repeatCount="indefinite"/>
            </rect>`);
          }
        }

        // Center dot (all)
        parts.push(`<circle cx="0" cy="0" r="1" fill="${color}" opacity="0.5"/>`);
        parts.push('</g>');

        // SOS pulse
        if (ne.sosActive) {
          parts.push(`<circle cx="${ex}" cy="${ey}" r="10" fill="none" stroke="#E25555" stroke-width="0.8" opacity="0">
            <animate attributeName="r" values="10;22" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.5;0" dur="1.5s" repeatCount="indefinite"/>
          </circle>`);
        }

        // Label below
        if (ne.name) {
          parts.push(`<text x="${ex}" y="${ey + shipH / 2 + 10}" fill="${color}" font-size="7" font-family="monospace" text-anchor="middle" opacity="0.8">${ne.name}</text>`);
        }

      } else if (zoom.shipMode === 'icon') {
        // Medium zoom: small diamond icon
        const sz = 5;
        parts.push(`<polygon points="${ex},${ey - sz} ${ex + sz * 0.6},${ey} ${ex},${ey + sz * 0.7} ${ex - sz * 0.6},${ey}"
          fill="none" stroke="${color}" stroke-width="0.8" opacity="0.85"/>`);
        if (ne.thrustActive) {
          parts.push(`<line x1="${ex}" y1="${ey + sz * 0.7}" x2="${ex}" y2="${ey + sz * 0.7 + 4}" stroke="#E2A355" stroke-width="1" opacity="0.7">
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="0.3s" repeatCount="indefinite"/>
          </line>`);
        }
        // Glow ring
        parts.push(`<circle cx="${ex}" cy="${ey}" r="${sz + 2}" fill="none" stroke="${color}" stroke-width="0.4" opacity="0.3"/>`);

        if (ne.sosActive) {
          parts.push(`<circle cx="${ex}" cy="${ey}" r="${sz}" fill="none" stroke="#E25555" stroke-width="0.6" opacity="0">
            <animate attributeName="r" values="${sz};${sz + 10}" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.5;0" dur="1.5s" repeatCount="indefinite"/>
          </circle>`);
        }

        if (ne.name) {
          parts.push(`<text x="${ex + sz + 3}" y="${ey + 3}" fill="${color}" font-size="7" font-family="monospace" opacity="0.8">${ne.name}</text>`);
        }

      } else {
        // Far zoom: simple dot
        parts.push(`<circle cx="${ex}" cy="${ey}" r="2" fill="${color}" opacity="0.9"/>`);
        parts.push(`<circle cx="${ex}" cy="${ey}" r="4" fill="none" stroke="${color}" stroke-width="0.4" opacity="0.3"/>`);
        if (ne.sosActive) {
          parts.push(`<circle cx="${ex}" cy="${ey}" r="2" fill="none" stroke="#E25555" stroke-width="0.6" opacity="0">
            <animate attributeName="r" values="2;8" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.5;0" dur="1.5s" repeatCount="indefinite"/>
          </circle>`);
        }
      }
    }
  }

  // Single innerHTML write with proper SVG namespace
  container.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewW}" height="${viewH}" viewBox="0 0 ${viewW} ${viewH}" shape-rendering="crispEdges" style="display:block">${parts.join('')}</svg>`;
}
